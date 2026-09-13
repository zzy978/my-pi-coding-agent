import { describe, expect, it } from "vitest";
import { retrieveGuidance, pairedSchedule, holdoutSummary, validateHoldoutTasks, type LibraryEntry } from "../src/benchmark/swe-holdout.js";
import { sha256Text } from "../src/evaluation/schema.js";
import { updateModelOutcome, type SweTask, type SweTrial } from "../src/benchmark/swe-mini.js";

const task: SweTask = { instance_id: "django__django-123", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "Validate username length before authentication" };
const entry = (id: string, content: string): LibraryEntry => ({ sourceTaskId: "django__django-1", sourceExperienceId: "e1", sourceRunId: "r1", title: content, applicability: [], contraindications: [], candidate: { id, kind: "strategy", content, contentSha256: sha256Text(content), rendererVersion: 1 } });

describe("跨任务经验库", () => {
  it("成功消息缺失usage也保持未知，后续正常消息不能抹除", () => {
    const state = { error: null as string | null, usageComplete: true };
    updateModelOutcome(state, { stopReason: "stop", totalTokens: 0 });
    updateModelOutcome(state, { stopReason: "stop", totalTokens: 123 });
    expect(state.usageComplete).toBe(false);
  });
  it("只用公开问题检索，忽略答案、评分测试和其他臂结果", () => {
    const library = [entry("a", "Check username length validation"), entry("b", "Inspect network request redirect headers")];
    const expected = retrieveGuidance(task, library);
    expect(expected.selected.map((x) => x.id)).toEqual(["a"]);
    expect(retrieveGuidance({ ...task, patch: "network request redirect headers", result: true } as SweTask, library)).toEqual(expected);
    expect(expected.candidate?.content).toContain("Check username length");
  });
  it("无相关经验返回空；最多3条；损坏哈希拒绝", () => {
    expect(retrieveGuidance(task, [entry("x", "Plot color limits")]).candidate).toBeNull();
    const library = Array.from({ length: 5 }, (_, i) => entry(String(i), `username length validation detail ${i}`));
    expect(retrieveGuidance(task, library).selected).toHaveLength(3);
    library[0]!.candidate.content = "tampered";
    expect(() => retrieveGuidance(task, library)).toThrow();
  });
  it("固定40题的两臂顺序平衡，每题每臂只出现一次", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => ({ ...task, instance_id: `django__django-${i}` }));
    const schedule = pairedSchedule(tasks);
    expect(schedule).toHaveLength(80);
    expect(schedule.filter((_, i) => i % 2 === 0).filter((x) => x.arm === "control")).toHaveLength(20);
    expect(new Set(schedule.map((x) => `${x.instanceId}:${x.arm}`)).size).toBe(80);
  });
  it("拒绝来源题、重复问题或错误仓库配额", () => {
    expect(() => validateHoldoutTasks([task], [task])).toThrow();
  });
  it("缺失usage不参与配对成本，共同成功任务单独计量", () => {
    const trial = (id: string, total: number, complete = true): SweTrial => ({ instanceId: id, runId: id, resolved: true, usage: {input:total,output:0,cacheRead:0,cacheWrite:0,total,cost:0}, usageComplete:complete,durationMs:1,executionError:null });
    const other = { ...task, instance_id: "pytest-dev__pytest-123", repo: "pytest-dev/pytest" };
    const result = holdoutSummary([task,other], [trial(task.instance_id,100),trial(other.instance_id,10,false)], [trial(task.instance_id,80),trial(other.instance_id,5)]);
    expect(result.overall.completeUsagePairs).toMatchObject({ count:1, control:100, experience:80 });
    expect(result.overall.control.totalTokens).toBeNull();
    expect(result.sameRepository.taskCount).toBe(1);
    expect(result.newRepository.taskCount).toBe(1);
  });
});
