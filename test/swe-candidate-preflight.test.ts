import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCandidatePreflight, verifyCandidatePreflight, type CandidatePreflightDependencies } from "../src/benchmark/swe-candidate-preflight.js";
import { sealFiles, type FileSeal } from "../src/benchmark/swe-candidate-storage.js";
import type { SweTask } from "../src/benchmark/swe-mini.js";

const protocolHash = "a".repeat(64);
const tasks: SweTask[] = [1, 2].map((id) => ({ instance_id: `django__django-${id}`, repo: "django/django", base_commit: String(id).repeat(40), problem_statement: `Issue ${id}` }));
interface Saved { protocolSha256: string; entries: Array<{ taskId: string; red: string; gold: string }>; files: FileSeal }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "picode-preflight-"));
  const calls: string[] = [];
  const dependencies: CandidatePreflightDependencies = {
    scorePatch: async (directory, taskId, patch, id) => {
      calls.push(`red:${taskId}`);
      const score = { completed: true, resolved: false };
      await writeFile(join(directory, `${id}.patch`), patch);
      await writeFile(join(directory, `${id}.score.json`), JSON.stringify(score));
      return score;
    },
    bridge: async (directory, args) => {
      calls.push(`gold:${args[1]}`);
      await writeFile(join(directory, `${args[3]}.score.json`), JSON.stringify({ completed: true, resolved: true }));
    }
  };
  return { root, dependencies, calls };
}
async function readSaved(root: string): Promise<Saved> { return JSON.parse(await readFile(join(root, "preflight.json"), "utf8")) as Saved; }
async function writeSaved(root: string, value: unknown) { await writeFile(join(root, "preflight.json"), JSON.stringify(value)); }

describe("SWE 单候选完整预检封存", () => {
  it("封存两题红金评分及红补丁，恢复验证时不重复执行评分", async () => {
    const { root, dependencies, calls } = await fixture();
    await ensureCandidatePreflight(root, protocolHash, tasks, dependencies);
    expect(calls).toEqual(["red:django__django-1", "gold:django__django-1", "red:django__django-2", "gold:django__django-2"]);
    const saved = await readSaved(root);
    expect(saved.protocolSha256).toBe(protocolHash);
    expect(saved.entries.map((entry) => entry.taskId)).toEqual(tasks.map((task) => task.instance_id));
    expect(Object.keys(saved.files)).toHaveLength(6);
    expect(await verifyCandidatePreflight(root, protocolHash, tasks)).toEqual([]);
    await ensureCandidatePreflight(root, protocolHash, tasks, dependencies);
    expect(calls).toHaveLength(4);
  });

  it.each(["empty", "empty-files", "missing-task", "duplicate-task", "duplicate-score", "extra-file", "missing-file", "extra-field", "protocol-drift"])("拒绝无效封存 %s 且不覆盖历史", async (kind) => {
    const { root, dependencies, calls } = await fixture();
    await ensureCandidatePreflight(root, protocolHash, tasks, dependencies);
    const saved = await readSaved(root);
    if (kind === "empty-files") saved.files = {};
    if (kind === "missing-task") saved.entries.pop();
    if (kind === "duplicate-task") saved.entries[1]!.taskId = saved.entries[0]!.taskId;
    if (kind === "duplicate-score") saved.entries[1]!.red = saved.entries[0]!.red;
    if (kind === "extra-file") saved.files["other.score.json"] = "b".repeat(64);
    if (kind === "missing-file") delete saved.files[Object.keys(saved.files)[0]!];
    if (kind === "protocol-drift") saved.protocolSha256 = "b".repeat(64);
    const invalid = kind === "empty" ? {} : kind === "extra-field" ? { ...saved, trusted: true } : saved;
    await writeSaved(root, invalid);
    expect(await verifyCandidatePreflight(root, protocolHash, tasks)).not.toEqual([]);
    await expect(ensureCandidatePreflight(root, protocolHash, tasks, dependencies)).rejects.toThrow();
    expect(calls).toHaveLength(4);
    expect(await readFile(join(root, "preflight.json"), "utf8")).toBe(JSON.stringify(invalid));
  });

  it.each(["red-pass", "gold-fail", "incomplete", "wrong-type", "official-incomplete", "patch"])("哈希一致也拒绝错误评分或补丁 %s", async (kind) => {
    const { root, dependencies } = await fixture();
    await ensureCandidatePreflight(root, protocolHash, tasks, dependencies);
    const saved = await readSaved(root), entry = saved.entries[0]!;
    if (kind === "patch") await writeFile(join(root, `${entry.red}.patch`), "changed baseline");
    else {
      const id = kind === "gold-fail" ? entry.gold : entry.red;
      await writeFile(join(root, `${id}.score.json`), JSON.stringify({ completed: kind !== "incomplete", resolved: kind === "wrong-type" ? "false" : kind === "red-pass", ...(kind === "official-incomplete" ? { officialCompleted: false, failureKind: "test_timeout" } : {}) }));
    }
    saved.files = await sealFiles(root, Object.keys(saved.files));
    await writeSaved(root, saved);
    expect(await verifyCandidatePreflight(root, protocolHash, tasks)).not.toEqual([]);
  });

  it("文件字节漂移会使已封存预检失效", async () => {
    const { root, dependencies } = await fixture();
    await ensureCandidatePreflight(root, protocolHash, tasks, dependencies);
    const saved = await readSaved(root);
    await writeFile(join(root, `${saved.entries[0]!.gold}.score.json`), "{}");
    expect(await verifyCandidatePreflight(root, protocolHash, tasks)).not.toEqual([]);
  });

  it("中途评分失败没有最终封存，重启使用新ID并保留已写历史", async () => {
    const { root, dependencies } = await fixture();
    await expect(ensureCandidatePreflight(root, protocolHash, tasks, { ...dependencies, bridge: () => Promise.reject(new Error("interrupted")) })).rejects.toThrow("interrupted");
    const before = await readdir(root);
    expect(before).not.toContain("preflight.json");
    const contents = await Promise.all(before.map((name) => readFile(join(root, name), "utf8")));
    await ensureCandidatePreflight(root, protocolHash, tasks, dependencies);
    expect(await verifyCandidatePreflight(root, protocolHash, tasks)).toEqual([]);
    expect(await Promise.all(before.map((name) => readFile(join(root, name), "utf8")))).toEqual(contents);
    expect((await readdir(root)).length).toBe(before.length + 7);
  });

  it("无效输入在任何评分前被拒绝", async () => {
    const { root, dependencies, calls } = await fixture();
    await expect(ensureCandidatePreflight(root, protocolHash, [tasks[0]!, tasks[0]!], dependencies)).rejects.toThrow();
    await expect(ensureCandidatePreflight(root, "bad", tasks, dependencies)).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(await verifyCandidatePreflight(root, protocolHash, tasks)).not.toEqual([]);
  });

  it("金补丁未通过时保留评分文件，但不创建可复用封存", async () => {
    const { root, dependencies } = await fixture();
    await expect(ensureCandidatePreflight(root, protocolHash, tasks, { ...dependencies, bridge: async (directory, args) => {
      await writeFile(join(directory, `${args[3]}.score.json`), JSON.stringify({ completed: true, resolved: false }));
    } })).rejects.toThrow("金成功");
    expect(await readdir(root)).not.toContain("preflight.json");
    expect(await verifyCandidatePreflight(root, protocolHash, tasks)).not.toEqual([]);
  });
});
