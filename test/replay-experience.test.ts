import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectReplayExperience } from "../src/evaluation/replay-experience.js";
import { parseRunManifest, sha256Json, sha256Text, type RunManifest } from "../src/evaluation/schema.js";
import type { RunBundle } from "../src/evaluation/store.js";
import { toRetrievalEntry } from "../src/experience/retrieval-index.js";
import type { ExperienceCandidate } from "../src/experience/candidate.js";
import { formatTaskPrompt, parseTaskSpec } from "../src/task/task-spec.js";
import { initializeGitRepository } from "./helpers/git-repository.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});

function manifest(repository: string, verifier = true): RunManifest {
  const task = parseTaskSpec({ id: "task-one", objective: "修复 parser 错误", verify: verifier ? ["npm test"] : [] });
  return parseRunManifest({ schemaVersion: 1, runId: "source-run", kind: "run", createdAt: "2026-09-25T00:00:00.000Z",
    sourceRepository: repository, baselineCommit: "a".repeat(40), replayable: true,
    task: { content: task, sha256: sha256Json(task) },
    agent: { appVersion: "0.1.0", model: { provider: "fixture", id: "model" }, thinkingLevel: "off", sessionMode: "ephemeral" },
    policy: { allowShell: false, allowedPaths: task.allowedPaths, tools: ["read"] },
    contextFiles: [], verifier: { commands: task.verify, sha256: sha256Json(task.verify) } });
}

function candidate(): ExperienceCandidate {
  const content = "先检查 parser 的失败断言。";
  return { id: "candidate-one", kind: "strategy", content, contentSha256: sha256Text(content), rendererVersion: 1,
    sourceRunId: "candidate-source", sourceExperienceId: "experience-one", createdAt: "2026-09-25T00:00:00.000Z",
    title: "解析错误诊断", applicability: ["parser 失败"], contraindications: [] };
}

describe("task-based replay experience selection", () => {
  it("freezes an explicit unpromoted candidate only after matching the repository and audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-replay-selection-"));
    directories.push(root);
    const repository = join(root, "repo"), dataDirectory = join(root, "data");
    await initializeGitRepository(repository);
    const source = manifest(repository);
    const item = candidate();
    const auditDirectory = join(dataDirectory, "reports", "retrieval");
    await mkdir(auditDirectory, { recursive: true });
    const selected = { id: "retrieved-one", kind: "strategy" as const, content: "Use the parser assertion.",
      contentSha256: sha256Text("Use the parser assertion."), rendererVersion: 1 as const };
    let calls = 0;
    const result = await selectReplayExperience(source, dataDirectory, [item.id], undefined, {
      loadCandidate: () => Promise.resolve(item),
      loadRunBundle: () => Promise.resolve({ directory: "", manifest: source } as RunBundle),
      selectTaskExperience: async ({ objective, candidates }) => {
        calls++;
        expect(objective).toBe("修复 parser 错误");
        expect(candidates.map((entry) => entry.id)).toEqual(["candidate-one"]);
        const selection = { candidate: selected, selectedIds: [item.id], reasons: [], auditId: "audit-one", status: "selected" as const };
        await writeFile(join(auditDirectory, "audit-one.json"), JSON.stringify({ auditId: "audit-one", status: "selected",
          querySha256: sha256Text(objective), poolSha256: sha256Json(candidates.map(toRetrievalEntry)), selection }));
        return selection;
      }
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: "selected", selectedIds: [item.id], candidate: selected });
    expect(result.effectivePromptSha256).not.toBe(sha256Text(formatTaskPrompt(source.task.content, source.task.content.objective)));
    expect(result.auditSha256).toBe(sha256Text(await readFile(join(auditDirectory, "audit-one.json"), "utf8")));
  });

  it("rejects cross-repository candidates before invoking the selection model", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-replay-other-repo-"));
    directories.push(root);
    const repository = join(root, "repo"), other = join(root, "other");
    await initializeGitRepository(repository);
    await initializeGitRepository(other);
    let called = false;
    await expect(selectReplayExperience(manifest(repository), join(root, "data"), ["candidate-one"], undefined, {
      loadCandidate: () => Promise.resolve(candidate()),
      loadRunBundle: () => Promise.resolve({ directory: "", manifest: manifest(other) } as RunBundle),
      selectTaskExperience: () => { called = true; throw new Error("should not call model"); }
    })).rejects.toThrow("another repository");
    expect(called).toBe(false);
  });

  it("does not select experience when the source cannot be verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-replay-no-verifier-"));
    directories.push(root);
    const repository = join(root, "repo");
    await initializeGitRepository(repository);
    let called = false;
    await expect(selectReplayExperience(manifest(repository, false), join(root, "data"), [], undefined, {
      listActiveCandidates: () => { called = true; throw new Error("should not load pool"); }
    })).rejects.toThrow("configured verifier");
    expect(called).toBe(false);
  });

  it("records a zero-injection decision and refuses an audit that changes the decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-replay-empty-"));
    directories.push(root);
    const repository = join(root, "repo"), dataDirectory = join(root, "data");
    await initializeGitRepository(repository);
    const source = manifest(repository);
    const auditDirectory = join(dataDirectory, "reports", "retrieval");
    await mkdir(auditDirectory, { recursive: true });
    let tamper = false;
    const dependencies = {
      listActiveCandidates: () => Promise.resolve([]),
      selectTaskExperience: async () => {
        const selection = { candidate: null, selectedIds: [], reasons: [], auditId: "audit-empty", status: "empty" as const };
        await writeFile(join(auditDirectory, "audit-empty.json"), JSON.stringify({ auditId: "audit-empty", status: "empty",
          querySha256: sha256Text(source.task.content.objective), poolSha256: sha256Json([]),
          selection: { ...selection, selectedIds: tamper ? ["injected-without-evidence"] : [] } }));
        return selection;
      }
    };
    const empty = await selectReplayExperience(source, dataDirectory, [], undefined, dependencies);
    expect(empty).toMatchObject({ status: "empty", selectedIds: [] });
    expect(empty).not.toHaveProperty("candidate");
    expect(empty.effectivePromptSha256).toBe(sha256Text(formatTaskPrompt(source.task.content, source.task.content.objective)));
    tamper = true;
    await expect(selectReplayExperience(source, dataDirectory, [], undefined, dependencies)).rejects.toThrow("audit");
  });
});
