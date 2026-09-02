import {
  InteractiveMode,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory
} from "@earendil-works/pi-coding-agent";
import { createPolicyExtension } from "../policy/policy-extension.js";
import { createSafeToolDefinitions } from "../policy/safe-tools.js";
import type { TaskSpec } from "../task/task-spec.js";
import type { WorkspaceInfo } from "../workspace/git.js";
import { createInteractiveHostExtension } from "./interactive-host-extension.js";
import { canonicalWorkspacePath, WorkspaceSessionStore } from "./session-store.js";
import { getDataDirectories, getDataDirectory } from "./data-dir.js";

export interface PiInteractiveOptions {
  workspace: WorkspaceInfo;
  task: TaskSpec;
  allowShell: boolean;
  continueSession: boolean;
  noSession: boolean;
  initialPrompt?: string;
  dataDirectory?: string;
  agentDirectory?: string;
}

async function initialSessionManager(
  options: PiInteractiveOptions,
  store: WorkspaceSessionStore
): Promise<{ sessionManager: SessionManager; objective?: string }> {
  if (options.noSession) {
    return { sessionManager: SessionManager.inMemory(options.workspace.workspace) };
  }
  if (!options.continueSession) {
    return { sessionManager: SessionManager.create(options.workspace.workspace, store.sessionDirectory) };
  }
  const recent = (await store.list())[0];
  if (!recent) {
    return { sessionManager: SessionManager.create(options.workspace.workspace, store.sessionDirectory) };
  }
  const sessionManager = recent.materialized
    ? SessionManager.open(recent.path, store.sessionDirectory, options.workspace.workspace)
    : SessionManager.create(options.workspace.workspace, store.sessionDirectory, { id: recent.id });
  return {
    sessionManager,
    ...(recent.objective ? { objective: recent.objective } : {})
  };
}

export async function createPiInteractiveRuntime(options: PiInteractiveOptions): Promise<AgentSessionRuntime> {
  const dataDirectory = options.dataDirectory ?? getDataDirectory();
  const directories = getDataDirectories(dataDirectory);
  const store = await WorkspaceSessionStore.create(options.workspace.sourceRoot, dataDirectory);
  const initialSession = await initialSessionManager(options, store);
  const { sessionManager } = initialSession;
  const agentDirectory = options.agentDirectory ?? directories.agent;
  const temporarySessionFiles = new Set<string>();
  const pendingSessionObjectives = new Map<string, string>();
  if (initialSession.objective) {
    pendingSessionObjectives.set(sessionManager.getSessionId(), initialSession.objective);
  }
  let initialObjectiveOverride = options.initialPrompt ? options.task.objective : undefined;
  const runtimeReference: { current?: AgentSessionRuntime } = {};
  const getRuntimeHost = (): AgentSessionRuntime => {
    if (!runtimeReference.current) throw new Error("Interactive runtime is not ready");
    return runtimeReference.current;
  };

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager: targetSessionManager,
    sessionStartEvent
  }) => {
    if (canonicalWorkspacePath(cwd) !== canonicalWorkspacePath(options.workspace.workspace)) {
      throw new Error(`Session workspace ${cwd} does not match ${options.workspace.workspace}`);
    }
    const sessionFile = targetSessionManager.getSessionFile();
    const rawReleaseLock = sessionFile && !temporarySessionFiles.has(sessionFile)
      ? store.acquire(targetSessionManager.getSessionId())
      : undefined;
    let lockReleased = false;
    const releaseSessionLock = rawReleaseLock ? () => {
      if (lockReleased) return;
      lockReleased = true;
      rawReleaseLock();
    } : undefined;
    try {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: {
          extensionFactories: [
            createPolicyExtension(cwd, () => options.task, {
              allowShell: options.allowShell,
              interactiveShellApproval: true
            }),
            createInteractiveHostExtension({
              task: options.task,
              workspace: options.workspace,
              store,
              getRuntimeHost,
              temporarySessionFiles,
              pendingSessionObjectives,
              dataDirectory,
              temporaryDirectory: directories.temp,
              consumeInitialObjectiveOverride: () => {
                const objective = initialObjectiveOverride;
                initialObjectiveOverride = undefined;
                return objective;
              },
              ...(releaseSessionLock ? { releaseSessionLock } : {})
            })
          ]
        }
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager: targetSessionManager,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
        noTools: "builtin",
        customTools: createSafeToolDefinitions(
          cwd,
          options.task.allowedPaths,
          options.allowShell,
          () => Promise.resolve(true)
        )
      });
      return {
        ...created,
        services,
        diagnostics: [
          ...services.diagnostics,
          ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
            type: "error" as const,
            message: `Failed to load extension "${path}": ${error}`
          }))
        ]
      };
    } catch (error) {
      releaseSessionLock?.();
      throw error;
    }
  };

  runtimeReference.current = await createAgentSessionRuntime(createRuntime, {
    cwd: options.workspace.workspace,
    agentDir: agentDirectory,
    sessionManager
  });
  return runtimeReference.current;
}

export async function runPiInteractive(options: PiInteractiveOptions): Promise<void> {
  const runtimeHost = await createPiInteractiveRuntime(options);
  const mode = new InteractiveMode(runtimeHost, {
    migratedProviders: [],
    startupDiagnostics: [...runtimeHost.diagnostics],
    ...(runtimeHost.modelFallbackMessage ? { modelFallbackMessage: runtimeHost.modelFallbackMessage } : {}),
    ...(options.initialPrompt ? { initialMessage: options.initialPrompt } : {}),
    initialImages: [],
    initialMessages: []
  });
  try {
    await mode.run();
  } catch (error) {
    await runtimeHost.dispose();
    throw error;
  }
}
