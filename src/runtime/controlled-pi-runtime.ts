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
import { parseRecordedModelConfig, readModelConfig, type ModelConfig, type RecordedModelConfig } from "../model-config.js";
import { applyModelLimits, configureModelRuntime, configuredModel, recordModelConfig } from "./model-configuration.js";

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
  modelConfig?: ModelConfig;
  recordedModelConfig?: RecordedModelConfig;
}

export class ControlledPiRuntime {
  private disposed = false;

  private constructor(
    readonly session: AgentSession,
    readonly hasAvailableModel: boolean,
    readonly contextFiles: readonly { path: string; sha256: string }[],
    readonly modelConfig?: RecordedModelConfig
  ) {}

  static async create(options: ControlledPiRuntimeOptions): Promise<ControlledPiRuntime> {
    const config = options.modelConfig ?? readModelConfig();
    const frozenConfig = options.recordedModelConfig ? parseRecordedModelConfig(options.recordedModelConfig) : undefined;
    const limits = frozenConfig ?? config;
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
    await configureModelRuntime(services.modelRuntime, config);
    applyModelLimits(services.modelRuntime, limits);
    const availableModels = services.modelRuntime.getAvailableSnapshot();
    const requestedModel = options.requestedModel
      ? availableModels.find((model) => model.provider === options.requestedModel?.provider && model.id === options.requestedModel.id)
      : configuredModel(services.modelRuntime, config);
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
        options.allowShell,
        () => Promise.resolve(false)
      )
    });
    const contextFiles = services.resourceLoader.getAgentsFiles().agentsFiles.map((file) => ({
      path: relativePathWithin(options.workspace, file.path) ?? `external:${basename(file.path)}`,
      sha256: sha256Text(file.content)
    })).sort((left, right) => left.path.localeCompare(right.path));
    const recorded = result.session.model ? recordModelConfig(result.session.model, limits) : undefined;
    if (frozenConfig && JSON.stringify(recorded) !== JSON.stringify(frozenConfig)) {
      result.session.dispose();
      throw new Error("模型服务地址或输出能力与记录不一致；未提交模型任务，请恢复配置或重新记录。");
    }
    return new ControlledPiRuntime(result.session, availableModels.length > 0, contextFiles, recorded);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.dispose();
  }
}
