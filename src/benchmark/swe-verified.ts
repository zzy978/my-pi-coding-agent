import { sha256Text, type RunUsage } from "../evaluation/schema.js";
import { publicTask, type SweTask, type SweTrial } from "./swe-mini.js";

export const VERIFIED_REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a";
export const VERIFIED_SEED = "verified-diverse50-20260921-v1";
export const VERIFIED_REPOSITORIES = ["astropy/astropy", "django/django", "matplotlib/matplotlib", "mwaskom/seaborn", "pallets/flask", "psf/requests", "pydata/xarray", "pylint-dev/pylint", "pytest-dev/pytest", "scikit-learn/scikit-learn", "sphinx-doc/sphinx", "sympy/sympy"] as const;
export function assertVerifiedCoverage(tasks: SweTask[]): void {
  const repos = new Set(tasks.map((task) => task.repo));
  if (repos.size !== VERIFIED_REPOSITORIES.length || VERIFIED_REPOSITORIES.some((repo) => !repos.has(repo))) throw new Error("Verified batch must cover all 12 repositories");
}
const normalized = (task: SweTask): string => task.problem_statement.toLowerCase().trim().replace(/\s+/g, " ");

/** 只使用公开字段；逐仓库轮转，避免大仓库占满名额。 */
export function selectDiverseTasks(rows: unknown[], excluded: SweTask[], count = 50): SweTask[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid sample size");
  const seenIds = new Set(excluded.map((task) => task.instance_id));
  const seenProblems = new Set(excluded.map(normalized));
  const ranked = rows.map(publicTask).sort((a, b) => sha256Text(`${VERIFIED_SEED}:${a.instance_id}`).localeCompare(sha256Text(`${VERIFIED_SEED}:${b.instance_id}`)));
  const groups = new Map<string, SweTask[]>();
  for (const task of ranked) {
    if (seenIds.has(task.instance_id) || seenProblems.has(normalized(task))) continue;
    seenIds.add(task.instance_id); seenProblems.add(normalized(task));
    const group = groups.get(task.repo) ?? []; group.push(task); groups.set(task.repo, group);
  }
  const repos = [...groups.keys()].sort();
  const selected: SweTask[] = [];
  while (selected.length < count) {
    let added = false;
    for (const repo of repos) {
      const next = groups.get(repo)!.shift();
      if (next) { selected.push(next); added = true; }
      if (selected.length === count) break;
    }
    if (!added) throw new Error("Insufficient unseen unique Verified tasks");
  }
  return selected;
}

export function experienceSkipReason(input: { resolved: boolean | null; executionError: string | null; toolCallCount: number }): string | null {
  if (input.resolved === null || input.executionError) return "skipped-invalid-execution";
  if (!Number.isSafeInteger(input.toolCallCount) || input.toolCallCount < 0) throw new Error("Invalid tool call count");
  return input.resolved && input.toolCallCount < 6 ? "skipped-success-under-6" : null;
}
export interface VerifiedSynthesis {
  status: string; experienceId: string | null; candidateIds: string[]; usage: RunUsage | null;
  indexes?: Array<{ candidateId: string; status: string; usage: RunUsage | null }>;
}
export interface VerifiedState {
  schemaVersion: 1; fingerprint: string; status: string; trials: SweTrial[];
  synthesis: Record<string, VerifiedSynthesis>;
  current: { phase: "prepare" | "run" | "synthesis"; instanceId: string; runId?: string } | null;
}
interface Execution {
  save: () => Promise<void>;
  prepare: (task: SweTask) => Promise<void>;
  run: (task: SweTask, started: (id: string) => Promise<void>) => Promise<SweTrial>;
  recover: (taskId: string, runId: string) => Promise<SweTrial>;
  analyze: (trial: SweTrial) => Promise<VerifiedSynthesis>;
}

/** 每项请求前落盘。未知的付费中断只允许人工核验，不能自动重试。 */
export async function executeVerifiedTasks(tasks: SweTask[], state: VerifiedState, deps: Execution): Promise<void> {
  const ids = new Set(tasks.map((task) => task.instance_id));
  if (ids.size !== tasks.length || new Set(state.trials.map((trial) => trial.instanceId)).size !== state.trials.length ||
    state.trials.some((trial) => !ids.has(trial.instanceId)) || Object.keys(state.synthesis).some((id) => !ids.has(id))) throw new Error("Verified task state binding mismatch");
  if (state.current) {
    const current = state.current;
    if (!ids.has(current.instanceId)) throw new Error("Unknown current task");
    if (current.phase !== "prepare") {
      if (current.phase !== "run" || !current.runId || state.trials.some((trial) => trial.instanceId === current.instanceId)) throw new Error("Interrupted request has unknown outcome; refusing paid retry");
      const recovered = await deps.recover(current.instanceId, current.runId);
      if (recovered.instanceId !== current.instanceId || recovered.runId !== current.runId) throw new Error("Recovered trial binding mismatch");
      state.trials.push(recovered);
    }
    state.current = null; await deps.save();
  }
  for (const task of tasks) {
    let trial = state.trials.find((trial) => trial.instanceId === task.instance_id);
    if (!trial) {
      state.status = "preparing"; state.current = { phase: "prepare", instanceId: task.instance_id }; await deps.save();
      await deps.prepare(task);
      state.status = "running"; state.current = { phase: "run", instanceId: task.instance_id }; await deps.save();
      trial = await deps.run(task, async (runId) => { state.current = { phase: "run", instanceId: task.instance_id, runId }; await deps.save(); });
      if (trial.instanceId !== task.instance_id || trial.runId !== state.current?.runId) throw new Error("Run binding mismatch");
      state.trials.push(trial); state.current = null; await deps.save();
    }
    if (trial.resolved === null || (trial.executionError && !trial.executionError.includes("Model task phase timed out"))) {
      state.status = "stopped-infrastructure"; await deps.save(); throw new Error("Infrastructure/model error; inspect existing run before continuing");
    }
    if (!state.synthesis[task.instance_id]) {
      state.status = "synthesis"; state.current = { phase: "synthesis", instanceId: task.instance_id, runId: trial.runId }; await deps.save();
      state.synthesis[task.instance_id] = await deps.analyze(trial);
      state.current = null; await deps.save();
    }
  }
  state.status = "completed"; await deps.save();
}
