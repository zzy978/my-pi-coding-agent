import type { VerificationReport } from "../verifier/verifier.js";
import type { TaskSpec } from "../task/task-spec.js";

const SECRET_NAME = /(api[_-]?key|token|secret|password|authorization|credential)/i;
const SENSITIVE_COMMAND = /(?:^|[\s"'=:/\\])\.env(?:$|[\s"'./\\])|\b(?:printenv|Get-ChildItem\s+Env:|set)\b/i;
const INLINE_SECRET = /\bsk-[A-Za-z0-9_-]{8,}\b|\b(?:api[_-]?key|token|secret|password|authorization|credential)\b\s*[:=]\s*["']?(?![$%{<])[A-Za-z0-9_./+~-]{8,}/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSensitiveText(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = value;
  for (const [name, secret] of Object.entries(env)) {
    if (!SECRET_NAME.test(name) || !secret || secret.length < 4) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), `[REDACTED:${name}]`);
  }
  redacted = redacted
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/^\s*[A-Za-z_][A-Za-z0-9_]*=.*$/gm, "[REDACTED_ENV_LINE]");
  return redacted;
}

export function summarizeToolArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (SECRET_NAME.test(key)) {
      summary[key] = "[REDACTED]";
    } else if (/^(path|file|filePath|directory)$/i.test(key) && typeof value === "string") {
      summary[key] = redactSensitiveText(value).slice(0, 500);
    } else if (/^(command|content|text|oldText|newText|patch)$/i.test(key)) {
      summary[key] = `[OMITTED ${typeof value === "string" ? value.length : 0} chars]`;
    } else if (typeof value === "boolean" || typeof value === "number") {
      summary[key] = value;
    } else if (typeof value === "string") {
      summary[key] = `[STRING ${value.length} chars]`;
    } else {
      summary[key] = `[${Array.isArray(value) ? "ARRAY" : "OBJECT"}]`;
    }
  }
  return summary;
}

export function assertRecordableTask(task: TaskSpec): void {
  const serialized = JSON.stringify(task);
  for (const [name, secret] of Object.entries(process.env)) {
    if (SECRET_NAME.test(name) && secret && secret.length >= 8 && serialized.includes(secret)) {
      throw new Error(`TaskSpec contains the value of sensitive environment variable ${name}; use a variable reference instead`);
    }
  }
  if (/\bsk-[A-Za-z0-9_-]{8,}\b/.test(serialized)) {
    throw new Error("TaskSpec appears to contain an API key; use an environment-variable reference instead");
  }
  const unsafeCommand = task.verify.find((item) => INLINE_SECRET.test(item.command));
  if (unsafeCommand) {
    throw new Error("Verifier command appears to contain an inline credential; use an environment-variable reference instead");
  }
}

export function assertRecordableCommands(commands: Array<{ command: string }>, label: string): void {
  const unsafeCommand = commands.find((item) => INLINE_SECRET.test(item.command));
  if (unsafeCommand) {
    throw new Error(`${label} command appears to contain an inline credential; use an environment-variable reference instead`);
  }
}

export function sanitizeVerificationReport(report: VerificationReport): VerificationReport {
  return {
    ...report,
    changedFiles: report.changedFiles.map((file) => redactSensitiveText(file)),
    disallowedChangedFiles: report.disallowedChangedFiles.map((file) => redactSensitiveText(file)),
    commands: report.commands.map((item) => {
      const sensitive = SENSITIVE_COMMAND.test(item.command);
      return {
        ...item,
        command: sensitive ? "[REDACTED SENSITIVE VERIFIER COMMAND]" : redactSensitiveText(item.command),
        stdout: sensitive ? "[REDACTED SENSITIVE VERIFIER OUTPUT]" : redactSensitiveText(item.stdout).slice(0, 20_000),
        stderr: sensitive ? "[REDACTED SENSITIVE VERIFIER OUTPUT]" : redactSensitiveText(item.stderr).slice(0, 20_000),
        outputTruncated: item.outputTruncated || item.stdout.length > 20_000 || item.stderr.length > 20_000
      };
    })
  };
}
