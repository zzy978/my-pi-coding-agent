import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Text } from "../src/evaluation/schema.js";
import { initializeGitRepository } from "./helpers/git-repository.js";
import { listActiveCandidates, listPromotions, promoteCandidate, revokeCandidate } from "../src/experience/promotions.js";

const fixtures = vi.hoisted(() => ({ candidate: {} as Record<string, unknown>, runs: new Map<string, unknown>(), experiments: new Map<string, unknown>() }));
vi.mock("../src/experience/store.js", () => ({
  loadCandidate: (id: string) => {
    if (id !== fixtures.candidate.id) throw new Error("missing candidate");
    return Promise.resolve(structuredClone(fixtures.candidate));
  }
}));
vi.mock("../src/evaluation/store.js", () => ({
  loadRunBundle: (id: string) => {
    if (!fixtures.runs.has(id)) throw new Error("missing run");
    return Promise.resolve(structuredClone(fixtures.runs.get(id)));
  }
}));
vi.mock("../src/experiment/store.js", () => ({
  loadExperiment: (id: string) => {
    if (!fixtures.experiments.has(id)) throw new Error("invalid experiment evidence");
    return Promise.resolve(structuredClone(fixtures.experiments.get(id)));
  }
}));

let root: string;
let repository: string;
let dataDirectory: string;
let first: Record<string, unknown>;
let second: Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-promotion-test-"));
  repository = join(root, "repo");
  dataDirectory = join(root, "data");
  await initializeGitRepository(repository);
  fixtures.runs.clear();
  fixtures.experiments.clear();
  const content = "先定位失败断言，再修复对应分支，最后运行既定验证器。";
  fixtures.candidate = { id: "candidate-1", kind: "strategy", content, contentSha256: sha256Text(content), rendererVersion: 1,
    sourceRunId: "source", sourceExperienceId: "experience-1", createdAt: new Date().toISOString(),
    title: "依据断言定位", applicability: ["验证失败"], contraindications: ["没有验证器"] };
  fixtures.runs.set("source", { manifest: { sourceRepository: repository, task: { content: { id: "a", objective: "修复计数错误" } } } });
  fixtures.runs.set("holdout", { manifest: { sourceRepository: repository, task: { content: { id: "b", objective: "修复解析错误" } } } });
  first = { id: "e1", sourceRunId: "source", sourceRepository: repository, candidate: fixtures.candidate,
    pairsRequested: 3, pairsCompleted: 3, completedAt: new Date().toISOString(), outcome: "observed_improvement", scopeViolations: 0,
    errors: [], isolationDifferences: [] };
  second = { ...first, id: "e2", sourceRunId: "holdout", outcome: "no_observed_gain" };
  fixtures.experiments.set("e1", first);
  fixtures.experiments.set("e2", second);
});

afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

const promote = (approved = true, evidenceIds = ["e1", "e2"]) =>
  promoteCandidate({ candidateId: "candidate-1", evidenceIds, approved, dataDirectory });

describe("manual candidate promotion", () => {
  it("requires human confirmation, cross-task evidence and three complete pairs per experiment", async () => {
    await expect(promote(false)).rejects.toThrow(/确认/);
    await expect(promote(true, ["e1", "e1"])).rejects.toThrow(/不同任务|重复/);
    second.pairsCompleted = 1;
    await expect(promote()).rejects.toThrow(/3|完整/);
    expect(await listActiveCandidates(repository, dataDirectory)).toEqual([]);
  });

  it("does not count random task IDs as a held-out task", async () => {
    fixtures.runs.set("holdout", { manifest: { sourceRepository: repository, task: { content: { id: "different", objective: " 修复计数错误  " } } } });
    await expect(promote()).rejects.toThrow(/不同任务|来源任务/);
  });

  it.each(["observed_regression", "inconclusive", "invalid_isolation"])("rejects %s evidence", async (outcome) => {
    second.outcome = outcome;
    await expect(promote()).rejects.toThrow(/退化|隔离|证据/);
  });

  it("rejects scope violations, mismatched candidates and evidence from another repository", async () => {
    second.scopeViolations = 1;
    await expect(promote()).rejects.toThrow(/越界/);
    second.scopeViolations = 0;
    second.candidate = { ...fixtures.candidate, kind: "prompt" };
    await expect(promote()).rejects.toThrow(/候选/);
    second.candidate = fixtures.candidate;
    const other = join(root, "other");
    await initializeGitRepository(other);
    second.sourceRepository = other;
    await expect(promote()).rejects.toThrow(/仓库/);
  });

  it("records immutable approval and revocation history, scoped to the source repository", async () => {
    const event = await promote();
    expect(event.action).toBe("promote");
    expect(await listActiveCandidates(repository, dataDirectory)).toEqual([fixtures.candidate]);
    const other = join(root, "other");
    await initializeGitRepository(other);
    expect(await listActiveCandidates(other, dataDirectory)).toEqual([]);
    await expect(revokeCandidate({ candidateId: "candidate-1", dataDirectory, approved: false })).rejects.toThrow(/确认/);
    await revokeCandidate({ candidateId: "candidate-1", dataDirectory, approved: true });
    expect(await listActiveCandidates(repository, dataDirectory)).toEqual([]);
    const history = await listPromotions(repository, dataDirectory);
    expect(history.map((entry) => entry.action)).toEqual(["promote", "revoke"]);
    expect(history[0]).toEqual(event);
  });

  it("fails closed when candidate content or experiment evidence changes after approval", async () => {
    await promote();
    fixtures.candidate.content = String(fixtures.candidate.content) + " new";
    await expect(listActiveCandidates(repository, dataDirectory)).rejects.toThrow(/hash|哈希|候选/);
    fixtures.candidate.content = String(fixtures.candidate.content).replace(/ new$/, "");
    second.outcome = "observed_improvement";
    await expect(listActiveCandidates(repository, dataDirectory)).rejects.toThrow(/证据/);
  });

  it("rejects edited approval records and preserves prior event bytes", async () => {
    await promote();
    const [repoId] = await readdir(join(dataDirectory, "promotions"));
    const directory = join(dataDirectory, "promotions", repoId!, "events");
    const [filename] = await readdir(directory);
    const path = join(directory, filename!);
    const original = await readFile(path, "utf8");
    const envelope = JSON.parse(original) as { event: { contentSha256: string } };
    envelope.event.contentSha256 = "0".repeat(64);
    await writeFile(path, JSON.stringify(envelope));
    await expect(listActiveCandidates(repository, dataDirectory)).rejects.toThrow(/哈希/);
  });

  it("does not reactivate a candidate when the latest revocation file goes missing", async () => {
    await promote();
    await revokeCandidate({ candidateId: "candidate-1", dataDirectory, approved: true });
    const [repoId] = await readdir(join(dataDirectory, "promotions"));
    const directory = join(dataDirectory, "promotions", repoId!, "events");
    const filenames = (await readdir(directory)).sort();
    await unlink(join(directory, filenames.at(-1)!));
    await expect(listActiveCandidates(repository, dataDirectory)).rejects.toThrow(/历史|哈希/);
  });

  it("can revoke using the approval journal even when candidate and source run evidence is missing", async () => {
    await promote();
    fixtures.candidate = {};
    fixtures.runs.clear();
    await revokeCandidate({ candidateId: "candidate-1", dataDirectory, approved: true });
    expect(await listActiveCandidates(repository, dataDirectory)).toEqual([]);
    expect((await listPromotions(repository, dataDirectory)).at(-1)?.action).toBe("revoke");
  });

  it("rejects a linked data root before creating a promotion directory", async () => {
    const link = join(root, "linked-data");
    await symlink(repository, link, process.platform === "win32" ? "junction" : "dir");
    await expect(promoteCandidate({ candidateId: "candidate-1", evidenceIds: ["e1", "e2"], approved: true, dataDirectory: link }))
      .rejects.toThrow(/目录|链接/);
    expect(await readdir(repository)).not.toContain("promotions");
  });
});
