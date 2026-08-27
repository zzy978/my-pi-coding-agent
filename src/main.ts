import { existsSync } from "node:fs";
import { APP_NAME, APP_VERSION } from "./config.js";
import type { CliOptions } from "./cli-args.js";
import { loadTaskSpec, createInteractiveTask } from "./task/task-spec.js";
import { discardManagedWorkspace, prepareWorkspace } from "./workspace/git.js";
import { PiRuntime } from "./runtime/pi-runtime.js";
import { CodingAgentTui } from "./tui/app.js";
import { runDoctor } from "./doctor.js";

export function helpText(): string {
  return `${APP_NAME} ${APP_VERSION}

Usage:
  ${APP_NAME} [workspace] [options]

Options:
  -C, --cwd <path>        Target Git repository
  -t, --task <text>       Start with a task objective
      --task-file <path>  Load a YAML or JSON TaskSpec
      --verify <command>  Add a verification command (repeatable)
      --allow <glob>       Add an allowed changed-path glob (repeatable)
  -c, --continue          Continue the latest session for the effective workspace
      --no-session        Do not persist the Pi session
      --in-place          Work in the source checkout instead of a managed worktree
      --unsafe-shell      Enable the unrestricted shell tool (not constrained by allowedPaths)
      --doctor            Check Node, Git, repository, and Pi model configuration
  -h, --help              Show help
  -v, --version           Show version

By default a clean source repository is required and a managed Git worktree is created.
Worktrees reduce source-checkout risk but are not a container security boundary.`;
}

export async function run(options: CliOptions): Promise<number> {
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  if (options.version) {
    console.log(APP_VERSION);
    return 0;
  }
  if (!existsSync(options.workspace)) {
    console.error(`Workspace does not exist: ${options.workspace}`);
    return 1;
  }
  if (options.doctor) {
    const checks = await runDoctor(options.workspace);
    for (const check of checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(12)} ${check.detail}`);
    }
    return checks.every((check) => check.ok) ? 0 : 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`${APP_NAME} requires an interactive terminal. Use --doctor for a non-interactive health check.`);
    return 1;
  }

  const task = options.taskFile
    ? await loadTaskSpec(options.taskFile)
    : createInteractiveTask({
        ...(options.task ? { objective: options.task } : {}),
        allowedPaths: options.allowedPaths,
        verifyCommands: options.verifyCommands
      });
  if (options.taskFile) {
    for (const allowed of options.allowedPaths) {
      if (!task.allowedPaths.includes(allowed)) task.allowedPaths.push(allowed);
    }
    for (const command of options.verifyCommands) task.verify.push({ command, timeoutMs: 120_000 });
  }

  const workspace = await prepareWorkspace(options.workspace, { inPlace: options.inPlace });
  let runtime: PiRuntime;
  try {
    runtime = await PiRuntime.create({
      workspace: workspace.workspace,
      getTask: () => task,
      continueSession: options.continueSession,
      noSession: options.noSession,
      allowShell: options.unsafeShell
    });
  } catch (error) {
    await discardManagedWorkspace(workspace);
    throw error;
  }
  if (!runtime.hasAvailableModel) {
    runtime.dispose();
    await discardManagedWorkspace(workspace);
    console.error("No configured Pi model. Run `pi`, use `/login`, then retry or run with --doctor.");
    return 1;
  }

  try {
    const app = new CodingAgentTui({
      runtime,
      task,
      workspace,
      ...(options.task || options.taskFile ? { initialPrompt: task.objective } : {})
    });
    app.start();
  } catch (error) {
    runtime.dispose();
    await discardManagedWorkspace(workspace);
    throw error;
  }
  return 0;
}
