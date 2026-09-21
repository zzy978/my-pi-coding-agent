import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sha256Json, sha256Text } from "../src/evaluation/schema.js";
import { readModelConfig } from "../src/model-config.js";
import { freezeHoldoutRetrieval, holdoutCandidate } from "../src/benchmark/swe-holdout-retrieval.js";
import type { LibraryEntry } from "../src/benchmark/swe-holdout.js";
import type { SweTask } from "../src/benchmark/swe-mini.js";

const content = "Validate username length before authentication.";
const entry: LibraryEntry = { sourceTaskId: "django__django-1", sourceExperienceId: "e1", sourceRunId: "r1", title: "username length", applicability: ["username length"], contraindications: [],
  candidate: { id: "c1", kind: "strategy", content, contentSha256: sha256Text(content), rendererVersion: 1 } };
const task: SweTask = { instance_id: "django__django-2", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "username length fails" };
const card = { candidateId: "c1", contentSha256: entry.candidate.contentSha256, mechanism: "username length", triggers: ["username length"], exclusions: [], action: "validate username length", stage: "initial", keywords: ["username", "length"], sourceQuotes: ["username length"] };
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0.01 };
const decision = { candidateId: "c1", verdict: "direct", reason: "长度条件匹配", taskQuotes: ["username length"], experienceQuotes: ["username length"], contraindication: "absent", stage: "initial", redundantWith: null };
function options(root: string) {
  return { root, tasks: [task], entries: [entry], catalogSha256: "catalog", librarySha256: "library", sourceSha256: "source",
    model: { provider: "test", id: "test" }, dataDirectory: join(root, "agent-data"), modelConfig: readModelConfig({ path: null, env: {} }) };
}

describe("SWE holdout 冻结 V2", () => {
  it("同一批次并发准备不会重复付费请求", async () => {
    const root = await mkdtemp(join(tmpdir(), "holdout-v2-"));
    let announce!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const complete = vi.fn(async (_material: unknown, prompt: string) => {
      announce(); await gate;
      return { text: JSON.stringify(prompt.includes("ONE existing") ? card : { decisions: [decision] }) };
    });
    try {
      const input = { ...options(root), complete }, pending = freezeHoldoutRetrieval(input);
      await started;
      await expect(freezeHoldoutRetrieval(input)).rejects.toThrow("already active");
      release(); await pending; expect(complete).toHaveBeenCalledTimes(2);
    } finally { release(); await rm(root, { recursive: true, force: true }); }
  });
  it("真实索引和选择调用后冻结；恢复不再调用模型，两臂使用正确候选", async () => {
    const root = await mkdtemp(join(tmpdir(), "holdout-v2-"));
    const materials: unknown[] = [];
    const complete = vi.fn((material: unknown, prompt: string) => {
      materials.push(material);
      return Promise.resolve({ text: JSON.stringify(prompt.includes("ONE existing") ? card : { decisions: [decision] }), usage });
    });
    try {
      const input = { ...options(root), tasks: [{ ...task, patch: "hidden answer", score: 1, trace: "private trace" }], complete };
      const first = await freezeHoldoutRetrieval(input);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(materials)).not.toMatch(/hidden answer|private trace|"score"/);
      expect(first.retrieval[task.instance_id]?.selected.map((item) => item.id)).toEqual(["c1"]);
      expect(holdoutCandidate(first.retrieval, task.instance_id, "control")).toBeNull();
      expect(holdoutCandidate(first.retrieval, task.instance_id, "experience")?.content).toContain(content);
      expect(await freezeHoldoutRetrieval(input)).toEqual(first);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(await readFile(join(root, "retrieval-v2.json"), "utf8")).toContain("长度条件匹配");
      for (const change of [{ sourceSha256: "changed" }, { catalogSha256: "changed" }, { model: { provider: "test", id: "other" } }]) {
        await expect(freezeHoldoutRetrieval({ ...input, ...change })).rejects.toThrow(/drift/);
      }
      await writeFile(join(root, "retrieval.json"), "{}");
      await expect(freezeHoldoutRetrieval(input)).rejects.toThrow(/drift/);
      expect(complete).toHaveBeenCalledTimes(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("判定失败保留已知usage并冻结零注入，不会重试收费", async () => {
    const root = await mkdtemp(join(tmpdir(), "holdout-v2-"));
    const complete = vi.fn((_material: unknown, prompt: string) => Promise.resolve(prompt.includes("ONE existing")
      ? { text: JSON.stringify(card), usage } : { text: "", usage, error: "known failure" }));
    try {
      const input = { ...options(root), complete };
      const result = await freezeHoldoutRetrieval(input);
      expect(result.retrieval[task.instance_id]?.candidate).toBeNull();
      const saved = await readFile(join(root, "retrieval-v2.json"), "utf8");
      expect(saved).toContain("known failure"); expect(saved).toContain('"cost": 0.01');
      const snapshot = JSON.parse(saved) as { snapshot: { completed: boolean; tasks: Record<string, { status: string; result: { usage: unknown } | null }> }; sha256: string };
      expect(snapshot.snapshot.tasks[task.instance_id]?.result?.usage).toEqual(usage);
      await freezeHoldoutRetrieval(input);
      expect(complete).toHaveBeenCalledTimes(2);
      snapshot.snapshot.completed = false;
      snapshot.snapshot.tasks[task.instance_id] = { status: "pending", result: null };
      snapshot.sha256 = sha256Json(snapshot.snapshot);
      await writeFile(join(root, "retrieval-v2.json"), JSON.stringify(snapshot));
      expect((await freezeHoldoutRetrieval(input)).retrieval[task.instance_id]?.candidate).toBeNull();
      expect(complete).toHaveBeenCalledTimes(2);
      expect(await readFile(join(root, "retrieval-v2.json"), "utf8")).toContain("Interrupted applicability request");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
