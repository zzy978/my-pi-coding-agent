import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), recorder: vi.fn(), stop: vi.fn(), abort: vi.fn(), abortRetry: vi.fn(), abortCompaction: vi.fn() }));
vi.mock("../src/runtime/controlled-pi-runtime.js", () => ({ ControlledPiRuntime: { create: mocks.create } }));
vi.mock("../src/evaluation/recorder.js", () => ({ RunRecorder: { create: mocks.recorder } }));
vi.mock("../src/benchmark/swe-container.js", () => ({ startTaskContainer: () => Promise.resolve("test-container"), stopTaskContainer: mocks.stop,
  containerShell: vi.fn(), collectContainerPatch: () => Promise.resolve({ patch: "test patch", files: ["source.py"] }), scorePatch: () => Promise.resolve({ completed: true, resolved: true }) }));
import { runSweTask } from "../src/benchmark/swe-run.js";

describe("SWE runner 任务时限", () => {
  it.each([0, 5])("taskTimeoutMs=%i：0不限时，正数触发取消并保留错误", async (taskTimeoutMs) => {
    vi.clearAllMocks();
    const root = await mkdtemp(join(tmpdir(), "swe-timeout-"));
    const directory = join(root, "run"); await mkdir(directory);
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 };
    mocks.abort.mockResolvedValue(undefined);
    mocks.create.mockResolvedValue({ dispose: vi.fn(), modelConfig: { taskTimeoutMs }, session: {
      model: { provider: "test", id: "test", api: "test", baseUrl: "https://example.invalid", contextWindow: 1000, maxTokens: 100 }, thinkingLevel: "high",
      subscribe: () => () => {}, prompt: () => new Promise<void>((resolve) => setTimeout(resolve, 40)),
      abort: mocks.abort, abortRetry: mocks.abortRetry, abortCompaction: mocks.abortCompaction
    } });
    mocks.recorder.mockResolvedValue({ manifest: { runId: "test-run" }, directory, record: vi.fn(), recordAgentEvent: vi.fn(),
      finalize: () => Promise.resolve({ result: { usage, durationMs: 40 } }) });
    try {
      const result = await runSweTask({ task: { repo: "repo/project", instance_id: "repo__project-1", base_commit: "a".repeat(40), problem_statement: "fix issue" },
        image: "image-id", root, data: root, phase: "R0", candidate: null, started: () => Promise.resolve(),
        config: { taskTimeoutMs, requestTimeoutMs: 1000, maxOutputTokens: 1000, synthesisTimeoutMs: 1000, synthesisMaxOutputTokens: 1000 } });
      expect(result.executionError).toBe(taskTimeoutMs === 0 ? null : "Model task phase timed out");
      expect(mocks.abort).toHaveBeenCalledTimes(taskTimeoutMs === 0 ? 0 : 1);
      expect(mocks.abortRetry).toHaveBeenCalledTimes(taskTimeoutMs === 0 ? 0 : 1);
      expect(mocks.abortCompaction).toHaveBeenCalledTimes(taskTimeoutMs === 0 ? 0 : 1);
      expect(mocks.stop).toHaveBeenCalledWith("test-container");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
