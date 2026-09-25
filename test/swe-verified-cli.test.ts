import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SweTask, SweTrial } from "../src/benchmark/swe-mini.js";
import { VERIFIED_REPOSITORIES, VERIFIED_REVISION } from "../src/benchmark/swe-verified.js";
import type * as EvaluationStore from "../src/evaluation/store.js";

const mocks = vi.hoisted(() => ({ load: vi.fn(), analyze: vi.fn(), run: vi.fn(), prepare: vi.fn(), failSummary: false, failCheckpoint: false }));
vi.mock("../src/evaluation/store.js", async (original) => {
  const actual = await original<typeof EvaluationStore>();
  return { ...actual, loadRunBundle: mocks.load, writeJsonAtomic: async (path: string, value: unknown) => {
    if (mocks.failCheckpoint && path.endsWith("batch.json")) { mocks.failCheckpoint = false; throw Object.assign(new Error("checkpoint busy"), { code: "EPERM" }); }
    if (mocks.failSummary && path.endsWith("summary.json")) { mocks.failSummary = false; throw Object.assign(new Error("summary busy"), { code: "EPERM" }); }
    await actual.writeJsonAtomic(path, value);
  } };
});
vi.mock("../src/experience/service.js", () => ({ analyzeRun: mocks.analyze }));
vi.mock("../src/model-config.js", async (original) => ({ ...await original<object>(), readModelConfig: () => ({ provider: "test", modelId: "test", requestTimeoutMs: 1000, maxOutputTokens: 1000, taskTimeoutMs: 1000, synthesisTimeoutMs: 1000, synthesisMaxOutputTokens: 1000 }) }));
vi.mock("../src/benchmark/swe-container.js", () => ({ EVALUATOR_IMAGE: "test-image", prepareImages: mocks.prepare, preflightTasks: vi.fn() }));
vi.mock("../src/benchmark/swe-process.js", () => ({ docker: () => Promise.resolve({ stdout: "image-id" }) }));
vi.mock("../src/benchmark/swe-run.js", () => ({ runSweTask: mocks.run, recoverTrial: vi.fn() }));
import { analyzeVerifiedTrial, runVerifiedCli } from "../src/benchmark/swe-verified-cli.js";

const config = { requestTimeoutMs: 1000, maxOutputTokens: 1000, taskTimeoutMs: 1000, synthesisTimeoutMs: 1000, synthesisMaxOutputTokens: 1000 };
const trial: SweTrial = { instanceId: "repo__project-1", runId: "r1", resolved: true, executionError: null, usage: null, durationMs: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.failSummary = false;
  mocks.failCheckpoint = false;
  mocks.analyze.mockResolvedValue({ id: "e1", candidates: [], synthesis: { status: "completed" } });
  mocks.load.mockResolvedValue({ manifest: { task: { content: { id: trial.instanceId } } }, result: { toolCallCount: 6 } });
});

describe("Verified 单轮 CLI 接线", () => {
  it("成功5次不进入复盘，6次明确使用 proposer；失败低调用保留分类门槛", async () => {
    mocks.load.mockResolvedValueOnce({ manifest: { task: { content: { id: trial.instanceId } } }, result: { toolCallCount: 5 } });
    expect((await analyzeVerifiedTrial(trial, "data", config)).status).toBe("skipped-success-under-6");
    expect(mocks.analyze).not.toHaveBeenCalled();
    await analyzeVerifiedTrial(trial, "data", config);
    expect(mocks.analyze).toHaveBeenCalledWith("r1", "data", { reviewMode: "proposer", minSuccessToolCalls: 6, modelConfig: config });
    mocks.load.mockResolvedValueOnce({ manifest: { task: { content: { id: trial.instanceId } } }, result: { toolCallCount: 2 } });
    await analyzeVerifiedTrial({ ...trial, resolved: false }, "data", config);
    expect(mocks.analyze).toHaveBeenCalledTimes(2);
  });
  it("无评分或执行异常不生成；来源缺失或错配拒绝", async () => {
    expect((await analyzeVerifiedTrial({ ...trial, resolved: null }, "data", config)).status).toBe("skipped-invalid-execution");
    expect((await analyzeVerifiedTrial({ ...trial, executionError: "Model task phase timed out" }, "data", config)).status).toBe("skipped-invalid-execution");
    mocks.load.mockResolvedValueOnce({ manifest: { task: { content: { id: "wrong" } } }, result: { toolCallCount: 6 } });
    await expect(analyzeVerifiedTrial(trial, "data", config)).rejects.toThrow("mismatched");
    mocks.load.mockResolvedValueOnce({ manifest: { task: { content: { id: trial.instanceId } } } });
    await expect(analyzeVerifiedTrial(trial, "data", config)).rejects.toThrow("Missing");
    expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it("50题全部只运行R0、不注入经验；恢复不重跑或重复复盘；拒绝协议漂移", async () => {
    const root = await mkdtemp(join(tmpdir(), "verified-cli-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runVerifiedCli(["status", root]); expect(await readdir(root)).toEqual([]);
      const tasks: SweTask[] = Array.from({ length: 50 }, (_, i) => { const repo = VERIFIED_REPOSITORIES[i % 12]!; return { repo, instance_id: `${repo.replace("/", "__")}-${i + 1}`, base_commit: "a".repeat(40), problem_statement: `issue ${i}` }; });
      await writeFile(join(root, "selection.json"), JSON.stringify({ tasks, excludedSha256: "test" }));
      await writeFile(join(root, "catalog.json"), JSON.stringify({ dataset: "princeton-nlp/SWE-bench_Verified", revision: VERIFIED_REVISION, tasks: tasks.map((task) => ({ ...task, image: "test-image" })) }));
      await mkdir(join(root, "private"));
      for (const task of tasks) await writeFile(join(root, "private", `${task.instance_id}.json`), "fixture");
      mocks.prepare.mockResolvedValue(Object.fromEntries(tasks.map((task) => [task.instance_id, "image-id"])));
      mocks.run.mockImplementation(async (input: { task: SweTask; started: (id: string) => Promise<void> }) => {
        const runId = input.task.instance_id; await input.started(runId);
        return { ...trial, instanceId: input.task.instance_id, runId };
      });
      mocks.load.mockImplementation((runId: string) => Promise.resolve({ manifest: { task: { content: { id: runId } } }, result: { toolCallCount: 6 } }));
      mocks.failCheckpoint = true;
      await expect(runVerifiedCli(["run", root])).rejects.toThrow("checkpoint busy");
      expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.analyze).not.toHaveBeenCalled();
      mocks.failSummary = true;
      await runVerifiedCli(["run", root]); await runVerifiedCli(["run", root]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("summary busy"));
      expect(mocks.run).toHaveBeenCalledTimes(50); expect(mocks.analyze).toHaveBeenCalledTimes(50);
      expect(mocks.run.mock.calls.every(([call]) => (call as { phase: string; candidate: unknown }).phase === "R0" && (call as { candidate: unknown }).candidate === null)).toBe(true);
      expect(mocks.analyze.mock.calls.every((call) => (call[2] as { reviewMode: string }).reviewMode === "proposer")).toBe(true);
      const protocol = JSON.parse(await readFile(join(root, "protocol.json"), "utf8")) as Record<string, unknown>;
      expect(protocol).toMatchObject({ taskExecutions: 50, minSuccessToolCalls: 6, strictSuccessMinimum: true, critic: false });
      await writeFile(join(root, "private", `${tasks[0]!.instance_id}.json`), "changed");
      await expect(runVerifiedCli(["run", root])).rejects.toThrow("Protocol drift");
      await writeFile(join(root, "private", `${tasks[0]!.instance_id}.json`), "fixture");
      await rm(join(root, "batch.json"));
      await expect(runVerifiedCli(["run", root])).rejects.toThrow("Missing batch state");
      await rm(join(root, "protocol.json"));
      await writeFile(join(root, "agent-data", "runs", "existing-evidence"), "preserve");
      await expect(runVerifiedCli(["run", root])).rejects.toThrow("Existing run evidence");
      expect(mocks.run).toHaveBeenCalledTimes(50);
    } finally { log.mockRestore(); warn.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});
