import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { sha256Text } from "../evaluation/schema.js";
import { createPolicyExtension } from "../policy/policy-extension.js";
import { relativePathWithin } from "../policy/path-policy.js";
import { createSafeToolDefinitions } from "../policy/safe-tools.js";
import type { TaskSpec } from "../task/task-spec.js";
import { getDataDirectories } from "./data-dir.js";

export interface ControlledPiRuntimeOptions {
  workspace: string;
  getTask: () => TaskSpec;
  noSession: boolean;
  allowShell: boolean;
  requestedModel?: { provider: string; id: string };
  thinkingLevel?: AgentSession["thinkingLevel"];
  tools?: string[];
  agentDirectory?: string;
  sessionDirectory?: string;
}

export class ControlledPiRuntime {
  private disposed = false;

  private constructor(
    readonly session: AgentSession,
    readonly hasAvailableModel: boolean,
    readonly contextFiles: readonly { path: string; sha256: string }[]
  ) {}

  static async create(options: ControlledPiRuntimeOptions): Promise<ControlledPiRuntime> {
    const task = options.getTask();
    const directories = getDataDirectories();
    const agentDirectory = options.agentDirectory ?? directories.agent;
    const sessionDirectory = options.sessionDirectory ?? join(directories.sessions, "controlled");
    const services = await createAgentSessionServices({
      cwd: options.workspace,
      agentDir: agentDirectory,
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
    if (!options.noSession) {
      await mkdir(sessionDirectory, { recursive: true });
    }
    const sessionManager = options.noSession
      ? SessionManager.inMemory(options.workspace)
      : SessionManager.create(options.workspace, sessionDirectory);
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
        () => Promise.resolve(false)
      )
    });
    const contextFiles = services.resourceLoader.getAgentsFiles().agentsFiles.map((file) => ({
      path: relativePathWithin(options.workspace, file.path) ?? `external:${basename(file.path)}`,
      sha256: sha256Text(file.content)
    })).sort((left, right) => left.path.localeCompare(right.path));
    return new ControlledPiRuntime(result.session, availableModels.length > 0, contextFiles);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.dispose();
  }
}
