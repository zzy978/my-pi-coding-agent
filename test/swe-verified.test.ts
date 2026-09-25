import { describe, expect, it, vi } from "vitest";
import { assertVerifiedCoverage, VERIFIED_REPOSITORIES, selectDiverseTasks, experienceSkipReason, executeVerifiedTasks, type VerifiedState } from "../src/benchmark/swe-verified.js";
import type { SweTask, SweTrial } from "../src/benchmark/swe-mini.js";

const task = (repo: string, n: number): SweTask => ({ repo, instance_id: `${repo.replace("/", "__")}-${n}`, base_commit: "a".repeat(40), problem_statement: `${repo} issue ${n}` });
const trial = (t: SweTask): SweTrial => ({ instanceId: t.instance_id, runId: `run-${t.instance_id}`, resolved: true, usage: null, durationMs: 1, executionError: null });
const state = (): VerifiedState => ({ schemaVersion: 1, fingerprint: "test", status: "ready", trials: [], synthesis: {}, current: null });

describe("多仓库 Verified 单轮", () => {
  it("批次必须包含固定的全部12仓库", () => {
    expect(() => assertVerifiedCoverage(VERIFIED_REPOSITORIES.map((repo) => task(repo, 1)))).not.toThrow();
    expect(() => assertVerifiedCoverage(Array.from({ length: 50 }, (_, n) => task("django/django", n)))).toThrow("12 repositories");
  });
  it("固定50题覆盖全部仓库，排除历史ID和重复问题且忽略私有字段", () => {
    const rows = Array.from({ length: 12 }, (_, r) => Array.from({ length: r === 0 ? 1 : r === 1 ? 2 : 12 }, (_, n) => task(`repo${r}/project`, n))).flat();
    const excluded = rows.at(-1)!;
    const a = selectDiverseTasks(rows.map((r) => ({ ...r, patch: "secret answer" })), [excluded]);
    const b = selectDiverseTasks([...rows].reverse(), [excluded]);
    expect(a).toEqual(b); expect(a).toHaveLength(50);
    expect(new Set(a.map((r) => r.repo)).size).toBe(12);
    expect(a.some((r) => r.instance_id === excluded.instance_id)).toBe(false);
    expect(JSON.stringify(a)).not.toContain("secret answer");
    expect(selectDiverseTasks([...rows, { ...rows[4]!, instance_id: "copy__project-1" }], [excluded])).toHaveLength(50);
    expect(() => selectDiverseTasks(rows.slice(0, 10), [])).toThrow();
  });
  it("成功少于6次工具调用严格跳过；失败不受成功阈值影响", () => {
    expect(experienceSkipReason({ resolved: true, executionError: null, toolCallCount: 5 })).toBe("skipped-success-under-6");
    expect(experienceSkipReason({ resolved: true, executionError: null, toolCallCount: 6 })).toBeNull();
    expect(experienceSkipReason({ resolved: false, executionError: null, toolCallCount: 2 })).toBeNull();
    expect(experienceSkipReason({ resolved: null, executionError: null, toolCallCount: 8 })).toBe("skipped-invalid-execution");
    expect(experienceSkipReason({ resolved: true, executionError: "failed", toolCallCount: 8 })).toBe("skipped-invalid-execution");
  });
  it("每题只执行一次，恢复已完成任务不重跑，未知付费中断拒绝", async () => {
    const tasks = [task("repo/project", 1), task("repo/project", 2)];
    const batch = state(), save = vi.fn(() => Promise.resolve());
    const run = vi.fn((t: SweTask, started: (id: string) => Promise<void>) => started(`run-${t.instance_id}`).then(() => trial(t)));
    const analyze = vi.fn(() => Promise.resolve({ status: "completed", experienceId: "e", candidateIds: [], usage: null }));
    const prepare = vi.fn(() => Promise.resolve());
    const deps = { save, run, analyze, prepare, recover: () => Promise.reject(new Error("unknown outcome")) };
    await executeVerifiedTasks(tasks, batch, deps); await executeVerifiedTasks(tasks, batch, deps);
    expect(run).toHaveBeenCalledTimes(2); expect(analyze).toHaveBeenCalledTimes(2); expect(prepare).toHaveBeenCalledTimes(2);
    expect(batch.status).toBe("completed");
    batch.current = { phase: "run", instanceId: tasks[0]!.instance_id };
    await expect(executeVerifiedTasks(tasks, batch, deps)).rejects.toThrow(/unknown/i);
  });
  it("付费中断仅恢复已存运行，提炼中断不重复请求", async () => {
    const t = task("repo/project", 1), batch = state();
    batch.current = { phase: "run", instanceId: t.instance_id, runId: "run-saved" };
    const run = vi.fn(), analyze = vi.fn(() => Promise.resolve({ status: "completed", experienceId: "e", candidateIds: [], usage: null }));
    const deps = { save: () => Promise.resolve(), prepare: () => Promise.resolve(), run, analyze,
      recover: () => Promise.resolve({ ...trial(t), runId: "run-saved" }) };
    await executeVerifiedTasks([t], batch, deps); expect(run).not.toHaveBeenCalled();
    batch.current = { phase: "synthesis", instanceId: t.instance_id, runId: "run-saved" };
    await expect(executeVerifiedTasks([t], batch, deps)).rejects.toThrow(/unknown/i);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
});
