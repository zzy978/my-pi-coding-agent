import { pairedSchedule, validateTrial, type Arm } from "./swe-holdout.js";
import type { SweTask, SweTrial } from "./swe-mini.js";

export interface HoldoutState {
  schemaVersion: 1; fingerprint: string; status: string;
  control: SweTrial[]; experience: SweTrial[];
  current: { instanceId: string; arm: Arm; runId?: string } | null;
}

function mustStop(trial: SweTrial): boolean {
  return trial.resolved === null || (trial.executionError !== null && trial.executionError !== "Model task phase timed out");
}

export function applyRegrade(trial: SweTrial, resolved: boolean): void {
  trial.resolved = resolved;
  if (trial.evaluationError && trial.executionError === trial.evaluationError) trial.executionError = null;
  trial.evaluationError = null;
}

/** Checkpoint before each potentially paid attempt; unknown outcomes never retry automatically. */
export async function executePairs(tasks: SweTask[], state: HoldoutState, dependencies: {
  save: () => Promise<void>;
  recover: (instanceId: string, arm: Arm, runId: string) => Promise<SweTrial>;
  run: (task: SweTask, arm: Arm, started: (runId: string) => Promise<void>) => Promise<SweTrial>;
}): Promise<void> {
  const schedule = pairedSchedule(tasks);
  if (state.current) {
    const { instanceId, arm, runId } = state.current;
    if (!runId || !schedule.some((entry) => entry.instanceId === instanceId && entry.arm === arm)) throw new Error("Interrupted attempt has unknown outcome; inspect before retrying paid work");
    const trial = validateTrial(await dependencies.recover(instanceId, arm, runId), instanceId, runId);
    if (state[arm].some((entry) => entry.instanceId === instanceId)) throw new Error("Duplicate recovered trial");
    state[arm].push(trial); state.current = null; await dependencies.save();
  }
  for (const arm of ["control", "experience"] as const) {
    if (new Set(state[arm].map((trial) => trial.instanceId)).size !== state[arm].length) throw new Error("Duplicate trial checkpoint");
    for (const trial of state[arm]) {
      validateTrial(trial, trial.instanceId, trial.runId);
      if (!tasks.some((task) => task.instance_id === trial.instanceId)) throw new Error("Unknown trial task");
      if (mustStop(trial)) {
        state.status = "stopped-infrastructure"; await dependencies.save();
        throw new Error("Incomplete scoring or infrastructure error in saved trial; inspect before resume");
      }
    }
  }
  state.status = "running"; await dependencies.save();
  for (const entry of schedule) {
    if (state[entry.arm].some((trial) => trial.instanceId === entry.instanceId)) continue;
    const task = tasks.find((item) => item.instance_id === entry.instanceId)!;
    state.current = entry; await dependencies.save();
    const trial = await dependencies.run(task, entry.arm, async (runId) => {
      state.current = { ...entry, runId }; await dependencies.save();
    });
    validateTrial(trial, entry.instanceId, state.current.runId ?? "");
    state[entry.arm].push(trial); state.current = null; await dependencies.save();
    if (mustStop(trial)) {
      state.status = "stopped-infrastructure"; await dependencies.save();
      throw new Error("Stopped after incomplete scoring or model infrastructure error; saved results preserved");
    }
  }
  state.status = "completed"; await dependencies.save();
}
