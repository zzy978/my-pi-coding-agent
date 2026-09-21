import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Json, type RunManifest, type RunResult } from "../src/evaluation/schema.js";
import { createRunDirectory, writeRunResult } from "../src/evaluation/store.js";
import { analyzeRun } from "../src/experience/service.js";
import { loadCandidate, loadExperience, listExperiences, saveExperience } from "../src/experience/store.js";
import { parseExperienceBundle } from "../src/experience/schema.js";
import type { ExperienceBundle } from "../src/experience/schema.js";
import { handleLearningManagement } from "../src/learning-cli.js";
import { parseCliArgs } from "../src/cli-args.js";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

async function recordActions(fixture: Awaited<ReturnType<typeof sourceRun>>, recovery = false) {
  const events = [
    { type: "tool_start", data: { toolCallId: "call-1", toolName: "read", arguments: { path: "count.ts" } } },
    { type: "tool_end", data: { toolCallId: "call-1", toolName: "read", isError: recovery, resultSummary: recovery ? "File not found" : "export function count(xs) { return xs.length }" } },
    { type: "tool_start", data: { toolCallId: "call-2", toolName: "shell", arguments: { command: "[OMITTED 14 chars]" } } },
    { type: "tool_end", data: { toolCallId: "call-2", toolName: "shell", isError: false, resultSummary: "empty input check passed", durationMs: 25 } }
  ];
  await writeFile(join(fixture.directory, "trace.jsonl"), events.map((event, index) => JSON.stringify({
    schemaVersion: 1, runId: "source", sequence: index + 1, at: fixture.manifest.createdAt, ...event
  })).join("\n") + "\n");
}

describe("outcome-independent retrospectives", () => {
  it("indexes the saved experience and keeps indexing failure separate from valid experience storage", async () => {
    const fixture = await sourceRun();
    const indexed: string[] = [];
    const bundle = await analyzeRun("source", fixture.dataDirectory, {
      synthesize: () => Promise.resolve({ text: proposal() }),
      index: (stored: ExperienceBundle) => { indexed.push(stored.id); return Promise.resolve(); }
    });
    expect(indexed).toEqual([bundle.id]);
    expect(await loadExperience(bundle.id, fixture.dataDirectory)).toEqual(bundle);
    const retrieval = join(fixture.dataDirectory, "experiences", bundle.id, "retrieval");
    await mkdir(retrieval);
    await writeFile(join(retrieval, `${bundle.candidates[0]!.id}.json`), '{"apiKey":"sk-cli-private-value"}');
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(handleLearningManagement(parseCliArgs(["--show-experience", bundle.id, "--json"]), fixture.dataDirectory)).resolves.toBe(0);
    const shown = JSON.parse(String(output.mock.lastCall?.[0])) as { id: string; retrievalIndexes: Array<{ status: string; error: string }> };
    expect(shown.id).toBe(bundle.id);
    expect(shown.retrievalIndexes[0]?.status).toBe("unavailable");
    expect(JSON.stringify(shown)).not.toContain("sk-cli-private-value");
    output.mockRestore();

    const another = await sourceRun();
    const retained = await analyzeRun("source", another.dataDirectory, {
      synthesize: () => Promise.resolve({ text: proposal() }),
      index: () => Promise.reject(new Error("index storage unavailable"))
    });
    expect(retained.candidates).toHaveLength(1);
    expect(await loadExperience(retained.id, another.dataDirectory)).toEqual(retained);
  });

  it("indexes proposer and critic candidate identities independently in compare mode", async () => {
    const fixture = await sourceRun();
    const indexed: Array<{ id: string; candidates: string[] }> = [];
    const bundle = await analyzeRun("source", fixture.dataDirectory, { reviewMode: "compare",
      synthesize: () => Promise.resolve({ text: proposal() }),
      review: () => Promise.resolve({ text: JSON.stringify({ decisions: [{ candidateIndex: 0, verdict: "accept", reason: "保留用于评测", evidenceRefs: ["result.json#/status"] }] }) }),
      index: (stored: ExperienceBundle) => { indexed.push({ id: stored.id, candidates: stored.candidates.map((item) => item.id) }); return Promise.resolve(); }
    });
    expect(indexed.map((item) => item.id)).toEqual([bundle.review!.proposerExperienceId, bundle.id]);
    expect(indexed[0]!.candidates[0]).not.toBe(indexed[1]!.candidates[0]);
  });

  it("keeps late recovery evidence within material limits and redacts structured tool secrets", async () => {
    const fixture = await sourceRun({ passing: true });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for (let index = 0; index < 110; index++) {
      const toolCallId = `call-${index}`;
      events.push({ type: "tool_start", data: { toolCallId, toolName: "shell", arguments: { command: "[OMITTED]" } } },
        { type: "tool_end", data: { toolCallId, toolName: "shell", isError: index === 108,
          resultSummary: index === 109 ? 'RECOVERY VERIFIED {"apiKey":"fake-material-private-key"}' : "x".repeat(800) } });
    }
    await writeFile(join(fixture.directory, "trace.jsonl"), events.map((event, index) => JSON.stringify({
      schemaVersion: 1, runId: "source", sequence: index + 1, at: fixture.manifest.createdAt, ...event
    })).join("\n"));
    await writeRunResult({ ...fixture.result, toolCallCount: 110 }, fixture.directory);
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: (input) => {
      expect(input.evidence.map((item) => item.excerpt).join("\n")).toContain("RECOVERY VERIFIED");
      expect(JSON.stringify(input)).not.toContain("fake-material-private-key");
      return Promise.resolve({ text: proposal() });
    } });
    expect(bundle.observation.category).toBe("recovered_success");
    expect(bundle.synthesis.status).toBe("completed");
    expect(bundle.evidence.length).toBeLessThanOrEqual(80);
    expect(bundle.evidence.reduce((count, item) => count + item.excerpt.length, 0)).toBeLessThanOrEqual(32_000);
    expect(bundle.warnings.some((warning) => warning.includes("capped"))).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain("fake-material-private-key");
  });

  it("reads old completed and skipped experience contracts without migrating source artifacts", async () => {
    for (const noVerifier of [false, true]) {
      const fixture = await sourceRun({ noVerifier });
      const current = await analyzeRun("source", fixture.dataDirectory, { synthesize: () => Promise.resolve({ text: proposal() }) });
      const legacy = parseExperienceBundle({ ...current, schemaVersion: 1, synthesis: { ...current.synthesis, generatorVersion: 1 } });
      const path = join(fixture.dataDirectory, "experiences", current.id, "experience.json");
      const text = JSON.stringify({ bundle: legacy, sha256: sha256Json(legacy) });
      await writeFile(path, text);
      expect(await loadExperience(current.id, fixture.dataDirectory)).toEqual(legacy);
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });
  it("includes measured run usage and duration in the evidence instead of only call counts", async () => {
    const fixture = await sourceRun();
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: (input) => {
      expect(input.evidence.some((item) => item.ref === "result.json#/usage" && item.excerpt.includes('"total":2'))).toBe(true);
      expect(input.evidence.some((item) => item.ref === "result.json#/status" && item.excerpt.includes('"durationMs":1000'))).toBe(true);
      return Promise.resolve({ text: proposal() });
    } });
    expect(bundle.synthesis.status).toBe("completed");
  });
  it("allows configurable/manual low-value selection without overriding evidence gates", async () => {
    const fixture = await sourceRun({ passing: true });
    await recordActions(fixture);
    const synthesize = () => Promise.resolve({ text: proposal() });
    expect((await analyzeRun("source", fixture.dataDirectory, { synthesize, minSuccessToolCalls: 2 })).candidates).toHaveLength(1);
    expect((await analyzeRun("source", fixture.dataDirectory, { synthesize, force: true })).candidates).toHaveLength(1);
    const missing = await sourceRun({ noVerifier: true });
    expect((await analyzeRun("source", missing.dataDirectory, { synthesize, force: true })).synthesis.status).toBe("skipped");
    await expect(analyzeRun("source", fixture.dataDirectory, { synthesize, minSuccessToolCalls: -1 })).rejects.toThrow(/minSuccessToolCalls/);
  });
  it("learns from a verified substantial success using observable action evidence", async () => {
    const fixture = await sourceRun({ passing: true });
    await recordActions(fixture);
    await writeRunResult({ ...fixture.result, toolCallCount: 8 }, fixture.directory);
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: (input) => {
      expect(input.evidence.some((item) => item.excerpt.includes("empty input check passed"))).toBe(true);
      expect(input.evidence.some((item) => item.excerpt.includes("count.ts") && item.ref.startsWith("trace"))).toBe(true);
      return Promise.resolve({ text: proposal() });
    } });
    expect(bundle.observation).toMatchObject({ eligibility: "eligible", category: "verified_success" });
    expect(bundle.candidates).toHaveLength(1);
    expect(await loadExperience(bundle.id, fixture.dataDirectory)).toEqual(bundle);
  });

  it("skips simple successes but keeps low-call failure recovery", async () => {
    const fixture = await sourceRun({ passing: true });
    await recordActions(fixture);
    const simple = await analyzeRun("source", fixture.dataDirectory, { synthesize: () => Promise.reject(new Error("Unexpected model call")) });
    expect(simple.synthesis.status).toBe("skipped");
    expect(simple.observation.eligibility).toBe("ignored");
    await recordActions(fixture, true);
    const recovery = await analyzeRun("source", fixture.dataDirectory, { synthesize: () => Promise.resolve({ text: proposal() }) });
    expect(recovery.observation).toMatchObject({ eligibility: "eligible", category: "recovered_success" });
    expect(recovery.candidates).toHaveLength(1);
  });

  it("does not invent success strategies from a high tool count without action evidence", async () => {
    const fixture = await sourceRun({ passing: true });
    await writeRunResult({ ...fixture.result, toolCallCount: 99 }, fixture.directory);
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: () => Promise.reject(new Error("Unexpected model call")) });
    expect(bundle.observation.eligibility).toBe("inconclusive");
    expect(bundle.synthesis.status).toBe("skipped");
  });

  it("persists a reasoned zero-candidate result without treating it as generator failure", async () => {
    const fixture = await sourceRun();
    const bundle = await analyzeRun("source", fixture.dataDirectory, { synthesize: () => Promise.resolve({
      text: '{"candidates":[],"noCandidateReason":"已有材料不足以提出可复用操作"}'
    }) });
    expect(bundle.synthesis.status).toBe("completed");
    expect(bundle.candidates).toEqual([]);
    expect(bundle.noCandidateReason).toContain("可复用");
    expect(await loadExperience(bundle.id, fixture.dataDirectory)).toEqual(bundle);
  });
});

describe("critic review of fixed proposals", () => {
  it("runs proposer and critic through separate real HTTP completions with isolated limits and no tools", async () => {
    const fixture = await sourceRun();
    const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[]; max_tokens?: number; max_completion_tokens?: number }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body) as (typeof requests)[number]);
        const content = requests.length === 1 ? proposal() : decisions("accept");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address");
    const agent = join(fixture.dataDirectory, "agent");
    await mkdir(agent);
    await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { fixture: {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [
        { id: "model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      ]
    } } }));
    vi.stubEnv("PICODE_MODEL_PROVIDER", "fixture");
    vi.stubEnv("PICODE_MODEL_API_KEY", "fake-local-review-key");
    vi.stubEnv("PICODE_MODEL_MAX_OUTPUT_TOKENS", "1");
    vi.stubEnv("PICODE_SYNTHESIS_MAX_OUTPUT_TOKENS", "123");
    const bundle = await analyzeRun("source", fixture.dataDirectory, { reviewMode: "critic", index: () => Promise.resolve() });
    expect(bundle.synthesis.status).toBe("completed");
    expect(bundle.review?.status).toBe("completed");
    expect(bundle.candidates).toHaveLength(1);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(request.tools ?? []).toEqual([]);
      expect(request.max_tokens ?? request.max_completion_tokens).toBe(123);
    }
    expect(requests[0]!.messages[0]!.content).not.toBe(requests[1]!.messages[0]!.content);
    expect(requests[1]!.messages[1]!.content).toContain('"proposals"');
    expect(JSON.stringify(bundle)).not.toContain("fake-local-review-key");
  });
  const synthesize = () => Promise.resolve({ text: proposal(), usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.01 } });
  const decisions = (verdict: string, index = 0, ref = "result.json#/verification/commands/0") => JSON.stringify({
    decisions: [{ candidateIndex: index, verdict, reason: "需要跨任务证据，当前推断只适用于边界输入", evidenceRefs: [ref] }]
  });

  it("binds identical accepted proposals by index rather than merging their candidate IDs", async () => {
    const fixture = await sourceRun();
    const content = JSON.parse(proposal()) as { candidates: unknown[] };
    content.candidates.push(content.candidates[0]);
    const bundle = await analyzeRun("source", fixture.dataDirectory, { reviewMode: "compare",
      synthesize: () => Promise.resolve({ text: JSON.stringify(content) }),
      review: () => Promise.resolve({ text: JSON.stringify({ decisions: [0, 1].map((candidateIndex) => ({
        candidateIndex, verdict: "accept", reason: "有限证据支持评测", evidenceRefs: ["result.json#/status"]
      })) }) }) });
    const { compareReviewPipelines } = await import("../src/experience/review-comparison.js");
    const report = await compareReviewPipelines(bundle.id, fixture.dataDirectory);
    expect(report.proposals.map((item) => item.criticCandidateId)).toEqual(bundle.candidates.map((candidate) => candidate.id));
    expect(new Set(report.proposals.map((item) => item.criticCandidateId)).size).toBe(2);
  });

  it("saves the exact proposer arm once and binds a rejected critic arm for comparison", async () => {
    const fixture = await sourceRun();
    let proposals = 0;
    const bundle = await analyzeRun("source", fixture.dataDirectory, { reviewMode: "compare", synthesize: () => { proposals++; return synthesize(); },
      review: (input) => {
        expect(input.proposals[0]?.content).toContain("empty inputs");
        return Promise.resolve({ text: decisions("reject"), usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.005 } });
      } });
    expect(proposals).toBe(1);
    expect(bundle.review).toMatchObject({ mode: "compare", status: "completed", usage: { cost: 0.005 } });
    expect(bundle.candidates).toEqual([]);
    expect(bundle.noCandidateReason).toBeTruthy();
    const baseline = await loadExperience(bundle.review!.proposerExperienceId!, fixture.dataDirectory);
    expect(baseline.candidates).toHaveLength(1);
    expect(bundle.review!.proposerExperienceSha256).toBe(sha256Json(baseline));
    expect(await loadExperience(bundle.id, fixture.dataDirectory)).toEqual(bundle);
    expect(await listExperiences(fixture.dataDirectory)).toHaveLength(2);
    const { compareReviewPipelines } = await import("../src/experience/review-comparison.js");
    const comparison = await compareReviewPipelines(bundle.id, fixture.dataDirectory);
    expect(comparison.proposer).toMatchObject({ candidates: 1, evaluatedCandidates: 0 });
    expect(comparison.critic).toMatchObject({ candidates: 0, evaluatedCandidates: 0 });
    expect(comparison.criticCost).toBe(0.005);
    expect(comparison.retrospectiveAvoidableEvaluationCost).toBeNull();
    expect(comparison.qualityComparisonAvailable).toBe(false);
    await mkdir(join(fixture.dataDirectory, "experiments", "broken"), { recursive: true });
    const incomplete = await compareReviewPipelines(bundle.id, fixture.dataDirectory);
    expect(incomplete.unavailableExperimentIds).toEqual(["broken"]);
    expect(incomplete.retrospectiveAvoidableEvaluationCost).toBeNull();
    const path = join(fixture.dataDirectory, "experiences", baseline.id, "experience.json");
    const changed = { ...baseline, warnings: ["modified"] };
    await writeFile(path, JSON.stringify({ bundle: changed, sha256: sha256Json(changed) }));
    await expect(compareReviewPipelines(bundle.id, fixture.dataDirectory)).rejects.toThrow(/binding mismatch/);
  });

  it("refuses comparison when original run evidence changes after synthesis", async () => {
    const fixture = await sourceRun();
    const bundle = await analyzeRun("source", fixture.dataDirectory, { reviewMode: "compare", synthesize,
      review: () => Promise.resolve({ text: decisions("accept") }) });
    await writeRunResult({ ...fixture.result, durationMs: 2000 }, fixture.directory);
    const { compareReviewPipelines } = await import("../src/experience/review-comparison.js");
    await expect(compareReviewPipelines(bundle.id, fixture.dataDirectory)).rejects.toThrow(/evidence changed/);
  });

  it("rejects candidate text drift and decisions missing or duplicated in stored critic evidence", async () => {
    const fixture = await sourceRun();
    const bundle = await analyzeRun("source", fixture.dataDirectory, { reviewMode: "critic", synthesize,
      review: () => Promise.resolve({ text: decisions("accept") }) });
    const drift = structuredClone(bundle);
    drift.candidates[0]!.title = "A different proposal";
    expect(() => parseExperienceBundle(drift)).toThrow(/match critic/);
    const duplicate = structuredClone(bundle);
    duplicate.review!.decisions.push(duplicate.review!.decisions[0]!);
    expect(() => parseExperienceBundle(duplicate)).toThrow(/exactly once/);
  });

  it("makes accepted proposals available through the existing candidate store without rewriting them", async () => {
    const fixture = await sourceRun();
    const bundle = await analyzeRun("source", fixture.dataDirectory, { reviewMode: "critic", synthesize,
      review: () => Promise.resolve({ text: decisions("accept") }) });
    expect(bundle.candidates).toHaveLength(1);
    expect((await loadCandidate(bundle.candidates[0]!.id, fixture.dataDirectory)).content).toBe(bundle.review!.proposals[0]!.content);
  });

  it.each([decisions("accept", 1), decisions("accept", 0, "unknown"), '{"decisions":[]}',
    '{"decisions":[{"candidateIndex":0,"verdict":"accept","reason":"ok","evidenceRefs":[]}]}'
  ])("fails closed on malformed critic decisions %#", async (text) => {
    const fixture = await sourceRun();
    const bundle = await analyzeRun("source", fixture.dataDirectory, { reviewMode: "critic", synthesize,
      review: () => Promise.resolve({ text, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0.001 } }) });
    expect(bundle.review).toMatchObject({ status: "failed", usage: { cost: 0.001 } });
    expect(bundle.candidates).toEqual([]);
    expect(bundle.review?.proposals).toHaveLength(1);
    expect(await loadExperience(bundle.id, fixture.dataDirectory)).toEqual(bundle);
  });

  it("skips critic after abstention, and redacts critic provider errors", async () => {
    const fixture = await sourceRun();
    const empty = await analyzeRun("source", fixture.dataDirectory, { reviewMode: "critic",
      synthesize: () => Promise.resolve({ text: '{"candidates":[],"noCandidateReason":"缺少可复用结论"}' }),
      review: () => Promise.reject(new Error("Unexpected critic call")) });
    expect(empty.review?.status).toBe("skipped");
    const failed = await analyzeRun("source", fixture.dataDirectory, { reviewMode: "critic", synthesize,
      review: () => Promise.resolve({ text: "", error: "Bearer fake-critic-private-value" }) });
    expect(failed.review?.status).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain("fake-critic-private-value");
    expect(failed.candidates).toEqual([]);
  });
});

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
