import { describe, expect, it } from "vitest";
import { publicTask, freezeGuidance, summarizeRounds, assertPhaseReady, updateModelOutcome, regradeIncompleteTrials, type SweTrial } from "../src/benchmark/swe-mini.js";
import { sha256Text } from "../src/evaluation/schema.js";

describe("SWE Mini 同题协议", () => {
  it("恢复时只重新评分未知项，保留原始run ID和token", async () => {
    const trials: SweTrial[] = [{ instanceId: "a", runId: "old-run", resolved: null, usage: null, durationMs: 1, executionError: "scorer" },
      { instanceId: "b", runId: "done-run", resolved: false, usage: null, durationMs: 2, executionError: null }];
    const called: string[] = [];
    await regradeIncompleteTrials(trials, (trial) => { called.push(trial.runId); return Promise.resolve(true); });
    expect(called).toEqual(["old-run"]);
    expect(trials[0]).toMatchObject({ runId: "old-run", resolved: true, usage: null });
  });
  it("成功重试清除最终失败，但保留缺失usage标记", () => {
    const state = { error: null as string | null, usageComplete: true };
    updateModelOutcome(state, { stopReason: "error", error: "429", totalTokens: 0 });
    updateModelOutcome(state, { stopReason: "stop", totalTokens: 12 });
    expect(state).toEqual({ error: null, usageComplete: false });
  });
  it("未完成全部 R0 或经验快照损坏时拒绝进入 B", () => {
    const g = freezeGuidance([]);
    expect(() => assertPhaseReady(["a"], [], { a: g })).toThrow();
    expect(() => assertPhaseReady(["a"], ["a"], { a: { ...g, sha256: "bad" } })).toThrow();
    expect(() => assertPhaseReady(["a"], ["a"], { a: g })).not.toThrow();
  });
  it("只向模型投影问题和原始提交，不传递答案或评分测试", () => {
    const task = publicTask({ instance_id: "django__django-123", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "Fix", patch: "SECRET", test_patch: "HIDDEN", hints_text: "ANSWER" });
    expect(Object.keys(task).sort()).toEqual(["base_commit", "instance_id", "problem_statement", "repo"]);
    expect(JSON.stringify(task)).not.toMatch(/SECRET|HIDDEN|ANSWER/);
    expect(() => publicTask({ ...task, instance_id: "../bad" })).toThrow();
  });
  it("按固定顺序选首个候选并验证哈希，允许零候选", () => {
    const candidate = { id: "c1", kind: "strategy" as const, content: "Check callers", contentSha256: sha256Text("Check callers"), rendererVersion: 1 as const };
    expect(freezeGuidance([candidate]).candidate?.id).toBe("c1");
    expect(freezeGuidance([]).candidate).toBeNull();
    expect(() => freezeGuidance([{ ...candidate, content: "changed" }])).toThrow();
  });
  it("按固定分母统计胜负，缺失数据不当成零；只在双方评分完成时配对", () => {
    const trial = (id: string, resolved: boolean | null, total: number): SweTrial => ({ instanceId: id, runId: id, resolved, usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, cost: 0 }, durationMs: 1, executionError: null });
    const report = summarizeRounds(["a", "b", "c"], [trial("a", false, 100), trial("b", true, 200)], [trial("a", true, 80), trial("b", false, 150), trial("c", null, 50)]);
    expect(report.r0.successRate).toBe(1 / 3);
    expect(report.r0.totalTokens).toBeNull();
    expect(report.b.totalTokens).toBe(280);
    const partial = trial("a", false, 100);
    partial.usageComplete = false;
    expect(summarizeRounds(["a"], [partial], []).r0.totalTokens).toBeNull();
    expect(summarizeRounds(["a"], [partial], []).r0.knownTokens).toBe(100);
    expect(report.transitions).toEqual({ improved: 1, regressed: 1, bothPassed: 0, bothFailed: 0, unpaired: 1 });
    expect(() => summarizeRounds(["a", "a"], [], [])).toThrow();
    expect(() => summarizeRounds(["a"], [trial("a", true, 1), trial("a", true, 2)], [])).toThrow();
  });
});
