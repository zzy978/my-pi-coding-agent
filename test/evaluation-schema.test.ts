import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/evaluation/comparison.js";
import { assertRecordableCommands, redactSensitiveText, sanitizeVerificationReport, summarizeToolArguments } from "../src/evaluation/redaction.js";
import { createReplayPlan } from "../src/evaluation/replay.js";
import {
  parseRunManifest,
  parseRunResult,
  sha256Json,
  type RunManifest,
  type RunResult
} from "../src/evaluation/schema.js";

const commit = "a".repeat(40);

function manifest(runId = "run-one", kind: "run" | "replay" = "run"): RunManifest {
  const task = {
    id: "fixture",
    objective: "Create result.txt",
    allowedPaths: ["result.txt"],
    verify: [{ command: "node verify.mjs", timeoutMs: 10_000 }],
    doneWhen: ["verification passes"]
  };
  return parseRunManifest({
    schemaVersion: 1,
    runId,
    kind,
    ...(kind === "replay" ? { replayOf: "run-one" } : {}),
    createdAt: "2026-08-30T00:00:00.000Z",
    sourceRepository: resolve("fixture"),
    baselineCommit: commit,
    replayable: true,
    task: { content: task, sha256: sha256Json(task) },
    agent: {
      appVersion: "0.1.0",
      model: { provider: "fixture", id: "model" },
      thinkingLevel: "off",
      sessionMode: "ephemeral"
    },
    policy: { allowShell: false, allowedPaths: task.allowedPaths, tools: ["edit", "read", "write"] },
    contextFiles: [{ path: "AGENTS.md", sha256: "b".repeat(64) }],
    verifier: { commands: task.verify, sha256: sha256Json(task.verify) }
  });
}

function result(runId = "run-one", status: RunResult["status"] = "verification_passed"): RunResult {
  const verification = {
    configured: true,
    success: status === "verification_passed",
    changedFiles: ["result.txt"],
    disallowedChangedFiles: [],
    commands: [{
      command: "node verify.mjs",
      status: status === "verification_passed" ? "passed" as const : "failed" as const,
      exitCode: status === "verification_passed" ? 0 : 1,
      stdout: "ok",
      stderr: "",
      outputTruncated: false,
      durationMs: 10
    }]
  };
  return parseRunResult({
    schemaVersion: 1,
    runId,
    manifestSha256: "c".repeat(64),
    startedAt: "2026-08-30T00:00:00.000Z",
    completedAt: "2026-08-30T00:00:01.000Z",
    status,
    workspace: { path: resolve("fixture-worktree"), branch: "agent/fixture", baselineCommit: commit, managedWorktree: true },
    ...(status === "execution_failed" ? {} : { verification }),
    diffSummary: "result.txt | 1 +",
    durationMs: 1_000,
    toolCallCount: 1,
    retryCount: 0,
    errorCount: status === "execution_failed" ? 1 : 0,
    errors: status === "execution_failed" ? ["failed"] : [],
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, cost: 0.001 }
  });
}

describe("evaluation artifact schemas", () => {
  it("round-trips a complete manifest with stable hashes", () => {
    const value = manifest();
    expect(parseRunManifest(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(sha256Json({ b: 2, a: 1 })).toBe(sha256Json({ a: 1, b: 2 }));
  });

  it("round-trips setup evidence and prompt policy while accepting legacy manifests", () => {
    const legacy = manifest();
    expect(legacy.setup).toBeUndefined();
    expect(legacy.agent.promptPolicyVersion).toBeUndefined();

    const commands = [{ command: "npm ci", timeoutMs: 600_000 }];
    const current = parseRunManifest({
      ...legacy,
      agent: { ...legacy.agent, promptPolicyVersion: 1 },
      setup: { source: "auto", commands, sha256: sha256Json(commands) }
    });
    expect(current.setup).toEqual({ source: "auto", commands, sha256: sha256Json(commands) });
    expect(current.agent.promptPolicyVersion).toBe(1);
  });

  it("rejects missing fields, hash drift, and duplicated replay state", () => {
    const missing = structuredClone(manifest()) as unknown as Record<string, unknown>;
    delete ((missing.task as { content: Record<string, unknown> }).content).doneWhen;
    expect(() => parseRunManifest(missing)).toThrow("doneWhen is required");

    const drift = structuredClone(manifest()) as unknown as { policy: { allowedPaths: string[] } };
    drift.policy.allowedPaths = ["**/*"];
    expect(() => parseRunManifest(drift)).toThrow("do not match TaskSpec");

    const invalidKind = { ...manifest(), replayOf: "other" };
    expect(() => parseRunManifest(invalidKind)).toThrow("cannot contain replayOf");
  });

  it("rejects result types and status/verification contradictions", () => {
    expect(() => parseRunResult({ ...result(), workspace: { ...result().workspace, managedWorktree: "false" } }))
      .toThrow("managedWorktree must be boolean");
    expect(() => parseRunResult({ ...result(), status: "verification_failed" }))
      .toThrow("contradicts verification failure");
    expect(() => parseRunResult({ ...result(), usage: { ...result().usage, cost: -1 } }))
      .toThrow("cost must be a non-negative number");
  });
});

describe("redaction and comparison", () => {
  it("omits tool bodies and suppresses env verifier output", () => {
    expect(summarizeToolArguments({ path: "src/a.ts", content: "top secret", token: "abc" })).toEqual({
      path: "src/a.ts",
      content: "[OMITTED 10 chars]",
      token: "[REDACTED]"
    });
    const report = sanitizeVerificationReport({
      configured: true,
      success: false,
      changedFiles: [],
      disallowedChangedFiles: [],
      commands: [{ command: "Get-Content .env", status: "failed", exitCode: 1, stdout: "API_KEY=secret", stderr: "", outputTruncated: false, durationMs: 1 }]
    });
    expect(JSON.stringify(report)).not.toContain("API_KEY=secret");
    expect(report.commands[0]?.command).toContain("REDACTED");
    expect(redactSensitiveText("Authorization: Bearer abcdefgh")).not.toContain("abcdefgh");
    expect(() => assertRecordableCommands([{ command: "tool --api-key=abcdefgh" }], "Setup"))
      .toThrow("inline credential");
  });

  it.each([
    ["execution_failed", "execution_failed"],
    ["verification_failed", "verification_failed"],
    ["verification_passed", "verification_passed"]
  ] as const)("classifies a comparable replay as %s", (status, expected) => {
    const comparison = compareRuns(manifest(), result(), manifest("replay-one", "replay"), result("replay-one", status));
    expect(comparison.status).toBe(expected);
  });

  it("classifies a baseline mismatch as not comparable", () => {
    const replay = { ...manifest("replay-one", "replay"), baselineCommit: "d".repeat(40) };
    expect(compareRuns(manifest(), result(), replay, result("replay-one")).status).toBe("not_comparable");
  });

  it("restores replay parameters without silently changing shell authorization", () => {
    const original = manifest();
    const plan = createReplayPlan(original, false);
    expect(plan).toMatchObject({
      sourceRepository: original.sourceRepository,
      baselineCommit: original.baselineCommit,
      allowShell: false,
      noSession: true,
      requestedModel: original.agent.model,
      thinkingLevel: "off",
      setupPreference: { mode: "disabled" }
    });
    plan.task.allowedPaths.push("extra.txt");
    expect(original.task.content.allowedPaths).toEqual(["result.txt"]);
    expect(() => createReplayPlan(original, true)).toThrow("cannot enable --unsafe-shell");

    const shellManifest = { ...original, policy: { ...original.policy, allowShell: true } };
    expect(() => createReplayPlan(shellManifest, false)).toThrow("requires explicit --unsafe-shell");
    expect(createReplayPlan(shellManifest, true).allowShell).toBe(true);
  });

  it("restores recorded setup while preserving legacy disabled semantics", () => {
    const legacy = manifest();
    expect(createReplayPlan(legacy, false).setupPreference).toEqual({ mode: "disabled" });

    const commands = [{ command: "npm ci --ignore-scripts", timeoutMs: 600_000 }];
    const current = parseRunManifest({
      ...legacy,
      setup: { source: "auto", commands, sha256: sha256Json(commands) }
    });
    expect(createReplayPlan(current, false).setupPreference).toEqual({
      mode: "resolved",
      plan: { source: "auto", commands }
    });

    const replay = { ...manifest("replay-one", "replay"), setup: { source: "disabled" as const, commands: [], sha256: sha256Json([]) } };
    expect(compareRuns(legacy, result(), replay, result("replay-one")).configurationDifferences).not.toContain("setup");
  });

  it("marks critical model or context drift as not comparable", () => {
    const replay = manifest("replay-one", "replay");
    replay.agent.model = { provider: "fixture", id: "other-model" };
    replay.contextFiles = [{ path: "AGENTS.md", sha256: "e".repeat(64) }];
    const comparison = compareRuns(manifest(), result(), replay, result("replay-one"));
    expect(comparison.status).toBe("not_comparable");
    expect(comparison.configurationDifferences).toEqual(expect.arrayContaining(["model", "contextFiles"]));
  });
});
