import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Json, type RunManifest, type RunResult } from "../src/evaluation/schema.js";
import { createRunDirectory, writeRunResult } from "../src/evaluation/store.js";
import { analyzeRun } from "../src/experience/service.js";
import { loadCandidate, loadExperience, listExperiences, saveExperience } from "../src/experience/store.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});

async function sourceRun(options: { noVerifier?: boolean; setupFailed?: boolean; passing?: boolean; timeout?: boolean; scope?: boolean } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "pi-experience-"));
  directories.push(dataDirectory);
  const task = { id: "fix-count", objective: "Fix count for empty arrays", allowedPaths: ["count.ts"],
    verify: options.noVerifier ? [] : [{ command: "node check.mjs", timeoutMs: 10_000 }], doneWhen: ["checks pass"] };
  const manifest: RunManifest = {
    schemaVersion: 1, runId: "source", kind: "run", createdAt: "2026-09-05T00:00:00.000Z",
    sourceRepository: resolve("fixture"), baselineCommit: "a".repeat(40), replayable: true,
    task: { content: task, sha256: sha256Json(task) },
    agent: { appVersion: "0.1.0", model: { provider: "fixture", id: "model" }, thinkingLevel: "off", sessionMode: "ephemeral" },
    policy: { allowShell: false, allowedPaths: task.allowedPaths, tools: ["read", "write"] },
    contextFiles: [], verifier: { commands: task.verify, sha256: sha256Json(task.verify) }
  };
  const result: RunResult = {
    schemaVersion: 1, runId: manifest.runId, manifestSha256: sha256Json(manifest), startedAt: manifest.createdAt,
    completedAt: "2026-09-05T00:00:01.000Z", status: options.setupFailed ? "execution_failed" : options.passing ? "verification_passed" : "verification_failed",
    workspace: { path: resolve("fixture-worktree"), branch: "agent/fixture", baselineCommit: manifest.baselineCommit, managedWorktree: true },
    ...(!options.setupFailed ? { verification: { configured: !options.noVerifier, success: !!options.passing,
      commands: options.noVerifier ? [] : [{ command: "node check.mjs", status: options.passing ? "passed" as const : options.timeout ? "timed_out" as const : "failed" as const,
        exitCode: options.passing ? 0 : 1, stdout: "", stderr: "Expected 0, received 1", durationMs: 10, outputTruncated: false }],
      changedFiles: options.scope ? ["outside.ts"] : ["count.ts"], disallowedChangedFiles: options.scope ? ["outside.ts"] : [] } } : {}),
    diffSummary: "count.ts | 1 +", durationMs: 1000, toolCallCount: 2, retryCount: 0, errorCount: 1,
    errors: [options.setupFailed ? "Setup failed" : "Tool grep failed"], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 }
  };
  const directory = await createRunDirectory(manifest, dataDirectory);
  await writeRunResult(result, directory);
  await writeFile(join(directory, "trace.jsonl"), JSON.stringify({ schemaVersion: 1, runId: "source", sequence: 1,
    at: manifest.createdAt, type: options.setupFailed ? "setup_end" : "tool_end", data: options.setupFailed ? { success: false } : { toolName: "grep", isError: true } }) + "\n");
  return { dataDirectory, directory, manifest, result };
}

function proposal(reference = "result.json#/verification/commands/0") {
  return JSON.stringify({ card: { title: "Boundary handling", pattern: "Empty arrays are mishandled",
    hypotheses: [{ text: "The empty input branch may be missing", confidence: 0.6, evidenceRefs: [reference] }],
    lessons: ["Inspect and test empty input explicitly"], applicability: ["array processing"], contraindications: ["No observed boundary failure"] },
    candidates: [{ kind: "prompt", title: "Check empty inputs", content: "Read the failing assertion and test empty inputs before broad edits.",
      applicability: ["array processing"], contraindications: ["No observed boundary failure"] }] });
}

describe("failure experience compilation", () => {
  it("persists evidence-only inconclusive observations without synthesizing when no verifier was configured", async () => {
    const fixture = await sourceRun({ noVerifier: true });
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: () => Promise.reject(new Error("Must not call generator")) });
    expect(bundle.observation).toMatchObject({ eligibility: "inconclusive", category: "no_verifier" });
    expect(bundle.synthesis.status).toBe("skipped");
    expect(bundle.candidates).toHaveLength(0);
    expect(await loadExperience(bundle.id, fixture.dataDirectory)).toEqual(bundle);
    expect(await listExperiences(fixture.dataDirectory)).toHaveLength(1);
    await expect(saveExperience(bundle, fixture.dataDirectory)).rejects.toThrow(/EEXIST|exist/i);
  });

  it.each([false, true])("grounds evidence and persists immutable candidates with fenced response=%s", async (fenced) => {
    const fixture = await sourceRun();
    const before = await readFile(join(fixture.directory, "result.json"), "utf8");
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: (input) => {
      expect(JSON.stringify(input)).toContain("Expected 0, received 1");
      return Promise.resolve({ text: fenced ? "```json\n" + proposal() + "\n```" : proposal(), usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.001 } });
    } });
    expect(bundle.observation.category).toBe("verifier_failed");
    expect(bundle.synthesis).toMatchObject({ status: "completed", usage: { total: 30 } });
    expect(bundle.card?.hypotheses[0]?.confidence).toBe(0.6);
    expect(bundle.candidates).toHaveLength(1);
    expect(await loadCandidate(bundle.candidates[0]!.id, fixture.dataDirectory)).toMatchObject({ sourceRunId: "source", sourceExperienceId: bundle.id });
    expect(await readFile(join(fixture.directory, "result.json"), "utf8")).toBe(before);
  });

  it.each([
    ["unreferenced hypothesis", () => proposal("trace.jsonl#999")],
    ["incomplete structure", () => "```json\n{}\n```"],
    ["malformed JSON", () => "```json\n{\n```"],
    ["secret", () => proposal().replace("Read the failing assertion", "Use sk-12345678901234567890")]
  ])("retains facts but no candidates after %s output", async (_label, text) => {
    const fixture = await sourceRun();
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: () => Promise.resolve({ text: text(), usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.001 } }) });
    expect(bundle.synthesis.status).toBe("failed");
    expect(bundle.synthesis.usage?.cost).toBe(0.001);
    expect(bundle.observation.category).toBe("verifier_failed");
    expect(bundle.candidates).toHaveLength(0);
    expect(bundle.card).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain("sk-12345678901234567890");
  });

  it.each([
    [{ setupFailed: true }, "setup_failed", "inconclusive"],
    [{ passing: true }, "none", "ignored"],
    [{ timeout: true }, "verifier_timeout", "eligible"],
    [{ scope: true }, "scope_violation", "eligible"]
  ] as const)("distinguishes environmental, successful, timeout and scope evidence: %j", async (options, category, eligibility) => {
    const fixture = await sourceRun(options);
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: () => Promise.resolve({ text: proposal() }) });
    expect(bundle.observation).toMatchObject({ category, eligibility });
  });

  it("rejects linked trace evidence and traversal before reading unrelated files", async () => {
    const fixture = await sourceRun();
    await expect(analyzeRun("../outside", fixture.dataDirectory)).rejects.toThrow(/ID|unsupported/);
    await rm(join(fixture.directory, "trace.jsonl"));
    await writeFile(join(fixture.dataDirectory, "external.jsonl"), "private");
    await link(join(fixture.dataDirectory, "external.jsonl"), join(fixture.directory, "trace.jsonl"));
    await expect(analyzeRun("source", fixture.dataDirectory)).rejects.toThrow(/link/);
  });

  it("rejects experience hash drift and linked storage roots", async () => {
    const fixture = await sourceRun({ noVerifier: true });
    const bundle = await analyzeRun("source", fixture.dataDirectory);
    const path = join(fixture.dataDirectory, "experiences", bundle.id, "experience.json");
    const stored = JSON.parse(await readFile(path, "utf8")) as { bundle: { sourceRunId: string } };
    stored.bundle.sourceRunId = "forged";
    await writeFile(path, JSON.stringify(stored));
    await expect(loadExperience(bundle.id, fixture.dataDirectory)).rejects.toThrow(/hash/);
    await expect(loadCandidate("../outside", fixture.dataDirectory)).rejects.toThrow(/ID/);
    const other = await mkdtemp(join(tmpdir(), "pi-experience-linked-"));
    directories.push(other);
    await mkdir(join(other, "elsewhere"));
    await symlink(join(other, "elsewhere"), join(other, "experiences"), "junction");
    await expect(listExperiences(other)).rejects.toThrow(/link|regular directory/);
  });

  it("records an incomplete run as inconclusive and makes no model call", async () => {
    const fixture = await sourceRun();
    await rm(join(fixture.directory, "result.json"));
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: () => Promise.reject(new Error("Unexpected generation")) });
    expect(bundle.observation).toMatchObject({ category: "unknown", eligibility: "inconclusive" });
    expect(bundle.synthesis.status).toBe("skipped");
  });

  it("redacts diagnostic secrets before sending evidence or persisting observations", async () => {
    const fixture = await sourceRun();
    const errors = ["Request failed with Bearer example-sensitive-credential"];
    await writeRunResult({ ...fixture.result, errors, errorCount: 1 }, fixture.directory);
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: (input) => {
      expect(JSON.stringify(input)).not.toContain("example-sensitive-credential");
      return Promise.resolve({ text: proposal() });
    } });
    expect(bundle.synthesis.status).toBe("completed");
    expect(JSON.stringify(bundle)).not.toContain("example-sensitive-credential");
  });

  it.each(["demo\"credential-value", "demo\\credential-value", "demo\ncredential-value"])("redacts credentials before JSON escaping them into structured evidence: %j", async (secret) => {
    vi.stubEnv("PI_EXPERIENCE_TEST_API_KEY", secret);
    const fixture = await sourceRun();
    await writeRunResult({ ...fixture.result, errors: [`Failed request ${secret}`], errorCount: 1 }, fixture.directory);
    const escapedSecret = JSON.stringify(secret).slice(1, -1);
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: (input) => {
      const excerpts = input.evidence.map((item) => item.excerpt).join("\n");
      expect(excerpts).not.toContain(secret);
      expect(excerpts).not.toContain(escapedSecret);
      return Promise.resolve({ text: proposal() });
    } });
    expect(bundle.synthesis.status).toBe("completed");
    expect(bundle.evidence.map((item) => item.excerpt).join("\n")).not.toContain(escapedSecret);
  });

  it("prioritizes late failing verifier diagnostics over earlier passing commands", async () => {
    const fixture = await sourceRun();
    const commands = Array.from({ length: 21 }, (_item, index) => ({ command: `node check-${index}.mjs`, timeoutMs: 10_000 }));
    fixture.manifest.task.content.verify = commands;
    fixture.manifest.task.sha256 = sha256Json(fixture.manifest.task.content);
    fixture.manifest.verifier = { commands, sha256: sha256Json(commands) };
    const verification = fixture.result.verification!;
    verification.commands = commands.map((command, index) => ({ command: command.command,
      status: index === 20 ? "failed" : "passed", exitCode: index === 20 ? 1 : 0,
      stdout: "", stderr: index === 20 ? "Late boundary check failed" : "", outputTruncated: false, durationMs: 1 }));
    await writeFile(join(fixture.directory, "manifest.json"), JSON.stringify(fixture.manifest));
    await writeRunResult({ ...fixture.result, manifestSha256: sha256Json(fixture.manifest), verification }, fixture.directory);
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: (input) => {
      expect(input.evidence.some((item) => item.ref === "result.json#/verification/commands/20" && item.excerpt.includes("Late boundary check failed"))).toBe(true);
      return Promise.resolve({ text: proposal("result.json#/verification/commands/20") });
    } });
    expect(bundle.synthesis.status).toBe("completed");
    expect(bundle.observation.evidenceRefs).toContain("result.json#/verification/commands/20");
  });
});
