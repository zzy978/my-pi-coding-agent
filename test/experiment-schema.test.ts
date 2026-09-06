import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../src/config.js";
import { parseRunManifest, sha256Json, sha256Text, type RunResult } from "../src/evaluation/schema.js";
import type { RunBundle } from "../src/evaluation/store.js";
import { renderCandidatePrompt } from "../src/experience/candidate.js";
import { emptyArmMetrics, parseExperiment, summarizeExperiment, type ExperimentBundle } from "../src/experiment/schema.js";
import { formatTaskPrompt, parseTaskSpec, PROMPT_POLICY_VERSION } from "../src/task/task-spec.js";

function fixture(controlPassed: boolean, treatmentPassed: boolean) {
  const task = parseTaskSpec({ id: "fixture", objective: "Write result", verify: ["node verify.cjs"] });
  const source = parseRunManifest({
    schemaVersion: 1, runId: "source", kind: "run", createdAt: "2026-09-05T00:00:00.000Z", sourceRepository: resolve("source"),
    baselineCommit: "a".repeat(40), replayable: true, task: { content: task, sha256: sha256Json(task) },
    agent: { appVersion: APP_VERSION, promptPolicyVersion: PROMPT_POLICY_VERSION, model: { provider: "fixture", id: "model" }, thinkingLevel: "off", sessionMode: "ephemeral" },
    setup: { source: "disabled", commands: [], sha256: sha256Json([]) }, policy: { allowShell: false, allowedPaths: task.allowedPaths, tools: ["read"] },
    contextFiles: [], verifier: { commands: task.verify, sha256: sha256Json(task.verify) }
  });
  const candidate = { id: "candidate", kind: "strategy" as const, content: "Check output", contentSha256: sha256Text("Check output"), rendererVersion: 1 as const };
  const experiment: ExperimentBundle = {
    schemaVersion: 1, id: "experiment", sourceRunId: source.runId, sourceRepository: source.sourceRepository,
    sourceManifestSha256: sha256Json(source), taskSha256: source.task.sha256, baselineCommit: source.baselineCommit, candidate,
    pairsRequested: 1, pairsCompleted: 0, createdAt: source.createdAt, completedAt: source.createdAt, outcome: "inconclusive",
    scopeViolations: 0, errors: [], isolationDifferences: [], trials: [],
    metrics: { control: emptyArmMetrics(), treatment: emptyArmMetrics(), pairedWins: 0, pairedLosses: 0 }
  };
  const runs: RunBundle[] = (["control", "treatment"] as const).map((arm) => {
    const prompt = formatTaskPrompt(task, task.objective);
    const manifest = parseRunManifest({ ...source, schemaVersion: 2, runId: arm, experiment: {
      experimentId: experiment.id, pairIndex: 0, arm, ...(arm === "treatment" ? { candidate } : {}),
      effectivePromptSha256: sha256Text(arm === "treatment" ? renderCandidatePrompt(prompt, candidate) : prompt)
    } });
    const passed = arm === "control" ? controlPassed : treatmentPassed;
    const result: RunResult = {
      schemaVersion: 1, runId: arm, manifestSha256: sha256Json(manifest), startedAt: source.createdAt, completedAt: source.createdAt,
      status: passed ? "verification_passed" : "verification_failed", workspace: { path: resolve(arm), branch: `fixture/${arm}`, baselineCommit: source.baselineCommit, managedWorktree: true },
      verification: { configured: true, success: passed, changedFiles: [], disallowedChangedFiles: [],
        commands: [{ command: "node verify.cjs", status: passed ? "passed" : "failed", exitCode: passed ? 0 : 1, stdout: "", stderr: "", outputTruncated: false, durationMs: 1 }] },
      diffSummary: "", durationMs: 1, toolCallCount: 1, retryCount: 0, errorCount: 0, errors: [],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 }
    };
    experiment.trials.push({ pairIndex: 0, arm, runId: arm, manifestSha256: sha256Json(manifest), resultSha256: sha256Json(result) });
    return { directory: resolve(arm), manifest, result };
  });
  return { source, experiment, runs };
}

describe("experiment evidence conclusions", () => {
  it.each([
    [false, true, "observed_improvement"], [true, false, "observed_regression"],
    [true, true, "no_observed_gain"], [false, false, "no_observed_gain"]
  ] as const)("classifies paired pass evidence %s/%s as %s", (control, treatment, outcome) => {
    const f = fixture(control, treatment);
    expect(summarizeExperiment(f.experiment, f.source, f.runs).outcome).toBe(outcome);
  });
  it("does not count a missing arm or a scope violation as improvement", () => {
    const f = fixture(false, true);
    f.experiment.trials.pop();
    expect(summarizeExperiment(f.experiment, f.source, f.runs.slice(0, 1)).outcome).toBe("inconclusive");
    const complete = fixture(false, true);
    const treatment = complete.runs[1]?.result;
    const reference = complete.experiment.trials[1];
    if (!treatment?.verification || !reference) throw new Error("Missing fixture trial");
    treatment.status = "verification_failed";
    treatment.verification.success = false;
    treatment.verification.disallowedChangedFiles = ["outside.txt"];
    reference.resultSha256 = sha256Json(treatment);
    expect(summarizeExperiment(complete.experiment, complete.source, complete.runs)).toMatchObject({ outcome: "observed_regression", scopeViolations: 1 });
  });
  it("rejects duplicate arms, altered snapshots, and model isolation drift", () => {
    const f = fixture(false, true);
    expect(() => parseExperiment({ ...f.experiment, trials: [f.experiment.trials[0], f.experiment.trials[0]] })).toThrow("duplicate");
    const treatment = f.runs[1];
    const reference = f.experiment.trials[1];
    if (!treatment || !reference || !treatment.result) throw new Error("Missing fixture trial");
    treatment.manifest.agent.model.id = "other";
    reference.manifestSha256 = sha256Json(treatment.manifest);
    expect(summarizeExperiment(f.experiment, f.source, f.runs).outcome).toBe("invalid_isolation");
    f.experiment.candidate.kind = "skill";
    expect(() => summarizeExperiment(f.experiment, f.source, f.runs)).toThrow("metadata");
  });
  it("rejects unequal prompt timeout budgets as invalid isolation", () => {
    const f = fixture(false, true);
    const treatment = f.runs[1];
    const reference = f.experiment.trials[1];
    if (!treatment?.manifest.experiment || !reference) throw new Error("Missing fixture trial");
    treatment.manifest.experiment.promptTimeoutMs = 1_000;
    reference.manifestSha256 = sha256Json(treatment.manifest);
    expect(summarizeExperiment(f.experiment, f.source, f.runs)).toMatchObject({ outcome: "invalid_isolation", isolationDifferences: ["promptTimeoutMs"] });
  });
});
