import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessResult, RunProcessOptions } from "../runtime/process.js";
import { runShellCommand } from "../runtime/process.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import {
  discardManagedWorkspace,
  listChangedFiles,
  prepareWorkspace,
  type WorkspaceInfo
} from "./git.js";

export interface SetupCommand {
  command: string;
  timeoutMs: number;
}

export interface SetupPlan {
  source: "auto" | "explicit" | "disabled";
  commands: SetupCommand[];
}

export type SetupPreference =
  | { mode: "auto" }
  | { mode: "disabled" }
  | { mode: "explicit"; commands: SetupCommand[] }
  | { mode: "resolved"; plan: SetupPlan };

export interface ReadyWorkspace {
  workspace: WorkspaceInfo;
  setup: SetupPlan;
}

export class WorkspaceSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSetupError";
  }
}

type SetupCommandRunner = (command: string, options: RunProcessOptions) => Promise<ProcessResult>;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function cloneCommands(commands: SetupCommand[]): SetupCommand[] {
  return commands.map((item) => ({ ...item }));
}

export function setupPreferenceFromCli(commands: string[], disabled: boolean): SetupPreference {
  if (disabled) return { mode: "disabled" };
  if (commands.length > 0) {
    return {
      mode: "explicit",
      commands: commands.map((command) => ({ command, timeoutMs: 600_000 }))
    };
  }
  return { mode: "auto" };
}

export async function resolveSetupPlan(
  workspace: WorkspaceInfo,
  preference: SetupPreference
): Promise<SetupPlan> {
  if (preference.mode === "resolved") {
    return { source: preference.plan.source, commands: cloneCommands(preference.plan.commands) };
  }
  if (preference.mode === "disabled") return { source: "disabled", commands: [] };
  if (preference.mode === "explicit") {
    return { source: "explicit", commands: cloneCommands(preference.commands) };
  }
  if (!workspace.managedWorktree) return { source: "auto", commands: [] };
  if (await fileExists(join(workspace.workspace, "package-lock.json"))) {
    return { source: "auto", commands: [{ command: "npm ci --ignore-scripts", timeoutMs: 600_000 }] };
  }
  return { source: "auto", commands: [] };
}

function setupFailureMessage(command: SetupCommand, result: ProcessResult): string {
  const status = result.timedOut
    ? `timed out after ${command.timeoutMs} ms`
    : `exited with code ${String(result.exitCode)}`;
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return redactSensitiveText(
    `Workspace setup command failed (${status}): ${command.command}${output ? `\n${output}` : ""}`
  );
}

export async function runWorkspaceSetup(
  workspace: WorkspaceInfo,
  preference: SetupPreference,
  options?: {
    onCommandStart?: (command: string, index: number, total: number) => void;
    runCommand?: SetupCommandRunner;
  }
): Promise<SetupPlan> {
  const plan = await resolveSetupPlan(workspace, preference);
  const runCommand = options?.runCommand ?? runShellCommand;
  for (let index = 0; index < plan.commands.length; index += 1) {
    const setup = plan.commands[index];
    if (!setup) continue;
    options?.onCommandStart?.(setup.command, index, plan.commands.length);
    let result: ProcessResult;
    try {
      result = await runCommand(setup.command, {
        cwd: workspace.workspace,
        timeoutMs: setup.timeoutMs,
        maxOutputBytes: 256 * 1024
      });
    } catch (error) {
      throw new WorkspaceSetupError(
        redactSensitiveText(
          `Workspace setup command could not start: ${setup.command}\n${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
    if (result.exitCode !== 0 || result.timedOut) {
      throw new WorkspaceSetupError(setupFailureMessage(setup, result));
    }
  }

  if (workspace.managedWorktree) {
    const changed = await listChangedFiles(workspace.workspace);
    if (changed.length > 0) {
      throw new WorkspaceSetupError(
        `Workspace setup changed tracked or untracked files: ${changed.join(", ")}. Setup must leave a clean Git baseline.`
      );
    }
  }
  return plan;
}

export async function prepareReadyWorkspace(
  sourcePath: string,
  workspaceOptions: Parameters<typeof prepareWorkspace>[1],
  setupPreference: SetupPreference,
  onSetupCommand?: (command: string, index: number, total: number) => void
): Promise<ReadyWorkspace> {
  const workspace = await prepareWorkspace(sourcePath, workspaceOptions);
  try {
    const setup = await runWorkspaceSetup(workspace, setupPreference, {
      ...(onSetupCommand ? { onCommandStart: onSetupCommand } : {})
    });
    return { workspace, setup };
  } catch (setupError) {
    try {
      await discardManagedWorkspace(workspace);
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        `Workspace setup failed and cleanup also failed for ${workspace.workspace}`
      );
    }
    throw setupError;
  }
}
