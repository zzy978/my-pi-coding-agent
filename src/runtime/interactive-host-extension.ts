import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type AgentSessionRuntime,
  type ExtensionContext,
  type InlineExtension
} from "@earendil-works/pi-coding-agent";
import { writeRunReport } from "../report/report.js";
import type { TaskSpec } from "../task/task-spec.js";
import { INTERACTIVE_TASK_OBJECTIVE } from "../task/task-spec.js";
import { formatVerificationSummary, runVerification } from "../verifier/verifier.js";
import { formatRepairPrompt, repairStopMessage, repairStopReason } from "../verifier/repair.js";
import { sanitizeVerificationReport } from "../evaluation/redaction.js";
import type { WorkspaceInfo } from "../workspace/git.js";
import { getDiff } from "../workspace/git.js";
import { SessionPicker } from "../tui/session-picker.js";
import { canonicalWorkspacePath, type WorkspaceSessionStore } from "./session-store.js";

interface InteractiveHostExtensionOptions {
  task: TaskSpec;
  workspace: WorkspaceInfo;
  store: WorkspaceSessionStore;
  getRuntimeHost: () => AgentSessionRuntime;
  temporarySessionFiles: Set<string>;
  pendingSessionObjectives: Map<string, string>;
  consumeInitialObjectiveOverride: () => string | undefined;
  dataDirectory: string;
  temporaryDirectory: string;
  releaseSessionLock?: () => void;
  isPlanning?: () => boolean;
  onAgentSettled?: () => void;
}

function completed(): Promise<void> {
  return Promise.resolve();
}

function storedObjective(sessionManager: ExtensionContext["sessionManager"]): string | undefined {
  const entries = sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== "pi-tui-session") continue;
    if (!entry.data || typeof entry.data !== "object") continue;
    const objective = (entry.data as { objective?: unknown }).objective;
    if (typeof objective === "string" && objective.trim()) return objective.trim();
  }
  return undefined;
}

export async function materializeEmptySession(sessionManager: SessionManager): Promise<string> {
  const path = sessionManager.getSessionFile();
  if (!path) throw new Error("Temporary persistent session has no file path");
  const header = sessionManager.getHeader() ?? {
    type: "session" as const,
    version: CURRENT_SESSION_VERSION,
    id: sessionManager.getSessionId(),
    timestamp: new Date().toISOString(),
    cwd: sessionManager.getCwd()
  };
  const entries = [header, ...sessionManager.getEntries()];
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

export function createInteractiveHostExtension(options: InteractiveHostExtensionOptions): InlineExtension {
  return {
    name: "pi-tui-host",
    hidden: true,
    factory: (pi) => {
      let verificationRunning = false;
      let verificationFinished = Promise.resolve();
      let generation = 0;
      let attempts = 0;
      let normalEnd = false;
      let chainTask = structuredClone(options.task);
      let continuation: ReturnType<typeof setTimeout> | undefined;
      const invalidate = (resetBudget = true): void => {
        generation += 1;
        if (resetBudget) attempts = 0;
        normalEnd = false;
        clearTimeout(continuation);
        continuation = undefined;
        if (resetBudget) chainTask = structuredClone(options.task);
      };
      pi.on("input", (event) => {
        // Other input handlers may transform the text before this handler sees it.
        // Extension-generated input must never replenish the current repair budget.
        invalidate(event.source !== "extension");
      });
      pi.on("agent_end", (event) => {
        const last = [...event.messages].reverse().find((message) => message.role === "assistant");
        normalEnd = last?.role === "assistant" && last.stopReason === "stop";
      });

      const persistObjective = async (ctx: ExtensionContext): Promise<void> => {
        const path = ctx.sessionManager.getSessionFile();
        if (!path || options.temporarySessionFiles.has(path)) return;
        await options.store.record({
          id: ctx.sessionManager.getSessionId(),
          path,
          cwd: options.workspace.workspace,
          objective: options.task.objective
        });
        pi.appendEntry("pi-tui-session", {
          sourceRoot: options.workspace.sourceRoot,
          objective: options.task.objective
        });
      };

      const verifyAndReport = async (ctx: ExtensionContext, automatic = false): Promise<void> => {
        if (options.isPlanning?.()) {
          ctx.ui.notify("计划模式暂停验证命令；退出计划模式后可使用 /verify。", "info");
          return;
        }
        if (verificationRunning) {
          ctx.ui.notify("Verification is already running.", "warning");
          return;
        }
        if (!automatic && !ctx.isIdle()) {
          ctx.ui.notify("请等待当前执行结束后再验证。", "warning");
          return;
        }
        const token = generation;
        const sessionId = ctx.sessionManager.getSessionId();
        const task = structuredClone(automatic ? chainTask : options.task);
        const current = () => token === generation && sessionId === ctx.sessionManager.getSessionId() &&
          JSON.stringify(task) === JSON.stringify(options.task) && !options.isPlanning?.();
        verificationRunning = true;
        let releaseVerification!: () => void;
        verificationFinished = new Promise<void>((resolve) => { releaseVerification = resolve; });
        ctx.ui.setStatus("pi-tui-verifier", "Verifying…");
        try {
          const verification = await runVerification(
            options.workspace.workspace,
            task,
            (command, index, total) => ctx.ui.setStatus(
              "pi-tui-verifier",
              `Verifying ${index + 1}/${total}: ${command}`
            ),
            { allowUnavailableGit: true }
          );
          const sessionFile = ctx.sessionManager.getSessionFile();
          const paths = await writeRunReport({
            version: 1,
            createdAt: new Date().toISOString(),
            task,
            workspace: options.workspace,
            sessionId: ctx.sessionManager.getSessionId(),
            ...(sessionFile ? { sessionFile } : {}),
            ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
            verification
          }, options.dataDirectory);
          if (!current()) return;
          ctx.ui.notify(
            `${formatVerificationSummary(sanitizeVerificationReport(verification))}\nReport: ${paths.markdownPath}`,
            verification.success ? "info" : "warning"
          );
          ctx.ui.setStatus(
            "pi-tui-verifier",
            verification.success ? "Last verification passed" : "Last verification incomplete/failed"
          );
          if (automatic && normalEnd) {
            const limit = task.maxRepairAttempts ?? 0;
            const reason = repairStopReason(verification, attempts, limit);
            if (reason) {
              if (reason !== "passed") ctx.ui.notify(repairStopMessage(reason), "warning");
              return;
            }
            const feedback = formatRepairPrompt(task, verification, attempts + 1, limit);
            // Let settled subscribers (including the task timer) finish before starting another run.
            continuation = setTimeout(() => {
              continuation = undefined;
              if (!current() || !normalEnd || !ctx.isIdle() || ctx.hasPendingMessages()) return;
              attempts += 1;
              normalEnd = false;
              ctx.ui.notify(`验证未通过，开始自动修复 ${attempts}/${limit}。`, "info");
              pi.sendUserMessage(feedback, { deliverAs: "followUp" });
            }, 0);
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          ctx.ui.setStatus("pi-tui-verifier", "Verification failed to run");
        } finally {
          verificationRunning = false;
          releaseVerification();
        }
      };

      pi.on("session_before_switch", (event, ctx) => {
        if (event.reason !== "resume" || !event.targetSessionFile) return undefined;
        try {
          const targetCwd = SessionManager.open(event.targetSessionFile).getCwd();
          if (canonicalWorkspacePath(targetCwd) !== canonicalWorkspacePath(options.workspace.workspace)) {
            ctx.ui.notify(
              "This application keeps tools and verification bound to the selected workspace. Open that session from its own repository.",
              "warning"
            );
            return { cancel: true };
          }
        } catch {
          return undefined;
        }
        return undefined;
      });

      pi.on("session_start", async (event, ctx) => {
        invalidate();
        const path = ctx.sessionManager.getSessionFile();
        const sessionId = ctx.sessionManager.getSessionId();
        const sessionOverride = options.pendingSessionObjectives.get(sessionId);
        options.pendingSessionObjectives.delete(sessionId);
        const restored = storedObjective(ctx.sessionManager);
        const initialOverride = event.reason === "startup" ? options.consumeInitialObjectiveOverride() : undefined;
        if (initialOverride) options.task.objective = initialOverride;
        else if (sessionOverride) options.task.objective = sessionOverride;
        else if (restored) options.task.objective = restored;
        else if (event.reason === "new" || event.reason === "resume") {
          options.task.objective = INTERACTIVE_TASK_OBJECTIVE;
        }
        chainTask = structuredClone(options.task);
        if (path && !options.temporarySessionFiles.has(path)) {
          try {
            await persistObjective(ctx);
          } catch (error) {
            options.releaseSessionLock?.();
            throw error;
          }
        }
        ctx.ui.setStatus("pi-tui-task", `Task: ${options.task.objective}`);
      });

      pi.on("session_shutdown", async (event, ctx) => {
        invalidate();
        if (event.reason === "reload") return;
        options.releaseSessionLock?.();
        const path = ctx.sessionManager.getSessionFile();
        if (path && options.temporarySessionFiles.delete(path)) {
          await rm(dirname(path), { recursive: true, force: true });
        }
      });

      pi.on("agent_settled", async (_event, ctx) => {
        options.onAgentSettled?.();
        if (options.isPlanning?.()) return;
        if (!normalEnd) return;
        const token = generation;
        if (verificationRunning) await verificationFinished;
        if (token !== generation || !normalEnd || options.isPlanning?.()) return;
        await verifyAndReport(ctx, true);
      });

      pi.registerCommand("repair", {
        description: "自动修复：/repair [status|off|0..5]",
        handler: (args, ctx) => {
          const value = args.trim();
          if (value === "off" || /^[0-5]$/.test(value)) {
            options.task.maxRepairAttempts = value === "off" ? 0 : Number(value);
            invalidate();
          } else if (value && value !== "status") {
            ctx.ui.notify("用法：/repair [status|off|0..5]", "warning");
            return completed();
          }
          ctx.ui.notify(`自动修复上限：${options.task.maxRepairAttempts ?? 0} 次；当前已修复：${attempts} 次。`, "info");
          return completed();
        }
      });

      pi.registerCommand("task", {
        description: "Set the host task objective",
        handler: async (args, ctx) => {
          const objective = args.trim();
          if (!objective) {
            ctx.ui.notify("Usage: /task <objective>", "warning");
            return;
          }
          options.task.objective = objective;
          invalidate();
          await persistObjective(ctx);
          ctx.ui.setStatus("pi-tui-task", `Task: ${objective}`);
          ctx.ui.notify(`Task objective updated: ${objective}`, "info");
        }
      });

      pi.registerCommand("allow", {
        description: "Legacy command; paths are unrestricted",
        handler: (_args, ctx) => {
          ctx.ui.notify("路径限制已取消，无需使用 /allow。", "info");
          return completed();
        }
      });

      pi.registerCommand("verify-add", {
        description: "Add a deterministic verification command",
        handler: (args, ctx) => {
          const command = args.trim();
          if (!command) {
            ctx.ui.notify("Usage: /verify-add <command>", "warning");
            return completed();
          }
          options.task.verify.push({ command, timeoutMs: 120_000 });
          invalidate();
          ctx.ui.notify(`Verification command added: ${command}`, "info");
          return completed();
        }
      });

      pi.registerCommand("run", {
        description: "Run the current host task objective",
        handler: (_args, ctx) => {
          if (options.task.objective === INTERACTIVE_TASK_OBJECTIVE) {
            ctx.ui.notify("Set an objective with /task <objective> first.", "warning");
            return completed();
          }
          invalidate();
          pi.sendUserMessage(options.task.objective);
          return completed();
        }
      });

      pi.registerCommand("verify", {
        description: "Run host verification commands",
        handler: async (_args, ctx) => {
          invalidate(false);
          await verifyAndReport(ctx);
        }
      });

      pi.registerCommand("diff", {
        description: "Show Git changes for the selected workspace",
        handler: async (_args, ctx) => {
          ctx.ui.notify(await getDiff(options.workspace.workspace, { allowUnavailableGit: true }), "info");
        }
      });

      pi.registerCommand("status", {
        description: "Show host task and workspace state",
        handler: (_args, ctx) => {
          ctx.ui.notify([
            `Task: ${options.task.objective}`,
            "Paths: unrestricted (protected files remain protected)",
            `Verifiers: ${options.task.verify.map((item) => item.command).join("; ") || "not configured"}`,
            `Workspace: ${options.workspace.workspace}`,
            `Branch: ${options.workspace.branch}`,
            `Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not configured"}`,
            `Session: ${ctx.sessionManager.getSessionId()}`
          ].join("\n"), "info");
          return completed();
        }
      });

      pi.registerCommand("sessions", {
        description: "Switch a session recorded for this workspace",
        handler: async (args, ctx) => {
          const sessions = await options.store.list();
          if (!sessions.length) {
            ctx.ui.notify("No persistent sessions are available for this workspace.", "info");
            return;
          }
          const requested = args.trim();
          const selected = requested
            ? (() => {
                const exact = sessions.find((session) => session.id === requested);
                const matches = exact ? [exact] : sessions.filter((session) => session.id.startsWith(requested));
                return matches.length === 1 ? matches[0] : undefined;
              })()
            : undefined;
          let choice = selected;
          if (requested && !choice) {
            ctx.ui.notify(`No unique session matches ${requested}.`, "warning");
            return;
          }
          if (!choice) {
            choice = await ctx.ui.custom((_tui, _theme, _keybindings, done) => {
              const picker = new SessionPicker(sessions, ctx.sessionManager.getSessionId());
              picker.onSelect = done;
              picker.onCancel = () => done(undefined);
              return picker;
            });
          }
          if (!choice || choice.id === ctx.sessionManager.getSessionId()) return;
          let targetPath = choice.path;
          if (!choice.materialized) {
            const pending = SessionManager.create(options.workspace.workspace, options.store.sessionDirectory, { id: choice.id });
            targetPath = await materializeEmptySession(pending);
          }
          if (choice.objective) options.pendingSessionObjectives.set(choice.id, choice.objective);
          try {
            const result = await options.getRuntimeHost().switchSession(targetPath, {
              cwdOverride: options.workspace.workspace,
              withSession: (replacement) => {
                replacement.ui.notify(`Switched to session ${choice?.id}`, "info");
                return completed();
              }
            });
            if (result.cancelled) options.pendingSessionObjectives.delete(choice.id);
          } catch (error) {
            options.pendingSessionObjectives.delete(choice.id);
            throw error;
          }
        }
      });

      pi.registerCommand("temp", {
        description: "Start a temporary session removed when it closes",
        handler: async () => {
          await mkdir(options.temporaryDirectory, { recursive: true });
          const directory = await mkdtemp(join(options.temporaryDirectory, "session-"));
          const temporary = SessionManager.create(options.workspace.workspace, directory);
          const path = await materializeEmptySession(temporary);
          options.temporarySessionFiles.add(path);
          await options.getRuntimeHost().switchSession(path, {
            cwdOverride: options.workspace.workspace,
            withSession: (replacement) => {
              replacement.ui.notify("Started temporary session", "info");
              return completed();
            }
          }).catch(async (error: unknown) => {
            options.temporarySessionFiles.delete(path);
            await rm(directory, { recursive: true, force: true });
            throw error;
          });
        }
      });
    }
  };
}
