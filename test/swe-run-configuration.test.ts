import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Json } from "../src/evaluation/schema.js";
import { parseTaskSpec } from "../src/task/task-spec.js";
import { runSweTask } from "../src/benchmark/swe-run.js";

const doubles = vi.hoisted(() => ({
  prompt: vi.fn(() => Promise.resolve()), dispose: vi.fn(), stop: vi.fn(() => Promise.resolve()),
  createRecorder: vi.fn(), started: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("../src/runtime/controlled-pi-runtime.js", () => ({ ControlledPiRuntime: {
  create: () => Promise.resolve({ modelConfig: { requestTimeoutMs: 1000, maxOutputTokens: 100, taskTimeoutMs: 1000 }, dispose: doubles.dispose,
    session: { model: { provider: "mock", id: "model", api: "mock", baseUrl: "https://example.invalid", contextWindow: 4096, maxTokens: 100 },
      thinkingLevel: "high", prompt: doubles.prompt, subscribe: () => () => undefined } }),
} }));
vi.mock("../src/evaluation/recorder.js", () => ({ RunRecorder: { create: doubles.createRecorder } }));
vi.mock("../src/benchmark/swe-container.js", () => ({
  startTaskContainer: () => Promise.resolve("mock-container"), stopTaskContainer: doubles.stop,
  containerShell: () => () => Promise.resolve(),
  collectContainerPatch: () => Promise.resolve({ patch: "", files: [] }),
  scorePatch: () => Promise.resolve({ completed: true, resolved: false, emptyPatch: true }),
}));

describe("SWE execution configuration gate", () => {
  let root: string;
  const spec = parseTaskSpec({ id: "django__django-1", objective: "Fix one issue", verify: [{ command: "swebench-official-evaluation", timeoutMs: 300_000 }] });
  const configuration = { task: { content: spec, sha256: sha256Json(spec) },
    agent: { appVersion: "1", model: { provider: "mock", id: "model" }, thinkingLevel: "high", sessionMode: "ephemeral" },
    setup: { source: "disabled", commands: [], sha256: sha256Json([]) },
    policy: { allowShell: true, allowedPaths: ["**/*"], tools: ["bash"] }, contextFiles: [],
    verifier: { commands: spec.verify, sha256: sha256Json(spec.verify) } };

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), "swe-config-gate-"));
    doubles.createRecorder.mockResolvedValue({ manifest: { runId: "mock-run", ...configuration }, directory: root,
      record: () => undefined, recordAgentEvent: () => undefined,
      finalize: () => Promise.resolve({ result: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 }, durationMs: 1 } }) });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function options() {
    return { task: { instance_id: "django__django-1", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "Fix one issue" },
      image: "mock-image", root, data: join(root, "data"), config: { requestTimeoutMs: 1000, maxOutputTokens: 100, taskTimeoutMs: 1000, synthesisTimeoutMs: 1000, synthesisMaxOutputTokens: 100 },
      phase: "control" as const, candidate: null, started: doubles.started };
  }

  it("rejects configuration drift before starting or sending a model request and cleans up", async () => {
    await expect(runSweTask({ ...options(), expectedConfigurationSha256: "f".repeat(64) })).rejects.toThrow(/configuration.*drift/i);
    expect(doubles.started).not.toHaveBeenCalled();
    expect(doubles.prompt).not.toHaveBeenCalled();
    expect(doubles.dispose).toHaveBeenCalledOnce();
    expect(doubles.stop).toHaveBeenCalledExactlyOnceWith("mock-container");
  });

  it("runs a matching configuration through scoring and cleans up", async () => {
    const trial = await runSweTask({ ...options(), expectedConfigurationSha256: sha256Json(configuration) });
    expect(trial.runId).toBe("mock-run");
    expect(trial.resolved).toBe(false);
    expect(trial.executionError).toBeNull();
    expect(doubles.prompt).toHaveBeenCalledOnce();
    expect(doubles.started).toHaveBeenCalledExactlyOnceWith("mock-run");
    expect(doubles.dispose).toHaveBeenCalledOnce();
    expect(doubles.stop).toHaveBeenCalledExactlyOnceWith("mock-container");
  });

  it("preserves existing callers without an expected fingerprint", async () => {
    const trial = await runSweTask(options());
    expect(trial.resolved).toBe(false);
    expect(doubles.prompt).toHaveBeenCalledOnce();
    expect(doubles.stop).toHaveBeenCalledOnce();
  });
});
