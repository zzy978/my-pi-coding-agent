import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";

export interface VerificationSpec {
  command: string;
  timeoutMs: number;
}

export interface TaskSpec {
  id: string;
  objective: string;
  allowedPaths: string[];
  verify: VerificationSpec[];
  doneWhen: string[];
}

export class TaskSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSpecError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TaskSpecError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stringList(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TaskSpecError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

function verificationList(value: unknown): VerificationSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TaskSpecError("verify must be an array");
  return value.map((item, index) => {
    if (typeof item === "string") {
      return { command: requireNonEmptyString(item, `verify[${index}]`), timeoutMs: 120_000 };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TaskSpecError(`verify[${index}] must be a command string or object`);
    }
    const record = item as Record<string, unknown>;
    const command = requireNonEmptyString(record.command, `verify[${index}].command`);
    const timeoutMs = record.timeoutMs === undefined ? 120_000 : Number(record.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
      throw new TaskSpecError(`verify[${index}].timeoutMs must be between 1000 and 3600000`);
    }
    return { command, timeoutMs };
  });
}

export function parseTaskSpec(value: unknown): TaskSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskSpecError("Task file must contain an object");
  }
  const record = value as Record<string, unknown>;
  return {
    id: record.id === undefined ? randomUUID() : requireNonEmptyString(record.id, "id"),
    objective: requireNonEmptyString(record.objective, "objective"),
    allowedPaths: stringList(record.allowedPaths ?? record.allowed_paths, "allowedPaths", ["**/*"]),
    verify: verificationList(record.verify),
    doneWhen: stringList(record.doneWhen ?? record.done_when, "doneWhen", [
      "All configured verification commands pass",
      "No changed file is outside allowedPaths"
    ])
  };
}

export async function loadTaskSpec(filePath: string): Promise<TaskSpec> {
  const source = await readFile(filePath, "utf8");
  const extension = extname(filePath).toLowerCase();
  let parsed: unknown;
  try {
    parsed = extension === ".json" ? JSON.parse(source) : YAML.parse(source);
  } catch (error) {
    throw new TaskSpecError(`Cannot parse task file: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseTaskSpec(parsed);
}

export function createInteractiveTask(options: {
  objective?: string;
  allowedPaths?: string[];
  verifyCommands?: string[];
}): TaskSpec {
  return {
    id: randomUUID(),
    objective: options.objective?.trim() || "Interactive coding task",
    allowedPaths: options.allowedPaths?.length ? [...new Set(options.allowedPaths)] : ["**/*"],
    verify: (options.verifyCommands ?? []).map((command) => ({ command, timeoutMs: 120_000 })),
    doneWhen: [
      "All configured verification commands pass",
      "No changed file is outside allowedPaths"
    ]
  };
}

export function formatTaskPrompt(task: TaskSpec, userInstruction?: string): string {
  const instruction = userInstruction?.trim() || task.objective;
  return `Task ID: ${task.id}\nObjective: ${task.objective}\nAllowed changed paths: ${task.allowedPaths.join(", ")}\nVerification commands: ${task.verify.length ? task.verify.map((item) => item.command).join("; ") : "not configured"}\nDone when:\n${task.doneWhen.map((item) => `- ${item}`).join("\n")}\n\nCurrent instruction:\n${instruction}`;
}
