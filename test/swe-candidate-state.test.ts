import { describe, expect, it } from "vitest";
import { executeCandidatePairs, type CandidateBatch } from "../src/benchmark/swe-candidate-state.js";
import type { SweTrial } from "../src/benchmark/swe-mini.js";

const tasks = ["django__django-1", "django__django-2"];
const state = (): CandidateBatch => ({ version: 1, protocolSha256: "frozen", status: "ready", trials: [], current: null });
const trial = (instanceId: string, runId: string): SweTrial => ({ instanceId, runId, resolved: true, usage: null,
  usageComplete: false, durationMs: 1, executionError: null, evaluationError: null });

describe("SWE 单候选重复配对", () => {
  it("两题各三对运行十二次，交替顺序并保留独立槽位", async () => {
    const batch = state(); const order: string[] = []; const saved: string[] = [];
    await executeCandidatePairs(tasks, 3, batch, { save: () => { saved.push(JSON.stringify(batch)); return Promise.resolve(); },
      recover: () => { throw new Error("unexpected recovery"); }, run: async (slot, started) => {
        order.push(`${slot.taskId}:${slot.pairIndex}:${slot.arm}`);
        expect(batch.current).toEqual(slot);
        const id = `run-${order.length}`; await started(id); return trial(slot.taskId, id);
      } });
    expect(order).toHaveLength(12);
    expect(order.slice(0, 6)).toEqual(["django__django-1:0:control", "django__django-1:0:treatment",
      "django__django-1:1:treatment", "django__django-1:1:control", "django__django-1:2:control", "django__django-1:2:treatment"]);
    expect(batch.trials).toHaveLength(12); expect(batch.status).toBe("completed"); expect(saved.length).toBeGreaterThan(12);
  });

  it("已完成记录恢复时不重复调用模型", async () => {
    const batch = state(); batch.current = { taskId: tasks[0]!, pairIndex: 0, arm: "control", runId: "paid" };
    let calls = 0;
    await executeCandidatePairs(tasks, 3, batch, { save: async () => {},
      recover: (slot) => Promise.resolve(trial(slot.taskId, "paid")), run: async (slot, started) => {
        const id = `new-${++calls}`; await started(id); return trial(slot.taskId, id);
      } });
    expect(calls).toBe(11); expect(batch.trials[0]?.trial.runId).toBe("paid");
  });

  it("未知中断、重复runId和身份不符均拒绝，不盲目付费重跑", async () => {
    const batch = state(); batch.current = { taskId: tasks[0]!, pairIndex: 0, arm: "control" };
    const deps = { save: async () => {}, recover: () => { throw new Error("unexpected"); }, run: () => { throw new Error("paid"); } };
    await expect(executeCandidatePairs(tasks, 3, batch, deps)).rejects.toThrow("Unknown interrupted");
    batch.current = null;
    batch.trials = [{ taskId: tasks[0]!, pairIndex: 0, arm: "control", trial: trial(tasks[0]!, "same") },
      { taskId: tasks[0]!, pairIndex: 0, arm: "treatment", trial: trial(tasks[0]!, "same") }];
    await expect(executeCandidatePairs(tasks, 3, batch, deps)).rejects.toThrow("Duplicate");
  });

  it("基础设施错误先保存结果后停止，模型未启动后续槽位", async () => {
    const batch = state(); let calls = 0;
    await expect(executeCandidatePairs(tasks, 3, batch, { save: async () => {}, recover: () => { throw new Error("unexpected"); },
      run: async (slot, started) => { calls++; await started("failed"); return { ...trial(slot.taskId, "failed"), resolved: null, executionError: "score unavailable" }; }
    })).rejects.toThrow("Infrastructure");
    expect(calls).toBe(1); expect(batch.trials).toHaveLength(1); expect(batch.current).toBeNull(); expect(batch.status).toBe("stopped");
  });
});
