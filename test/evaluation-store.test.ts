import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Json, type RunManifest, type RunResult } from "../src/evaluation/schema.js";
import {
  createRunDirectory,
  listRunBundles,
  loadRunBundle,
  loadRunManifest,
  runsDirectory,
  writeRunResult
} from "../src/evaluation/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});

function fixtureManifest(runId: string): RunManifest {
  const task = {
    id: "store",
    objective: "test store",
    allowedPaths: ["result.txt"],
    verify: [{ command: "node verify.mjs", timeoutMs: 10_000 }],
    doneWhen: ["passes"]
  };
  return {
    schemaVersion: 1,
    runId,
    kind: "run",
    createdAt: "2026-08-30T00:00:00.000Z",
    sourceRepository: resolve("fixture"),
    baselineCommit: "a".repeat(40),
    replayable: true,
    task: { content: task, sha256: sha256Json(task) },
    agent: {
      appVersion: "0.1.0",
      model: { provider: "fixture", id: "model" },
      thinkingLevel: "off",
      sessionMode: "ephemeral"
    },
    policy: { allowShell: false, allowedPaths: task.allowedPaths, tools: ["read", "write"] },
    contextFiles: [],
    verifier: { commands: task.verify, sha256: sha256Json(task.verify) }
  };
}

function fixtureResult(manifest: RunManifest): RunResult {
  return {
    schemaVersion: 1,
    runId: manifest.runId,
    manifestSha256: sha256Json(manifest),
    startedAt: manifest.createdAt,
    completedAt: "2026-08-30T00:00:01.000Z",
    status: "verification_passed",
    workspace: {
      path: resolve("fixture-worktree"),
      branch: "agent/fixture",
      baselineCommit: manifest.baselineCommit,
      managedWorktree: true
    },
    verification: {
      configured: true,
      success: true,
      changedFiles: ["result.txt"],
      disallowedChangedFiles: [],
      commands: [{ command: "node verify.mjs", status: "passed", exitCode: 0, stdout: "ok", stderr: "", outputTruncated: false, durationMs: 1 }]
    },
    diffSummary: "result.txt | 1 +",
    durationMs: 1_000,
    toolCallCount: 1,
    retryCount: 0,
    errorCount: 0,
    errors: [],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 }
  };
}

describe("evaluation run store", () => {
  it("loads a complete bundle and lists it", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "pi-store-"));
    temporaryDirectories.push(dataDirectory);
    const manifest = fixtureManifest("run-store");
    const directory = await createRunDirectory(manifest, dataDirectory);
    await writeRunResult(fixtureResult(manifest), directory);
    await expect(loadRunBundle(manifest.runId, dataDirectory)).resolves.toMatchObject({ manifest, result: { status: "verification_passed" } });
    await expect(listRunBundles(dataDirectory)).resolves.toHaveLength(1);
  });

  it("rejects traversal, damaged manifests, and cross-artifact hash drift", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "pi-store-bad-"));
    temporaryDirectories.push(dataDirectory);
    await expect(loadRunManifest("../escape", dataDirectory)).rejects.toThrow("unsupported characters");
    await expect(loadRunManifest("missing", dataDirectory)).rejects.toThrow("Cannot read run directory");

    const damaged = fixtureManifest("damaged");
    const damagedDirectory = await createRunDirectory(damaged, dataDirectory);
    await writeFile(join(damagedDirectory, "manifest.json"), "{not-json", "utf8");
    await expect(loadRunManifest("damaged", dataDirectory)).rejects.toThrow("Cannot parse manifest");

    const drift = fixtureManifest("drift");
    const driftDirectory = await createRunDirectory(drift, dataDirectory);
    await writeRunResult({ ...fixtureResult(drift), manifestSha256: "f".repeat(64) }, driftDirectory);
    await expect(loadRunBundle("drift", dataDirectory)).rejects.toThrow("manifest hash does not match");
  });

  it("distinguishes an incomplete run from damaged or linked artifacts", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "pi-store-links-"));
    temporaryDirectories.push(dataDirectory);
    const incomplete = fixtureManifest("incomplete");
    const incompleteDirectory = await createRunDirectory(incomplete, dataDirectory);
    await expect(loadRunBundle("incomplete", dataDirectory)).resolves.not.toHaveProperty("result");

    await writeFile(join(incompleteDirectory, "result.json"), "{broken", "utf8");
    await expect(loadRunBundle("incomplete", dataDirectory)).rejects.toThrow("Cannot parse result");

    const external = join(dataDirectory, "external-run");
    await mkdir(external);
    await writeFile(join(external, "manifest.json"), JSON.stringify(fixtureManifest("linked")), "utf8");
    await symlink(external, join(runsDirectory(dataDirectory), "linked"), "junction");
    await expect(loadRunManifest("linked", dataDirectory)).rejects.toThrow("not a regular directory");
  });
});
