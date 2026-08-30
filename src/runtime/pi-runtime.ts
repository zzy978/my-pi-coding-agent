import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import type { TaskSpec } from "../task/task-spec.js";
import { basename } from "node:path";
import { sha256Text } from "../evaluation/schema.js";
import { createPolicyExtension } from "../policy/policy-extension.js";
import { relativePathWithin } from "../policy/path-policy.js";
import { createSafeToolDefinitions } from "../policy/safe-tools.js";

export interface PiRuntimeOptions {
  workspace: string;
  getTask: () => TaskSpec;
  continueSession: boolean;
  noSession: boolean;
  allowShell: boolean;
  requestedModel?: { provider: string; id: string };
  thinkingLevel?: AgentSession["thinkingLevel"];
}

export class PiRuntime {
  readonly session: AgentSession;
  readonly diagnostics: readonly { type: "info" | "warning" | "error"; message: string }[];
  readonly modelFallbackMessage: string | undefined;
  readonly hasAvailableModel: boolean;
  readonly contextFiles: readonly { path: string; sha256: string }[];

  private constructor(
    session: AgentSession,
    diagnostics: readonly { type: "info" | "warning" | "error"; message: string }[],
    modelFallbackMessage: string | undefined,
    hasAvailableModel: boolean,
    contextFiles: readonly { path: string; sha256: string }[]
  ) {
    this.session = session;
    this.diagnostics = diagnostics;
    this.modelFallbackMessage = modelFallbackMessage;
    this.hasAvailableModel = hasAvailableModel;
    this.contextFiles = contextFiles;
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
      noTools: "builtin",
      customTools: createSafeToolDefinitions(options.workspace, task.allowedPaths, options.allowShell)
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
      contextFiles
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
