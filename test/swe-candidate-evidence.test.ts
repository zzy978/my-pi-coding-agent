import { describe, expect, it } from "vitest";
import { sha256Json, sha256Text, type RunManifest } from "../src/evaluation/schema.js";
import { renderCandidatePrompt } from "../src/experience/candidate.js";
import { formatTaskPrompt, parseTaskSpec } from "../src/task/task-spec.js";
import { taskPolicyText } from "../src/policy/policy-extension.js";
import { assertSweCandidateProtocol, auditSweCandidate, type SweCandidateEvidence, type SweCandidateProtocol } from "../src/benchmark/swe-candidate-evidence.js";

it("大小写和任务 ID 变化不能伪造新问题", () => {
  const { protocol } = fixture(); const changed = protocol.tasks[1]!;
  changed.task.problem_statement = protocol.tasks[0]!.task.problem_statement.toUpperCase();
  changed.configuration.task.content.objective = changed.task.problem_statement;
  changed.configuration.task.sha256 = sha256Json(changed.configuration.task.content);
  changed.configurationSha256 = sha256Json(changed.configuration);
  expect(() => assertSweCandidateProtocol(protocol)).toThrow("重复问题");
});

it("公开题目末尾换行与 TaskSpec 去空白保持兼容", () => {
  const { protocol } = fixture();
  protocol.tasks[1]!.task.problem_statement += "\n\t ";
  expect(() => assertSweCandidateProtocol(protocol)).not.toThrow();
});

function fixture(): { protocol: SweCandidateProtocol; evidence: SweCandidateEvidence } {
  const candidate = { id: "candidate-1", kind: "strategy" as const, content: "Inspect related conversions.", contentSha256: sha256Text("Inspect related conversions."), rendererVersion: 1 as const };
  const tasks = [1, 2].map((number) => {
    const task = { instance_id: `django__django-${number}`, repo: "django/django", base_commit: String(number).repeat(40), problem_statement: `Fix conversion ${number}` };
    const spec = parseTaskSpec({ id: task.instance_id, objective: task.problem_statement, verify: [{ command: "swebench-official-evaluation", timeoutMs: 300_000 }] });
    const configuration = { task: { content: spec, sha256: sha256Json(spec) },
      agent: { appVersion: "1", promptPolicyVersion: 4, model: { provider: "mock", id: "mock" }, modelConfig: { requestTimeoutMs: 300_000, maxOutputTokens: 4096, taskTimeoutMs: 900_000, baseUrlSha256: "a".repeat(64) }, thinkingLevel: "high", sessionMode: "ephemeral" as const },
      setup: { source: "disabled" as const, commands: [], sha256: sha256Json([]) },
      policy: { allowShell: true, allowedPaths: ["**/*"], tools: ["bash"] }, contextFiles: [],
      verifier: { commands: spec.verify, sha256: sha256Json(spec.verify) } };
    return { task, image: `swe:${number}`, imageId: `sha256:${String(number).repeat(64)}`, configuration, configurationSha256: sha256Json(configuration) };
  });
  const protocol: SweCandidateProtocol = { candidate, sourceTask: tasks[0]!.task, tasks, pairs: 3 };
  const runs: SweCandidateEvidence["runs"] = [];
  for (const frozen of tasks) for (let pairIndex = 0; pairIndex < 3; pairIndex++) for (const arm of ["control", "treatment"] as const) {
    const runId = `run-${frozen.task.instance_id}-${pairIndex}-${arm}`;
    const resolved = arm === "treatment";
    const manifest: RunManifest = { schemaVersion: 1, runId, kind: "run", createdAt: "2026-09-16T00:00:00.000Z", sourceRepository: "D:/fixture", baselineCommit: frozen.task.base_commit, replayable: false, ...structuredClone(frozen.configuration) };
    const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20, cost: 0.5 };
    const patch = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-old\n+new\n";
    const result = { schemaVersion: 1 as const, runId, manifestSha256: sha256Json(manifest), startedAt: manifest.createdAt, completedAt: manifest.createdAt,
      status: resolved ? "verification_passed" as const : "verification_failed" as const,
      workspace: { path: "D:/fixture", branch: "container-snapshot", baselineCommit: manifest.baselineCommit, managedWorktree: false },
      verification: { configured: true, success: resolved, changedFiles: ["app.py"], disallowedChangedFiles: [], commands: [{ command: "swebench-official-evaluation", status: resolved ? "passed" as const : "failed" as const, exitCode: resolved ? 0 : 1, stdout: JSON.stringify({ resolved, emptyPatch: false }), stderr: "", durationMs: 0, outputTruncated: false }] },
      diffSummary: patch, durationMs: 100, toolCallCount: 1, retryCount: 0, errorCount: 0, errors: [], usage };
    const injected = arm === "treatment" ? candidate : null;
    const base = formatTaskPrompt(manifest.task.content, manifest.task.content.objective);
    runs.push({ taskId: frozen.task.instance_id, pairIndex, arm, runId, bundle: { directory: "D:/fixture", manifest, result }, imageId: frozen.imageId,
      benchmark: { phase: arm === "control" ? "control" : "experience", instanceId: frozen.task.instance_id, image: frozen.image, container: `container-${runId}`, toolset: "isolated-bash", candidate: injected,
        promptSha256: sha256Text(injected ? renderCandidatePrompt(base, injected) : base), policySha256: sha256Text(taskPolicyText(manifest.task.content)) },
      trial: { instanceId: frozen.task.instance_id, runId, resolved, usage, usageComplete: true, durationMs: 100, executionError: null, evaluationError: null },
      score: { completed: true, resolved, emptyPatch: false }, modelPatch: patch, modelPatchSha256: sha256Text(patch) });
  }
  return { protocol, evidence: { runs, integrityIssues: [] } };
}

function setResolved(run: SweCandidateEvidence["runs"][number], resolved: boolean): void {
  run.trial.resolved = resolved;
  run.score.resolved = resolved;
  const result = run.bundle.result!;
  result.status = resolved ? "verification_passed" : "verification_failed";
  result.verification!.success = resolved;
  const command = result.verification!.commands[0]!;
  command.status = resolved ? "passed" : "failed";
  command.exitCode = resolved ? 0 : 1;
  command.stdout = JSON.stringify({ resolved, emptyPatch: false });
}

describe("SWE candidate evidence audit", () => {
  it("recomputes six complete winning pairs without claiming promotion", () => {
    const { protocol, evidence } = fixture();
    const before = JSON.stringify({ protocol, evidence });
    const audit = auditSweCandidate(protocol, evidence);
    expect(audit.eligible).toBe(true);
    expect(audit.reasons).toEqual([]);
    expect(audit.tasks.map((task) => [task.completedPairs, task.pairedWins, task.pairedLosses, task.outcome])).toEqual([[3, 3, 0, "improved"], [3, 3, 0, "improved"]]);
    expect(audit.usage.totalTokens).toBe(240);
    expect(audit.usage.totalCost).toBe(6);
    expect(JSON.stringify({ protocol, evidence })).toBe(before);
  });

  it("rejects no improvement", () => {
    const { protocol, evidence } = fixture();
    evidence.runs.forEach((run) => setResolved(run, true));
    expect(auditSweCandidate(protocol, evidence).eligible).toBe(false);
  });

  it("rejects one pair loss even when aggregate gains are positive", () => {
    const { protocol, evidence } = fixture();
    setResolved(evidence.runs[0]!, true);
    setResolved(evidence.runs[1]!, false);
    const audit = auditSweCandidate(protocol, evidence);
    expect(audit.eligible).toBe(false);
    expect(audit.tasks[0]!.pairedLosses).toBe(1);
  });

  it.each([
    ["missing run", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs.pop(); }],
    ["duplicate run", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs[1]!.runId = e.runs[0]!.runId; }],
    ["duplicate container", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs[1]!.benchmark.container = e.runs[0]!.benchmark.container; }],
    ["candidate tamper", (p: SweCandidateProtocol) => { p.candidate.content += " Changed"; }],
    ["same problem new ID", (p: SweCandidateProtocol) => { p.tasks[1]!.task.problem_statement = p.tasks[0]!.task.problem_statement; }],
    ["cross repository", (p: SweCandidateProtocol) => { p.tasks[1]!.task.repo = "other/project"; }],
    ["two pairs", (p: SweCandidateProtocol) => { p.pairs = 2; }],
    ["image drift", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs[0]!.imageId = "sha256:" + "9".repeat(64); }],
    ["model drift", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs[0]!.bundle.manifest.agent.model.id = "changed"; }],
    ["trial-score contradiction", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs[0]!.trial.resolved = true; }],
    ["execution failure disguised by trial", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs[0]!.bundle.result!.status = "execution_failed"; }],
    ["protected file", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs[0]!.bundle.result!.verification!.changedFiles.push(".env"); }],
    ["source or verifier issue", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.integrityIssues.push("existing tests were disabled"); }],
    ["patch drift", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs[0]!.modelPatch += "x"; }],
    ["incomplete evaluator", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs[0]!.score.completed = false; }],
    ["prompt drift", (p: SweCandidateProtocol, e: SweCandidateEvidence) => { e.runs[0]!.benchmark.promptSha256 = "0".repeat(64); }],
  ] as const)("rejects %s", (_label, mutate) => {
    const { protocol, evidence } = fixture();
    mutate(protocol, evidence);
    const audit = auditSweCandidate(protocol, evidence);
    expect(audit.eligible).toBe(false);
    expect(audit.reasons.length).toBeGreaterThan(0);
  });

  it("keeps incomplete usage unknown while preserving recorded costs", () => {
    const { protocol, evidence } = fixture();
    evidence.runs[0]!.trial.usageComplete = false;
    const audit = auditSweCandidate(protocol, evidence);
    expect(audit.usage.totalTokens).toBeNull();
    expect(audit.usage.totalCost).toBeNull();
    expect(audit.usage.knownTokens).toBe(240);
    expect(audit.usage.knownCost).toBe(6);
  });

  it("rejects limits absent from both frozen and actual configuration", () => {
    const { protocol, evidence } = fixture();
    for (const frozen of protocol.tasks) {
      delete frozen.configuration.agent.modelConfig;
      frozen.configurationSha256 = sha256Json(frozen.configuration);
    }
    for (const run of evidence.runs) {
      delete run.bundle.manifest.agent.modelConfig;
      run.bundle.result!.manifestSha256 = sha256Json(run.bundle.manifest);
    }
    expect(auditSweCandidate(protocol, evidence).eligible).toBe(false);
  });

  it("rejects changing model between tasks even with internally consistent fingerprints", () => {
    const { protocol, evidence } = fixture();
    const changed = protocol.tasks[1]!;
    changed.configuration.agent.model.id = "other-model";
    changed.configurationSha256 = sha256Json(changed.configuration);
    for (const run of evidence.runs.filter((run) => run.taskId === changed.task.instance_id)) {
      run.bundle.manifest.agent.model.id = "other-model";
      run.bundle.result!.manifestSha256 = sha256Json(run.bundle.manifest);
    }
    expect(auditSweCandidate(protocol, evidence).eligible).toBe(false);
  });

  it("rejects arm configuration drift even after recomputing manifest hash", () => {
    const { protocol, evidence } = fixture();
    const run = evidence.runs[0]!;
    run.bundle.manifest.agent.model.id = "other-model";
    run.bundle.result!.manifestSha256 = sha256Json(run.bundle.manifest);
    expect(auditSweCandidate(protocol, evidence).eligible).toBe(false);
  });

  it("does not mistake a truncated diff summary for full patch evidence", () => {
    const { protocol, evidence } = fixture();
    evidence.runs[0]!.bundle.result!.diffSummary = "short or redacted summary";
    expect(auditSweCandidate(protocol, evidence).eligible).toBe(true);
  });

  it("counts recorded usage from distinct runs even when container reuse invalidates evidence", () => {
    const { protocol, evidence } = fixture();
    evidence.runs[1]!.benchmark.container = evidence.runs[0]!.benchmark.container;
    const audit = auditSweCandidate(protocol, evidence);
    expect(audit.eligible).toBe(false);
    expect(audit.totals.runs).toBe(12);
    expect(audit.usage.knownCost).toBe(6);
    expect(audit.usage.totalCost).toBeNull();
  });
});
