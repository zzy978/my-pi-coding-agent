import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import { APP_VERSION } from "../config.js";
import type { PiRuntime } from "../runtime/pi-runtime.js";
import type { TaskSpec } from "../task/task-spec.js";
import type { VerificationReport } from "../verifier/verifier.js";
import type { WorkspaceInfo } from "../workspace/git.js";
import { compareRuns, comparisonMarkdown } from "./comparison.js";
import { assertRecordableTask, redactSensitiveText, sanitizeVerificationReport, summarizeToolArguments } from "./redaction.js";
import {
  EVALUATION_SCHEMA_VERSION,
  parseRunManifest,
  sha256Json,
  type RunKind,
  type RunManifest,
  type RunResult,
  type RunUsage,
  type TraceEntry
} from "./schema.js";
import {
  createRunDirectory,
  loadRunBundle,
  writeComparisonArtifacts,
  writeJsonAtomic,
  writeRunResult
} from "./store.js";

interface RecorderOptions {
  kind: RunKind;
  replayOf?: string;
  task: TaskSpec;
  workspace: WorkspaceInfo;
  runtime: PiRuntime;
  allowShell: boolean;
  noSession: boolean;
  dataDirectory?: string;
}

export interface FinalizedRun {
  manifest: RunManifest;
  result: RunResult;
  directory: string;
  manifestPath: string;
  tracePath: string;
  resultPath: string;
  comparisonPaths?: { jsonPath: string; markdownPath: string };
}

function cloneTask(task: TaskSpec): TaskSpec {
  return {
    id: task.id,
    objective: task.objective,
    allowedPaths: [...task.allowedPaths],
    verify: task.verify.map((item) => ({ ...item })),
    doneWhen: [...task.doneWhen]
  };
}

function subtractUsage(after: SessionStats, before: SessionStats): RunUsage {
  const delta = (right: number, left: number): number => Math.max(0, right - left);
  return {
    input: delta(after.tokens.input, before.tokens.input),
    output: delta(after.tokens.output, before.tokens.output),
    cacheRead: delta(after.tokens.cacheRead, before.tokens.cacheRead),
    cacheWrite: delta(after.tokens.cacheWrite, before.tokens.cacheWrite),
    total: delta(after.tokens.total, before.tokens.total),
    cost: Math.max(0, after.cost - before.cost)
  };
}

export class RunRecorder {
  readonly manifest: RunManifest;
  readonly directory: string;
  readonly manifestPath: string;
  readonly tracePath: string;

  private sequence = 0;
  private readonly startedAt = new Date();
  private readonly statsBefore: SessionStats;
  private readonly workspace: WorkspaceInfo;
  private readonly dataDirectory: string | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly toolStartedAt = new Map<string, number>();
  private errors: string[] = [];
  private retryCount = 0;
  private reasoningRecorded = false;
  private finalized = false;

  private constructor(
    manifest: RunManifest,
    directory: string,
    runtime: PiRuntime,
    workspace: WorkspaceInfo,
    dataDirectory: string | undefined
  ) {
    this.manifest = manifest;
    this.directory = directory;
    this.manifestPath = join(directory, "manifest.json");
    this.tracePath = join(directory, "trace.jsonl");
    this.statsBefore = runtime.session.getSessionStats();
    this.workspace = workspace;
    this.dataDirectory = dataDirectory;
  }

  static async create(options: RecorderOptions): Promise<RunRecorder> {
    const model = options.runtime.session.model;
    if (!model) throw new Error("Cannot record a controlled run without a configured model");
    assertRecordableTask(options.task);
    const task = cloneTask(options.task);
    const runId = randomUUID();
    const manifest = parseRunManifest({
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      runId,
      kind: options.kind,
      ...(options.replayOf ? { replayOf: options.replayOf } : {}),
      createdAt: new Date().toISOString(),
      sourceRepository: options.workspace.sourceRoot,
      baselineCommit: options.workspace.baselineCommit,
      replayable: options.workspace.managedWorktree,
      task: { content: task, sha256: sha256Json(task) },
      agent: {
        appVersion: APP_VERSION,
        model: { provider: model.provider, id: model.id },
        thinkingLevel: options.runtime.session.thinkingLevel,
        sessionMode: options.noSession ? "ephemeral" : "persistent"
      },
      policy: {
        allowShell: options.allowShell,
        allowedPaths: [...task.allowedPaths],
        tools: [...options.runtime.session.getActiveToolNames()].sort()
      },
      contextFiles: options.runtime.contextFiles.map((item) => ({ ...item })),
      verifier: { commands: task.verify.map((item) => ({ ...item })), sha256: sha256Json(task.verify) }
    });
    const directory = await createRunDirectory(manifest, options.dataDirectory);
    const recorder = new RunRecorder(manifest, directory, options.runtime, options.workspace, options.dataDirectory);
    await writeFile(recorder.tracePath, "", { encoding: "utf8", flag: "wx" });
    recorder.record("run_started", { kind: manifest.kind, taskId: task.id, baselineCommit: manifest.baselineCommit });
    return recorder;
  }

  recordAgentEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
      case "agent_settled":
        this.record(event.type);
        break;
      case "agent_end":
        this.record("agent_end", { willRetry: event.willRetry, messageCount: event.messages.length });
        break;
      case "tool_execution_start":
        this.toolStartedAt.set(event.toolCallId, Date.now());
        this.record("tool_start", { toolCallId: event.toolCallId, toolName: event.toolName, arguments: summarizeToolArguments(event.args) });
        break;
      case "tool_execution_end": {
        const started = this.toolStartedAt.get(event.toolCallId);
        this.toolStartedAt.delete(event.toolCallId);
        if (event.isError) this.addError(`Tool ${event.toolName} failed`);
        this.record("tool_end", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          ...(started === undefined ? {} : { durationMs: Date.now() - started })
        });
        break;
      }
      case "auto_retry_start":
        this.retryCount += 1;
        this.addError(event.errorMessage);
        this.record("retry_start", { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs });
        break;
      case "auto_retry_end":
        if (event.finalError) this.addError(event.finalError);
        this.record("retry_end", { attempt: event.attempt, success: event.success });
        break;
      case "compaction_start":
        this.record("compaction_start", { reason: event.reason });
        break;
      case "compaction_end":
        if (event.errorMessage) this.addError(event.errorMessage);
        this.record("compaction_end", { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry });
        break;
      case "message_start":
      case "message_end":
        this.record(event.type, { role: event.message.role });
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "thinking_delta" && !this.reasoningRecorded) {
          this.reasoningRecorded = true;
          this.record("reasoning_status", { active: true });
        }
        break;
      default:
        break;
    }
  }

  record(type: string, data?: Record<string, unknown>): void {
    const entry: TraceEntry = {
      schemaVersion: 1,
      runId: this.manifest.runId,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      type,
      ...(data ? { data } : {})
    };
    const line = `${JSON.stringify(entry)}\n`;
    this.writeQueue = this.writeQueue.then(() => appendFile(this.tracePath, line, "utf8"));
  }

  addError(error: unknown): void {
    const text = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    if (text && !this.errors.includes(text)) this.errors.push(text);
  }

  async finalize(options: {
    runtime: PiRuntime;
    verification?: VerificationReport;
    diffSummary: string;
    executionError?: unknown;
  }): Promise<FinalizedRun> {
    if (this.finalized) throw new Error(`Run ${this.manifest.runId} has already been finalized`);
    this.finalized = true;
    if (options.executionError) this.addError(options.executionError);
    const verification = options.verification ? sanitizeVerificationReport(options.verification) : undefined;
    const status = options.executionError
      ? "execution_failed"
      : verification?.success
        ? "verification_passed"
        : "verification_failed";
    const completedAt = new Date();
    const statsAfter = options.runtime.session.getSessionStats();
    const result: RunResult = {
      schemaVersion: 1,
      runId: this.manifest.runId,
      manifestSha256: sha256Json(this.manifest),
      startedAt: this.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      status,
      workspace: {
        path: this.workspace.workspace,
        branch: this.workspace.branch,
        baselineCommit: this.manifest.baselineCommit,
        managedWorktree: this.workspace.managedWorktree
      },
      ...(verification ? { verification } : {}),
      diffSummary: redactSensitiveText(options.diffSummary).slice(0, 20_000),
      durationMs: completedAt.getTime() - this.startedAt.getTime(),
      toolCallCount: Math.max(0, statsAfter.toolCalls - this.statsBefore.toolCalls),
      retryCount: this.retryCount,
      errorCount: this.errors.length,
      errors: [...this.errors],
      usage: subtractUsage(statsAfter, this.statsBefore)
    };
    this.record("run_finished", {
      status: result.status,
      durationMs: result.durationMs,
      toolCallCount: result.toolCallCount,
      retryCount: result.retryCount,
      errorCount: result.errorCount,
      usage: result.usage
    });
    await this.writeQueue;
    const resultPath = await writeRunResult(result, this.directory);
    await writeJsonAtomic(join(this.directory, "verification.json"), verification ?? null);

    let comparisonPaths: FinalizedRun["comparisonPaths"];
    if (this.manifest.replayOf) {
      const original = await loadRunBundle(this.manifest.replayOf, this.dataDirectory);
      if (!original.result) throw new Error(`Original run ${this.manifest.replayOf} has no completed result`);
      const comparison = compareRuns(original.manifest, original.result, this.manifest, result);
      comparisonPaths = await writeComparisonArtifacts(comparison, comparisonMarkdown(comparison), this.directory);
    }
    return {
      manifest: this.manifest,
      result,
      directory: this.directory,
      manifestPath: this.manifestPath,
      tracePath: this.tracePath,
      resultPath,
      ...(comparisonPaths ? { comparisonPaths } : {})
    };
  }
}
