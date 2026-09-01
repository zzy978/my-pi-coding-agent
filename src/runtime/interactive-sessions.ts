import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { INTERACTIVE_TASK_OBJECTIVE, type TaskSpec } from "../task/task-spec.js";
import { PiRuntime } from "./pi-runtime.js";
import { WorkspaceSessionStore, type StoredSessionInfo } from "./session-store.js";

export type InteractiveSessionTarget =
  | { type: "new" }
  | { type: "temporary" }
  | { type: "open"; session: StoredSessionInfo };

export interface RuntimePreferences {
  model?: { provider: string; id: string };
  thinkingLevel?: AgentSession["thinkingLevel"];
  objective?: string;
}

export interface InteractiveSessionControllerOptions {
  workspace: string;
  sourceRoot: string;
  getTask: () => TaskSpec;
  allowShell: boolean;
  dataDirectory?: string;
}

export interface TuiSessionController {
  list(): Promise<StoredSessionInfo[]>;
  create(target: InteractiveSessionTarget, preferences?: RuntimePreferences): Promise<PiRuntime>;
  continueRecentOrCreate(preferences?: RuntimePreferences): Promise<PiRuntime>;
  updateObjective(runtime: PiRuntime, objective: string): Promise<void>;
}

function normalizedObjective(objective: string | undefined): string {
  return objective?.trim() || INTERACTIVE_TASK_OBJECTIVE;
}

function storedObjective(runtime: PiRuntime): string | undefined {
  const entries = runtime.session.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== "pi-tui-session") continue;
    if (!entry.data || typeof entry.data !== "object") continue;
    const objective = (entry.data as { objective?: unknown }).objective;
    if (typeof objective === "string" && objective.trim()) return objective.trim();
  }
  return undefined;
}

export class InteractiveSessionController implements TuiSessionController {
  private constructor(
    private readonly options: InteractiveSessionControllerOptions,
    private readonly store: WorkspaceSessionStore
  ) {}

  static async create(options: InteractiveSessionControllerOptions): Promise<InteractiveSessionController> {
    const store = await WorkspaceSessionStore.create(options.sourceRoot, options.dataDirectory);
    return new InteractiveSessionController(options, store);
  }

  list(): Promise<StoredSessionInfo[]> {
    return this.store.list();
  }

  async continueRecentOrCreate(preferences?: RuntimePreferences): Promise<PiRuntime> {
    const recent = (await this.list())[0];
    return this.create(recent ? { type: "open", session: recent } : { type: "new" }, preferences);
  }

  async create(target: InteractiveSessionTarget, preferences?: RuntimePreferences): Promise<PiRuntime> {
    let releaseLock = target.type === "open" ? this.store.acquire(target.session.id) : undefined;
    let runtime: PiRuntime | undefined;
    try {
      runtime = await PiRuntime.create({
        workspace: this.options.workspace,
        getTask: this.options.getTask,
        continueSession: false,
        noSession: target.type === "temporary",
        allowShell: this.options.allowShell,
        ...((target.type === "new" || target.type === "open") ? { sessionDirectory: this.store.sessionDirectory } : {}),
        ...(target.type === "open" && target.session.materialized ? { sessionFile: target.session.path } : {}),
        ...(target.type === "open" && !target.session.materialized ? { sessionId: target.session.id } : {}),
        ...(preferences?.model ? { requestedModel: preferences.model } : {}),
        ...(preferences?.thinkingLevel ? { thinkingLevel: preferences.thinkingLevel } : {})
      });
      if (!runtime.hasAvailableModel) {
        throw new Error("No configured Pi model. Run `pi`, use `/login`, then retry or run with --doctor.");
      }
      if (target.type === "open" && runtime.session.sessionId !== target.session.id) {
        throw new Error(`Session ID mismatch while opening ${target.session.id}`);
      }
      const objective = target.type === "open"
        ? normalizedObjective(target.session.objective ?? storedObjective(runtime))
        : normalizedObjective(preferences?.objective);
      runtime.setConversationObjective(objective);
      if (target.type === "new") releaseLock = this.store.acquire(runtime.session.sessionId);
      if (releaseLock) {
        runtime.onDispose(releaseLock);
        releaseLock = undefined;
      }
      if (target.type !== "temporary") {
        const sessionFile = runtime.session.sessionFile;
        if (!sessionFile) throw new Error(`Persistent session ${runtime.session.sessionId} has no session file`);
        await this.store.record({
          id: runtime.session.sessionId,
          path: sessionFile,
          cwd: this.options.workspace,
          objective
        });
      }
      if (target.type === "new") {
        runtime.session.sessionManager.appendCustomEntry("pi-tui-session", {
          sourceRoot: this.store.sourceRoot,
          objective
        });
      }
      return runtime;
    } catch (error) {
      runtime?.dispose();
      releaseLock?.();
      throw error;
    }
  }

  async updateObjective(runtime: PiRuntime, objective: string): Promise<void> {
    const normalized = normalizedObjective(objective);
    runtime.setConversationObjective(normalized);
    if (!runtime.session.sessionFile) return;
    await this.store.record({
      id: runtime.session.sessionId,
      path: runtime.session.sessionFile,
      cwd: this.options.workspace,
      objective: normalized
    });
    runtime.session.sessionManager.appendCustomEntry("pi-tui-session", {
      sourceRoot: this.store.sourceRoot,
      objective: normalized
    });
  }
}
