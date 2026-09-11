import { join } from "node:path";
import { redactSensitiveText, sanitizeVerificationReport, summarizeToolArguments } from "../evaluation/redaction.js";
import { sha256Text, type TraceEntry } from "../evaluation/schema.js";
import type { RunBundle } from "../evaluation/store.js";
import { assertRegularDirectory, isMissing, readArtifactText } from "./artifact-io.js";
import type { EvidenceItem } from "./schema.js";
import { stripUnsafeControls } from "./candidate.js";

export interface CollectedEvidence { evidence: EvidenceItem[]; trace: TraceEntry[]; warnings: string[] }

function clean(value: string): string {
  return stripUnsafeControls(redactSensitiveText(value)).slice(0, 4_000);
}

function sanitizeStructuredEvidence(value: unknown): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map(sanitizeStructuredEvidence);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeStructuredEvidence(item)]));
  }
  return value;
}

export async function collectEvidence(bundle: RunBundle, dataDirectory: string): Promise<CollectedEvidence> {
  await assertRegularDirectory(dataDirectory);
  await assertRegularDirectory(join(dataDirectory, "runs"));
  await assertRegularDirectory(bundle.directory);
  const evidence: EvidenceItem[] = [];
  const warnings: string[] = [];
  let excerptCharacters = 0;
  let capped = false;
  const add = (ref: string, value: unknown): void => {
    // Redact raw strings before JSON escaping: a credential containing quotes or backslashes
    // would no longer match its environment value after serialization.
    const sanitized = sanitizeStructuredEvidence(value);
    const excerpt = (typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized)).slice(0, 4_000);
    if (evidence.length >= 80 || excerptCharacters + excerpt.length > 32_000) { capped = true; return; }
    excerptCharacters += excerpt.length;
    evidence.push({ ref, excerpt, sha256: sha256Text(excerpt) });
  };
  add("manifest.json#/task", { objective: bundle.manifest.task.content.objective, allowedPaths: bundle.manifest.task.content.allowedPaths, taskSha256: bundle.manifest.task.sha256 });
  add("manifest.json#/verifier", { configured: bundle.manifest.verifier.commands.length > 0, commandCount: bundle.manifest.verifier.commands.length });
  if (bundle.result) {
    add("result.json#/status", { status: bundle.result.status, durationMs: bundle.result.durationMs, toolCallCount: bundle.result.toolCallCount, retryCount: bundle.result.retryCount });
    add("result.json#/usage", bundle.result.usage);
    if (bundle.result.errors.length) add("result.json#/errors", bundle.result.errors);
    if (bundle.result.verification) {
      const verification = sanitizeVerificationReport(bundle.result.verification);
      add("result.json#/verification", { configured: verification.configured, success: verification.success, disallowedChangedFiles: verification.disallowedChangedFiles });
      const priority = { timed_out: 0, failed: 1, passed: 2 };
      const diagnostics = [...verification.commands.entries()].sort((left, right) => priority[left[1].status] - priority[right[1].status]).slice(0, 20);
      if (verification.commands.length > 20) warnings.push("Only 20 verifier command results are included, prioritizing timeouts and failures over passing commands.");
      for (const [index, command] of diagnostics) {
        add(`result.json#/verification/commands/${index}`, { command: command.command, status: command.status, exitCode: command.exitCode, stdout: command.stdout.slice(0, 1_000), stderr: command.stderr.slice(0, 1_000), outputTruncated: command.outputTruncated || command.stdout.length > 1_000 || command.stderr.length > 1_000 });
      }
    }
    if (bundle.result.diffSummary) add("result.json#/diffSummary", bundle.result.diffSummary);
  }
  let source: string;
  try { source = await readArtifactText(join(bundle.directory, "trace.jsonl"), 8 * 1024 * 1024); }
  catch (error) {
    if (!isMissing(error)) throw error;
    warnings.push("Trace is missing; analysis is limited to manifest and result evidence.");
    return { evidence, trace: [], warnings };
  }
  const trace: TraceEntry[] = [];
  const traceEvidence: Array<{ ref: string; entry: TraceEntry }> = [];
  let previousSequence = 0;
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error(`Invalid trace JSON at line ${index + 1}`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid trace entry");
    const item = parsed as Record<string, unknown>;
    if (item.schemaVersion !== 1 || item.runId !== bundle.manifest.runId || typeof item.sequence !== "number" || !Number.isSafeInteger(item.sequence) || item.sequence <= previousSequence || typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at)) || typeof item.type !== "string") throw new Error("Invalid trace identity, version or sequence");
    previousSequence = item.sequence;
    if (!["setup_end", "tool_start", "tool_end", "retry_start", "retry_end", "execution_error", "verification_command_end"].includes(item.type)) continue;
    if (item.data !== undefined && (!item.data || typeof item.data !== "object" || Array.isArray(item.data))) throw new Error("Invalid trace data");
    const data = (item.data ?? {}) as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    // Only bounded observable summaries are retained; no assistant text or reasoning.
    for (const key of ["toolCallId", "toolName", "isError", "success", "attempt", "index", "status", "exitCode", "message", "stdoutSummary", "stderrSummary", "resultSummary", "durationMs"]) {
      const value = data[key];
      if (typeof value === "string") safe[key] = clean(value).slice(0, 1_000);
      else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || value === null) safe[key] = value;
    }
    if (item.type === "tool_start") safe.arguments = sanitizeStructuredEvidence(summarizeToolArguments(data.arguments));
    const entry: TraceEntry = { schemaVersion: 1, runId: bundle.manifest.runId, sequence: item.sequence, at: item.at, type: item.type, data: safe };
    // All relevant event facts are available to the deterministic classifier. Only a bounded subset is sent to the model.
    trace.push(entry);
    traceEvidence.push({ ref: `trace.jsonl#L${index + 1}`, entry });
  }
  // Reserve evidence for failures and their next successful action, including starts.
  const priorityIds = new Set<unknown>();
  let afterFailure = false;
  for (const entry of trace) {
    if (entry.type !== "tool_end") continue;
    if (entry.data?.isError === true) {
      priorityIds.add(entry.data.toolCallId);
      afterFailure = true;
    } else if (afterFailure && entry.data?.isError === false) {
      priorityIds.add(entry.data.toolCallId);
      afterFailure = false;
    }
  }
  const priority = (entry: TraceEntry): number => entry.type !== "tool_start" && entry.type !== "tool_end" ? 0
    : entry.data?.isError === true || (entry.data?.toolCallId !== undefined && priorityIds.has(entry.data.toolCallId)) ? 1 : 2;
  for (const { ref, entry } of traceEvidence.sort((a, b) => priority(a.entry) - priority(b.entry) || a.entry.sequence - b.entry.sequence)) {
    add(ref, { sequence: entry.sequence, type: entry.type, ...entry.data });
  }
  if (!trace.some((entry) => entry.type === "tool_end" && typeof entry.data?.resultSummary === "string")) {
    warnings.push("Tool result summaries are unavailable in this run; missing action details cannot support success strategies.");
  }
  if (capped) warnings.push("Evidence was capped at 80 excerpts and 32000 excerpt characters; omitted events cannot support generated hypotheses.");
  return { evidence, trace, warnings };
}
