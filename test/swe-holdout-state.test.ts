import { expect, it, vi } from "vitest";
import { executePairs, applyRegrade, type HoldoutState } from "../src/benchmark/swe-holdout-state.js";
import type { SweTrial } from "../src/benchmark/swe-mini.js";
const task = { instance_id: "django__django-123", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "fix" };
const trial: SweTrial = { instanceId: task.instance_id, runId: "old", resolved: true, usage: null, durationMs: 1, executionError: null };
const state = (): HoldoutState => ({ schemaVersion: 1, fingerprint: "x", status: "ready", control: [], experience: [], current: null });
it("补评分只清除评分错误，不能抹除模型错误", () => {
  const scoring = { ...trial, resolved: null, executionError: "docker failed", evaluationError: "docker failed" };
  applyRegrade(scoring, true);
  expect(scoring).toMatchObject({ resolved: true, executionError: null, evaluationError: null });
  const model = { ...trial, resolved: null, executionError: "429", evaluationError: "docker failed" };
  applyRegrade(model, false);
  expect(model).toMatchObject({ resolved: false, executionError: "429" });
});
it("恢复设施错误仍停止，不能绕过停止条件继续付费", async () => {
  const s = state(); s.current = { instanceId: task.instance_id, arm: "control", runId: "old" };
  const run = vi.fn(() => Promise.resolve(trial));
  await expect(executePairs([task], s, { save: async () => {}, recover: () => Promise.resolve({ ...trial, resolved: false, executionError: "429" }), run })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
it("恢复已付费任务后只运行缺失实验臂", async () => {
  const s = state(); s.current = { instanceId: task.instance_id, arm: "control", runId: "old" };
  const calls: string[] = [];
  await executePairs([task], s, { save: async () => {}, recover: () => Promise.resolve(trial), run: async (_task, arm, started) => {
    calls.push(arm); expect(s.current?.arm).toBe(arm); await started("new"); return { ...trial, runId: "new" };
  } });
  expect(calls).toEqual(["experience"]); expect(s.status).toBe("completed");
});
it("未知中断或恢复结果身份不匹配时不付费重跑", async () => {
  const s = state(); s.current = { instanceId: task.instance_id, arm: "control" };
  const run = vi.fn(() => Promise.resolve(trial));
  const deps = { save: async () => {}, recover: () => Promise.resolve({ ...trial, instanceId: "wrong" }), run };
  await expect(executePairs([task], s, deps)).rejects.toThrow("unknown outcome");
  s.current.runId = "old";
  await expect(executePairs([task], s, deps)).rejects.toThrow("Invalid recovered trial");
  expect(run).not.toHaveBeenCalled();
});
it("评分设施失败先保存已知结果再停止；不启动下个臂", async () => {
  const s = state(); const run = vi.fn(async (_task, _arm, started: (id: string) => Promise<void>) => { await started("old"); return { ...trial, resolved: null }; });
  await expect(executePairs([task], s, { save: async () => {}, recover: () => Promise.resolve(trial), run })).rejects.toThrow("Stopped");
  expect(s.control).toHaveLength(1); expect(s.current).toBeNull(); expect(run).toHaveBeenCalledTimes(1);
});
