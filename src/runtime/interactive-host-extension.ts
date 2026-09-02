import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import type { WorkspaceInfo } from "../workspace/git.js";
import { getDiff } from "../workspace/git.js";
import { SessionPicker } from "../tui/session-picker.js";
import type { WorkspaceSessionStore } from "./session-store.js";

interface InteractiveHostExtensionOptions {
  task: TaskSpec;
  workspace: WorkspaceInfo;
  store: WorkspaceSessionStore;
  getRuntimeHost: () => AgentSessionRuntime;
  temporarySessionFiles: Set<string>;
  consumeInitialObjectiveOverride: () => string | undefined;
  releaseSessionLock?: () => void;
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

async function materializeEmptySession(sessionManager: SessionManager): Promise<string> {
  const path = sessionManager.getSessionFile();
  if (!path) throw new Error("Temporary persistent session has no file path");
  const header = sessionManager.getHeader() ?? {
    type: "session" as const,
    version: CURRENT_SESSION_VERSION,
    id: sessionManager.getSessionId(),
    timestamp: new Date().toISOString(),
    cwd: sessionManager.getCwd()
  };
  await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

export function createInteractiveHostExtension(options: InteractiveHostExtensionOptions): InlineExtension {
  return {
    name: "pi-tui-host",
    hidden: true,
    factory: (pi) => {
      let verificationRunning = false;

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

      const verifyAndReport = async (ctx: ExtensionContext): Promise<void> => {
        if (verificationRunning) {
          ctx.ui.notify("Verification is already running.", "warning");
          return;
        }
        verificationRunning = true;
        ctx.ui.setStatus("pi-tui-verifier", "Verifying…");
        try {
          const verification = await runVerification(
            options.workspace.workspace,
            options.task,
            (command, index, total) => ctx.ui.setStatus(
              "pi-tui-verifier",
              `Verifying ${index + 1}/${total}: ${command}`
            )
          );
          const sessionFile = ctx.sessionManager.getSessionFile();
          const paths = await writeRunReport({
            version: 1,
            createdAt: new Date().toISOString(),
            task: options.task,
            workspace: options.workspace,
            sessionId: ctx.sessionManager.getSessionId(),
            ...(sessionFile ? { sessionFile } : {}),
            ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
            verification
          });
          ctx.ui.notify(
            `${formatVerificationSummary(verification)}\nReport: ${paths.markdownPath}`,
            verification.success ? "info" : "warning"
          );
          ctx.ui.setStatus(
            "pi-tui-verifier",
            verification.success ? "Last verification passed" : "Last verification incomplete/failed"
          );
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          ctx.ui.setStatus("pi-tui-verifier", "Verification failed to run");
        } finally {
          verificationRunning = false;
        }
      };

      pi.on("session_before_switch", (event, ctx) => {
        if (event.reason !== "resume" || !event.targetSessionFile) return undefined;
        try {
          const targetCwd = SessionManager.open(event.targetSessionFile).getCwd();
          if (canonicalPath(targetCwd) !== canonicalPath(options.workspace.workspace)) {
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
        const path = ctx.sessionManager.getSessionFile();
        const restored = storedObjective(ctx.sessionManager);
        const initialOverride = event.reason === "startup" ? options.consumeInitialObjectiveOverride() : undefined;
        if (initialOverride) options.task.objective = initialOverride;
        else if (restored) options.task.objective = restored;
        else if (event.reason === "new" || event.reason === "resume") {
          options.task.objective = INTERACTIVE_TASK_OBJECTIVE;
        }
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
        if (event.reason === "reload") return;
        options.releaseSessionLock?.();
        const path = ctx.sessionManager.getSessionFile();
        if (path && options.temporarySessionFiles.delete(path)) {
          await rm(dirname(path), { recursive: true, force: true });
        }
      });

      pi.on("agent_settled", async (_event, ctx) => {
        await verifyAndReport(ctx);
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
          await persistObjective(ctx);
          ctx.ui.setStatus("pi-tui-task", `Task: ${objective}`);
          ctx.ui.notify(`Task objective updated: ${objective}`, "info");
        }
      });

      pi.registerCommand("allow", {
        description: "Add an allowed changed-path glob",
        handler: (args, ctx) => {
          const glob = args.trim();
          if (!glob) {
            ctx.ui.notify("Usage: /allow <glob>", "warning");
            return completed();
          }
          if (!options.task.allowedPaths.includes(glob)) options.task.allowedPaths.push(glob);
          ctx.ui.notify(`Allowed path added: ${glob}`, "info");
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
          pi.sendUserMessage(options.task.objective);
          return completed();
        }
      });

      pi.registerCommand("verify", {
        description: "Run host verification commands",
        handler: async (_args, ctx) => verifyAndReport(ctx)
      });

      pi.registerCommand("diff", {
        description: "Show Git changes for the selected workspace",
        handler: async (_args, ctx) => {
          ctx.ui.notify(await getDiff(options.workspace.workspace), "info");
        }
      });

      pi.registerCommand("status", {
        description: "Show host task and workspace state",
        handler: (_args, ctx) => {
          ctx.ui.notify([
            `Task: ${options.task.objective}`,
            `Allowed: ${options.task.allowedPaths.join(", ")}`,
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
          await options.getRuntimeHost().switchSession(targetPath, {
            cwdOverride: options.workspace.workspace,
            withSession: (replacement) => {
              replacement.ui.notify(`Switched to session ${choice?.id}`, "info");
              return completed();
            }
          });
        }
      });

      pi.registerCommand("temp", {
        description: "Start a temporary session removed when it closes",
        handler: async () => {
          const directory = await mkdtemp(join(tmpdir(), "pi-tui-session-"));
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
