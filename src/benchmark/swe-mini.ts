import { parseCandidateSnapshot, type CandidateSnapshot } from "../experience/candidate.js";
import { sha256Json, type RunUsage } from "../evaluation/schema.js";

export interface SweTask { instance_id: string; repo: string; base_commit: string; problem_statement: string }
export interface SweTrial {
  instanceId: string;
  runId: string;
  resolved: boolean | null;
  usage: RunUsage | null;
  usageComplete?: boolean;
  durationMs: number;
  executionError: string | null;
  evaluationError?: string | null;
}
export interface FrozenGuidance { candidate: CandidateSnapshot | null; sha256: string }

export async function regradeIncompleteTrials(trials: SweTrial[], grade: (trial: SweTrial) => Promise<boolean>): Promise<void> {
  for (const trial of trials) if (trial.resolved === null) trial.resolved = await grade(trial);
}

export function updateModelOutcome(state: { error: string | null; usageComplete: boolean }, message: { stopReason: string; error?: string; totalTokens: number }): void {
  if (!Number.isFinite(message.totalTokens) || message.totalTokens <= 0) state.usageComplete = false;
  if (["error", "aborted"].includes(message.stopReason)) {
    state.error = message.error ?? message.stopReason;
  } else state.error = null;
}

export function assertPhaseReady(ids: string[], completed: string[], guidance: Record<string, FrozenGuidance>): void {
  if (new Set(ids).size !== ids.length || completed.length !== ids.length || new Set(completed).size !== ids.length || ids.some((id) => !completed.includes(id))) throw new Error("R0 is incomplete");
  for (const id of ids) {
    const entry = guidance[id];
    if (!entry || entry.sha256 !== sha256Json(entry.candidate)) throw new Error("Missing or damaged frozen guidance");
    if (entry.candidate) parseCandidateSnapshot(entry.candidate);
  }
}

export function publicTask(value: unknown): SweTask {
  if (!value || typeof value !== "object") throw new Error("Invalid SWE task");
  const r = value as Record<string, unknown>;
  if (typeof r.instance_id !== "string" || !/^[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+-\d+$/.test(r.instance_id) ||
      typeof r.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(r.repo) ||
      typeof r.base_commit !== "string" || !/^[a-f0-9]{40}$/.test(r.base_commit) ||
      typeof r.problem_statement !== "string" || !r.problem_statement.trim()) throw new Error("Invalid SWE task fields");
  return { instance_id: r.instance_id, repo: r.repo, base_commit: r.base_commit, problem_statement: r.problem_statement };
}

/** Fixed first-candidate selection; no tuning against B outcomes. */
export function assertResumeB(ids: string[], trials: Array<{ instanceId: string; resolved: boolean | null }>): void {
  if (ids.length !== 50 || new Set(ids).size !== 50 || trials.length !== 50 ||
    new Set(trials.map((trial) => trial.instanceId)).size !== 50 ||
    trials.some((trial) => !ids.includes(trial.instanceId) || typeof trial.resolved !== "boolean")) {
    throw new Error("resume-b requires all 50 unique R0 tasks with completed scores; R0 will never be executed");
  }
}

export function freezeGuidance(candidates: CandidateSnapshot[]): FrozenGuidance {
  const parsed = candidates.map(parseCandidateSnapshot);
  const candidate = parsed[0] ?? null;
  return { candidate, sha256: sha256Json(candidate) };
}

export function summarizeRounds(ids: string[], r0: SweTrial[], b: SweTrial[]) {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("Empty or duplicate task IDs");
  const summarize = (trials: SweTrial[]) => {
    if (new Set(trials.map((t) => t.instanceId)).size !== trials.length || trials.some((t) => !ids.includes(t.instanceId))) throw new Error("Duplicate or unknown trial");
    const known = trials.filter((t) => t.usage !== null);
    const knownTokens = known.reduce((sum, t) => sum + t.usage!.total, 0);
    const knownCost = known.reduce((sum, t) => sum + t.usage!.cost, 0);
    const complete = known.length === ids.length && trials.every((t) => t.usageComplete !== false);
    const passed = trials.filter((t) => t.resolved === true).length;
    return { completed: trials.length, scored: trials.filter((t) => t.resolved !== null).length, passed, successRate: passed / ids.length,
      knownTokens, totalTokens: complete ? knownTokens : null, knownCost, totalCost: complete ? knownCost : null,
      tokenBreakdown: Object.fromEntries((["input", "output", "cacheRead", "cacheWrite"] as const).map((key) => [key, known.reduce((s, t) => s + t.usage![key], 0)])) };
  };
  const left = summarize(r0), right = summarize(b);
  const transitions = { improved: 0, regressed: 0, bothPassed: 0, bothFailed: 0, unpaired: 0 };
  const rows = ids.map((id) => {
    const a = r0.find((t) => t.instanceId === id), z = b.find((t) => t.instanceId === id);
    const category = a?.resolved == null || z?.resolved == null ? "unpaired" : a.resolved ? z.resolved ? "bothPassed" : "regressed" : z.resolved ? "improved" : "bothFailed";
    transitions[category]++;
    return { id, r0: a ?? null, b: z ?? null, category, tokenDelta: a?.usage && z?.usage && a.usageComplete !== false && z.usageComplete !== false ? z.usage.total - a.usage.total : null };
  });
  return { taskCount: ids.length, r0: left, b: right, transitions, rows,
    bothPassedTokenDelta: rows.filter((r) => r.category === "bothPassed").map((r) => ({ id: r.id, delta: r.tokenDelta })) };
}
