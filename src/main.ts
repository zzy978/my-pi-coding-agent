import { existsSync } from "node:fs";
import { APP_NAME, APP_VERSION } from "./config.js";
import type { CliOptions } from "./cli-args.js";
import { loadTaskSpec, createInteractiveTask } from "./task/task-spec.js";
import { discardManagedWorkspace, prepareWorkspace } from "./workspace/git.js";
import { prepareReadyCurrentWorkspace, resolveSetupPlan, setupPreferenceFromCli } from "./workspace/setup.js";
import { PiRuntime } from "./runtime/pi-runtime.js";
import { runPiInteractive } from "./runtime/pi-interactive.js";
import { runDoctor } from "./doctor.js";
import { executeControlledRun } from "./evaluation/runner.js";
import { listRunBundles, loadRunBundle } from "./evaluation/store.js";
import { createReplayPlan } from "./evaluation/replay.js";
import { assertRecordableCommands } from "./evaluation/redaction.js";

export function helpText(): string {
  return `${APP_NAME} ${APP_VERSION}

Usage:
  ${APP_NAME} [workspace] [options]

Options:
  -C, --cwd <path>        Target Git repository
  -t, --task <text>       Start with a task objective
      --task-file <path>  Load a YAML or JSON TaskSpec
      --verify <command>  Add a verification command (repeatable)
      --setup <command>   Run a setup command before the TUI starts (repeatable)
      --no-setup          Disable setup commands
      --allow <glob>       Add an allowed changed-path glob (repeatable)
  -c, --continue          Continue the latest session for the source workspace
      --no-session        Do not persist the Pi session
      --no-shell          Disable the Shell tool (enabled by default)
      --record            Run one headless, reproducible prompt and save evaluation artifacts
      --list-runs         List recorded controlled runs
      --show-run <runId>  Show a recorded manifest and result
      --replay <runId>    Replay a run from its recorded baseline in a fresh worktree
      --json              Use JSON output with --list-runs or --show-run
      --doctor            Check Node, Git, repository, and Pi model configuration
  -h, --help              Show help
  -v, --version           Show version

Interactive tasks run directly in the repository's current checkout and preserve existing Git changes.
Use --record or --replay only when you explicitly need a fresh, reproducible worktree.
Git and path policies are guardrails, not a sandbox or automatic rollback mechanism.`;
}

async function taskFromOptions(options: CliOptions) {
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
  return task;
}

async function handleRunManagement(options: CliOptions): Promise<number | undefined> {
  if (options.listRuns) {
    const runs = await listRunBundles();
    const summaries = runs.map((run) => ({
      runId: run.manifest.runId,
      kind: run.manifest.kind,
      createdAt: run.manifest.createdAt,
      taskId: run.manifest.task.content.id,
      status: run.result?.status ?? "incomplete"
    }));
    if (options.json) console.log(JSON.stringify(summaries, null, 2));
    else if (!summaries.length) console.log("No controlled runs recorded.");
    else for (const run of summaries) console.log(`${run.runId}  ${run.status.padEnd(20)} ${run.kind.padEnd(6)} ${run.taskId}`);
    return 0;
  }
  if (options.showRunId) {
    const bundle = await loadRunBundle(options.showRunId);
    if (options.json) console.log(JSON.stringify({ manifest: bundle.manifest, result: bundle.result ?? null }, null, 2));
    else {
      console.log([
        `Run: ${bundle.manifest.runId}`,
        `Kind: ${bundle.manifest.kind}`,
        `Task: ${bundle.manifest.task.content.id}`,
        `Baseline: ${bundle.manifest.baselineCommit}`,
        `Model: ${bundle.manifest.agent.model.provider}/${bundle.manifest.agent.model.id}`,
        `Status: ${bundle.result?.status ?? "incomplete"}`,
        `Directory: ${bundle.directory}`
      ].join("\n"));
    }
    return 0;
  }
  return undefined;
}

async function runControlled(options: CliOptions): Promise<number> {
  const original = options.replayRunId ? await loadRunBundle(options.replayRunId) : undefined;
  if (original && !original.result) throw new Error(`Run ${original.manifest.runId} has no completed result`);
  const replayPlan = original
    ? createReplayPlan(original.manifest, options.shellExplicit ? options.shellEnabled : undefined)
    : undefined;
  const sourceRepository = replayPlan?.sourceRepository ?? options.workspace;
  if (!existsSync(sourceRepository)) throw new Error(`Workspace does not exist: ${sourceRepository}`);
  const task = replayPlan?.task ?? await taskFromOptions(options);
  const setupPreference = replayPlan?.setupPreference ?? setupPreferenceFromCli(options.setupCommands, options.noSetup);
  const recordedSetupCommands = setupPreference.mode === "explicit"
    ? setupPreference.commands
    : setupPreference.mode === "resolved"
      ? setupPreference.plan.commands
      : [];
  assertRecordableCommands(recordedSetupCommands, "Setup");
  const workspace = await prepareWorkspace(sourceRepository, {
    inPlace: false,
    ...(replayPlan ? { baselineCommit: replayPlan.baselineCommit, branchPrefix: "replay" as const } : {})
  });
  const setup = await resolveSetupPlan(workspace, setupPreference).catch(async (setupError: unknown) => {
    try {
      await discardManagedWorkspace(workspace);
    } catch (cleanupError) {
      throw new AggregateError([setupError, cleanupError], `Setup resolution and cleanup failed for ${workspace.workspace}`);
    }
    throw setupError;
  });
  const noSession = replayPlan?.noSession ?? options.noSession;
  let runtime: PiRuntime;
  try {
    runtime = await PiRuntime.create({
      workspace: workspace.workspace,
      getTask: () => task,
      continueSession: false,
      noSession,
      allowShell: replayPlan?.allowShell ?? options.shellEnabled,
      ...(replayPlan ? {
        requestedModel: replayPlan.requestedModel,
        thinkingLevel: replayPlan.thinkingLevel,
        tools: replayPlan.tools
      } : {})
    });
  } catch (error) {
    await discardManagedWorkspace(workspace);
    throw error;
  }
  if (!runtime.hasAvailableModel) {
    runtime.dispose();
    await discardManagedWorkspace(workspace);
    throw new Error("No configured Pi model. Run `pi`, use `/login`, then retry or run with --doctor.");
  }
  let runtimeDisposed = false;
  try {
    const finalized = await executeControlledRun({
      kind: original ? "replay" : "run",
      ...(original ? { replayOf: original.manifest.runId } : {}),
      runtime,
      task,
      workspace,
      allowShell: replayPlan?.allowShell ?? options.shellEnabled,
      noSession,
      setup,
      onStatus: (status) => console.error(status)
    });
    if (finalized.setupFailed) {
      runtime.dispose();
      runtimeDisposed = true;
      try {
        await discardManagedWorkspace(workspace);
      } catch (error) {
        console.error(`Setup failed and the managed worktree could not be cleaned up: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log([
      `Run ID: ${finalized.manifest.runId}`,
      `Status: ${finalized.result.status}`,
      `Artifacts: ${finalized.directory}`,
      ...(finalized.comparisonPaths ? [`Comparison: ${finalized.comparisonPaths.markdownPath}`] : [])
    ].join("\n"));
    return finalized.result.status === "verification_passed" ? 0 : 1;
  } finally {
    if (!runtimeDisposed) runtime.dispose();
  }
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
  const managementResult = await handleRunManagement(options);
  if (managementResult !== undefined) return managementResult;
  if (options.record || options.replayRunId) return runControlled(options);
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

  const task = await taskFromOptions(options);
  const initialPrompt = options.task || options.taskFile ? task.objective : undefined;

  const ready = await prepareReadyCurrentWorkspace(
    options.workspace,
    setupPreferenceFromCli(options.setupCommands, options.noSetup),
    (command, index, total) => console.error(`Setup ${index + 1}/${total}: ${command}`)
  );
  const { workspace } = ready;
  try {
    await runPiInteractive({
      task,
      workspace,
      allowShell: options.shellEnabled,
      continueSession: options.continueSession,
      noSession: options.noSession,
      ...(initialPrompt ? { initialPrompt } : {})
    });
  } catch (error) {
    await discardManagedWorkspace(workspace);
    throw error;
  }
  return 0;
}
