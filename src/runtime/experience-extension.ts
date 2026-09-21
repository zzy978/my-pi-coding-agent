import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { parseCandidateSnapshot, renderCandidatePrompt, type ExperienceCandidate } from "../experience/candidate.js";
import type { TaskExperienceSelection } from "../experience/retrieval-service.js";

export interface ExperienceExtensionOptions {
  sourceRepository: string;
  dataDirectory: string;
  loadActiveCandidates: (sourceRepository: string, dataDirectory: string) => Promise<ExperienceCandidate[]>;
  retrieve?: (objective: string, candidates: ExperienceCandidate[], ctx: ExtensionContext) => Promise<TaskExperienceSelection>;
  getTaskObjective?: () => string;
  isPlanning?: () => boolean;
}

function visibleText(text: string, maximum = 300): string {
  let result = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const unsafe = code <= 0x1f || (code >= 0x7f && code <= 0x9f)
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    const rendered = unsafe ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    if (result.length + rendered.length > maximum) return `${result}…`;
    result += rendered;
  }
  return result;
}

// Bind applicability metadata as well as content: a changed condition invalidates a pending decision.
function candidateIdentity(candidate: ExperienceCandidate): string {
  return JSON.stringify([candidate.id, candidate.kind, candidate.contentSha256, candidate.rendererVersion,
    candidate.sourceRunId, candidate.sourceExperienceId, candidate.createdAt, candidate.title,
    candidate.applicability, candidate.contraindications]);
}

export function createExperienceExtension(options: ExperienceExtensionOptions): InlineExtension {
  return {
    name: "host-experience",
    hidden: true,
    factory: (pi) => {
      let mode: "auto" | "use" | "off" = "auto";
      let selected: { id: string; identity: string } | undefined;
      let revision = 0;
      const invalidate = (ctx: ExtensionContext): void => {
        revision += 1;
        ctx.ui.setStatus("experience", undefined);
      };
      const loadCandidates = async (): Promise<ExperienceCandidate[]> => {
        const candidates = await options.loadActiveCandidates(options.sourceRepository, options.dataDirectory);
        return candidates.map((candidate) => ({ ...candidate, ...parseCandidateSnapshot(candidate),
          applicability: [...candidate.applicability], contraindications: [...candidate.contraindications] }));
      };
      const checkManualSelection = (active: ExperienceCandidate[], ctx: ExtensionContext): boolean => {
        if (mode !== "use" || active.some((item) => item.id === selected?.id
          && candidateIdentity(item) === selected.identity)) return true;
        mode = "off";
        selected = undefined;
        invalidate(ctx);
        ctx.ui.notify("限定的经验候选已撤销或变更，已停用。", "warning");
        return false;
      };
      pi.on("session_start", (_event, ctx) => {
        mode = "auto";
        selected = undefined;
        invalidate(ctx);
      });
      pi.on("session_before_switch", (_event, ctx) => invalidate(ctx));
      pi.on("session_shutdown", (_event, ctx) => invalidate(ctx));
      pi.on("model_select", (_event, ctx) => invalidate(ctx));
      pi.on("input", (_event, ctx) => invalidate(ctx));

      pi.on("before_agent_start", async (event, ctx) => {
        invalidate(ctx);
        if (mode === "off" || options.isPlanning?.() || !event.prompt.trim()) return undefined;
        if (!options.retrieve || !ctx.model) {
          ctx.ui.setStatus("experience", "经验：筛选不可用，本轮未注入");
          return undefined;
        }
        const startedAtRevision = revision;
        const taskObjective = options.getTaskObjective?.();
        const sessionId = ctx.sessionManager.getSessionId();
        const modelIdentity = JSON.stringify([ctx.model.provider, ctx.model.id]);
        const current = (): boolean => revision === startedAtRevision
          && !options.isPlanning?.()
          && options.getTaskObjective?.() === taskObjective
          && ctx.sessionManager.getSessionId() === sessionId
          && JSON.stringify([ctx.model?.provider, ctx.model?.id]) === modelIdentity;
        try {
          const active = await loadCandidates();
          if (!current()) return undefined;
          if (!checkManualSelection(active, ctx)) return undefined;
          const pool = mode === "use"
            ? active.filter((item) => item.id === selected?.id && candidateIdentity(item) === selected.identity)
            : active;
          if (pool.length === 0) {
            ctx.ui.setStatus("experience", "经验：暂无可用候选");
            return undefined;
          }
          const identities = new Map(pool.map((item) => [item.id, candidateIdentity(item)]));
          const result = await options.retrieve(event.prompt, pool, ctx);
          if (!current()) return undefined;
          if (result.status !== "selected" || !result.candidate || result.selectedIds.length === 0) {
            ctx.ui.setStatus("experience", result.status === "failed" ? "经验：筛选失败，本轮未注入" : "经验：本轮无适用候选");
            return undefined;
          }
          const refreshed = await loadCandidates();
          if (!current()) return undefined;
          if (!checkManualSelection(refreshed, ctx)) return undefined;
          if (result.selectedIds.length > 2 || new Set(result.selectedIds).size !== result.selectedIds.length
            || result.selectedIds.some((id) => !identities.has(id)
              || !refreshed.some((item) => item.id === id && candidateIdentity(item) === identities.get(id)))) {
            ctx.ui.setStatus("experience", "经验：候选已变更，本轮未注入");
            return undefined;
          }
          const content = renderCandidatePrompt("", result.candidate).trimStart();
          ctx.ui.setStatus("experience", `经验：已筛选 ${result.selectedIds.length} 条`);
          return { message: { customType: "host-experience", content, display: true,
            details: { candidateId: result.candidate.id, contentSha256: result.candidate.contentSha256,
              rendererVersion: result.candidate.rendererVersion, selectedIds: result.selectedIds, auditId: result.auditId } } };
        } catch {
          if (current()) ctx.ui.notify("经验筛选或校验失败，本轮不加入经验指导。", "warning");
          return undefined;
        }
      });

      pi.registerCommand("experience", {
        description: "自动筛选、限定或停用本仓库已晋升的经验候选",
        handler: async (args, ctx) => {
          const tokens = args.trim().split(/\s+/).filter(Boolean);
          const action = tokens[0] ?? "list";
          if (!["list", "use", "off", "auto"].includes(action)
            || (action === "use" ? tokens.length !== 2 : tokens.length > 1)) {
            ctx.ui.notify("用法：/experience [list | auto | use <候选 ID> | off]", "warning");
            return;
          }
          if (action === "off" || action === "auto") {
            mode = action;
            selected = undefined;
            invalidate(ctx);
            ctx.ui.notify(action === "auto" ? "已启用自动经验筛选；仅注入适合当前任务的有效晋升候选。"
              : "经验候选已停用。既有会话内容仍会保留；需要干净上下文时请新建会话。", "info");
            return;
          }
          if (action === "use") {
            mode = "off";
            selected = undefined;
            invalidate(ctx);
          }
          const startedAtRevision = revision;
          try {
            const active = await loadCandidates();
            if (revision !== startedAtRevision) return;
            if (action === "list") {
              checkManualSelection(active, ctx);
              const status = mode === "auto" ? "当前：自动筛选" : mode === "use" ? `当前限定：${selected?.id}` : "当前已停用经验候选";
              ctx.ui.notify([status,
                active.map((item) => `${item.id} [${item.kind}] ${visibleText(item.title)}`).join("\n") || "本仓库暂无有效晋升候选。",
                "使用 /experience auto 自动筛选，use <候选 ID> 限定候选，off 停用。"].join("\n"), "info");
              return;
            }
            const candidate = active.find((item) => item.id === tokens[1]);
            if (!candidate) {
              ctx.ui.notify("该候选尚未在本仓库有效晋升，无法启用。", "warning");
              return;
            }
            mode = "use";
            selected = { id: candidate.id, identity: candidateIdentity(candidate) };
            invalidate(ctx);
            ctx.ui.setStatus("experience", `经验：待筛选 ${visibleText(candidate.title, 80)}`);
            ctx.ui.notify(`已限定候选 ${candidate.id}；后续轮次仍须通过适用性、阶段和完整性检查。`, "info");
          } catch {
            if (revision === startedAtRevision) ctx.ui.notify("无法读取或验证经验候选。请检查经验与晋升记录。", "warning");
          }
        }
      });
    }
  };
}
