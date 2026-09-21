import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { sha256Json, sha256Text } from "../src/evaluation/schema.js";
import { QUOTAS } from "../src/benchmark/swe-holdout.js";
import type { SweTask } from "../src/benchmark/swe-mini.js";
import type { HoldoutState } from "../src/benchmark/swe-holdout-state.js";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), run: vi.fn(), prepare: vi.fn(), recover: vi.fn() }));
vi.mock("../src/experience/synthesizer.js", () => ({ completeExperienceStage: mocks.complete }));
vi.mock("../src/model-config.js", async (original) => ({ ...await original<object>(), readModelConfig: () => ({ provider: "test", modelId: "test", requestTimeoutMs: 1000, maxOutputTokens: 1000, taskTimeoutMs: 1000, synthesisTimeoutMs: 1000, synthesisMaxOutputTokens: 1000 }) }));
vi.mock("../src/benchmark/swe-container.js", () => ({ bridge: vi.fn(), EVALUATOR_IMAGE: "test-image", prepareImages: mocks.prepare,
  preflightTasks: vi.fn(), scorePatch: vi.fn() }));
vi.mock("../src/benchmark/swe-process.js", () => ({ docker: () => Promise.resolve({ stdout: "image-id" }) }));
vi.mock("../src/benchmark/swe-run.js", () => ({ runSweTask: mocks.run, recoverTrial: mocks.recover }));
import { runHoldoutCli } from "../src/benchmark/swe-holdout-cli.js";

async function fixture(root: string) {
  const tasks: SweTask[] = Object.entries(QUOTAS).flatMap(([repo, count]) => Array.from({ length: count }, (_, i) => ({ repo, instance_id: `${repo.replace("/", "__")}-${i + 10}`, base_commit: "a".repeat(40), problem_statement: `username length ${repo} ${i}` })));
  const catalog = { dataset: "test", revision: "test", tasks: tasks.map((task) => ({ ...task, image: "test-image" })) };
  const source = { ...catalog, tasks: [{ ...tasks[0], instance_id: "django__django-1", problem_statement: "source problem" }] };
  const content = "Validate username length";
  const entries = [{ sourceTaskId: "django__django-1", sourceExperienceId: "e1", sourceRunId: "r1", title: "username length", applicability: ["username length"], contraindications: [], candidate: { id: "c1", kind: "strategy", content, contentSha256: sha256Text(content), rendererVersion: 1 } }];
  const model = { provider: "test", id: "test", baseUrlSha256: sha256Text("provider-default"), requestTimeoutMs: 1000, maxOutputTokens: 1000, taskTimeoutMs: 1000 };
  const library = { entries, sha256: sha256Json(entries), sourceCatalogSha256: sha256Json(source), sourceProtocol: { model } };
  await writeFile(join(root, "catalog.json"), JSON.stringify(catalog));
  await writeFile(join(root, "source-catalog.json"), JSON.stringify(source));
  await writeFile(join(root, "library.json"), JSON.stringify(library));
  await mkdir(join(root, "private"));
  for (const task of tasks) await writeFile(join(root, "private", `${task.instance_id}.json`), "private fixture");
  mocks.prepare.mockResolvedValue(Object.fromEntries(tasks.map((task) => [task.instance_id, "test-image"])));
  mocks.complete.mockImplementation((_input: unknown, _material: unknown, prompt: string) => Promise.resolve({ text: JSON.stringify(prompt.includes("ONE existing")
    ? { candidateId: "c1", contentSha256: entries[0]!.candidate.contentSha256, mechanism: "username length", triggers: ["username length"], exclusions: [], action: "validate username length", stage: "initial", keywords: ["username", "length"], sourceQuotes: ["username length"] }
    : { decisions: [{ candidateId: "c1", verdict: "direct", reason: "长度匹配", taskQuotes: ["username length"], experienceQuotes: ["username length"], contraindication: "absent", stage: "initial", redundantWith: null }] }) }));
  mocks.run.mockImplementation(async (input: { task: SweTask; phase: string; started: (id: string) => Promise<void> }) => {
    const runId = `${input.phase}-${input.task.instance_id}`; await input.started(runId);
    return { instanceId: input.task.instance_id, runId, resolved: true, usage: null, durationMs: 1, executionError: null };
  });
}

describe("holdout CLI V2 接线", () => {
  it("status只读；catalog无模型；prepare冻结后run与恢复不再次判定", async () => {
    const root = await mkdtemp(join(tmpdir(), "holdout-cli-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const oldData = process.env.PI_TUI_AGENT_DATA_DIR;
    mocks.complete.mockClear(); mocks.run.mockClear();
    try {
      await runHoldoutCli(["status", root]); expect(await readdir(root)).toEqual([]);
      await fixture(root); await runHoldoutCli(["catalog", root]);
      expect(mocks.complete).not.toHaveBeenCalled();
      await runHoldoutCli(["prepare", root]);
      expect(mocks.complete).toHaveBeenCalledTimes(41);
      await runHoldoutCli(["run", root]);
      expect(mocks.run).toHaveBeenCalledTimes(80);
      const calls = mocks.run.mock.calls.map((call) => call[0] as { phase: string; candidate: unknown });
      expect(calls.filter((call) => call.phase === "control").every((call) => call.candidate === null)).toBe(true);
      expect(calls.filter((call) => call.phase === "experience").every((call) => call.candidate !== null)).toBe(true);
      await runHoldoutCli(["run", root]); expect(mocks.complete).toHaveBeenCalledTimes(41); expect(mocks.run).toHaveBeenCalledTimes(80);
      const state = JSON.parse(await readFile(join(root, "batch.json"), "utf8")) as HoldoutState;
      const interrupted = state.experience.pop()!;
      state.current = { instanceId: interrupted.instanceId, arm: "experience", runId: interrupted.runId };
      await writeFile(join(root, "batch.json"), JSON.stringify(state));
      const runPath = join(root, "agent-data", "runs", interrupted.runId);
      await mkdir(runPath, { recursive: true });
      const metadata = { phase: "experience", instanceId: interrupted.instanceId, candidate: null as unknown };
      await writeFile(join(runPath, "benchmark.json"), JSON.stringify(metadata));
      await expect(runHoldoutCli(["run", root])).rejects.toThrow("Recovered run binding mismatch");
      const retrieval = JSON.parse(await readFile(join(root, "retrieval.json"), "utf8")) as Record<string, { candidate: unknown }>;
      metadata.candidate = retrieval[interrupted.instanceId]!.candidate;
      await writeFile(join(runPath, "benchmark.json"), JSON.stringify(metadata));
      mocks.recover.mockResolvedValue(interrupted);
      await runHoldoutCli(["run", root]);
      expect(mocks.recover).toHaveBeenCalledWith(join(root, "agent-data"), interrupted.runId);
      expect(mocks.complete).toHaveBeenCalledTimes(41); expect(mocks.run).toHaveBeenCalledTimes(80);
      const protocol = JSON.parse(await readFile(join(root, "protocol.json"), "utf8")) as { version: number };
      expect(protocol.version).toBe(2);
    } finally {
      if (oldData === undefined) delete process.env.PI_TUI_AGENT_DATA_DIR; else process.env.PI_TUI_AGENT_DATA_DIR = oldData;
      log.mockRestore(); await rm(root, { recursive: true, force: true });
    }
  });
  it("旧V1协议仍检查源码与运行指纹漂移，不调用V2模型", async () => {
    const root = await mkdtemp(join(tmpdir(), "holdout-cli-v1-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.complete.mockClear();
    try {
      await fixture(root);
      await writeFile(join(root, "protocol.json"), JSON.stringify({ version: 1, sourceSha256: "old-source" }));
      await writeFile(join(root, "batch.json"), JSON.stringify({ schemaVersion: 1, fingerprint: "old", status: "ready", control: [], experience: [], current: null }));
      await expect(runHoldoutCli(["run", root])).rejects.toThrow("Protocol drift");
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(await readdir(root)).not.toContain("retrieval-v2.json");
    } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});
