import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDirectory } from "../runtime/data-dir.js";
import type { TaskSpec } from "../task/task-spec.js";
import type { VerificationReport } from "../verifier/verifier.js";
import type { WorkspaceInfo } from "../workspace/git.js";

export interface RunReport {
  version: 1;
  createdAt: string;
  task: TaskSpec;
  workspace: WorkspaceInfo;
  sessionId: string;
  sessionFile?: string;
  model?: { provider: string; id: string };
  verification: VerificationReport;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "run";
}

function codeBlock(value: string): string {
  const longestFence = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}text\n${value || "(no output)"}\n${fence}`;
}

function inlineCode(value: string): string {
  const longestFence = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(1, longestFence + 1));
  return `${fence}${value}${fence}`;
}

function markdown(report: RunReport): string {
  const verification = report.verification;
  const commandSections = verification.commands.map((item) => `### ${item.status.toUpperCase()}

- Command: ${inlineCode(item.command)}
- Exit code: ${item.exitCode ?? "none"}
- Duration: ${item.durationMs} ms
- Output truncated: ${item.outputTruncated ? "yes" : "no"}

#### Standard output

${codeBlock(item.stdout.slice(0, 20_000))}

#### Standard error

${codeBlock(item.stderr.slice(0, 20_000))}`).join("\n\n");
  return `# Coding Agent Run

- Created: ${report.createdAt}
- Task: ${report.task.id}
- Objective: ${report.task.objective}
- Workspace: ${report.workspace.workspace}
- Branch: ${report.workspace.branch}
- Session: ${report.sessionId}
- Result: ${verification.success ? "PASS" : "INCOMPLETE OR FAILED"}

## Changed files

${verification.changedFiles.length ? verification.changedFiles.map((file) => `- ${file}`).join("\n") : "No changed files."}

## Disallowed changes

${verification.disallowedChangedFiles.length ? verification.disallowedChangedFiles.map((file) => `- ${file}`).join("\n") : "None."}

## Verification

${verification.configured ? commandSections || "No command results." : "No verification commands were configured; this run is not considered successful."}
`;
}

export async function writeRunReport(report: RunReport, dataDirectory = getDataDirectory()): Promise<{ jsonPath: string; markdownPath: string }> {
  const reportDir = join(dataDirectory, "reports");
  await mkdir(reportDir, { recursive: true });
  const timestamp = report.createdAt.replace(/[-:TZ.]/g, "");
  const base = `${timestamp}-${safeName(report.task.id)}`;
  const jsonPath = join(reportDir, `${base}.json`);
  const markdownPath = join(reportDir, `${base}.md`);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, markdown(report), "utf8")
  ]);
  return { jsonPath, markdownPath };
}
