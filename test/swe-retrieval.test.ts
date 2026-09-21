import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import { sha256Json, sha256Text } from "../src/evaluation/schema.js";
import { retrieveGuidance, type LibraryEntry } from "../src/benchmark/swe-holdout.js";
import type { SweTask } from "../src/benchmark/swe-mini.js";
import { runRetrievalWorkflow, reportRetrievalWorkflow, readRetrievalStatus, type CompletionRequest, type RetrievalCompletion } from "../src/benchmark/swe-retrieval.js";
import { loadRetrievalInputs } from "../src/benchmark/swe-retrieval-io.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const task: SweTask = { instance_id: "demo__repo-1", repo: "demo/repo", base_commit: "a".repeat(40), problem_statement: "Sibling methods disagree on vocabulary initialization." };
const content = "Inspect sibling methods and reuse vocabulary initialization.";
const entry: LibraryEntry = { sourceTaskId: "demo__repo-2", sourceExperienceId: "e1", sourceRunId: "r1", title: "Vocabulary initialization", applicability: ["Sibling methods disagree"], contraindications: ["The difference is intentional"], candidate: { id: "c1", kind: "strategy", content, contentSha256: sha256Text(content), rendererVersion: 1 } };
const model = { provider: "fake", id: "fake", baseUrlSha256: sha256Text("fake"), timeoutMs: 1000, maxOutputTokens: 2000 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "retrieval-workflow-")); roots.push(root);
  const { mkdir } = await import("node:fs/promises");
  const sourceRoot = join(root, "source"), outputRoot = join(root, "v2");
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, "library.json"), JSON.stringify({ entries: [entry], sha256: sha256Json([entry]) }));
  await writeFile(join(sourceRoot, "catalog.json"), JSON.stringify({ tasks: [{ ...task, patch: "HIDDEN_ANSWER", FAIL_TO_PASS: "HIDDEN_TEST" }] }));
  await writeFile(join(sourceRoot, "retrieval.json"), JSON.stringify({ [task.instance_id]: retrieveGuidance(task, [entry]) }));
  return { sourceRoot, outputRoot, model };
}
function answer(request: CompletionRequest) {
  if (request.stage === "index") return { candidateId: "c1", contentSha256: entry.candidate.contentSha256, mechanism: "初始化 initialization", triggers: ["Sibling methods disagree"], exclusions: ["The difference is intentional"], action: "Reuse vocabulary initialization", stage: "initial", keywords: ["vocabulary", "initialization", "初始化"], sourceQuotes: [content] };
  return { decisions: [{ candidateId: "c1", verdict: "direct", reason: "两个方法初始化不一致，适合查找既有入口。", taskQuotes: [task.problem_statement], experienceQuotes: [content], contraindication: "absent", stage: "initial", redundantWith: null }] };
}
const complete: RetrievalCompletion = (request) => Promise.resolve({ text: JSON.stringify(answer(request)), usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0.01 } });

describe("SWE 检索离线流水线", () => {
  it("保留 V1、隔离隐藏字段、实际选择原候选并独立评审；断点恢复不重复请求", async () => {
    const config = await fixture(); const before = await readFile(join(config.sourceRoot, "library.json"), "utf8");
    const calls: CompletionRequest[] = [];
    const result = await runRetrievalWorkflow({ ...config, complete: async (request) => { calls.push(request); return complete(request); } });
    expect(calls.map((call) => call.stage)).toEqual(["index", "select", "audit"]);
    expect(JSON.stringify(calls)).not.toMatch(/HIDDEN_ANSWER|HIDDEN_TEST|resolved|FAIL_TO_PASS/);
    expect(JSON.stringify(calls[2]?.material)).not.toMatch(/ranking|selectedIds|v1|v2|verdict/);
    expect(result.modelEvaluation.historicalLabeledCount).toBe(1);
    expect(result.modelEvaluation.v2.selectedCount).toBe(1);
    expect(result.humanEvaluation.labelCount).toBe(0);
    expect(result.humanEvaluation.v2.precision).toBeNull();
    expect(result.usage.requestCount).toBe(3);
    await runRetrievalWorkflow({ ...config, complete: () => { throw new Error("不得重复请求"); } });
    expect(await readFile(join(config.sourceRoot, "library.json"), "utf8")).toBe(before);
    const retrieved = JSON.parse(await readFile(join(config.outputRoot, "retrieval-v2.json"), "utf8")) as Record<string, { candidate: { content: string } }>;
    expect(retrieved[task.instance_id]?.candidate.content).toContain(content);
    expect((await readRetrievalStatus(config.outputRoot)).status).toBe("completed");
  });
  it("筛选失败禁止注入，已知费用保留，评审仍覆盖历史配对", async () => {
    const config = await fixture();
    const result = await runRetrievalWorkflow({ ...config, complete: async (request) => request.stage === "select" ? { text: "not json", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0.01 } } : complete(request) });
    expect(result.modelEvaluation.v2.selectedCount).toBe(0);
    expect(result.modelEvaluation.v2.precision).toBeNull();
    expect(result.modelEvaluation.historicalLabeledCount).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.usage.knownCost).toBeCloseTo(0.03);
  });
  it("请求异常的凭据脱敏、未知用量不补零，report 不调用模型", async () => {
    const config = await fixture();
    const result = await runRetrievalWorkflow({ ...config, complete: async (request) => {
      if (request.stage === "select") throw new Error("Bearer fake-sensitive-credential"); return complete(request);
    } });
    expect(result.usage.totalCost).toBeNull();
    expect(JSON.stringify(result)).not.toContain("fake-sensitive-credential");
    expect(await reportRetrievalWorkflow(config.sourceRoot, config.outputRoot)).toEqual(result);
  });
  it("输入漂移、同目录或嵌套输出拒绝，status 不创建目录", async () => {
    const config = await fixture();
    expect((await readRetrievalStatus(config.outputRoot)).status).toBe("not_started");
    await expect(runRetrievalWorkflow({ ...config, outputRoot: config.sourceRoot, complete })).rejects.toThrow();
    await expect(runRetrievalWorkflow({ ...config, outputRoot: join(config.sourceRoot, "child"), complete })).rejects.toThrow();
    await runRetrievalWorkflow({ ...config, complete });
    await writeFile(join(config.sourceRoot, "catalog.json"), JSON.stringify({ tasks: [{ ...task, problem_statement: "Different public task" }] }));
    await expect(runRetrievalWorkflow({ ...config, complete })).rejects.toThrow(/drift|漂移|retrieval/i);
  });
  it("pending 请求不重发，恢复后记为失败与未知费用", async () => {
    const config = await fixture(); await runRetrievalWorkflow({ ...config, complete });
    const file = join(config.outputRoot, "calls", `select-${task.instance_id}.json`);
    const saved = JSON.parse(await readFile(file, "utf8")) as { record: Record<string, unknown> };
    saved.record.status = "pending"; saved.record.value = null; saved.record.usage = null;
    await writeFile(file, JSON.stringify({ record: saved.record, sha256: sha256Json(saved.record) }));
    const result = await runRetrievalWorkflow({ ...config, complete: () => { throw new Error("不应重发"); } });
    expect(result.failures[0]?.error).toContain("中断");
    expect(result.usage.unknownUsageCount).toBe(1);
    expect(result.modelEvaluation.v2.selectedCount).toBe(0);
  });
  it("坏检查点和模型配置漂移拒绝，不静默覆盖", async () => {
    const config = await fixture(); await runRetrievalWorkflow({ ...config, complete });
    await expect(runRetrievalWorkflow({ ...config, model: { ...model, id: "changed" }, complete })).rejects.toThrow(/drift/i);
    await expect(runRetrievalWorkflow({ ...config, model: { ...model, reasoning: "low" }, complete })).rejects.toThrow(/drift/i);
    const file = join(config.outputRoot, "calls", "index-c1.json");
    const saved = JSON.parse(await readFile(file, "utf8")) as { record: Record<string, unknown>; sha256: string };
    saved.record.value = {}; await writeFile(file, JSON.stringify(saved));
    await expect(runRetrievalWorkflow({ ...config, complete })).rejects.toThrow(/drift/i);
  });
  it("索引失败仍评审历史选项，审核失败不会补假标签", async () => {
    const config = await fixture();
    const result = await runRetrievalWorkflow({ ...config, complete: (request) => request.stage === "index" || request.stage === "audit" ? Promise.resolve({ text: "broken" }) : complete(request) });
    expect(result.indexCount).toBe(0);
    expect(result.modelEvaluation.v2.selectedCount).toBe(0);
    expect(result.modelEvaluation.historicalLabeledCount).toBe(0);
    expect(result.modelEvaluation.v1.precision).toBeNull();
    expect(result.usage.requestCount).toBe(2);
  });
  it("人工待确认模板不会填入模型结论，确认后可独立重算", async () => {
    const config = await fixture(); await runRetrievalWorkflow({ ...config, complete });
    const file = join(config.outputRoot, "human-labels.json");
    const saved = JSON.parse(await readFile(file, "utf8")) as { pairs: Array<Record<string, unknown>> };
    expect(saved.pairs[0]?.verdict).toBeNull();
    Object.assign(saved.pairs[0]!, { verdict: "inapplicable", reason: "人工认为该建议不适用", reviewedBy: "test-reviewer", reviewedAt: new Date().toISOString() });
    await writeFile(file, JSON.stringify(saved));
    const result = await reportRetrievalWorkflow(config.sourceRoot, config.outputRoot);
    expect(result.humanEvaluation.v1.precision).toBe(0);
    expect(result.modelEvaluation.v1.precision).toBe(1);
    saved.pairs[0]!.contentSha256 = "0".repeat(64); await writeFile(file, JSON.stringify(saved));
    await expect(reportRetrievalWorkflow(config.sourceRoot, config.outputRoot)).rejects.toThrow(/mismatch/i);
  });
  it("同主机已退出进程的遗留锁可恢复，存活进程的锁不能抢占", async () => {
    const config = await fixture(); await runRetrievalWorkflow({ ...config, complete });
    const file = join(config.outputRoot, "workflow.lock");
    await writeFile(file, JSON.stringify({ pid: 999999, host: hostname(), startedAt: new Date().toISOString() }));
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await expect(runRetrievalWorkflow({ ...config, complete })).resolves.toMatchObject({ status: "completed" });
    vi.restoreAllMocks();
    await writeFile(file, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
    await expect(runRetrievalWorkflow({ ...config, complete })).rejects.toThrow(/正在|active/);
  });
  it("模型调用前检查原始经验边界，不因坏元数据先产生费用", async () => {
    const config = await fixture(); const changed = { ...entry, applicability: ["x".repeat(2001)] };
    await writeFile(join(config.sourceRoot, "library.json"), JSON.stringify({ entries: [changed], sha256: sha256Json([changed]) }));
    await writeFile(join(config.sourceRoot, "retrieval.json"), JSON.stringify({ [task.instance_id]: retrieveGuidance(task, [changed]) }));
    let calls = 0;
    await expect(runRetrievalWorkflow({ ...config, complete: (request) => { calls++; return complete(request); } })).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("一个并发 worker 发现损坏后，不继续为余下项目发起请求", async () => {
    const config = await fixture();
    const entries = [entry, ...["c2", "c3", "c4"].map((id) => ({ ...entry, candidate: { ...entry.candidate, id } }))];
    await writeFile(join(config.sourceRoot, "library.json"), JSON.stringify({ entries, sha256: sha256Json(entries) }));
    await writeFile(join(config.sourceRoot, "retrieval.json"), JSON.stringify({ [task.instance_id]: retrieveGuidance(task, entries) }));
    await runRetrievalWorkflow({ ...config, complete });
    await writeFile(join(config.outputRoot, "calls", "index-c1.json"), "{}");
    for (const id of ["c2", "c3", "c4"]) await rm(join(config.outputRoot, "calls", `index-${id}.json`));
    let calls = 0;
    await expect(runRetrievalWorkflow({ ...config, complete: async (request) => {
      calls++; await new Promise((done) => setTimeout(done, 50)); return complete(request);
    } })).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(1);
  });
  it("允许公开题目的普通代码赋值，仍拒绝凭据", async () => {
    const config = await fixture(); const publicTask = { ...task, problem_statement: `max_eps=1.0\n${task.problem_statement}` };
    await writeFile(join(config.sourceRoot, "catalog.json"), JSON.stringify({ tasks: [publicTask] }));
    await writeFile(join(config.sourceRoot, "retrieval.json"), JSON.stringify({ [task.instance_id]: retrieveGuidance(publicTask, [entry]) }));
    await expect(loadRetrievalInputs(config.sourceRoot)).resolves.toMatchObject({ tasks: [publicTask] });
    await writeFile(join(config.sourceRoot, "catalog.json"), JSON.stringify({ tasks: [{ ...publicTask, problem_statement: "Bearer fake-sensitive-credential" }] }));
    await expect(loadRetrievalInputs(config.sourceRoot)).rejects.toThrow();
  });
});
