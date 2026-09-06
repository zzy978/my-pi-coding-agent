import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { executeControlledRun } from "../src/evaluation/runner.js";
import { analyzeRun } from "../src/experience/service.js";
import { loadCandidate, loadExperience } from "../src/experience/store.js";
import { listActiveCandidates, listPromotions, promoteCandidate, revokeCandidate } from "../src/experience/promotions.js";
import { runExperiment } from "../src/experiment/service.js";
import { loadExperiment } from "../src/experiment/store.js";
import type { ControlledPiRuntime, ControlledPiRuntimeOptions } from "../src/runtime/controlled-pi-runtime.js";
import { runProcess } from "../src/runtime/process.js";
import { parseTaskSpec } from "../src/task/task-spec.js";
import { discardManagedWorkspace, prepareWorkspace } from "../src/workspace/git.js";
import { initializeGitRepository } from "./helpers/git-repository.js";

/** Only the model adapter is synthetic; Git, verifier, evidence stores and promotion gates are real. */
it("closes the failure → grounded candidate → two-task evaluation → approval → revocation loop without network calls", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-learning-loop-"));
  const source = join(parent, "source");
  const dataDirectory = join(parent, "data");
  const prompts: string[] = [];
  function runtime(workspace: string, outputPath: string): ControlledPiRuntime {
    const stats: SessionStats = { sessionFile: undefined, sessionId: "learning-loop", userMessages: 0, assistantMessages: 0,
      toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
    return { hasAvailableModel: true, contextFiles: [], dispose: () => undefined, session: {
      model: { provider: "fixture", id: "deterministic" }, thinkingLevel: "off", sessionId: stats.sessionId,
      getActiveToolNames: () => ["read", "write"], getSessionStats: () => structuredClone(stats), subscribe: () => () => undefined,
      abortCompaction: () => undefined, abort: () => Promise.resolve(),
      prompt: async (text: string) => {
        prompts.push(text);
        if (text.includes("<experience-guidance")) await writeFile(join(workspace, outputPath), "done\n", "utf8");
        stats.tokens = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
      }
    } } as unknown as ControlledPiRuntime;
  }
  const createRuntime = (options: ControlledPiRuntimeOptions) => Promise.resolve(runtime(options.workspace, options.getTask().allowedPaths[0] ?? "missing"));
  try {
    await initializeGitRepository(source);
    await writeFile(join(source, "verify.cjs"), "const fs = require('node:fs'); if (!fs.existsSync(process.argv[2])) { console.error('Missing requested output'); process.exit(1); }\n", "utf8");
    for (const args of [["add", "verify.cjs"], ["commit", "-m", "add verifier"]]) {
      const command = await runProcess("git", args, { cwd: source });
      if (command.exitCode !== 0) throw new Error(command.stderr);
    }
    const originals = [];
    for (const [outputPath, objective] of [["result.txt", "Write result.txt with a result"], ["report.txt", "Create report.txt with a summary"]] as const) {
      const task = parseTaskSpec({ id: outputPath, objective, allowedPaths: [outputPath], verify: [`node verify.cjs ${outputPath}`] });
      const workspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
      try {
        originals.push(await executeControlledRun({ kind: "run", runtime: runtime(workspace.workspace, outputPath), task,
          workspace, allowShell: false, noSession: true, setup: { source: "disabled", commands: [] }, dataDirectory }));
      } finally { await discardManagedWorkspace(workspace); }
    }
    const original = originals[0];
    if (!original) throw new Error("Missing source run");
    expect(original.result.status).toBe("verification_failed");
    const originalResultText = await readFile(original.resultPath, "utf8");
    const experience = await analyzeRun(original.manifest.runId, dataDirectory, { synthesize: (input) => {
      expect(input.observation.category).toBe("verifier_failed");
      expect(input.evidence.some((evidence) => evidence.excerpt.includes("Missing requested output"))).toBe(true);
      return Promise.resolve({ text: JSON.stringify({
        card: { title: "Check requested outputs", pattern: "The requested output was not produced",
          hypotheses: [{ text: "The agent may have finished before writing the output", confidence: 0.7, evidenceRefs: ["result.json#/verification/commands/0"] }],
          lessons: ["Write and verify the requested file"], applicability: ["file generation"], contraindications: ["read-only tasks"] },
        candidates: [{ kind: "skill", title: "Verify requested files", content: "Before finishing, create the requested output and check its presence.",
          applicability: ["file generation"], contraindications: ["read-only tasks"] }]
      }) });
    } });
    expect(experience.synthesis.status).toBe("completed");
    expect(await loadExperience(experience.id, dataDirectory)).toEqual(experience);
    const proposed = experience.candidates[0];
    if (!proposed) throw new Error("No candidate generated");
    const candidate = await loadCandidate(proposed.id, dataDirectory);
    const evidenceIds: string[] = [];
    for (const taskRun of originals) {
      const experiment = await runExperiment({ sourceRunId: taskRun.manifest.runId, candidate, dataDirectory }, { createRuntime });
      expect(experiment).toMatchObject({ outcome: "observed_improvement", pairsCompleted: 3, scopeViolations: 0 });
      expect(await loadExperiment(experiment.id, dataDirectory)).toEqual(experiment);
      evidenceIds.push(experiment.id);
    }
    expect(prompts).toHaveLength(14);
    expect(await listActiveCandidates(source, dataDirectory)).toEqual([]);
    await expect(promoteCandidate({ candidateId: candidate.id, evidenceIds, approved: false, dataDirectory })).rejects.toThrow("人工确认");
    await promoteCandidate({ candidateId: candidate.id, evidenceIds, approved: true, dataDirectory });
    expect(await listActiveCandidates(source, dataDirectory)).toEqual([candidate]);
    await revokeCandidate({ candidateId: candidate.id, approved: true, dataDirectory });
    expect(await listActiveCandidates(source, dataDirectory)).toEqual([]);
    expect((await listPromotions(source, dataDirectory)).map((event) => event.action)).toEqual(["promote", "revoke"]);
    expect(await readFile(original.resultPath, "utf8")).toBe(originalResultText);
    for (const path of ["result.txt", "report.txt"]) await expect(access(join(source, path))).rejects.toThrow();
  } finally { await rm(parent, { recursive: true, force: true, maxRetries: 3 }); }
}, 180_000);
