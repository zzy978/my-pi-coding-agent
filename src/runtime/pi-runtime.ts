import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import type { TaskSpec } from "../task/task-spec.js";
import { createPolicyExtension } from "../policy/policy-extension.js";
import { createSafeToolDefinitions } from "../policy/safe-tools.js";

export interface PiRuntimeOptions {
  workspace: string;
  getTask: () => TaskSpec;
  continueSession: boolean;
  noSession: boolean;
  allowShell: boolean;
}

export class PiRuntime {
  readonly session: AgentSession;
  readonly diagnostics: readonly { type: "info" | "warning" | "error"; message: string }[];
  readonly modelFallbackMessage: string | undefined;
  readonly hasAvailableModel: boolean;

  private constructor(
    session: AgentSession,
    diagnostics: readonly { type: "info" | "warning" | "error"; message: string }[],
    modelFallbackMessage: string | undefined,
    hasAvailableModel: boolean
  ) {
    this.session = session;
    this.diagnostics = diagnostics;
    this.modelFallbackMessage = modelFallbackMessage;
    this.hasAvailableModel = hasAvailableModel;
  }

  static async create(options: PiRuntimeOptions): Promise<PiRuntime> {
    const task = options.getTask();
    const services = await createAgentSessionServices({
      cwd: options.workspace,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [createPolicyExtension(options.workspace, options.getTask)]
      }
    });
    const sessionManager = options.noSession
      ? SessionManager.inMemory(options.workspace)
      : options.continueSession
        ? SessionManager.continueRecent(options.workspace)
        : SessionManager.create(options.workspace);
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      noTools: "builtin",
      customTools: createSafeToolDefinitions(options.workspace, task.allowedPaths, options.allowShell)
    });
    return new PiRuntime(
      result.session,
      services.diagnostics,
      result.modelFallbackMessage,
      services.modelRuntime.getAvailableSnapshot().length > 0
    );
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    return this.session.subscribe(listener);
  }

  prompt(text: string): Promise<void> {
    return this.session.prompt(text);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  dispose(): void {
    this.session.dispose();
  }
}
