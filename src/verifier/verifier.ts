import type { TaskSpec } from "../task/task-spec.js";
import { runShellCommand } from "../runtime/process.js";
import { isAllowedChangedPath } from "../policy/path-policy.js";
import { listChangedFiles } from "../workspace/git.js";

export interface VerificationCommandResult {
  command: string;
  status: "passed" | "failed" | "timed_out";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  durationMs: number;
}

export interface VerificationReport {
  configured: boolean;
  success: boolean;
  changedFiles: string[];
  disallowedChangedFiles: string[];
  commands: VerificationCommandResult[];
}

export async function runVerification(
  workspace: string,
  task: TaskSpec,
  onCommandStart?: (command: string, index: number, total: number) => void
): Promise<VerificationReport> {
  const commands: VerificationCommandResult[] = [];

  for (let index = 0; index < task.verify.length; index += 1) {
    const verification = task.verify[index];
    if (!verification) continue;
    onCommandStart?.(verification.command, index, task.verify.length);
    try {
      const result = await runShellCommand(verification.command, {
        cwd: workspace,
        timeoutMs: verification.timeoutMs,
        maxOutputBytes: 128 * 1024
      });
      commands.push({
        command: verification.command,
        status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        outputTruncated: result.stdoutTruncated || result.stderrTruncated,
        durationMs: result.durationMs
      });
    } catch (error) {
      commands.push({
        command: verification.command,
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        outputTruncated: false,
        durationMs: 0
      });
    }
  }

  const changedFiles = await listChangedFiles(workspace);
  const disallowedChangedFiles = changedFiles.filter((file) => !isAllowedChangedPath(file, task.allowedPaths));
  const configured = task.verify.length > 0;
  const commandsPassed = configured && commands.length === task.verify.length && commands.every((item) => item.status === "passed");
  return {
    configured,
    success: commandsPassed && disallowedChangedFiles.length === 0,
    changedFiles,
    disallowedChangedFiles,
    commands
  };
}

export function formatVerificationSummary(report: VerificationReport): string {
  if (!report.configured) {
    return `Verification incomplete: no commands configured.\nChanged files: ${report.changedFiles.length}`;
  }
  const lines = [
    report.success ? "Verification passed." : "Verification failed.",
    `Changed files: ${report.changedFiles.length}`,
    `Commands: ${report.commands.filter((item) => item.status === "passed").length}/${report.commands.length} passed`
  ];
  if (report.disallowedChangedFiles.length) {
    lines.push(`Disallowed changes: ${report.disallowedChangedFiles.join(", ")}`);
  }
  for (const command of report.commands) {
    lines.push(`- [${command.status}] ${command.command} (${command.durationMs}ms)`);
  }
  return lines.join("\n");
}
