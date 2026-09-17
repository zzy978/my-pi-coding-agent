import { validateTrial } from "./swe-holdout.js";
import type { SweTrial } from "./swe-mini.js";

export interface CandidateSlot { taskId: string; pairIndex: number; arm: "control" | "treatment" }
export interface CandidateBatch {
  version: 1;
  protocolSha256: string;
  status: "ready" | "running" | "stopped" | "completed";
  trials: Array<CandidateSlot & { trial: SweTrial }>;
  current: (CandidateSlot & { runId?: string }) | null;
}

export function candidateSchedule(taskIds: string[], pairs: number): CandidateSlot[] {
  if (taskIds.length < 2 || taskIds.length > 20 || new Set(taskIds).size !== taskIds.length ||
    !taskIds.every((id) => /^[\w-]+__[\w-]+-\d+$/.test(id)) || !Number.isInteger(pairs) || pairs < 3 || pairs > 20) {
    throw new Error("Expected 2–20 unique tasks and 3–20 pairs");
  }
  return taskIds.flatMap((taskId) => Array.from({ length: pairs }, (_, pairIndex) =>
    (pairIndex % 2 ? ["treatment", "control"] as const : ["control", "treatment"] as const)
      .map((arm) => ({ taskId, pairIndex, arm }))).flat());
}

const key = (slot: CandidateSlot): string => `${slot.taskId}/${slot.pairIndex}/${slot.arm}`;
const incomplete = (trial: SweTrial): boolean => trial.resolved === null || trial.executionError !== null || Boolean(trial.evaluationError);

/** 每个付费槽位先落盘；未知中断不可自动重跑，失败记录不可覆盖。 */
export async function executeCandidatePairs(taskIds: string[], pairs: number, batch: CandidateBatch, deps: {
  save: () => Promise<void>;
  recover: (slot: CandidateSlot & { runId: string }) => Promise<SweTrial>;
  run: (slot: CandidateSlot, started: (runId: string) => Promise<void>) => Promise<SweTrial>;
}): Promise<void> {
  const schedule = candidateSchedule(taskIds, pairs);
  if (batch.version !== 1 || !Array.isArray(batch.trials)) throw new Error("Invalid batch");
  const slots = new Set<string>(), runs = new Set<string>();
  const validate = (slot: CandidateSlot, trial: SweTrial): void => {
    if (!schedule.some((expected) => key(expected) === key(slot))) throw new Error("Unknown trial slot");
    validateTrial(trial, slot.taskId, trial.runId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(trial.runId)) throw new Error("Invalid run ID");
    if (slots.has(key(slot)) || runs.has(trial.runId)) throw new Error("Duplicate slot or run ID");
    slots.add(key(slot)); runs.add(trial.runId);
  };
  for (const entry of batch.trials) validate(entry, entry.trial);
  if (batch.current) {
    const current = batch.current;
    if (!current.runId) throw new Error("Unknown interrupted paid attempt; inspect before resuming");
    if (!schedule.some((slot) => key(slot) === key(current)) || slots.has(key(current)) || runs.has(current.runId)) throw new Error("Invalid interrupted slot");
    const trial = await deps.recover({ ...current, runId: current.runId });
    validateTrial(trial, current.taskId, current.runId); validate(current, trial);
    batch.trials.push({ taskId: current.taskId, pairIndex: current.pairIndex, arm: current.arm, trial });
    batch.current = null; await deps.save();
  }
  if (batch.trials.some((entry) => incomplete(entry.trial))) {
    batch.status = "stopped"; await deps.save(); throw new Error("Infrastructure or model error in recorded trial; no automatic retry");
  }
  batch.status = "running"; await deps.save();
  for (const slot of schedule) {
    if (slots.has(key(slot))) continue;
    batch.current = { ...slot }; await deps.save();
    const trial = await deps.run(slot, async (runId) => {
      if (batch.current?.runId || runs.has(runId)) throw new Error("Duplicate started run ID");
      batch.current = { ...slot, runId }; await deps.save();
    });
    if (!batch.current.runId) throw new Error("Run missing paid-start checkpoint");
    validateTrial(trial, slot.taskId, batch.current.runId); validate(slot, trial);
    batch.trials.push({ ...slot, trial }); batch.current = null; await deps.save();
    if (incomplete(trial)) {
      batch.status = "stopped"; await deps.save(); throw new Error("Infrastructure or model error; saved trial retained");
    }
  }
  batch.status = "completed"; await deps.save();
}
