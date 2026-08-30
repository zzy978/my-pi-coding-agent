import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseTaskSpec, type TaskSpec, type VerificationSpec } from "../task/task-spec.js";
import type { VerificationCommandResult, VerificationReport } from "../verifier/verifier.js";

export const EVALUATION_SCHEMA_VERSION = 1 as const;

export type RunKind = "run" | "replay";
export type RunStatus = "execution_failed" | "verification_failed" | "verification_passed";
export type ComparisonStatus = "not_comparable" | RunStatus;

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  kind: RunKind;
  replayOf?: string;
  createdAt: string;
  sourceRepository: string;
  baselineCommit: string;
  replayable: boolean;
  task: { content: TaskSpec; sha256: string };
  agent: {
    appVersion: string;
    model: { provider: string; id: string };
    thinkingLevel: string;
    sessionMode: "persistent" | "ephemeral";
  };
  policy: {
    allowShell: boolean;
    allowedPaths: string[];
    tools: string[];
  };
  contextFiles: Array<{ path: string; sha256: string }>;
  verifier: { commands: VerificationSpec[]; sha256: string };
}

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface RunResult {
  schemaVersion: 1;
  runId: string;
  manifestSha256: string;
  startedAt: string;
  completedAt: string;
  status: RunStatus;
  workspace: {
    path: string;
    branch: string;
    baselineCommit: string;
    managedWorktree: boolean;
  };
  verification?: VerificationReport;
  diffSummary: string;
  durationMs: number;
  toolCallCount: number;
  retryCount: number;
  errorCount: number;
  errors: string[];
  usage: RunUsage;
}

export interface TraceEntry {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  at: string;
  type: string;
  data?: Record<string, unknown>;
}

export interface RunComparison {
  schemaVersion: 1;
  createdAt: string;
  originalRunId: string;
  replayRunId: string;
  status: ComparisonStatus;
  baseline: { original: string; replay: string; same: boolean };
  task: { originalSha256: string; replaySha256: string; same: boolean };
  configurationDifferences: string[];
  verification: {
    original: RunStatus;
    replay: RunStatus;
    originalPassed: boolean;
    replayPassed: boolean;
  };
  changedFiles: { original: string[]; replay: string[]; common: string[]; onlyOriginal: string[]; onlyReplay: string[] };
  diffSummary: { original: string; replay: string };
  durationMs: { original: number; replay: number };
  toolCallCount: { original: number; replay: number };
  errors: {
    original: { count: number; retries: number; summaries: string[] };
    replay: { count: number; retries: number; summaries: string[] };
  };
}

export class EvaluationArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationArtifactError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)])
  );
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(canonicalize(value)));
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvaluationArtifactError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EvaluationArtifactError(`${name} must be a non-empty string`);
  }
  return value;
}

function isoTimestamp(value: unknown, name: string): string {
  const timestamp = nonEmptyString(value, name);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new EvaluationArtifactError(`${name} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new EvaluationArtifactError(`${name} must be an array of strings`);
  }
  return value as string[];
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new EvaluationArtifactError(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function verificationStatus(value: unknown, name: string): VerificationCommandResult["status"] {
  if (value !== "passed" && value !== "failed" && value !== "timed_out") {
    throw new EvaluationArtifactError(`${name} is invalid`);
  }
  return value;
}

function assertRunId(value: unknown, name = "runId"): string {
  const runId = nonEmptyString(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(runId)) {
    throw new EvaluationArtifactError(`${name} contains unsupported characters`);
  }
  return runId;
}

function assertSha256(value: unknown, name: string): string {
  const hash = nonEmptyString(value, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new EvaluationArtifactError(`${name} must be a SHA-256 hash`);
  return hash;
}

function assertCommit(value: unknown): string {
  const commit = nonEmptyString(value, "manifest.baselineCommit").toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new EvaluationArtifactError("manifest.baselineCommit must be a full Git commit hash");
  }
  return commit;
}

function parseVerificationCommands(value: unknown): VerificationSpec[] {
  if (!Array.isArray(value)) throw new EvaluationArtifactError("manifest.verifier.commands must be an array");
  return value.map((item, index) => {
    const record = objectValue(item, `manifest.verifier.commands[${index}]`);
    const command = nonEmptyString(record.command, `manifest.verifier.commands[${index}].command`);
    const timeoutMs = integer(record.timeoutMs, `manifest.verifier.commands[${index}].timeoutMs`);
    if (timeoutMs < 1_000 || timeoutMs > 3_600_000) {
      throw new EvaluationArtifactError(`manifest.verifier.commands[${index}].timeoutMs is out of range`);
    }
    return { command, timeoutMs };
  });
}

function parseVerificationReport(value: unknown): VerificationReport {
  const record = objectValue(value, "result.verification");
  if (typeof record.configured !== "boolean" || typeof record.success !== "boolean") {
    throw new EvaluationArtifactError("result.verification configured/success must be boolean");
  }
  if (!Array.isArray(record.commands)) throw new EvaluationArtifactError("result.verification.commands must be an array");
  const commands = record.commands.map((item, index) => {
    const command = objectValue(item, `result.verification.commands[${index}]`);
    const status = verificationStatus(command.status, `result.verification.commands[${index}].status`);
    if (command.exitCode !== null && !Number.isInteger(command.exitCode)) {
      throw new EvaluationArtifactError(`result.verification.commands[${index}].exitCode is invalid`);
    }
    if (typeof command.outputTruncated !== "boolean") {
      throw new EvaluationArtifactError(`result.verification.commands[${index}].outputTruncated must be boolean`);
    }
    return {
      command: nonEmptyString(command.command, `result.verification.commands[${index}].command`),
      status,
      exitCode: command.exitCode as number | null,
      stdout: typeof command.stdout === "string" ? command.stdout : "",
      stderr: typeof command.stderr === "string" ? command.stderr : "",
      outputTruncated: command.outputTruncated,
      durationMs: integer(command.durationMs, `result.verification.commands[${index}].durationMs`)
    };
  });
  if (!record.configured && commands.length > 0) {
    throw new EvaluationArtifactError("result.verification has commands while configured is false");
  }
  if (record.configured && commands.length === 0) {
    throw new EvaluationArtifactError("result.verification is configured but has no command results");
  }
  const disallowedChangedFiles = stringArray(record.disallowedChangedFiles, "result.verification.disallowedChangedFiles");
  if (record.success && (!record.configured || disallowedChangedFiles.length > 0 || commands.some((command) => command.status !== "passed"))) {
    throw new EvaluationArtifactError("result.verification success contradicts its command or path evidence");
  }
  return {
    configured: record.configured,
    success: record.success,
    changedFiles: stringArray(record.changedFiles, "result.verification.changedFiles"),
    disallowedChangedFiles,
    commands
  };
}

export function parseRunManifest(value: unknown): RunManifest {
  const record = objectValue(value, "manifest");
  if (record.schemaVersion !== EVALUATION_SCHEMA_VERSION) {
    throw new EvaluationArtifactError(`Unsupported manifest schemaVersion: ${String(record.schemaVersion)}`);
  }
  const runId = assertRunId(record.runId);
  if (record.kind !== "run" && record.kind !== "replay") {
    throw new EvaluationArtifactError("manifest.kind must be run or replay");
  }
  const sourceRepository = nonEmptyString(record.sourceRepository, "manifest.sourceRepository");
  if (!isAbsolute(sourceRepository)) {
    throw new EvaluationArtifactError("manifest.sourceRepository must be an absolute path");
  }
  const taskRecord = objectValue(record.task, "manifest.task");
  const taskContentRecord = objectValue(taskRecord.content, "manifest.task.content");
  for (const field of ["id", "objective", "allowedPaths", "verify", "doneWhen"]) {
    if (!(field in taskContentRecord)) throw new EvaluationArtifactError(`manifest.task.content.${field} is required`);
  }
  const task = parseTaskSpec(taskRecord.content);
  const taskHash = assertSha256(taskRecord.sha256, "manifest.task.sha256");
  if (sha256Json(task) !== taskHash) throw new EvaluationArtifactError("manifest task hash does not match its content");

  const agent = objectValue(record.agent, "manifest.agent");
  const model = objectValue(agent.model, "manifest.agent.model");
  const thinkingLevel = nonEmptyString(agent.thinkingLevel, "manifest.agent.thinkingLevel");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) {
    throw new EvaluationArtifactError("manifest.agent.thinkingLevel is invalid");
  }
  if (agent.sessionMode !== "persistent" && agent.sessionMode !== "ephemeral") {
    throw new EvaluationArtifactError("manifest.agent.sessionMode is invalid");
  }
  const policy = objectValue(record.policy, "manifest.policy");
  if (typeof policy.allowShell !== "boolean") throw new EvaluationArtifactError("manifest.policy.allowShell must be boolean");
  const verifier = objectValue(record.verifier, "manifest.verifier");
  const commands = parseVerificationCommands(verifier.commands);
  const verifierHash = assertSha256(verifier.sha256, "manifest.verifier.sha256");
  if (sha256Json(commands) !== verifierHash) throw new EvaluationArtifactError("manifest verifier hash does not match its commands");

  if (!Array.isArray(record.contextFiles)) throw new EvaluationArtifactError("manifest.contextFiles must be an array");
  const contextFiles = record.contextFiles.map((item, index) => {
    const context = objectValue(item, `manifest.contextFiles[${index}]`);
    return {
      path: nonEmptyString(context.path, `manifest.contextFiles[${index}].path`),
      sha256: assertSha256(context.sha256, `manifest.contextFiles[${index}].sha256`)
    };
  });
  if (typeof record.replayable !== "boolean") throw new EvaluationArtifactError("manifest.replayable must be boolean");
  const allowedPaths = stringArray(policy.allowedPaths, "manifest.policy.allowedPaths");
  if (JSON.stringify(allowedPaths) !== JSON.stringify(task.allowedPaths)) {
    throw new EvaluationArtifactError("manifest policy allowedPaths do not match TaskSpec");
  }
  if (JSON.stringify(commands) !== JSON.stringify(task.verify)) {
    throw new EvaluationArtifactError("manifest verifier commands do not match TaskSpec");
  }
  if (record.kind === "replay" && record.replayOf === undefined) {
    throw new EvaluationArtifactError("Replay manifest requires replayOf");
  }
  if (record.kind === "run" && record.replayOf !== undefined) {
    throw new EvaluationArtifactError("Original run manifest cannot contain replayOf");
  }
  if (record.replayOf === runId) throw new EvaluationArtifactError("Replay manifest cannot reference itself");
  const tools = stringArray(policy.tools, "manifest.policy.tools");
  if (tools.length === 0) throw new EvaluationArtifactError("manifest.policy.tools must not be empty");

  return {
    schemaVersion: 1,
    runId,
    kind: record.kind,
    ...(record.replayOf === undefined ? {} : { replayOf: assertRunId(record.replayOf, "manifest.replayOf") }),
    createdAt: isoTimestamp(record.createdAt, "manifest.createdAt"),
    sourceRepository,
    baselineCommit: assertCommit(record.baselineCommit),
    replayable: record.replayable,
    task: { content: task, sha256: taskHash },
    agent: {
      appVersion: nonEmptyString(agent.appVersion, "manifest.agent.appVersion"),
      model: {
        provider: nonEmptyString(model.provider, "manifest.agent.model.provider"),
        id: nonEmptyString(model.id, "manifest.agent.model.id")
      },
      thinkingLevel,
      sessionMode: agent.sessionMode
    },
    policy: {
      allowShell: policy.allowShell,
      allowedPaths,
      tools
    },
    contextFiles,
    verifier: { commands, sha256: verifierHash }
  };
}

export function parseRunResult(value: unknown): RunResult {
  const record = objectValue(value, "result");
  if (record.schemaVersion !== EVALUATION_SCHEMA_VERSION) {
    throw new EvaluationArtifactError(`Unsupported result schemaVersion: ${String(record.schemaVersion)}`);
  }
  if (!(["execution_failed", "verification_failed", "verification_passed"] as unknown[]).includes(record.status)) {
    throw new EvaluationArtifactError("result.status is invalid");
  }
  const workspace = objectValue(record.workspace, "result.workspace");
  const usage = objectValue(record.usage, "result.usage");
  const errors = stringArray(record.errors, "result.errors");
  if (typeof workspace.managedWorktree !== "boolean") {
    throw new EvaluationArtifactError("result.workspace.managedWorktree must be boolean");
  }
  if (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) {
    throw new EvaluationArtifactError("result.usage.cost must be a non-negative number");
  }
  const verification = record.verification === undefined ? undefined : parseVerificationReport(record.verification);
  if (record.status === "verification_passed" && verification?.success !== true) {
    throw new EvaluationArtifactError("result status contradicts verification success");
  }
  if (record.status === "verification_failed" && (!verification || verification.success)) {
    throw new EvaluationArtifactError("result status contradicts verification failure");
  }
  if (record.status === "execution_failed" && verification?.success) {
    throw new EvaluationArtifactError("execution_failed result cannot contain passing verification");
  }
  const errorCount = integer(record.errorCount, "result.errorCount");
  if (errorCount !== errors.length) throw new EvaluationArtifactError("result.errorCount does not match errors");
  return {
    schemaVersion: 1,
    runId: assertRunId(record.runId),
    manifestSha256: assertSha256(record.manifestSha256, "result.manifestSha256"),
    startedAt: isoTimestamp(record.startedAt, "result.startedAt"),
    completedAt: isoTimestamp(record.completedAt, "result.completedAt"),
    status: record.status as RunStatus,
    workspace: {
      path: (() => {
        const path = nonEmptyString(workspace.path, "result.workspace.path");
        if (!isAbsolute(path)) throw new EvaluationArtifactError("result.workspace.path must be absolute");
        return path;
      })(),
      branch: nonEmptyString(workspace.branch, "result.workspace.branch"),
      baselineCommit: assertCommit(workspace.baselineCommit),
      managedWorktree: workspace.managedWorktree
    },
    ...(verification ? { verification } : {}),
    diffSummary: typeof record.diffSummary === "string" ? record.diffSummary : "",
    durationMs: integer(record.durationMs, "result.durationMs"),
    toolCallCount: integer(record.toolCallCount, "result.toolCallCount"),
    retryCount: integer(record.retryCount, "result.retryCount"),
    errorCount,
    errors,
    usage: {
      input: integer(usage.input, "result.usage.input"),
      output: integer(usage.output, "result.usage.output"),
      cacheRead: integer(usage.cacheRead, "result.usage.cacheRead"),
      cacheWrite: integer(usage.cacheWrite, "result.usage.cacheWrite"),
      total: integer(usage.total, "result.usage.total"),
      cost: usage.cost
    }
  };
}
