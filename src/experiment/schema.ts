import { isAbsolute } from "node:path";
import { assertArtifactId, parseCandidateSnapshot, type CandidateSnapshot } from "../experience/candidate.js";
import { EXPERIMENT_PROMPT_TIMEOUT_MS, sha256Json, type RunManifest, type RunResult } from "../evaluation/schema.js";
import type { RunBundle } from "../evaluation/store.js";

export type ExperimentOutcome = "observed_improvement" | "no_observed_gain" | "observed_regression" | "inconclusive" | "invalid_isolation";
export interface ExperimentTrial {
  pairIndex: number;
  arm: "control" | "treatment";
  runId: string;
  manifestSha256: string;
  resultSha256: string;
}
export interface ArmMetrics {
  runs: number; passed: number; durationMs: number; toolCalls: number; retries: number; tokens: number; cost: number;
}
export interface ExperimentBundle {
  schemaVersion: 1;
  id: string;
  sourceRunId: string;
  sourceRepository: string;
  sourceManifestSha256: string;
  taskSha256: string;
  baselineCommit: string;
  candidate: CandidateSnapshot;
  pairsRequested: number;
  pairsCompleted: number;
  createdAt: string;
  completedAt?: string;
  outcome: ExperimentOutcome;
  scopeViolations: number;
  trials: ExperimentTrial[];
  errors: string[];
  isolationDifferences: string[];
  metrics: { control: ArmMetrics; treatment: ArmMetrics; pairedWins: number; pairedLosses: number };
}

export function emptyArmMetrics(): ArmMetrics {
  return { runs: 0, passed: 0, durationMs: 0, toolCalls: 0, retries: 0, tokens: 0, cost: 0 };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Experiment object is invalid");
  return value as Record<string, unknown>;
}
function number(value: unknown, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new Error("Experiment number is invalid");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("Experiment hash is invalid");
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Experiment timestamp is invalid");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 300 || value.some((item) => typeof item !== "string" || item.length > 4_000)) throw new Error("Experiment string array is invalid");
  return value as string[];
}
function metrics(value: unknown): ArmMetrics {
  const item = object(value);
  return { runs: number(item.runs), passed: number(item.passed), durationMs: number(item.durationMs), toolCalls: number(item.toolCalls),
    retries: number(item.retries), tokens: number(item.tokens), cost: number(item.cost, false) };
}

export function parseExperiment(value: unknown): ExperimentBundle {
  const item = object(value);
  if (item.schemaVersion !== 1) throw new Error("Unsupported experiment schema version");
  const pairsRequested = number(item.pairsRequested);
  if (pairsRequested < 1 || pairsRequested > 100) throw new Error("Experiment pairs must be between 1 and 100");
  if (typeof item.sourceRepository !== "string" || !isAbsolute(item.sourceRepository)) throw new Error("Experiment sourceRepository must be absolute");
  if (typeof item.baselineCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(item.baselineCommit)) throw new Error("Experiment baseline commit is invalid");
  if (!["observed_improvement", "no_observed_gain", "observed_regression", "inconclusive", "invalid_isolation"].includes(String(item.outcome))) throw new Error("Experiment outcome is invalid");
  if (!Array.isArray(item.trials) || item.trials.length > pairsRequested * 2) throw new Error("Experiment trials are invalid");
  const seen = new Set<string>();
  const runIds = new Set<string>();
  const trials: ExperimentTrial[] = item.trials.map((value) => {
    const trial = object(value);
    const pairIndex = number(trial.pairIndex);
    if (pairIndex >= pairsRequested || (trial.arm !== "control" && trial.arm !== "treatment")) throw new Error("Experiment trial position is invalid");
    const key = `${pairIndex}:${trial.arm}`;
    const runId = assertArtifactId(trial.runId);
    if (seen.has(key) || runIds.has(runId)) throw new Error("Experiment contains duplicate trials");
    seen.add(key); runIds.add(runId);
    return { pairIndex, arm: trial.arm, runId, manifestSha256: hash(trial.manifestSha256), resultSha256: hash(trial.resultSha256) };
  });
  const summary = object(item.metrics);
  return {
    schemaVersion: 1, id: assertArtifactId(item.id), sourceRunId: assertArtifactId(item.sourceRunId),
    sourceRepository: item.sourceRepository, sourceManifestSha256: hash(item.sourceManifestSha256), taskSha256: hash(item.taskSha256),
    baselineCommit: item.baselineCommit, candidate: parseCandidateSnapshot(item.candidate), pairsRequested,
    pairsCompleted: number(item.pairsCompleted), createdAt: timestamp(item.createdAt),
    ...(item.completedAt === undefined ? {} : { completedAt: timestamp(item.completedAt) }),
    outcome: item.outcome as ExperimentOutcome, scopeViolations: number(item.scopeViolations), trials,
    errors: strings(item.errors), isolationDifferences: strings(item.isolationDifferences),
    metrics: { control: metrics(summary.control), treatment: metrics(summary.treatment), pairedWins: number(summary.pairedWins), pairedLosses: number(summary.pairedLosses) }
  };
}

export function trialIsolationDifferences(source: RunManifest, trial: RunManifest): string[] {
  const differences: string[] = [];
  const compare = (key: string, left: unknown, right: unknown): void => { if (sha256Json(left) !== sha256Json(right)) differences.push(key); };
  compare("sourceRepository", source.sourceRepository, trial.sourceRepository);
  compare("baselineCommit", source.baselineCommit, trial.baselineCommit);
  compare("task", source.task, trial.task);
  compare("model", source.agent.model, trial.agent.model);
  compare("thinkingLevel", source.agent.thinkingLevel, trial.agent.thinkingLevel);
  compare("appVersion", source.agent.appVersion, trial.agent.appVersion);
  compare("promptPolicyVersion", source.agent.promptPolicyVersion ?? null, trial.agent.promptPolicyVersion ?? null);
  compare("setup", source.setup ?? { source: "disabled", commands: [], sha256: sha256Json([]) }, trial.setup);
  compare("policy", source.policy, trial.policy);
  compare("contextFiles", source.contextFiles, trial.contextFiles);
  compare("verifier", source.verifier, trial.verifier);
  if (!trial.replayable || trial.agent.sessionMode !== "ephemeral") differences.push("workspace/session");
  return differences;
}

function addMetrics(target: ArmMetrics, result: RunResult): void {
  target.runs += 1;
  target.passed += Number(result.status === "verification_passed");
  target.durationMs += result.durationMs;
  target.toolCalls += result.toolCallCount;
  target.retries += result.retryCount;
  target.tokens += result.usage.total;
  target.cost += result.usage.cost;
}

/** Derives conclusions from bound run evidence, never from stored success booleans. */
export function summarizeExperiment(experiment: ExperimentBundle, source: RunManifest, runs: RunBundle[]): ExperimentBundle {
  if (experiment.sourceManifestSha256 !== sha256Json(source) || experiment.sourceRunId !== source.runId ||
      experiment.sourceRepository !== source.sourceRepository || experiment.taskSha256 !== source.task.sha256 || experiment.baselineCommit !== source.baselineCommit) {
    throw new Error("Experiment source evidence does not match");
  }
  const differences = new Set(experiment.isolationDifferences);
  const metrics = { control: emptyArmMetrics(), treatment: emptyArmMetrics(), pairedWins: 0, pairedLosses: 0 };
  const pairs = new Map<number, Partial<Record<"control" | "treatment", RunResult>>>();
  const workspacePaths = new Set<string>();
  let scopeViolations = 0;
  for (const trial of experiment.trials) {
    const bundle = runs.find((run) => run.manifest.runId === trial.runId);
    if (!bundle?.result || trial.manifestSha256 !== sha256Json(bundle.manifest) || trial.resultSha256 !== sha256Json(bundle.result)) throw new Error("Experiment trial evidence hash does not match");
    const context = bundle.manifest.experiment;
    if (!context || context.experimentId !== experiment.id || context.pairIndex !== trial.pairIndex || context.arm !== trial.arm ||
        (trial.arm === "treatment" && sha256Json(context.candidate) !== sha256Json(experiment.candidate))) throw new Error("Experiment trial metadata does not match");
    if ((context.promptTimeoutMs ?? EXPERIMENT_PROMPT_TIMEOUT_MS) !== EXPERIMENT_PROMPT_TIMEOUT_MS) differences.add("promptTimeoutMs");
    for (const difference of trialIsolationDifferences(source, bundle.manifest)) differences.add(difference);
    if (workspacePaths.has(bundle.result.workspace.path) || bundle.result.workspace.path === source.sourceRepository) differences.add("freshWorkspace");
    workspacePaths.add(bundle.result.workspace.path);
    addMetrics(metrics[trial.arm], bundle.result);
    scopeViolations += bundle.result.verification?.disallowedChangedFiles.length ?? 0;
    const pair = pairs.get(trial.pairIndex) ?? {};
    pair[trial.arm] = bundle.result;
    pairs.set(trial.pairIndex, pair);
  }
  let pairsCompleted = 0;
  for (const pair of pairs.values()) {
    if (!pair.control || !pair.treatment) continue;
    pairsCompleted += 1;
    const controlPassed = pair.control.status === "verification_passed";
    const treatmentPassed = pair.treatment.status === "verification_passed";
    metrics.pairedWins += Number(!controlPassed && treatmentPassed);
    metrics.pairedLosses += Number(controlPassed && !treatmentPassed);
  }
  const incomplete = !experiment.completedAt || pairsCompleted !== experiment.pairsRequested || source.verifier.commands.length === 0 || experiment.errors.length > 0 ||
    runs.some((run) => run.result?.status === "execution_failed" || run.result?.verification?.configured !== true);
  const outcome: ExperimentOutcome = differences.size ? "invalid_isolation" : incomplete ? "inconclusive" :
    scopeViolations > 0 || metrics.pairedLosses > 0 ? "observed_regression" : metrics.pairedWins > 0 ? "observed_improvement" : "no_observed_gain";
  return { ...experiment, pairsCompleted, scopeViolations, metrics, isolationDifferences: [...differences].sort(), outcome };
}
