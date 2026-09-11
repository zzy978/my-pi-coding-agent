import type { VerificationReport } from "../verifier/verifier.js";
import type { TaskSpec } from "../task/task-spec.js";
import { modelSecrets } from "../model-config.js";

const SECRET_NAME = /(api[_-]?key|token|secret|password|authorization|credential)/i;
const SENSITIVE_COMMAND = /(?:^|[\s"'=:/\\])\.env(?:$|[\s"'./\\])|\b(?:printenv|Get-ChildItem\s+Env:|set)\b/i;
const INLINE_SECRET = /\bsk-[A-Za-z0-9_-]{8,}\b|\b(?:api[_-]?key|token|secret|password|authorization|credential)\b\s*[:=]\s*["']?(?![$%{<])[A-Za-z0-9_./+~-]{8,}/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSensitiveText(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = value;
  for (const secret of modelSecrets()) redacted = redacted.replaceAll(secret, "[REDACTED_MODEL_KEY]");
  for (const [name, secret] of Object.entries(env)) {
    if (!SECRET_NAME.test(name) || !secret || secret.length < 4) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), `[REDACTED:${name}]`);
  }
  redacted = redacted
    .replace(/(?<!\\)(["'])([^"'\\\r\n]*(?:api[_-]?key|token|secret|password|authorization|credential)[^"'\\\r\n]*)\1\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi,
      (_match, quote: string, key: string) => `${quote}${key}${quote}:"[REDACTED]"`)
    .replace(/\b(Bearer|Basic)\s+[^\s"']+/gi, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization|credential)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, "$1=[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/^\s*[A-Za-z_][A-Za-z0-9_]*=.*$/gm, "[REDACTED_ENV_LINE]");
  return redacted;
}

/** For policy diagnostics only; ordinary command bodies remain omitted. */
export function redactCommandPreview(command: string): string {
  if (SENSITIVE_COMMAND.test(command)) return "[REDACTED SENSITIVE COMMAND]";
  const withoutCredentials = command
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, "[REDACTED_AUTH]")
    .replace(/\b(?:https?|ftp):\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[REDACTED]@")
    .replace(/((?:api[_-]?key|token|secret|password|authorization|credential)["']?\s*(?:[:=]\s*|\s+))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi, "$1[REDACTED]");
  let visible = "";
  for (const character of redactSensitiveText(withoutCredentials)) {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f)
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    const rendered = control ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    if (visible.length + rendered.length > 1_200) return `${visible}…`;
    visible += rendered;
  }
  return visible;
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

/** Bounded observable text only: never serialize arbitrary details, images or reasoning. */
export function summarizeToolResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  const blocks: string[] = [];
  let length = 0;
  for (const block of result.content as unknown[]) {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text" || !("text" in block) || typeof block.text !== "string") continue;
    // Redact before truncation so a credential straddling the boundary cannot leak.
    const redacted = redactSensitiveText(block.text);
    const visible = Array.from(redacted).filter((character) => {
      const code = character.codePointAt(0)!;
      return !((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159) ||
        (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069));
    }).join("");
    blocks.push(visible.slice(0, 1_000 - length));
    length += blocks.at(-1)!.length + 1;
    if (length >= 1_000) break;
  }
  return blocks.join("\n").slice(0, 1_000);
}

export function assertRecordableTask(task: TaskSpec): void {
  const serialized = JSON.stringify(task);
  if (modelSecrets().some((secret) => serialized.includes(secret))) throw new Error("TaskSpec contains a configured model credential");
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
  if (commands.some(({ command }) => modelSecrets().some((secret) => command.includes(secret)))) {
    throw new Error(`${label} command contains a configured model credential`);
  }
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
