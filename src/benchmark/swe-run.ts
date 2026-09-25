import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ControlledPiRuntime } from "../runtime/controlled-pi-runtime.js";
import { RunRecorder } from "../evaluation/recorder.js";
import { parseTaskSpec, formatTaskPrompt } from "../task/task-spec.js";
import { renderCandidatePrompt, type CandidateSnapshot } from "../experience/candidate.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { isAllowedChangedPath } from "../policy/path-policy.js";
import { taskPolicyText } from "../policy/policy-extension.js";
import { sha256Text, sha256Json } from "../evaluation/schema.js";
import type { ModelConfig } from "../model-config.js";
import type { VerificationReport } from "../verifier/verifier.js";
import { updateModelOutcome, type SweTask, type SweTrial } from "./swe-mini.js";
import { startTaskContainer, stopTaskContainer, containerShell, collectContainerPatch, scorePatch } from "./swe-container.js";

export async function runSweTask(options: {
  task: SweTask; image: string; root: string; data: string; config: ModelConfig; phase: "R0" | "B" | "control" | "experience";
  candidate: CandidateSnapshot | null; started: (runId: string) => Promise<void>;
  expectedConfigurationSha256?: string;
}): Promise<SweTrial> {
  const { task, root, data, config } = options;
  const name = await startTaskContainer(task, options.image);
  let runtime: ControlledPiRuntime | undefined;
  const cwd = join(root, "workspaces", task.instance_id);
  await mkdir(cwd, { recursive: true });
  const spec = parseTaskSpec({ id: task.instance_id,
    objective: `Fix the following issue in ${task.repo}. All bash commands run in the isolated Linux repository /testbed, NOT the host working directory shown in system metadata. Python environment testbed is activated automatically. Inspect source, reproduce the issue with your own tests, implement a minimal fix, and test it. Hidden evaluation runs independently after you finish. Do not edit existing tests to evade checks.\n\n${task.problem_statement}`,
    verify: [{ command: "swebench-official-evaluation", timeoutMs: 300_000 }], doneWhen: ["The issue is fixed and existing behavior is preserved"] });
  try {
    runtime = await ControlledPiRuntime.create({ workspace: cwd, getTask: () => spec, noSession: true, allowShell: true,
      modelConfig: config, thinkingLevel: "high", agentDirectory: join(data, "agent"), remoteShell: containerShell(name) });
    const selected = runtime.session.model;
    if (!selected) throw new Error("No model available");
    const effective = { modelDefinitionSha256: sha256Json(selected), provider: selected.provider, id: selected.id, api: String(selected.api), baseUrlSha256: sha256Text(selected.baseUrl),
      contextWindow: selected.contextWindow, maxTokens: selected.maxTokens, thinkingLevel: runtime.session.thinkingLevel, limits: runtime.modelConfig };
    const effectivePath = join(root, "effective-model.json");
    try { if (sha256Json(JSON.parse(await readFile(effectivePath, "utf8"))) !== sha256Json(effective)) throw new Error("Effective model drift"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") await writeFile(effectivePath, JSON.stringify(effective, null, 2), { flag: "wx" }); else throw error; }
    const recorder = await RunRecorder.create({ kind: "run", task: spec, runtime,
      workspace: { sourceRoot: cwd, workspace: cwd, baselineCommit: task.base_commit, branch: "container-snapshot", managedWorktree: false },
      allowShell: true, noSession: true, setup: { source: "disabled", commands: [] }, dataDirectory: data });
    if (options.expectedConfigurationSha256 !== undefined) {
      const manifest = recorder.manifest;
      const configuration = { task: manifest.task, agent: manifest.agent, ...(manifest.setup ? { setup: manifest.setup } : {}),
        policy: manifest.policy, contextFiles: manifest.contextFiles, verifier: manifest.verifier };
      if (sha256Json(configuration) !== options.expectedConfigurationSha256) throw new Error("SWE run configuration drift before model request");
    }
    await options.started(recorder.manifest.runId);
    const base = formatTaskPrompt(spec, spec.objective);
    const prompt = options.candidate ? renderCandidatePrompt(base, options.candidate) : base;
    await writeFile(join(recorder.directory, "benchmark.json"), JSON.stringify({ phase: options.phase, instanceId: task.instance_id, image: options.image,
      container: name, toolset: "isolated-bash", candidate: options.candidate, promptSha256: sha256Text(prompt), policySha256: sha256Text(taskPolicyText(spec)) }, null, 2));
    recorder.record("setup_end", { success: true });
    let executionError: string | null = null;
    const outcome = { error: null as string | null, usageComplete: true };
    const unsubscribe = runtime.session.subscribe((event) => {
      recorder.recordAgentEvent(event);
      if (event.type === "message_end" && event.message.role === "assistant") {
        updateModelOutcome(outcome, { stopReason: event.message.stopReason, totalTokens: event.message.usage.totalTokens,
          ...(event.message.errorMessage ? { error: redactSensitiveText(event.message.errorMessage) } : {}) });
      }
    });
    const session = runtime.session;
    const timer = config.taskTimeoutMs > 0 ? setTimeout(() => { executionError = "Model task phase timed out"; outcome.usageComplete = false; session.abortRetry(); session.abortCompaction(); void session.abort().catch(() => undefined); }, config.taskTimeoutMs) : undefined;
    try { await session.prompt(prompt); }
    catch (error) { executionError = redactSensitiveText(error instanceof Error ? error.message : String(error)); outcome.usageComplete = false; }
    finally { clearTimeout(timer); unsubscribe(); }
    executionError ??= outcome.error;
    const { patch, files } = await collectContainerPatch(name);
    await writeFile(join(recorder.directory, "model.patch"), patch);
    const scoreId = recorder.manifest.runId;
    let resolved: boolean | null = null;
    let evaluationError: string | null = null;
    let verification: VerificationReport | undefined;
    try {
      const score = await scorePatch(root, task.instance_id, patch, scoreId);
      if (score.completed) {
        resolved = score.resolved;
        const disallowedChangedFiles = files.filter((p) => !isAllowedChangedPath(p));
        verification = { configured: true, success: score.resolved && !disallowedChangedFiles.length, changedFiles: files, disallowedChangedFiles,
          commands: [{ command: "swebench-official-evaluation", status: score.resolved ? "passed" : "failed", exitCode: score.resolved ? 0 : 1,
            stdout: JSON.stringify({ resolved: score.resolved, emptyPatch: score.emptyPatch ?? false }), stderr: "", durationMs: 0, outputTruncated: false }] };
      } else evaluationError = "Official evaluation incomplete; inspect evaluator logs";
    } catch (error) { evaluationError = redactSensitiveText(error instanceof Error ? error.message : String(error)); }
    executionError ??= evaluationError;
    const finalized = await recorder.finalize({ runtime, diffSummary: patch, ...(verification ? { verification } : {}), ...(executionError ? { executionError } : {}) });
    // Token counters are SDK-reported, including failed attempts and cache accounting.
    const trial: SweTrial = { instanceId: task.instance_id, runId: recorder.manifest.runId, resolved,
      usage: executionError && finalized.result.usage.total === 0 ? null : finalized.result.usage,
      usageComplete: outcome.usageComplete,
      durationMs: finalized.result.durationMs, executionError, evaluationError };
    await writeFile(join(recorder.directory, "trial.json"), JSON.stringify(trial, null, 2));
    return trial;
  } finally { runtime?.dispose(); await stopTaskContainer(name); }
}

export async function recoverTrial(data: string, runId: string): Promise<SweTrial> {
  return JSON.parse(await readFile(join(data, "runs", runId, "trial.json"), "utf8")) as SweTrial;
}
