import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Json, sha256Text, type RunUsage } from "../evaluation/schema.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { assertNoSecrets, stripUnsafeControls } from "../experience/candidate.js";
import { assertRegularDirectory } from "../experience/artifact-io.js";
import { parseSynthesisUsage } from "../experience/schema.js";
import { parseSearchCard, rankGuidance, parseApplicability, selectGuidance, type SearchCard, type ApplicabilityDecision } from "../experience/retrieval.js";
import { evaluateRetrieval, type PairLabel, type EvaluationTask } from "../experience/retrieval-evaluation.js";
import type { SynthesisResponse } from "../experience/synthesizer.js";
import type { LibraryEntry } from "./swe-holdout.js";
import type { SweTask } from "./swe-mini.js";
import { INDEX_PROMPT, SELECTION_PROMPT, AUDIT_PROMPT } from "./swe-retrieval-prompts.js";
import { checkOutputPath, exists, loadRetrievalInputs, object, readJson, withOutputLock, writeCheckedJson, type RetrievalInputs } from "./swe-retrieval-io.js";

export interface ModelStamp { provider: string; id: string; baseUrlSha256: string; timeoutMs: number; maxOutputTokens: number; reasoning?: "low" | "high" }
export interface CompletionRequest { stage: "index" | "select" | "audit"; systemPrompt: string; material: unknown }
export type RetrievalCompletion = (request: CompletionRequest) => Promise<SynthesisResponse>;
interface CallRecord<T> {
  stage: CompletionRequest["stage"]; id: string; requestSha256: string; status: "pending" | "completed" | "failed";
  requested: boolean; responseReceived: boolean; startedAt: string; durationMs: number; usage: RunUsage | null; value: T | null; error: string | null;
  responseText: string | null;
}
interface Protocol {
  schemaVersion: 2; sourceHashes: Record<string, string>; inputSha256: string; implementationSha256: string;
  model: ModelStamp; promptsSha256: string; topK: 8; maxSelected: 2; maxCharacters: 9000; maxConcurrent: 2;
  runtime: { node: string; icu: string }; dependencyLockSha256: string;
  evaluation: "independent-model-request-not-human-ground-truth";
}
export interface WorkflowOptions { sourceRoot: string; outputRoot: string; model: ModelStamp; complete: RetrievalCompletion; onProgress?: (message: string) => void }
const prompts = { index: INDEX_PROMPT, select: SELECTION_PROMPT, audit: AUDIT_PROMPT };
const runtime = { node: process.versions.node, icu: process.versions.icu ?? "unknown" };
async function dependencyLockHash(): Promise<string> { return sha256Text(await readFile(fileURLToPath(new URL("../../package-lock.json", import.meta.url)), "utf8")); }
async function mapBounded<T, R>(items: T[], action: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length); let next = 0, stopped = false;
  const workers = Array.from({ length: Math.min(2, items.length) }, async () => {
    while (!stopped && next < items.length) {
      const index = next++;
      try { result[index] = await action(items[index]!); }
      catch (error) { stopped = true; throw error; }
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((item) => item.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return result;
}
function safeError(error: unknown): string { return stripUnsafeControls(redactSensitiveText(error instanceof Error ? error.message : String(error))).slice(0, 1500); }
function safeErrorText(value: string): string { return stripUnsafeControls(redactSensitiveText(value)).slice(0, 100_000); }
function publicEntry(entry: LibraryEntry) {
  return { candidateId: entry.candidate.id, contentSha256: entry.candidate.contentSha256, title: entry.title,
    applicability: entry.applicability, contraindications: entry.contraindications, content: entry.candidate.content };
}
function publicProblem(task: SweTask) { return { repo: task.repo, problem_statement: task.problem_statement }; }
function inputHash(inputs: RetrievalInputs): string { return sha256Json({ entries: inputs.entries, tasks: inputs.tasks, legacy: inputs.legacy }); }
async function implementationHash(): Promise<string> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const files = ["./swe-retrieval", "./swe-retrieval-cli", "./swe-retrieval-io", "./swe-retrieval-prompts", "./swe-holdout", "./swe-mini", "../experience/retrieval", "../experience/retrieval-prompts", "../experience/retrieval-text", "../experience/retrieval-evaluation", "../experience/candidate", "../experience/synthesizer"];
  return sha256Json(await Promise.all(files.map(async (file) => [file, sha256Text(await readFile(fileURLToPath(new URL(`${file}.${extension}`, import.meta.url)), "utf8"))])));
}
async function ensureSame(path: string, value: unknown): Promise<void> {
  if (await exists(path)) { if (sha256Json(await readJson(path)) !== sha256Json(value)) throw new Error("Retrieval protocol/input drift; use a new output directory"); }
  else await writeCheckedJson(path, value);
}
async function saveCall<T>(path: string, record: CallRecord<T>): Promise<void> {
  await writeCheckedJson(path, { record, sha256: sha256Json(record) });
}
async function readCall<T>(path: string, request: CompletionRequest, id: string, validate: (value: unknown) => T): Promise<CallRecord<T> | null> {
  if (!await exists(path)) return null;
  const envelope = object(await readJson(path)), raw = object(envelope.record);
  if (envelope.sha256 !== sha256Json(raw) || raw.requestSha256 !== sha256Json(request) || raw.id !== id || raw.stage !== request.stage) throw new Error("Call checkpoint binding drift");
  if (!["pending", "completed", "failed"].includes(String(raw.status)) || typeof raw.requested !== "boolean" || typeof raw.responseReceived !== "boolean" || typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt)) || typeof raw.durationMs !== "number" || !Number.isFinite(raw.durationMs) || raw.durationMs < 0 || (raw.error !== null && typeof raw.error !== "string")) throw new Error("Invalid call checkpoint");
  if (typeof raw.error === "string") assertNoSecrets(raw.error);
  if (raw.responseText !== null && (typeof raw.responseText !== "string" || raw.responseText.length > 100_000 || safeErrorText(raw.responseText) !== raw.responseText)) throw new Error("Invalid stored response text");
  const usage = raw.usage === null ? null : parseSynthesisUsage(raw.usage);
  const status = raw.status as CallRecord<T>["status"];
  if ((status === "completed" && (raw.value === null || raw.error !== null)) || (status !== "completed" && raw.value !== null)) throw new Error("Call checkpoint status contradiction");
  return { stage: request.stage, id, requestSha256: sha256Json(request), status, requested: raw.requested, responseReceived: raw.responseReceived, startedAt: raw.startedAt,
    durationMs: raw.durationMs, usage, value: status === "completed" ? validate(raw.value) : null, error: raw.error, responseText: raw.responseText };
}
async function stage<T>(options: WorkflowOptions, kind: CompletionRequest["stage"], id: string, material: unknown, validate: (value: unknown) => T, empty?: T): Promise<CallRecord<T>> {
  const request: CompletionRequest = { stage: kind, systemPrompt: prompts[kind], material }, path = join(options.outputRoot, "calls", `${kind}-${id}.json`);
  const previous = await readCall(path, request, id, validate);
  if (previous) {
    if (previous.status === "pending") {
      previous.status = "failed"; previous.error = "上次请求中断，调用结果和用量未知；为避免重复计费未自动重试。";
      previous.responseReceived = false;
      await saveCall(path, previous);
    }
    return previous;
  }
  const record: CallRecord<T> = { stage: kind, id, requestSha256: sha256Json(request), status: "pending", requested: empty === undefined,
    responseReceived: false, responseText: null, startedAt: new Date().toISOString(), durationMs: 0, usage: null, value: null, error: null };
  await saveCall(path, record);
  const started = Date.now();
  try {
    if (empty !== undefined) record.value = validate(empty);
    else {
      if (JSON.stringify(request.material).length > 64_000) { record.requested = false; throw new Error("Retrieval material exceeds the 64000 character preflight limit"); }
      const response = await options.complete(request);
      record.responseReceived = true;
      record.responseText = safeErrorText(response.text);
      if (response.usage !== undefined) record.usage = parseSynthesisUsage(response.usage);
      if (response.error) throw new Error(response.error);
      if (response.text.length > 100_000) throw new Error("Model response exceeds limit");
      record.value = validate(JSON.parse(response.text) as unknown);
    }
    record.status = "completed";
  } catch (error) { record.status = "failed"; record.error = safeError(error); record.value = null; }
  record.durationMs = Date.now() - started; await saveCall(path, record);
  options.onProgress?.(`${kind} ${id}: ${record.status}${record.error ? ` (${record.error})` : ""}`);
  return record;
}
function decisionParser(task: SweTask, entries: LibraryEntry[]) {
  return (value: unknown) => parseApplicability(JSON.stringify(Array.isArray(value) ? { decisions: value } : value), task, entries);
}
function effectiveVerdict(decision: ApplicabilityDecision): PairLabel["verdict"] {
  if (decision.verdict !== "direct") return decision.verdict;
  if (decision.contraindication === "present") return "inapplicable";
  return decision.contraindication === "absent" && decision.stage === "initial" ? "direct" : "unknown";
}
function makeLabels(taskId: string, decisions: ApplicabilityDecision[], origin: PairLabel["origin"]): PairLabel[] {
  return decisions.map((decision) => ({ taskId, candidateId: decision.candidateId, verdict: effectiveVerdict(decision), reason: decision.reason,
    taskQuotes: decision.taskQuotes, experienceQuotes: decision.experienceQuotes, origin }));
}

async function validateProtocol(source: string, output: string): Promise<{ inputs: RetrievalInputs; protocol: Protocol }> {
  await checkOutputPath(source, output); await assertRegularDirectory(output);
  const inputs = await loadRetrievalInputs(source), protocol = object(await readJson(join(output, "protocol.json"))) as unknown as Protocol;
  if (protocol.schemaVersion !== 2 || protocol.inputSha256 !== inputHash(inputs) || sha256Json(protocol.sourceHashes) !== sha256Json(inputs.sourceHashes) ||
      protocol.promptsSha256 !== sha256Json(prompts) || protocol.implementationSha256 !== await implementationHash() || protocol.topK !== 8 || protocol.maxSelected !== 2 || protocol.maxCharacters !== 9000 || protocol.maxConcurrent !== 2 ||
      sha256Json(protocol.runtime) !== sha256Json(runtime) || protocol.dependencyLockSha256 !== await dependencyLockHash()) throw new Error("Retrieval protocol/source drift");
  return { inputs, protocol };
}

export async function runRetrievalWorkflow(options: WorkflowOptions) {
  await checkOutputPath(options.sourceRoot, options.outputRoot);
  const inputs = await loadRetrievalInputs(options.sourceRoot);
  return withOutputLock(options.outputRoot, async () => {
    const callsDir = join(options.outputRoot, "calls"); await mkdir(callsDir, { recursive: true }); await assertRegularDirectory(callsDir);
    const protocol: Protocol = { schemaVersion: 2, sourceHashes: inputs.sourceHashes, inputSha256: inputHash(inputs), implementationSha256: await implementationHash(),
      model: { ...options.model, reasoning: options.model.reasoning ?? "high" }, promptsSha256: sha256Json(prompts), topK: 8, maxSelected: 2, maxCharacters: 9000, maxConcurrent: 2, runtime, dependencyLockSha256: await dependencyLockHash(), evaluation: "independent-model-request-not-human-ground-truth" };
    await ensureSame(join(options.outputRoot, "protocol.json"), protocol);
    await ensureSame(join(options.outputRoot, "inputs.json"), inputs);
    const indexed = await mapBounded(inputs.entries, async (entry) => {
      const record = await stage(options, "index", entry.candidate.id, publicEntry(entry), (value) => parseSearchCard(value, entry));
      return record.value;
    });
    const cards = indexed.filter((card): card is SearchCard => card !== null);
    await mapBounded(inputs.tasks, async (task) => {
      const ranking = rankGuidance(task, inputs.entries, cards);
      const shortlist = ranking.map(({ id }) => inputs.entries.find((entry) => entry.candidate.id === id)!);
      const selected = await stage(options, "select", task.instance_id, { task: publicProblem(task), candidates: shortlist.map(publicEntry) }, decisionParser(task, shortlist), shortlist.length ? undefined : []);
      const selection = selectGuidance(task, inputs.entries, ranking, selected.value ?? []);
      const ids = new Set([...(inputs.legacy[task.instance_id]?.selected.map((item) => item.id) ?? []), ...selection.selectedIds]);
      const auditEntries = inputs.entries.filter((entry) => ids.has(entry.candidate.id)).sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));
      await stage(options, "audit", task.instance_id, { task: publicProblem(task), candidates: auditEntries.map(publicEntry) }, decisionParser(task, auditEntries), auditEntries.length ? undefined : []);
    });
    return buildReport(options.sourceRoot, options.outputRoot);
  });
}

async function loadHumanLabels(output: string, inputs: RetrievalInputs): Promise<PairLabel[]> {
  const file = join(output, "human-labels.json"); if (!await exists(file)) return [];
  const root = object(await readJson(file));
  if (root.inputSha256 !== inputHash(inputs) || !Array.isArray(root.pairs) || root.pairs.length > inputs.tasks.length * inputs.entries.length) throw new Error("Human label binding mismatch");
  const labels: PairLabel[] = [], seen = new Set<string>();
  for (const value of root.pairs) {
    const pair = object(value), task = inputs.tasks.find((item) => item.instance_id === pair.taskId), entry = inputs.entries.find((item) => item.candidate.id === pair.candidateId);
    if (!task || !entry || pair.taskSha256 !== sha256Json(task) || pair.contentSha256 !== entry.candidate.contentSha256) throw new Error("Human pair source mismatch");
    const key = `${task.instance_id}:${entry.candidate.id}`; if (seen.has(key)) throw new Error("Duplicate human pair"); seen.add(key);
    if (pair.verdict === null) continue;
    if (typeof pair.reviewedBy !== "string" || !pair.reviewedBy.trim() || typeof pair.reviewedAt !== "string" || !Number.isFinite(Date.parse(pair.reviewedAt))) throw new Error("Human label requires reviewer and timestamp");
    const decisions = parseApplicability(JSON.stringify({ decisions: [{ candidateId: pair.candidateId, verdict: pair.verdict, reason: pair.reason,
      taskQuotes: pair.taskQuotes, experienceQuotes: pair.experienceQuotes, contraindication: pair.contraindication, stage: pair.stage, redundantWith: null }] }), task, [entry]);
    labels.push(...makeLabels(task.instance_id, decisions, "human"));
  }
  return labels;
}

async function buildReport(source: string, output: string) {
  const { inputs, protocol } = await validateProtocol(source, output);
  const records: Array<CallRecord<unknown>> = [], cards: SearchCard[] = [];
  for (const entry of inputs.entries) {
    const request: CompletionRequest = { stage: "index", systemPrompt: INDEX_PROMPT, material: publicEntry(entry) };
    const record = await readCall(join(output, "calls", `index-${entry.candidate.id}.json`), request, entry.candidate.id, (value) => parseSearchCard(value, entry));
    if (!record) throw new Error("Workflow incomplete: index checkpoint missing"); records.push(record); if (record.value) cards.push(record.value);
  }
  const evaluationTasks: EvaluationTask[] = [], labels: PairLabel[] = [];
  const retrieval: Record<string, ReturnType<typeof selectGuidance>> = {};
  const details: Array<{ taskId: string; ranking: ReturnType<typeof rankGuidance>; decisions: ApplicabilityDecision[]; selection: ReturnType<typeof selectGuidance> }> = [];
  const humanPairs: Array<Record<string, unknown>> = [];
  for (const task of inputs.tasks) {
    const ranking = rankGuidance(task, inputs.entries, cards), shortlist = ranking.map(({ id }) => inputs.entries.find((entry) => entry.candidate.id === id)!);
    const request: CompletionRequest = { stage: "select", systemPrompt: SELECTION_PROMPT, material: { task: publicProblem(task), candidates: shortlist.map(publicEntry) } };
    const select = await readCall(join(output, "calls", `select-${task.instance_id}.json`), request, task.instance_id, decisionParser(task, shortlist));
    if (!select) throw new Error("Workflow incomplete: select checkpoint missing"); records.push(select);
    const selection = selectGuidance(task, inputs.entries, ranking, select.value ?? []); retrieval[task.instance_id] = selection;
    details.push({ taskId: task.instance_id, ranking, decisions: select.value ?? [], selection });
    const v1 = inputs.legacy[task.instance_id]!.selected.map((item) => item.id), ids = new Set([...v1, ...selection.selectedIds]);
    const auditEntries = inputs.entries.filter((entry) => ids.has(entry.candidate.id)).sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));
    const auditRequest: CompletionRequest = { stage: "audit", systemPrompt: AUDIT_PROMPT, material: { task: publicProblem(task), candidates: auditEntries.map(publicEntry) } };
    const audit = await readCall(join(output, "calls", `audit-${task.instance_id}.json`), auditRequest, task.instance_id, decisionParser(task, auditEntries));
    if (!audit) throw new Error("Workflow incomplete: audit checkpoint missing"); records.push(audit);
    labels.push(...makeLabels(task.instance_id, audit.value ?? [], "model"));
    evaluationTasks.push({ taskId: task.instance_id, v1, v2: selection.selectedIds });
    for (const entry of auditEntries) humanPairs.push({ taskId: task.instance_id, candidateId: entry.candidate.id, taskSha256: sha256Json(task), contentSha256: entry.candidate.contentSha256,
      verdict: null, reason: "", taskQuotes: [], experienceQuotes: [], contraindication: "unknown", stage: "initial", reviewedBy: null, reviewedAt: null });
  }
  if (records.some((record) => record.status === "pending")) throw new Error("Workflow incomplete: interrupted request; resume run to record unknown outcome");
  const humans = await loadHumanLabels(output, inputs), allLabels = [...labels, ...humans];
  const calls = records.filter((record) => record.requested), unknownUsageCount = calls.filter((record) => record.usage === null).length;
  const knownTokens = calls.reduce((sum, record) => sum + (record.usage?.total ?? 0), 0), knownCost = calls.reduce((sum, record) => sum + (record.usage?.cost ?? 0), 0);
  const failures = records.filter((record) => record.status === "failed").map((record) => ({ stage: record.stage, id: record.id, error: record.error }));
  const report = {
    schemaVersion: 2, status: failures.length ? "completed_with_failures" : "completed", inputSha256: protocol.inputSha256, indexCount: cards.length, librarySize: inputs.entries.length,
    modelEvaluation: evaluateRetrieval(evaluationTasks, inputs.entries.map((entry) => entry.candidate.id), allLabels, "model"),
    humanEvaluation: evaluateRetrieval(evaluationTasks, inputs.entries.map((entry) => entry.candidate.id), allLabels, "human"),
    usage: { attemptCount: calls.length, requestCount: calls.filter((record) => record.responseReceived).length, unknownDispatchCount: calls.filter((record) => !record.responseReceived).length,
      unknownUsageCount, knownTokens, totalTokens: unknownUsageCount ? null : knownTokens, knownCost, totalCost: unknownUsageCount ? null : knownCost,
      requestDurationMs: calls.reduce((sum, record) => sum + record.durationMs, 0) },
    failures, selectionCharacters: { v1: inputs.tasks.reduce((sum, task) => sum + (inputs.legacy[task.instance_id]?.candidate?.content.length ?? 0), 0),
      v2: Object.values(retrieval).reduce((sum, selection) => sum + (selection.candidate?.content.length ?? 0), 0) },
    limitations: ["模型辅助配对标签不是人工真值；独立请求仍使用同一模型，存在相关偏差。", "只评审 V1/V2 选项并集；未覆盖全库，不能据此推断全库召回率或库中不存在适用经验。", "没有运行修复任务，不能声称成功率、修复耗时或任务 Token 改善。", "本批历史任务已用于开发诊断；最终泛化评价须使用新题。", "费用为 SDK 记录值，不代表核对后的服务商账单。"],
  };
  await writeCheckedJson(join(output, "index.json"), { sourceHashes: inputs.sourceHashes, cards, sha256: sha256Json(cards) });
  await writeCheckedJson(join(output, "retrieval-v2.json"), retrieval);
  await writeCheckedJson(join(output, "selection-audit.json"), { inputSha256: protocol.inputSha256, details });
  await writeCheckedJson(join(output, "pair-labels.json"), { inputSha256: protocol.inputSha256, labels });
  if (!await exists(join(output, "human-labels.json"))) await writeCheckedJson(join(output, "human-labels.json"), { schemaVersion: 1, inputSha256: protocol.inputSha256, instruction: "由人工阅读 inputs.json 后填写；不得将模型标签直接复制为人工结论。新增全库配对须保持任务和候选哈希绑定。", pairs: humanPairs });
  await writeCheckedJson(join(output, "summary.json"), report);
  const ratio = (value: number | null) => value === null ? "未确认/不可计算" : `${(value * 100).toFixed(1)}%`;
  const rows = evaluationTasks.map((task) => `| ${task.taskId} | ${task.v1.length} | ${task.v2.length} | ${labels.filter((label) => label.taskId === task.taskId && task.v1.includes(label.candidateId) && label.verdict === "direct").length} | ${labels.filter((label) => label.taskId === task.taskId && task.v2.includes(label.candidateId) && label.verdict === "direct").length} |`).join("\n");
  const markdown = `# 经验检索 V2 离线诊断\n\n状态：${report.status}。已生成 ${cards.length}/${inputs.entries.length} 份独立检索描述。\n\n这是模型辅助诊断，人工已确认 ${humans.length} 个配对；人工覆盖未完整时不能声称人工验证完成，不能作为修复效果提升证明。\n\n| 指标 | V1 | V2 |\n| --- | ---: | ---: |\n| 选择条数 | ${report.modelEvaluation.v1.selectedCount} | ${report.modelEvaluation.v2.selectedCount} |\n| 模型评审覆盖条数 | ${report.modelEvaluation.v1.labeledCount} | ${report.modelEvaluation.v2.labeledCount} |\n| 模型判为直接适用的比例 | ${ratio(report.modelEvaluation.v1.precision)} | ${ratio(report.modelEvaluation.v2.precision)} |\n| 人工确认适用比例 | ${ratio(report.humanEvaluation.v1.precision)} | ${ratio(report.humanEvaluation.v2.precision)} |\n| 有注入的任务占比 | ${ratio(report.modelEvaluation.v1.taskCoverage)} | ${ratio(report.modelEvaluation.v2.taskCoverage)} |\n| 注入正文字符数 | ${report.selectionCharacters.v1} | ${report.selectionCharacters.v2} |\n\n历史配对已评审 ${report.modelEvaluation.historicalLabeledCount}/${report.modelEvaluation.historicalPairCount}；全库召回率和无适用经验任务的错误注入率见 summary.json，仅全库标签充分时可计算。字符数不等于 Token，也不是整个任务节省量。\n\n模型调用尝试 ${calls.length} 次，其中收到响应 ${report.usage.requestCount} 次、发送状态未知 ${report.usage.unknownDispatchCount} 次；失败 ${failures.length} 次，用量未知 ${unknownUsageCount} 次。已知 Token ${knownTokens}，已知 SDK 记录费用 ${knownCost.toFixed(8)}；完整费用 ${report.usage.totalCost === null ? "未知" : report.usage.totalCost.toFixed(8)}。无 Docker 修复或官方评分调用。\n\n| 任务 | V1 条数 | V2 条数 | V1 直接适用数（模型） | V2 直接适用数（模型） |\n| --- | ---: | ---: | ---: | ---: |\n${rows}\n\n${report.limitations.map((item) => `- ${item}`).join("\n")}\n\n[逐项选择理由](selection-audit.json) · [独立配对评审](pair-labels.json) · [待人工确认标签](human-labels.json) · [完整指标](summary.json) · [源输入与原候选](inputs.json)\n`;
  const reportPath = join(output, "report.md");
  if (await exists(reportPath)) { const { readArtifactText } = await import("../experience/artifact-io.js"); await readArtifactText(reportPath, 2_000_000); }
  await writeFile(reportPath, markdown, "utf8");
  return report;
}

export async function reportRetrievalWorkflow(source: string, output: string) {
  await checkOutputPath(source, output); await assertRegularDirectory(output);
  return withOutputLock(output, () => buildReport(source, output));
}
export async function readRetrievalStatus(output: string): Promise<{ status: string; summary?: unknown; cached?: boolean }> {
  if (!await exists(output)) return { status: "not_started" };
  await assertRegularDirectory(output);
  if (await exists(join(output, "summary.json"))) {
    const summary = object(await readJson(join(output, "summary.json")));
    return { status: String(summary.status), summary, cached: true };
  }
  return { status: "in_progress" };
}
