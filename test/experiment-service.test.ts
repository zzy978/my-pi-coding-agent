import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { executeControlledRun } from "../src/evaluation/runner.js";
import { createReplayPlan } from "../src/evaluation/replay.js";
import { sha256Text } from "../src/evaluation/schema.js";
import { loadRunBundle } from "../src/evaluation/store.js";
import type { ExperienceCandidate } from "../src/experience/candidate.js";
import { runExperiment } from "../src/experiment/service.js";
import { loadExperiment, listExperiments } from "../src/experiment/store.js";
import type { ControlledPiRuntime, ControlledPiRuntimeOptions } from "../src/runtime/controlled-pi-runtime.js";
import { runProcess } from "../src/runtime/process.js";
import { formatTaskPrompt, parseTaskSpec } from "../src/task/task-spec.js";
import { discardManagedWorkspace, prepareWorkspace } from "../src/workspace/git.js";
import { initializeGitRepository } from "./helpers/git-repository.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
});

function fakeRuntime(workspace: string, prompts: string[], improvement = true): ControlledPiRuntime {
  const stats: SessionStats = {
    sessionFile: undefined, sessionId: "experiment-fixture", userMessages: 0, assistantMessages: 0,
    toolCalls: 0, toolResults: 0, totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0
  };
  return {
    hasAvailableModel: true, contextFiles: [], dispose: () => undefined,
    session: {
      model: { provider: "fixture", id: "deterministic" }, thinkingLevel: "off",
      sessionId: stats.sessionId, getActiveToolNames: () => ["read", "write"],
      getSessionStats: () => structuredClone(stats),
      subscribe: () => () => undefined,
      abort: () => Promise.resolve(),
      abortCompaction: () => undefined,
      abortRetry: () => undefined,
      prompt: async (text: string) => {
        prompts.push(text);
        if (improvement && text.includes("<experience-guidance")) await writeFile(join(workspace, "result.txt"), "done\n", "utf8");
        stats.tokens = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
        stats.cost = 0.001;
      }
    }
  } as unknown as ControlledPiRuntime;
}

async function fixture(withVerifier = true) {
  const parent = await mkdtemp(join(tmpdir(), "pi-experiment-"));
  temporaryDirectories.push(parent);
  const source = join(parent, "source");
  const dataDirectory = join(parent, "data");
  await initializeGitRepository(source);
  await writeFile(join(source, "verify.cjs"), "process.exit(require('node:fs').existsSync('result.txt') ? 0 : 1);\n", "utf8");
  for (const args of [["add", "verify.cjs"], ["commit", "-m", "add verification fixture"]]) {
    const command = await runProcess("git", args, { cwd: source });
    if (command.exitCode !== 0) throw new Error(command.stderr);
  }
  const task = parseTaskSpec({ id: "fixture", objective: "Create result.txt", allowedPaths: ["result.txt"],
    verify: withVerifier ? ["node verify.cjs"] : [] });
  const workspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
  const original = await executeControlledRun({ kind: "run", runtime: fakeRuntime(workspace.workspace, []), task, workspace,
    allowShell: false, noSession: true, setup: { source: "disabled", commands: [] }, dataDirectory });
  await discardManagedWorkspace(workspace);
  const content = "Create the requested output file before running verification.";
  const candidate: ExperienceCandidate = {
    id: "candidate-one", kind: "prompt", content, contentSha256: sha256Text(content), rendererVersion: 1,
    sourceRunId: original.manifest.runId, sourceExperienceId: "experience-one", createdAt: new Date().toISOString(),
    title: "Write the output", applicability: ["file tasks"], contraindications: ["read-only tasks"]
  };
  return { source, dataDirectory, task, original, candidate };
}

describe("candidate experiments", () => {
  it("records the same configured 45 minute budget in both arms and replay", async () => {
    const f = await fixture();
    const options = { sourceRunId: f.original.manifest.runId, candidate: f.candidate, dataDirectory: f.dataDirectory,
      pairs: 1, promptTimeoutMs: 2_700_000 };
    const experiment = await runExperiment(options, {
      createRuntime: (runtimeOptions) => Promise.resolve(fakeRuntime(runtimeOptions.workspace, []))
    });
    expect(experiment).toHaveProperty("promptTimeoutMs", 2_700_000);
    expect(experiment.outcome).toBe("observed_improvement");
    for (const trial of experiment.trials) {
      const run = await loadRunBundle(trial.runId, f.dataDirectory);
      expect(run.manifest.experiment?.promptTimeoutMs).toBe(2_700_000);
      expect(createReplayPlan(run.manifest).experiment?.promptTimeoutMs).toBe(2_700_000);
    }
    expect(await loadExperiment(experiment.id, f.dataDirectory)).toEqual(experiment);
  });
  it.each([0, -1, 1.5, 3_600_001, NaN])("rejects invalid runtime budget %s before touching storage", async (promptTimeoutMs) => {
    const options = { sourceRunId: "missing", candidate: {} as ExperienceCandidate, dataDirectory: "missing", promptTimeoutMs };
    await expect(runExperiment(options)).rejects.toThrow("prompt timeout");
  });
  it("runs three fresh, alternating pairs and preserves frozen treatment replay", async () => {
    const f = await fixture();
    const prompts: string[] = [];
    const runtimeOptions: ControlledPiRuntimeOptions[] = [];
    const experiment = await runExperiment({ sourceRunId: f.original.manifest.runId, candidate: f.candidate, dataDirectory: f.dataDirectory }, {
      createRuntime: (options) => { runtimeOptions.push(options); return Promise.resolve(fakeRuntime(options.workspace, prompts)); }
    });
    expect(experiment).toMatchObject({ outcome: "observed_improvement", pairsCompleted: 3, pairsRequested: 3, scopeViolations: 0,
      metrics: { pairedWins: 3, pairedLosses: 0, control: { runs: 3, passed: 0, tokens: 45 }, treatment: { runs: 3, passed: 3 } } });
    expect(experiment.trials.map((trial) => trial.arm)).toEqual(["control", "treatment", "treatment", "control", "control", "treatment"]);
    expect(new Set(runtimeOptions.map((options) => options.workspace)).size).toBe(6);
    expect(runtimeOptions.every((options) => options.noSession)).toBe(true);
    expect(prompts[0]).toBe(formatTaskPrompt(f.task, f.task.objective));
    expect(prompts[1]).toContain(f.candidate.content);
    for (const options of runtimeOptions) await expect(access(options.workspace)).rejects.toThrow();
    await expect(access(join(f.source, "result.txt"))).rejects.toThrow();
    expect(await loadExperiment(experiment.id, f.dataDirectory)).toEqual(experiment);
    expect(await listExperiments(f.dataDirectory)).toHaveLength(1);
    const treatment = experiment.trials.find((trial) => trial.arm === "treatment");
    if (!treatment) throw new Error("Missing treatment trial");
    const stored = await loadRunBundle(treatment.runId, f.dataDirectory);
    const replay = createReplayPlan(stored.manifest);
    expect(replay.experiment?.candidate).toMatchObject({ content: f.candidate.content });
    const replayWorkspace = await prepareWorkspace(f.source, { inPlace: false, dataDirectory: f.dataDirectory, baselineCommit: replay.baselineCommit });
    try {
      await executeControlledRun({ kind: "replay", replayOf: treatment.runId, runtime: fakeRuntime(replayWorkspace.workspace, prompts),
        task: replay.task, workspace: replayWorkspace, allowShell: false, noSession: true,
        setup: { source: "disabled", commands: [] }, dataDirectory: f.dataDirectory,
        ...(replay.experiment ? { experiment: replay.experiment } : {}) });
      expect(prompts.at(-1)).toBe(prompts[1]);
    } finally { await discardManagedWorkspace(replayWorkspace); }
    const resultPath = join(f.dataDirectory, "runs", treatment.runId, "result.json");
    const result = await readFile(resultPath, "utf8");
    await writeFile(resultPath, result.replace('"cost": 0.001', '"cost": 0.002'), "utf8");
    await expect(loadExperiment(experiment.id, f.dataDirectory)).rejects.toThrow("hash");
  }, 60_000);

  it("does not spend model calls when the source has no verifier", async () => {
    const f = await fixture(false);
    const experiment = await runExperiment({ sourceRunId: f.original.manifest.runId, candidate: f.candidate, dataDirectory: f.dataDirectory }, {
      createRuntime: () => { throw new Error("must not create a runtime"); }
    });
    expect(experiment).toMatchObject({ outcome: "inconclusive", pairsCompleted: 0, trials: [] });
    expect(experiment.errors.join(" ")).toContain("verifier");
    const linked = join(f.dataDirectory, "..", "linked-data");
    await symlink(f.dataDirectory, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(loadExperiment(experiment.id, linked)).rejects.toThrow("link");
  }, 30_000);

  it("detects context drift before prompting and preserves evidence after startup failure", async () => {
    const f = await fixture();
    const prompts: string[] = [];
    const drift = await runExperiment({ sourceRunId: f.original.manifest.runId, candidate: f.candidate, dataDirectory: f.dataDirectory, pairs: 1 }, {
      createRuntime: (options) => Promise.resolve({ ...fakeRuntime(options.workspace, prompts), contextFiles: [{ path: "AGENTS.md", sha256: "a".repeat(64) }] } as unknown as ControlledPiRuntime)
    });
    expect(drift.outcome).toBe("invalid_isolation");
    expect(drift.isolationDifferences).toContain("contextFiles");
    expect(prompts).toEqual([]);
    const failed = await runExperiment({ sourceRunId: f.original.manifest.runId, candidate: f.candidate, dataDirectory: f.dataDirectory, pairs: 1 }, {
      createRuntime: () => Promise.reject(new Error("provider unavailable"))
    });
    expect(failed.outcome).toBe("inconclusive");
    expect(failed.errors).toContain("provider unavailable");
    expect(await loadExperiment(failed.id, f.dataDirectory)).toEqual(failed);
    const metadataPath = join(f.dataDirectory, "experiments", failed.id, "experiment.json");
    const original = await readFile(metadataPath, "utf8");
    await writeFile(metadataPath, original.replace("provider unavailable", "tampered"), "utf8");
    await expect(loadExperiment(failed.id, f.dataDirectory)).rejects.toThrow("hash");
  }, 30_000);

  it("retains a completed arm when the next runtime fails, and stops after cancellation", async () => {
    const f = await fixture();
    let calls = 0;
    const partial = await runExperiment({ sourceRunId: f.original.manifest.runId, candidate: f.candidate, dataDirectory: f.dataDirectory, pairs: 1 }, {
      createRuntime: (options) => {
        calls += 1;
        return calls === 1 ? Promise.resolve(fakeRuntime(options.workspace, [])) : Promise.reject(new Error("second runtime failed"));
      }
    });
    expect(partial).toMatchObject({ outcome: "inconclusive", pairsCompleted: 0 });
    expect(partial.trials).toHaveLength(1);
    expect(await loadExperiment(partial.id, f.dataDirectory)).toEqual(partial);
    const controller = new AbortController();
    let compactionAborted = false;
    const aborted = await runExperiment({ sourceRunId: f.original.manifest.runId, candidate: f.candidate, dataDirectory: f.dataDirectory, pairs: 1, signal: controller.signal }, {
      createRuntime: (options) => {
        const runtime = fakeRuntime(options.workspace, []);
        runtime.session.abortCompaction = () => { compactionAborted = true; };
        runtime.session.prompt = () => { controller.abort(); return Promise.resolve(); };
        return Promise.resolve(runtime);
      }
    });
    expect(aborted.outcome).toBe("inconclusive");
    expect(compactionAborted).toBe(true);
    expect(aborted.trials).toHaveLength(1);
    expect(aborted.metrics.control.passed).toBe(0);
    const trial = aborted.trials[0];
    if (!trial) throw new Error("Missing aborted trial");
    expect((await loadRunBundle(trial.runId, f.dataDirectory)).result?.errors.join(" ")).toContain("aborted");
  }, 40_000);

  it("never promotes an experiment cancelled during the final verification", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let verificationCount = 0;
    const experiment = await runExperiment({ sourceRunId: f.original.manifest.runId, candidate: f.candidate,
      dataDirectory: f.dataDirectory, pairs: 1, signal: controller.signal,
      onStatus: (status) => { if (status.endsWith(": verification") && ++verificationCount === 2) controller.abort(); }
    }, { createRuntime: (options) => Promise.resolve(fakeRuntime(options.workspace, [])) });
    expect(experiment.outcome).toBe("inconclusive");
    expect(experiment.errors.join(" ")).toMatch(/abort|failed/i);
  }, 30_000);

  it.each(["experiment", "task"] as const)("aborts compaction and the model when a frozen %s deadline expires", async (deadline) => {
    const f = await fixture();
    const workspace = await prepareWorkspace(f.source, { inPlace: false, dataDirectory: f.dataDirectory });
    const runtime = fakeRuntime(workspace.workspace, []);
    if (deadline === "task") Object.assign(runtime, { modelConfig: { requestTimeoutMs: 5000, maxOutputTokens: 100,
      taskTimeoutMs: 20, baseUrlSha256: "e".repeat(64) } });
    let settlePrompt: (() => void) | undefined;
    let compactionAborted = false;
    runtime.session.prompt = () => new Promise<void>((resolve) => { settlePrompt = resolve; });
    runtime.session.abortCompaction = () => { compactionAborted = true; };
    runtime.session.abort = () => { settlePrompt?.(); return Promise.resolve(); };
    try {
      const run = await executeControlledRun({ kind: "run", runtime, task: f.task, workspace, noSession: true, allowShell: false,
        setup: { source: "disabled", commands: [] }, dataDirectory: f.dataDirectory,
        ...(deadline === "experiment" ? { experiment: { experimentId: "timeout-fixture", pairIndex: 0, arm: "control" as const, promptTimeoutMs: 20,
          effectivePromptSha256: sha256Text(formatTaskPrompt(f.task, f.task.objective)) } } : {}) });
      expect(compactionAborted).toBe(true);
      expect(run.result.status).toBe("execution_failed");
      expect(run.result.errors.join(" ")).toContain("timed out");
      expect(run.result.verification).toBeUndefined();
    } finally { await discardManagedWorkspace(workspace); }
  }, 30_000);
});
