import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { INTERACTIVE_TASK_OBJECTIVE, type TaskSpec } from "../task/task-spec.js";
import { basename } from "node:path";
import { sha256Text } from "../evaluation/schema.js";
import { createPolicyExtension } from "../policy/policy-extension.js";
import { relativePathWithin } from "../policy/path-policy.js";
import { createSafeToolDefinitions } from "../policy/safe-tools.js";
import { ShellApprovalGate, type ShellApprovalHandler } from "../policy/shell-approval.js";

export interface PiRuntimeOptions {
  workspace: string;
  getTask: () => TaskSpec;
  continueSession: boolean;
  noSession: boolean;
  allowShell: boolean;
  sessionDirectory?: string;
  sessionFile?: string;
  sessionId?: string;
  requestedModel?: { provider: string; id: string };
  thinkingLevel?: AgentSession["thinkingLevel"];
  tools?: string[];
}

export class PiRuntime {
  readonly session: AgentSession;
  readonly diagnostics: readonly { type: "info" | "warning" | "error"; message: string }[];
  readonly modelFallbackMessage: string | undefined;
  readonly hasAvailableModel: boolean;
  readonly contextFiles: readonly { path: string; sha256: string }[];
  private sessionObjective = INTERACTIVE_TASK_OBJECTIVE;

  private constructor(
    session: AgentSession,
    diagnostics: readonly { type: "info" | "warning" | "error"; message: string }[],
    modelFallbackMessage: string | undefined,
    hasAvailableModel: boolean,
    contextFiles: readonly { path: string; sha256: string }[],
    private readonly shellApproval: ShellApprovalGate
  ) {
    this.session = session;
    this.diagnostics = diagnostics;
    this.modelFallbackMessage = modelFallbackMessage;
    this.hasAvailableModel = hasAvailableModel;
    this.contextFiles = contextFiles;
  }

  static async create(options: PiRuntimeOptions): Promise<PiRuntime> {
    const task = options.getTask();
    const shellApproval = new ShellApprovalGate();
    const services = await createAgentSessionServices({
      cwd: options.workspace,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [createPolicyExtension(options.workspace, options.getTask, {
          allowShell: options.allowShell
        })]
      }
    });
    const sessionManager = options.noSession
      ? SessionManager.inMemory(options.workspace)
      : options.sessionFile
        ? SessionManager.open(options.sessionFile, options.sessionDirectory, options.workspace)
        : options.continueSession
          ? SessionManager.continueRecent(options.workspace, options.sessionDirectory)
          : SessionManager.create(options.workspace, options.sessionDirectory, options.sessionId ? { id: options.sessionId } : undefined);
    const availableModels = services.modelRuntime.getAvailableSnapshot();
    const requestedModel = options.requestedModel
      ? availableModels.find((model) => model.provider === options.requestedModel?.provider && model.id === options.requestedModel.id)
      : undefined;
    if (options.requestedModel && !requestedModel) {
      throw new Error(`Replay model is not available: ${options.requestedModel.provider}/${options.requestedModel.id}`);
    }
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      noTools: "builtin",
      customTools: createSafeToolDefinitions(
        options.workspace,
        task.allowedPaths,
        options.allowShell,
        (request) => shellApproval.request(request)
      )
    });
    const contextFiles = services.resourceLoader.getAgentsFiles().agentsFiles.map((file) => ({
      path: relativePathWithin(options.workspace, file.path) ?? `external:${basename(file.path)}`,
      sha256: sha256Text(file.content)
    })).sort((left, right) => left.path.localeCompare(right.path));
    return new PiRuntime(
      result.session,
      services.diagnostics,
      result.modelFallbackMessage,
      availableModels.length > 0,
      contextFiles,
      shellApproval
    );
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    return this.session.subscribe(listener);
  }

  prompt(text: string): Promise<void> {
    return this.session.prompt(text);
  }

  get conversationObjective(): string {
    return this.sessionObjective;
  }

  setConversationObjective(objective: string): void {
    this.sessionObjective = objective.trim() || INTERACTIVE_TASK_OBJECTIVE;
  }

  setShellApprovalHandler(handler: ShellApprovalHandler | undefined): void {
    this.shellApproval.setHandler(handler);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shellApproval.setHandler(undefined);
    try {
      this.session.dispose();
    } finally {
      for (const handler of this.disposeHandlers.splice(0)) handler();
    }
  }

  private disposed = false;
  private readonly disposeHandlers: Array<() => void> = [];

  onDispose(handler: () => void): void {
    if (this.disposed) handler();
    else this.disposeHandlers.push(handler);
  }
}
