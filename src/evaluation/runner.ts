import type { PiRuntime } from "../runtime/pi-runtime.js";
import { writeRunReport } from "../report/report.js";
import { formatTaskPrompt, type TaskSpec } from "../task/task-spec.js";
import { runVerification, type VerificationReport } from "../verifier/verifier.js";
import { getDiff, type WorkspaceInfo } from "../workspace/git.js";
import { RunRecorder, type FinalizedRun } from "./recorder.js";
import { sanitizeVerificationReport } from "./redaction.js";
import type { RunKind } from "./schema.js";

interface ControlledRunOptions {
  kind: RunKind;
  replayOf?: string;
  runtime: PiRuntime;
  task: TaskSpec;
  workspace: WorkspaceInfo;
  allowShell: boolean;
  noSession: boolean;
  dataDirectory?: string;
  onStatus?: (status: string) => void;
}

export async function executeControlledRun(options: ControlledRunOptions): Promise<FinalizedRun> {
  const recorder = await RunRecorder.create({
    kind: options.kind,
    ...(options.replayOf ? { replayOf: options.replayOf } : {}),
    task: options.task,
    workspace: options.workspace,
    runtime: options.runtime,
    allowShell: options.allowShell,
    noSession: options.noSession,
    ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {})
  });
  const unsubscribe = options.runtime.subscribe((event) => recorder.recordAgentEvent(event));
  let verification: VerificationReport | undefined;
  let executionError: unknown;
  try {
    options.onStatus?.(`Run ${recorder.manifest.runId}: agent`);
    await options.runtime.prompt(formatTaskPrompt(options.task, options.task.objective));
    recorder.record("verification_start", { commandCount: options.task.verify.length });
    options.onStatus?.(`Run ${recorder.manifest.runId}: verification`);
    verification = await runVerification(options.workspace.workspace, options.task, (command, index, total) => {
      recorder.record("verification_command_start", { index, total, commandLength: command.length });
    });
    const safeVerification = sanitizeVerificationReport(verification);
    for (const [index, command] of safeVerification.commands.entries()) {
      recorder.record("verification_command_end", {
        index,
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
      changedFiles: safeVerification.changedFiles,
      disallowedChangedFiles: safeVerification.disallowedChangedFiles
    });
    recorder.record("verification_end", {
      success: verification.success,
      changedFileCount: verification.changedFiles.length,
      disallowedChangedFileCount: verification.disallowedChangedFiles.length
    });
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
  return finalized;
}
