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
  changeAuditUnavailable?: boolean;
}

export async function runVerification(
  workspace: string,
  task: TaskSpec,
  onCommandStart?: (command: string, index: number, total: number) => void,
  options?: { allowUnavailableGit?: boolean }
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

  let changedFiles: string[] = [];
  let changeAuditUnavailable = false;
  try {
    changedFiles = await listChangedFiles(workspace);
  } catch (error) {
    if (!options?.allowUnavailableGit) throw error;
    changeAuditUnavailable = true;
  }
  const disallowedChangedFiles = changedFiles.filter((file) => !isAllowedChangedPath(file));
  const configured = task.verify.length > 0;
  const commandsPassed = configured && commands.length === task.verify.length && commands.every((item) => item.status === "passed");
  return {
    configured,
    success: commandsPassed && !changeAuditUnavailable && disallowedChangedFiles.length === 0,
    ...(changeAuditUnavailable ? { changeAuditUnavailable: true } : {}),
    changedFiles,
    disallowedChangedFiles,
    commands
  };
}

export function formatVerificationSummary(report: VerificationReport): string {
  const auditSummary = report.changeAuditUnavailable
    ? "Git 变更审计不可用，变更文件与受保护文件状态未知。"
    : `Changed files: ${report.changedFiles.length}`;
  if (!report.configured) {
    return `Verification incomplete: no commands configured.\n${auditSummary}`;
  }
  const lines = [
    report.success ? "Verification passed." : "Verification incomplete/failed.",
    auditSummary,
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
