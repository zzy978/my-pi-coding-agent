import { join } from "node:path";
import type { ControlledPiRuntime } from "../runtime/controlled-pi-runtime.js";
import { writeRunReport } from "../report/report.js";
import { formatTaskPrompt, type TaskSpec } from "../task/task-spec.js";
import { renderCandidatePrompt } from "../experience/candidate.js";
import { runVerification, type VerificationReport } from "../verifier/verifier.js";
import { getDiff, type WorkspaceInfo } from "../workspace/git.js";
import type { SetupPlan } from "../workspace/setup.js";
import { runWorkspaceSetup } from "../workspace/setup.js";
import { RunRecorder, type FinalizedRun } from "./recorder.js";
import { sanitizeVerificationReport } from "./redaction.js";
import { formatRepairPrompt, repairStopReason } from "../verifier/repair.js";
import { writeJsonAtomic } from "./store.js";
import { EXPERIMENT_PROMPT_TIMEOUT_MS, type RunKind, type RunExperimentContext, type ReplayExperienceContext } from "./schema.js";

interface ControlledRunOptions {
  experiment?: RunExperimentContext;
  replayExperience?: ReplayExperienceContext;
  signal?: AbortSignal;
  kind: RunKind;
  replayOf?: string;
  runtime: ControlledPiRuntime;
  task: TaskSpec;
  workspace: WorkspaceInfo;
  allowShell: boolean;
  noSession: boolean;
  setup: SetupPlan;
  dataDirectory?: string;
  onStatus?: (status: string) => void;
}

export interface ControlledRunResult extends FinalizedRun {
  setupFailed: boolean;
}

async function promptControlled(options: ControlledRunOptions, prompt: string, elapsedMs: number): Promise<void> {
  options.signal?.throwIfAborted();
  const taskTimeout = options.runtime.modelConfig?.taskTimeoutMs || undefined;
  const experimentTimeout = options.experiment ? options.experiment.promptTimeoutMs ?? EXPERIMENT_PROMPT_TIMEOUT_MS : undefined;
  const budget = taskTimeout && experimentTimeout ? Math.min(taskTimeout, experimentTimeout) : taskTimeout ?? experimentTimeout;
  const timeoutMs = budget === undefined ? undefined : budget - elapsedMs;
  if (timeoutMs !== undefined && timeoutMs <= 0) throw new Error("Model task phase timed out");
  if (!options.signal && timeoutMs === undefined) {
    await options.runtime.session.prompt(prompt);
    return;
  }
  let cancelled = false;
  let abortPromise: Promise<void> | undefined;
  const abort = (): void => {
    cancelled = true;
    options.runtime.session.abortRetry();
    options.runtime.session.abortCompaction();
    abortPromise ??= options.runtime.session.abort().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
  timer?.unref();
  try {
    await options.runtime.session.prompt(prompt);
    if (cancelled) throw new Error(options.signal?.aborted ? "Experiment aborted" : "Model task phase timed out");
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await abortPromise;
  }
}

export async function executeControlledRun(options: ControlledRunOptions): Promise<ControlledRunResult> {
  // Freeze commands and repair policy for all rounds, including callers holding the original task.
  options = { ...options, task: structuredClone(options.task) };
  const recorder = await RunRecorder.create({
    ...(options.experiment ? { experiment: options.experiment } : {}),
    ...(options.replayExperience ? { replayExperience: options.replayExperience } : {}),
    kind: options.kind,
    ...(options.replayOf ? { replayOf: options.replayOf } : {}),
    task: options.task,
    workspace: options.workspace,
    runtime: options.runtime,
    allowShell: options.allowShell,
    noSession: options.noSession,
    setup: options.setup,
    ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {})
  });
  let modelOutcome: { stopReason?: string } = {};
  const unsubscribe = options.runtime.session.subscribe((event) => {
    recorder.recordAgentEvent(event);
    if (event.type === "message_end" && event.message.role === "assistant") modelOutcome.stopReason = event.message.stopReason;
  });
  let verification: VerificationReport | undefined;
  let executionError: unknown;
  let setupFailed = false;
  try {
    options.signal?.throwIfAborted();
    options.onStatus?.(`Run ${recorder.manifest.runId}: setup`);
    recorder.record("setup_start", { source: options.setup.source, commandCount: options.setup.commands.length });
    try {
      await runWorkspaceSetup(options.workspace, { mode: "resolved", plan: options.setup }, {
        onCommandStart: (command, index, total) => {
          options.onStatus?.(`Run ${recorder.manifest.runId}: setup ${index + 1}/${total}: ${command}`);
          recorder.record("setup_command_start", { index, total });
        }
      });
      recorder.record("setup_end", { success: true });
    } catch (error) {
      setupFailed = true;
      recorder.record("setup_end", { success: false });
      throw error;
    }
    options.onStatus?.(`Run ${recorder.manifest.runId}: agent`);
    const basePrompt = formatTaskPrompt(options.task, options.task.objective);
    const candidate = recorder.manifest.experiment?.candidate ?? recorder.manifest.replayExperience?.candidate;
    let prompt = candidate ? renderCandidatePrompt(basePrompt, candidate) : basePrompt;
    let agentElapsedMs = 0;
    const limit = options.task.maxRepairAttempts ?? 0;
    for (let round = 0; ; round += 1) {
      modelOutcome = {};
      const promptStartedAt = Date.now();
      try {
        await promptControlled(options, prompt, agentElapsedMs);
      } finally {
        agentElapsedMs += Date.now() - promptStartedAt;
      }
      if (modelOutcome.stopReason && modelOutcome.stopReason !== "stop") throw new Error(`Agent did not finish normally: ${modelOutcome.stopReason}`);
      recorder.record("verification_start", { round, commandCount: options.task.verify.length });
      options.onStatus?.(`Run ${recorder.manifest.runId}: verification`);
      options.signal?.throwIfAborted();
      verification = await runVerification(options.workspace.workspace, options.task, (command, index, total) => {
        recorder.record("verification_command_start", { round, index, total, commandLength: command.length });
      });
      const safeVerification = sanitizeVerificationReport(verification);
      await writeJsonAtomic(join(recorder.directory, `verification-${round}.json`), safeVerification);
      for (const [index, command] of safeVerification.commands.entries()) {
        recorder.record("verification_command_end", {
          index,
          round,
          command: command.command,
          status: command.status,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
          stdoutSummary: command.stdout.slice(0, 1_000),
          stderrSummary: command.stderr.slice(0, 1_000),
          outputTruncated: command.outputTruncated || command.stdout.length > 1_000 || command.stderr.length > 1_000
        });
      }
      recorder.record("file_changes", {
        round,
        changedFiles: safeVerification.changedFiles,
        disallowedChangedFiles: safeVerification.disallowedChangedFiles
      });
      recorder.record("verification_end", {
        round,
        success: verification.success,
        changedFileCount: verification.changedFiles.length,
        disallowedChangedFileCount: verification.disallowedChangedFiles.length
      });
      if (options.signal?.aborted) {
        recorder.record("repair_stopped", { reason: "aborted", attempts: round, limit });
        break;
      }
      const reason = repairStopReason(verification, round, limit);
      if (reason) {
        recorder.record("repair_stopped", { reason, attempts: round, limit });
        break;
      }
      prompt = formatRepairPrompt(options.task, verification, round + 1, limit);
      recorder.record("repair_start", { attempt: round + 1, limit });
      options.onStatus?.(`Run ${recorder.manifest.runId}: 自动修复 ${round + 1}/${limit}`);
    }
  } catch (error) {
    executionError = error;
    recorder.record("execution_error", { message: "Controlled run failed; see sanitized result error summary" });
  } finally {
    unsubscribe();
  }

  let diffSummary = "Diff unavailable.";
  try {
    diffSummary = await getDiff(options.workspace.workspace);
  } catch (error) {
    recorder.addError(error);
  }
  const finalized = await recorder.finalize({
    runtime: options.runtime,
    ...(verification ? { verification } : {}),
    diffSummary,
    ...(executionError ? { executionError } : {})
  });
  await writeRunReport({
    version: 1,
    createdAt: finalized.result.completedAt,
    task: finalized.manifest.task.content,
    workspace: options.workspace,
    sessionId: options.runtime.session.sessionId,
    ...(options.runtime.session.sessionFile ? { sessionFile: options.runtime.session.sessionFile } : {}),
    model: finalized.manifest.agent.model,
    verification: finalized.result.verification ?? {
      configured: options.task.verify.length > 0,
      success: false,
      changedFiles: [],
      disallowedChangedFiles: [],
      commands: []
    }
  }, options.dataDirectory, { outputDirectory: finalized.directory, baseName: "report" });
  return { ...finalized, setupFailed };
}
