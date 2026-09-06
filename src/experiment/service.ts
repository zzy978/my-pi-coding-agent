import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { APP_VERSION } from "../config.js";
import { parseCandidateSnapshot, renderCandidatePrompt, type ExperienceCandidate } from "../experience/candidate.js";
import { assertRecordableCommands, assertRecordableTask, redactSensitiveText } from "../evaluation/redaction.js";
import { createReplayPlan } from "../evaluation/replay.js";
import { executeControlledRun } from "../evaluation/runner.js";
import { EXPERIMENT_PROMPT_TIMEOUT_MS, sha256Json, sha256Text, type RunManifest } from "../evaluation/schema.js";
import { assertRegularDirectory } from "../experience/artifact-io.js";
import { loadRunBundle, type RunBundle } from "../evaluation/store.js";
import { ControlledPiRuntime, type ControlledPiRuntimeOptions } from "../runtime/controlled-pi-runtime.js";
import { PROMPT_POLICY_VERSION, formatTaskPrompt } from "../task/task-spec.js";
import { discardManagedWorkspace, prepareWorkspace, type WorkspaceInfo } from "../workspace/git.js";
import { resolveSetupPlan } from "../workspace/setup.js";
import { emptyArmMetrics, summarizeExperiment, type ExperimentBundle } from "./schema.js";
import { saveExperiment } from "./store.js";

export interface ExperimentOptions {
  sourceRunId: string;
  candidate: ExperienceCandidate;
  dataDirectory: string;
  pairs?: number;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
}
export interface ExperimentDependencies {
  createRuntime?: (options: ControlledPiRuntimeOptions) => Promise<ControlledPiRuntime>;
}

function runtimeDifferences(source: RunManifest, runtime: ControlledPiRuntime): string[] {
  const differences: string[] = [];
  if (source.agent.appVersion !== APP_VERSION) differences.push("appVersion");
  if (source.agent.promptPolicyVersion !== PROMPT_POLICY_VERSION) differences.push("promptPolicyVersion");
  if (!runtime.hasAvailableModel || runtime.session.model?.provider !== source.agent.model.provider || runtime.session.model.id !== source.agent.model.id) differences.push("model");
  if (runtime.session.thinkingLevel !== source.agent.thinkingLevel) differences.push("thinkingLevel");
  if (sha256Json([...runtime.session.getActiveToolNames()].sort()) !== sha256Json(source.policy.tools)) differences.push("tools");
  if (sha256Json(runtime.contextFiles) !== sha256Json(source.contextFiles)) differences.push("contextFiles");
  return differences;
}

/** Candidate text is the only configurable treatment; all execution authority comes from the source run. */
export async function runExperiment(options: ExperimentOptions, dependencies: ExperimentDependencies = {}): Promise<ExperimentBundle> {
  const pairs = options.pairs ?? 3;
  if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 100) throw new Error("Experiment pairs must be between 1 and 100");
  const candidate = parseCandidateSnapshot(options.candidate);
  await assertRegularDirectory(options.dataDirectory);
  await assertRegularDirectory(join(options.dataDirectory, "runs"));
  const source = await loadRunBundle(options.sourceRunId, options.dataDirectory);
  if (!source.result) throw new Error("Experiment source run has no completed result");
  const plan = createReplayPlan(source.manifest);
  assertRecordableTask(plan.task);
  if (plan.setupPreference.mode === "resolved") assertRecordableCommands(plan.setupPreference.plan.commands, "Setup");
  let experiment: ExperimentBundle = {
    schemaVersion: 1, id: randomUUID(), sourceRunId: options.sourceRunId, sourceRepository: plan.sourceRepository,
    sourceManifestSha256: sha256Json(source.manifest), taskSha256: source.manifest.task.sha256, baselineCommit: plan.baselineCommit,
    candidate, pairsRequested: pairs, pairsCompleted: 0, createdAt: new Date().toISOString(), outcome: "inconclusive",
    scopeViolations: 0, trials: [], errors: [], isolationDifferences: [],
    metrics: { control: emptyArmMetrics(), treatment: emptyArmMetrics(), pairedWins: 0, pairedLosses: 0 }
  };
  await saveExperiment(experiment, options.dataDirectory, true);
  const runs: RunBundle[] = [];
  const createRuntime = dependencies.createRuntime ?? ((runtimeOptions) => ControlledPiRuntime.create(runtimeOptions));
  if (plan.task.verify.length === 0) experiment.errors.push("Source run has no verifier; experiment is inconclusive and no model was called.");
  else {
    try {
      for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
        const arms = pairIndex % 2 === 0 ? ["control", "treatment"] as const : ["treatment", "control"] as const;
        for (const arm of arms) {
          let workspace: WorkspaceInfo | undefined;
          let runtime: ControlledPiRuntime | undefined;
          try {
            options.signal?.throwIfAborted();
            options.onStatus?.(`Experiment ${experiment.id}: pair ${pairIndex + 1}/${pairs}, ${arm}`);
            workspace = await prepareWorkspace(plan.sourceRepository, { inPlace: false, dataDirectory: options.dataDirectory, baselineCommit: plan.baselineCommit, branchPrefix: "replay" });
            const setup = await resolveSetupPlan(workspace, plan.setupPreference);
            runtime = await createRuntime({ workspace: workspace.workspace, getTask: () => plan.task, noSession: true,
              allowShell: plan.allowShell, requestedModel: plan.requestedModel, thinkingLevel: plan.thinkingLevel, tools: plan.tools,
              agentDirectory: join(options.dataDirectory, "agent"), sessionDirectory: join(options.dataDirectory, "sessions", "controlled") });
            experiment.isolationDifferences.push(...runtimeDifferences(source.manifest, runtime));
            if (experiment.isolationDifferences.length > 0) throw new Error("Experimental runtime configuration differs from source; no prompt was submitted.");
            const basePrompt = formatTaskPrompt(plan.task, plan.task.objective);
            const finalized = await executeControlledRun({ kind: "run", runtime, task: plan.task, workspace, allowShell: plan.allowShell,
              noSession: true, setup, dataDirectory: options.dataDirectory, ...(options.onStatus ? { onStatus: options.onStatus } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
              experiment: { experimentId: experiment.id, pairIndex, arm,
                promptTimeoutMs: EXPERIMENT_PROMPT_TIMEOUT_MS,
                ...(arm === "treatment" ? { candidate } : {}),
                effectivePromptSha256: sha256Text(arm === "treatment" ? renderCandidatePrompt(basePrompt, candidate) : basePrompt) }
            });
            runs.push(finalized);
            experiment.trials.push({ pairIndex, arm, runId: finalized.manifest.runId,
              manifestSha256: sha256Json(finalized.manifest), resultSha256: sha256Json(finalized.result) });
            experiment = summarizeExperiment(experiment, source.manifest, runs);
            await saveExperiment(experiment, options.dataDirectory);
            options.signal?.throwIfAborted();
            if (finalized.result.status === "execution_failed") throw new Error(`Trial ${finalized.manifest.runId} failed during execution; experiment stopped.`);
          } finally {
            try { runtime?.dispose(); }
            finally { if (workspace) await discardManagedWorkspace(workspace); }
          }
        }
      }
    } catch (error) {
      experiment.errors.push(redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 4_000));
    }
  }
  if (options.signal?.aborted) experiment.errors.push("Experiment aborted; completed trial evidence is retained.");
  experiment.completedAt = new Date().toISOString();
  experiment = summarizeExperiment(experiment, source.manifest, runs);
  await saveExperiment(experiment, options.dataDirectory);
  return experiment;
}
