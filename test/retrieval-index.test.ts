import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Text } from "../src/evaluation/schema.js";
import type { ExperienceCandidate } from "../src/experience/candidate.js";
import {
  candidateIndexPath,
  ensureSearchIndex,
  indexExperience,
  loadSearchIndex,
  toRetrievalEntry
} from "../src/experience/retrieval-index.js";
import type { ExperienceBundle } from "../src/experience/schema.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function candidate(id = "candidate-one", experienceId = "experience-one"): ExperienceCandidate {
  const content = "先读取失败断言，再围绕空数组补充最小回归测试。";
  return { id, kind: "strategy", content, contentSha256: sha256Text(content), rendererVersion: 1,
    sourceRunId: "run-one", sourceExperienceId: experienceId, createdAt: "2026-09-21T00:00:00.000Z",
    title: "空数组边界检查", applicability: ["数组边界失败"], contraindications: ["没有边界失败证据"] };
}

function response(entry = toRetrievalEntry(candidate())) {
  return JSON.stringify({ candidateId: entry.candidate.id, contentSha256: entry.candidate.contentSha256,
    mechanism: "空数组分支遗漏会导致边界断言失败", triggers: ["空数组断言失败"], exclusions: ["没有边界失败"],
    action: "先复现空数组断言，再修改最小分支", stage: "initial", keywords: ["空数组", "boundary"],
    sourceQuotes: [entry.candidate.content] });
}

async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "pi-retrieval-index-"));
  roots.push(dataDirectory);
  const item = candidate();
  await mkdir(join(dataDirectory, "experiences", item.sourceExperienceId), { recursive: true });
  return { dataDirectory, candidate: item, entry: toRetrievalEntry(item), path: candidateIndexPath(item, dataDirectory) };
}

describe("retrieval search index sidecars", () => {
  it("generates a bound card once and reuses the completed record", async () => {
    const value = await fixture();
    let calls = 0;
    const complete = () => { calls++; return Promise.resolve({ text: response(value.entry), usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, total: 7, cost: 0.001 } }); };
    const options = { model: { provider: "fixture", id: "model" }, dataDirectory: value.dataDirectory, complete };
    const first = await ensureSearchIndex(value.entry, value.path, options);
    const second = await ensureSearchIndex(value.entry, value.path, options);
    expect(first).toMatchObject({ status: "completed", card: { candidateId: value.candidate.id }, usage: { total: 7 }, model: options.model });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(await loadSearchIndex(value.entry, value.path)).toEqual(first);
  });

  it("persists a failed generation and does not retry it implicitly", async () => {
    const value = await fixture();
    let calls = 0;
    const complete = () => { calls++; return Promise.reject(new Error("Bearer private-index-token")); };
    const options = { model: { provider: "fixture", id: "model" }, dataDirectory: value.dataDirectory, complete };
    const first = await ensureSearchIndex(value.entry, value.path, options);
    const second = await ensureSearchIndex(value.entry, value.path, options);
    expect(first.status).toBe("failed");
    expect(first.card).toBeNull();
    expect(first.error).toBeTruthy();
    expect(JSON.stringify(first)).not.toContain("private-index-token");
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("retains billed usage when the returned card is malformed", async () => {
    const value = await fixture();
    const record = await ensureSearchIndex(value.entry, value.path, { model: { provider: "fixture", id: "model" },
      dataDirectory: value.dataDirectory, complete: () => Promise.resolve({ text: "{}",
        usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0.002 } }) });
    expect(record).toMatchObject({ status: "failed", usage: { total: 10, cost: 0.002 } });
  });

  it("rejects oversized model material before invoking an injected completion", async () => {
    const value = await fixture();
    const oversized = { ...value.entry, applicability: Array.from({ length: 40 }, (_item, index) => `${index}-${"边界".repeat(900)}`) };
    let calls = 0;
    const record = await ensureSearchIndex(oversized, value.path, { model: { provider: "fixture", id: "model" },
      dataDirectory: value.dataDirectory, complete: () => { calls++; return Promise.resolve({ text: response(oversized) }); } });
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/64000/);
    expect(calls).toBe(0);
  });

  it("fails closed when an existing sidecar is bound to different candidate metadata", async () => {
    const value = await fixture();
    await ensureSearchIndex(value.entry, value.path, { model: { provider: "fixture", id: "model" }, dataDirectory: value.dataDirectory,
      complete: () => Promise.resolve({ text: response(value.entry) }) });
    const changed = { ...value.entry, title: "被改写的标题" };
    await expect(loadSearchIndex(changed, value.path)).rejects.toThrow(/binding|hash/i);
    await expect(ensureSearchIndex(changed, value.path, { model: { provider: "fixture", id: "model" }, dataDirectory: value.dataDirectory,
      complete: () => Promise.reject(new Error("must not regenerate")) })).rejects.toThrow(/binding|hash/i);
  });

  it("coalesces concurrent generation so one candidate incurs one completion call", async () => {
    const value = await fixture();
    let calls = 0;
    const complete = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 20)); return { text: response(value.entry) }; };
    const options = { model: { provider: "fixture", id: "model" }, dataDirectory: value.dataDirectory, complete };
    const [left, right] = await Promise.all([
      ensureSearchIndex(value.entry, value.path, options), ensureSearchIndex(value.entry, value.path, options)
    ]);
    expect(left.status).toBe("completed");
    expect(right).toEqual(left);
    expect(calls).toBe(1);
  });

  it("does not let an in-flight request bypass a different entry binding", async () => {
    const value = await fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const first = ensureSearchIndex(value.entry, value.path, { model: { provider: "fixture", id: "model" },
      dataDirectory: value.dataDirectory, complete: async () => { await waiting; return { text: response(value.entry) }; } });
    const drifted = ensureSearchIndex({ ...value.entry, title: "并发漂移标题" }, value.path,
      { model: { provider: "fixture", id: "model" }, dataDirectory: value.dataDirectory, complete: () => Promise.reject(new Error("must not call")) });
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    await expect(drifted).rejects.toThrow(/binding|hash/i);
  });

  it("indexes every stored candidate without changing experience.json", async () => {
    const value = await fixture();
    const second = candidate("candidate-two");
    const bundle = { id: value.candidate.sourceExperienceId, candidates: [value.candidate, second],
      synthesis: { model: { provider: "fixture", id: "model" } } } as ExperienceBundle;
    const experiencePath = join(value.dataDirectory, "experiences", bundle.id, "experience.json");
    await writeFile(experiencePath, "immutable-source\n");
    let calls = 0;
    await indexExperience(bundle, value.dataDirectory, { complete: (material) => {
      calls++;
      const entry = material as ReturnType<typeof toRetrievalEntry>;
      return Promise.resolve({ text: response(entry) });
    } });
    expect(calls).toBe(2);
    expect((await loadSearchIndex(toRetrievalEntry(second), candidateIndexPath(second, value.dataDirectory)))?.status).toBe("completed");
    expect(await readFile(experiencePath, "utf8")).toBe("immutable-source\n");
  });
});
