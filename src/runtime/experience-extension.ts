import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { parseCandidateSnapshot, renderCandidatePrompt, type ExperienceCandidate } from "../experience/candidate.js";

export interface ExperienceExtensionOptions {
  sourceRepository: string;
  dataDirectory: string;
  loadActiveCandidates: (sourceRepository: string, dataDirectory: string) => Promise<ExperienceCandidate[]>;
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

export function createExperienceExtension(options: ExperienceExtensionOptions): InlineExtension {
  return {
    name: "host-experience",
    hidden: true,
    factory: (pi) => {
      let selected: { id: string; hash: string } | undefined;
      let revision = 0;

      const clearSelection = (ctx: ExtensionContext): void => {
        selected = undefined;
        revision += 1;
        ctx.ui.setStatus("experience", undefined);
      };
      const loadCandidates = async (): Promise<ExperienceCandidate[]> => {
        const candidates = await options.loadActiveCandidates(options.sourceRepository, options.dataDirectory);
        // Do not allow a malformed snapshot to reach either the user or model context.
        return candidates.map((candidate) => ({ ...candidate, ...parseCandidateSnapshot(candidate) }));
      };

      pi.on("session_start", (_event, ctx) => clearSelection(ctx));

      pi.on("before_agent_start", async (_event, ctx) => {
        if (!selected) return undefined;
        const selection = selected;
        const startedAtRevision = revision;
        try {
          const active = await loadCandidates();
          if (revision !== startedAtRevision) return undefined;
          const candidate = active.find((item) => item.id === selection.id && item.contentSha256 === selection.hash);
          if (!candidate) {
            clearSelection(ctx);
            ctx.ui.notify("经验候选已撤销或内容已变更，已停用。请重新选择有效候选。", "warning");
            return undefined;
          }
          return {
            message: {
              customType: "host-experience",
              content: renderCandidatePrompt("", candidate).trimStart(),
              display: true,
              details: {
                candidateId: candidate.id,
                contentSha256: candidate.contentSha256,
                sourceRunId: candidate.sourceRunId,
                rendererVersion: candidate.rendererVersion
              }
            }
          };
        } catch {
          if (revision !== startedAtRevision) return undefined;
          clearSelection(ctx);
          ctx.ui.notify("无法验证经验候选，已停用；本轮不加入经验指导。", "warning");
          return undefined;
        }
      });

      pi.registerCommand("experience", {
        description: "列出、选择或停用本仓库已晋升的经验候选",
        handler: async (args, ctx) => {
          const tokens = args.trim().split(/\s+/).filter(Boolean);
          const action = tokens[0] ?? "list";
          if ((action !== "list" && action !== "use" && action !== "off")
            || (action === "use" ? tokens.length !== 2 : tokens.length > 1)) {
            ctx.ui.notify("用法：/experience [list | use <候选 ID> | off]", "warning");
            return;
          }
          if (action === "off") {
            clearSelection(ctx);
            ctx.ui.notify("经验候选已停用。既有会话内容仍会保留；需要干净上下文时请新建会话。", "info");
            return;
          }
          if (action === "use") clearSelection(ctx);
          const startedAtRevision = revision;
          try {
            const active = await loadCandidates();
            if (revision !== startedAtRevision) return;
            if (action === "list") {
              if (selected && !active.some((item) => item.id === selected?.id && item.contentSha256 === selected.hash)) {
                clearSelection(ctx);
              }
              const status = selected ? `当前选择：${selected.id}` : "当前未启用经验候选";
              const entries = active.map((candidate) => `${candidate.id} [${candidate.kind}] ${visibleText(candidate.title)}`);
              ctx.ui.notify([
                status,
                entries.length > 0 ? entries.join("\n") : "本仓库暂无有效晋升候选。",
                "使用 /experience use <候选 ID> 选择，/experience off 停用。"
              ].join("\n"), "info");
              return;
            }
            const candidate = active.find((item) => item.id === tokens[1]);
            if (!candidate) {
              ctx.ui.notify("该候选尚未在本仓库有效晋升，无法启用。", "warning");
              return;
            }
            selected = { id: candidate.id, hash: candidate.contentSha256 };
            revision += 1;
            ctx.ui.setStatus("experience", `经验：${visibleText(candidate.title, 80)}`);
            ctx.ui.notify([
              `已选择经验候选 ${candidate.id}：${visibleText(candidate.title)}`,
              `适用：${candidate.applicability.map((text) => visibleText(text)).join("；") || "请按当前任务判断"}`,
              `不适用：${candidate.contraindications.map((text) => visibleText(text)).join("；") || "未列明"}`,
              "仅作为后续轮次的文本指导，不更改任务权限、工具或验证器。"
            ].join("\n"), "info");
          } catch {
            if (revision !== startedAtRevision) return;
            clearSelection(ctx);
            ctx.ui.notify("无法读取或验证经验候选，已停用。请检查经验与晋升记录。", "warning");
          }
        }
      });
    }
  };
}
