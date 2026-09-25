import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { RunRecorder } from "../src/evaluation/recorder.js";
import { createApprovalGatedShellOperations } from "../src/policy/safe-tools.js";
import { executeControlledRun } from "../src/evaluation/runner.js";
import { createReplayPlan } from "../src/evaluation/replay.js";
import { sha256Text } from "../src/evaluation/schema.js";
import { loadRunBundle } from "../src/evaluation/store.js";
import { renderCandidatePrompt } from "../src/experience/candidate.js";
import type { ControlledPiRuntime } from "../src/runtime/controlled-pi-runtime.js";
import { formatTaskPrompt, parseTaskSpec } from "../src/task/task-spec.js";
import { discardManagedWorkspace, prepareWorkspace } from "../src/workspace/git.js";
import { initializeGitRepository } from "./helpers/git-repository.js";

const temporaryDirectories: string[] = [];
const capturedPrompts: string[] = [];

afterEach(async () => {
  capturedPrompts.length = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});

function createFakeRuntime(workspace: string, act?: (attempt: number) => Promise<void>, stopReason = "stop"): ControlledPiRuntime {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let stats: SessionStats = {
    sessionFile: undefined,
    sessionId: `fixture-${Date.now()}`,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0
  };
  const emit = (event: AgentSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  return {
    hasAvailableModel: true,
    contextFiles: [],
    session: {
      model: { provider: "fixture", id: "deterministic" },
      thinkingLevel: "off",
      sessionId: stats.sessionId,
      sessionFile: undefined,
      getActiveToolNames: () => ["read", "edit", "write", "ls"],
      getSessionStats: () => structuredClone(stats),
      subscribe: (listener: (event: AgentSessionEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abortRetry: () => undefined,
      abortCompaction: () => undefined,
      abort: () => Promise.resolve(),
      prompt: async (text: string) => {
        capturedPrompts.push(text);
        emit({ type: "agent_start" } as AgentSessionEvent);
        emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hidden" } } as AgentSessionEvent);
        emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "write", args: { path: "result.txt", content: "done\nSECRET" } } as AgentSessionEvent);
        await writeFile(join(workspace, "result.txt"), "done\n", "utf8");
        await act?.(capturedPrompts.length);
        emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "write", isError: false, result: { content: [{ type: "text", text: "Wrote result.txt\nBearer fake-tool-result-secret\u001b[2J\n" + '{"apiKey":"fake-json-result-key"}\n' + "x".repeat(2_000) }] } } as AgentSessionEvent);
        emit({ type: "message_end", message: { role: "assistant", stopReason } } as AgentSessionEvent);
        emit({ type: "agent_settled" } as AgentSessionEvent);
        stats = {
          ...stats,
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 1,
          toolResults: 1,
          totalMessages: 3,
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
          cost: 0.001
        };
      }
    },
    dispose: () => undefined
  } as unknown as ControlledPiRuntime;
}

describe("controlled run and replay lifecycle", () => {
  it("repairs a failed verifier in the same run and retains the first failure evidence", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-controlled-repair-"));
    temporaryDirectories.push(parent);
    const source = join(parent, "source");
    const dataDirectory = join(parent, "data");
    await initializeGitRepository(source);
    const workspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
    const task = parseTaskSpec({ objective: "修复 result.txt", maxRepairAttempts: 2,
      verify: ["node -e \"process.exit(require('fs').readFileSync('result.txt','utf8').trim()==='fixed'?0:1)\""] });
    const result = await executeControlledRun({ kind: "run", task, workspace, allowShell: false, noSession: true,
      setup: { source: "disabled", commands: [] }, dataDirectory,
      runtime: createFakeRuntime(workspace.workspace, async (attempt) => {
        if (attempt === 2) await writeFile(join(workspace.workspace, "result.txt"), "fixed");
      }) });
    expect(result.result.status).toBe("verification_passed");
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).toContain("exitCode");
    expect(JSON.parse(await readFile(join(result.directory, "verification-0.json"), "utf8"))).toMatchObject({ success: false });
    expect(JSON.parse(await readFile(join(result.directory, "verification-1.json"), "utf8"))).toMatchObject({ success: true });
    const stored = await loadRunBundle(result.manifest.runId, dataDirectory);
    expect(stored.manifest.task.content).toMatchObject({ maxRepairAttempts: 2 });
    await discardManagedWorkspace(workspace);
  });

  it.each([undefined, 0, 2])("bounds unsuccessful repairs with maxRepairAttempts=%s", async (limit) => {
    const parent = await mkdtemp(join(tmpdir(), "pi-controlled-repair-limit-"));
    temporaryDirectories.push(parent);
    const source = join(parent, "source");
    const dataDirectory = join(parent, "data");
    await initializeGitRepository(source);
    const workspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
    const task = parseTaskSpec({ objective: "失败验收", ...(limit === undefined ? {} : { maxRepairAttempts: limit }),
      verify: ["node -e \"process.exit(1)\""] });
    const result = await executeControlledRun({ kind: "run", task, workspace, allowShell: false, noSession: true,
      setup: { source: "disabled", commands: [] }, dataDirectory, runtime: createFakeRuntime(workspace.workspace) });
    expect(capturedPrompts).toHaveLength(1 + (limit ?? 0));
    expect(result.result.status).toBe("verification_failed");
    await discardManagedWorkspace(workspace);
  });

  it.each(["error", "abort"])("preserves failure evidence if repair ends in %s", async (failure) => {
    const parent = await mkdtemp(join(tmpdir(), "pi-controlled-repair-error-"));
    temporaryDirectories.push(parent);
    const source = join(parent, "source");
    const dataDirectory = join(parent, "data");
    await initializeGitRepository(source);
    const workspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
    const controller = new AbortController();
    const task = parseTaskSpec({ objective: "错误不能判成功", maxRepairAttempts: 2, verify: ["node -e \"process.exit(1)\""] });
    const result = await executeControlledRun({ kind: "run", task, workspace, allowShell: false, noSession: true,
      signal: controller.signal, setup: { source: "disabled", commands: [] }, dataDirectory,
      runtime: createFakeRuntime(workspace.workspace, (attempt) => {
        if (attempt === 2) {
          if (failure === "abort") controller.abort();
          else throw new Error("simulated model failure");
        }
        return Promise.resolve();
      }) });
    expect(capturedPrompts).toHaveLength(2);
    expect(result.result.status).toBe("execution_failed");
    expect(result.result.verification?.success).toBe(false);
    expect(JSON.parse(await readFile(join(result.directory, "verification-0.json"), "utf8"))).toMatchObject({ success: false });
    await expect(readFile(join(result.directory, "verification-1.json"), "utf8")).rejects.toThrow();
    await discardManagedWorkspace(workspace);
  });
  it("retains a completed passing verification when cancelled during the verification stage", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-controlled-verifier-cancel-"));
    temporaryDirectories.push(parent);
    const source = join(parent, "source");
    const dataDirectory = join(parent, "data");
    await initializeGitRepository(source);
    const workspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await executeControlledRun({ kind: "run", workspace, allowShell: false, noSession: true,
        task: parseTaskSpec({ objective: "验证期间取消", maxRepairAttempts: 2, verify: ["node -e \"setTimeout(()=>process.exit(0),200)\""] }),
        signal: controller.signal, setup: { source: "disabled", commands: [] }, dataDirectory,
        onStatus: (status) => { if (status.endsWith(": verification")) timer = setTimeout(() => controller.abort(), 50); },
        runtime: createFakeRuntime(workspace.workspace) });
      expect(controller.signal.aborted).toBe(true);
      expect(result.result.status).toBe("verification_passed");
      expect(capturedPrompts).toHaveLength(1);
      await expect(loadRunBundle(result.manifest.runId, dataDirectory)).resolves.toBeDefined();
    } finally {
      clearTimeout(timer);
      await discardManagedWorkspace(workspace);
    }
  });
  it("shares the model phase deadline across repair prompts", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-controlled-repair-budget-"));
    temporaryDirectories.push(parent);
    const source = join(parent, "source");
    const dataDirectory = join(parent, "data");
    await initializeGitRepository(source);
    const workspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
    const runtime = createFakeRuntime(workspace.workspace, () => new Promise((resolve) => setTimeout(resolve, 650)));
    Object.defineProperty(runtime, "modelConfig", { value: {
      requestTimeoutMs: 1_000, maxOutputTokens: 1024, taskTimeoutMs: 1_000, baseUrlSha256: "0".repeat(64)
    } });
    const result = await executeControlledRun({ kind: "run", workspace, allowShell: false, noSession: true,
      task: parseTaskSpec({ objective: "累计模型预算", maxRepairAttempts: 5, verify: ["node -e \"process.exit(1)\""] }),
      setup: { source: "disabled", commands: [] }, dataDirectory, runtime });
    expect(result.result.status).toBe("execution_failed");
    expect(result.result.errors.join("\n")).toContain("timed out");
    expect(capturedPrompts).toHaveLength(2);
    await discardManagedWorkspace(workspace);
  });
  it.each(["error", "aborted", "length"])("does not verify or repair a model ending with %s without throwing", async (reason) => {
    const parent = await mkdtemp(join(tmpdir(), "pi-controlled-model-stop-"));
    temporaryDirectories.push(parent);
    const source = join(parent, "source");
    const dataDirectory = join(parent, "data");
    await initializeGitRepository(source);
    const workspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
    const result = await executeControlledRun({ kind: "run", workspace, allowShell: false, noSession: true,
      task: parseTaskSpec({ objective: "模型异常不判成功", maxRepairAttempts: 2, verify: ["node -e \"process.exit(0)\""] }),
      setup: { source: "disabled", commands: [] }, dataDirectory,
      runtime: createFakeRuntime(workspace.workspace, undefined, reason) });
    expect(result.result.status).toBe("execution_failed");
    expect(result.result.verification).toBeUndefined();
    expect(capturedPrompts).toHaveLength(1);
    await discardManagedWorkspace(workspace);
  });
  it("persists a redacted policy failure correlated with the tool call", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-policy-trace-"));
    temporaryDirectories.push(parent);
    const source = join(parent, "source");
    const dataDirectory = join(parent, "data");
    await initializeGitRepository(source);
    const workspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
    const runtime = createFakeRuntime(workspace.workspace);
    const task = parseTaskSpec({ objective: "record policy diagnostic" });
    const recorder = await RunRecorder.create({ kind: "run", runtime, task, workspace, allowShell: true,
      noSession: true, setup: { source: "disabled", commands: [] }, dataDirectory });
    const command = 'format D: --token="private multiword credential"';
    const operations = createApprovalGatedShellOperations({ exec: () => { throw new Error("must not execute"); } },
      () => Promise.resolve(false));
    let message = "";
    try { await operations.exec(command, source, { onData: () => undefined }); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    recorder.recordAgentEvent({ type: "tool_execution_start", toolCallId: "denied-1", toolName: "powershell", args: { command } } as AgentSessionEvent);
    recorder.recordAgentEvent({ type: "tool_execution_end", toolCallId: "denied-1", toolName: "powershell", isError: true,
      result: { content: [{ type: "text", text: message }], terminate: true } } as AgentSessionEvent);
    recorder.recordAgentEvent({ type: "tool_execution_end", toolCallId: "recoverable", toolName: "bash", isError: true,
      result: { content: [], terminate: false } } as AgentSessionEvent);
    recorder.recordAgentEvent({ type: "tool_execution_end", toolCallId: "legacy", toolName: "bash", isError: false,
      result: { content: [] } } as AgentSessionEvent);
    recorder.recordAgentEvent({ type: "tool_execution_end", toolCallId: "malformed", toolName: "bash", isError: false,
      result: { content: [], terminate: "private-terminate-value" } } as unknown as AgentSessionEvent);
    for (const stopReason of ["stop", "toolUse", "length", "error", "aborted", "private-stop-reason"]) {
      recorder.recordAgentEvent({ type: "message_end", message: { role: "assistant", stopReason,
        content: [{ type: "thinking", thinking: "private-thought" }] } } as AgentSessionEvent);
    }
    const run = await recorder.finalize({ runtime, diffSummary: "" });
    const trace = await readFile(run.tracePath, "utf8");
    const result = await readFile(run.resultPath, "utf8");
    expect(trace).toContain('"policyFailure"');
    expect(trace).toContain("denied-1");
    const entries = trace.trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
    const toolData = (id: string) => entries.find((entry) => entry.type === "tool_end" && entry.data?.toolCallId === id)?.data;
    expect(toolData("denied-1")).toMatchObject({ terminate: true });
    expect(toolData("recoverable")).toMatchObject({ terminate: false });
    expect(toolData("legacy")).not.toHaveProperty("terminate");
    expect(toolData("malformed")).not.toHaveProperty("terminate");
    expect(entries.filter((entry) => entry.type === "message_end").map((entry) => entry.data?.stopReason))
      .toEqual(["stop", "toolUse", "length", "error", "aborted", undefined]);
    for (const secret of ["private-terminate-value", "private-stop-reason", "private-thought"]) expect(trace).not.toContain(secret);
    for (const artifact of [trace, result]) {
      expect(artifact).toContain("disk-format");
      expect(artifact).toContain("format D:");
      expect(artifact).not.toContain("private multiword credential");
    }
    await discardManagedWorkspace(workspace);
  });

  it("records setup failures before the model is prompted", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-controlled-setup-failure-"));
    temporaryDirectories.push(parent);
    const source = join(parent, "source");
    const dataDirectory = join(parent, "data");
    await initializeGitRepository(source);
    const workspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
    const task = parseTaskSpec({ id: "setup-failure", objective: "不应启动模型" });
    const runtime = createFakeRuntime(workspace.workspace);
    const finalized = await executeControlledRun({
      kind: "run",
      runtime,
      task,
      workspace,
      allowShell: false,
      noSession: true,
      setup: {
        source: "explicit",
        commands: [{ command: "npm run missing-setup-script", timeoutMs: 10_000 }]
      },
      dataDirectory
    });

    expect(finalized.setupFailed).toBe(true);
    expect(finalized.result.status).toBe("execution_failed");
    expect(finalized.result.errors.join("\n")).toContain("Workspace setup command failed");
    expect(capturedPrompts).toEqual([]);
    await expect(access(join(finalized.directory, "manifest.json"))).resolves.toBeUndefined();
    await expect(access(join(finalized.directory, "result.json"))).resolves.toBeUndefined();
    expect(await readFile(join(finalized.directory, "trace.jsonl"), "utf8")).toContain('"type":"setup_end"');
    await discardManagedWorkspace(workspace);
  });

  it("records evidence and replays from the same baseline in a fresh worktree", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-controlled-e2e-"));
    temporaryDirectories.push(parent);
    const source = join(parent, "source");
    const dataDirectory = join(parent, "data");
    await initializeGitRepository(source);
    const task = parseTaskSpec({
      id: "write-result",
      objective: "Create result.txt containing done",
      allowedPaths: ["result.txt"],
      verify: ["node -e \"process.exit(require('fs').readFileSync('result.txt','utf8').trim()==='done'?0:1)\""]
    });

    const originalWorkspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
    const original = await executeControlledRun({
      kind: "run",
      runtime: createFakeRuntime(originalWorkspace.workspace),
      task,
      workspace: originalWorkspace,
      allowShell: false,
      noSession: true,
      setup: { source: "disabled", commands: [] },
      dataDirectory
    });
    expect(original.result.status).toBe("verification_passed");
    expect(original.result.usage.total).toBe(15);
    await expect(access(join(original.directory, "manifest.json"))).resolves.toBeUndefined();
    await expect(access(join(original.directory, "trace.jsonl"))).resolves.toBeUndefined();
    await expect(access(join(original.directory, "verification.json"))).resolves.toBeUndefined();
    await expect(access(join(original.directory, "report.md"))).resolves.toBeUndefined();
    const trace = await readFile(join(original.directory, "trace.jsonl"), "utf8");
    expect(trace).toContain('"type":"tool_start"');
    const toolEnd = trace.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { type: string; data?: { resultSummary?: string } }).find((entry) => entry.type === "tool_end");
    expect(toolEnd?.data?.resultSummary).toContain("Wrote result.txt");
    expect(toolEnd?.data?.resultSummary?.length).toBeLessThanOrEqual(1_000);
    expect(trace).not.toContain("fake-tool-result-secret");
    expect(trace).not.toContain("fake-json-result-key");
    expect(toolEnd?.data?.resultSummary).not.toContain("\u001b");
    expect(trace).toContain("[OMITTED 11 chars]");
    expect(trace).not.toContain("done\\nSECRET");
    expect(trace).not.toContain('"delta":"hidden"');

    const stored = await loadRunBundle(original.manifest.runId, dataDirectory);
    const replayWorkspace = await prepareWorkspace(stored.manifest.sourceRepository, {
      inPlace: false,
      dataDirectory,
      baselineCommit: stored.manifest.baselineCommit,
      branchPrefix: "replay"
    });
    expect(replayWorkspace.workspace).not.toBe(originalWorkspace.workspace);
    expect(replayWorkspace.workspace).not.toBe(source);
    const replay = await executeControlledRun({
      kind: "replay",
      replayOf: stored.manifest.runId,
      runtime: createFakeRuntime(replayWorkspace.workspace),
      task: stored.manifest.task.content,
      workspace: replayWorkspace,
      allowShell: false,
      noSession: true,
      setup: { source: "disabled", commands: [] },
      dataDirectory
    });
    expect(replay.result.status).toBe("verification_passed");
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[0]).toContain("Current user message:\nCreate result.txt containing done");
    expect(capturedPrompts[0]).toContain("Response-language rule:");
    expect(capturedPrompts[1]).toBe(capturedPrompts[0]);
    expect(JSON.parse(await readFile(join(replay.directory, "comparison.json"), "utf8"))).toMatchObject({
      originalRunId: original.manifest.runId,
      replayRunId: replay.manifest.runId,
      status: "verification_passed",
      baseline: { same: true },
      task: { same: true }
    });
    await expect(readFile(join(source, "result.txt"), "utf8")).rejects.toThrow();

    await discardManagedWorkspace(originalWorkspace);
    await discardManagedWorkspace(replayWorkspace);
  }, 30_000);

  it("records a selected replay prompt and reports a single-run experience observation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-replay-experience-"));
    temporaryDirectories.push(parent);
    const source = join(parent, "source");
    const dataDirectory = join(parent, "data");
    await initializeGitRepository(source);
    const task = parseTaskSpec({ objective: "Create result.txt containing done", maxRepairAttempts: 0,
      verify: ["node -e \"process.exit(require('fs').readFileSync('result.txt','utf8').trim()==='done'?0:1)\""] });
    const originalWorkspace = await prepareWorkspace(source, { inPlace: false, dataDirectory });
    const original = await executeControlledRun({ kind: "run", task, workspace: originalWorkspace, allowShell: false,
      noSession: true, setup: { source: "disabled", commands: [] }, dataDirectory,
      runtime: createFakeRuntime(originalWorkspace.workspace, () => writeFile(join(originalWorkspace.workspace, "result.txt"), "wrong\n")) });
    expect(original.result.status).toBe("verification_failed");
    const candidate = { id: "retrieved-one", kind: "strategy" as const, content: "Inspect the failing test first.",
      contentSha256: sha256Text("Inspect the failing test first."), rendererVersion: 1 as const };
    const selection = { mode: "auto" as const, status: "selected" as const, poolSha256: "d".repeat(64),
      auditId: "audit-one", auditSha256: "e".repeat(64), selectedIds: ["candidate-one"], candidate,
      effectivePromptSha256: sha256Text(renderCandidatePrompt(formatTaskPrompt(task, task.objective), candidate)) };
    const replayWorkspace = await prepareWorkspace(source, { inPlace: false, dataDirectory,
      baselineCommit: original.manifest.baselineCommit, branchPrefix: "replay" });
    const replay = await executeControlledRun({ kind: "replay", replayOf: original.manifest.runId,
      replayExperience: selection, task, workspace: replayWorkspace, allowShell: false, noSession: true,
      setup: { source: "disabled", commands: [] }, dataDirectory, runtime: createFakeRuntime(replayWorkspace.workspace) });
    expect(replay.manifest.schemaVersion).toBe(3);
    expect(replay.manifest.replayExperience).toMatchObject({ status: "selected", selectedIds: ["candidate-one"] });
    expect(capturedPrompts[1]).toContain(candidate.content);
    expect(capturedPrompts[1]).toContain("<experience-guidance");
    const comparison = JSON.parse(await readFile(join(replay.directory, "comparison.json"), "utf8")) as {
      status: string; experienceObservation?: { outcome: string; eligible: boolean };
    };
    expect(comparison.status).toBe("not_comparable");
    expect(comparison.experienceObservation).toMatchObject({ eligible: true, outcome: "observed_improvement" });

    const frozen = createReplayPlan((await loadRunBundle(replay.manifest.runId, dataDirectory)).manifest);
    const secondWorkspace = await prepareWorkspace(source, { inPlace: false, dataDirectory,
      baselineCommit: frozen.baselineCommit, branchPrefix: "replay" });
    const second = await executeControlledRun({ kind: "replay", replayOf: replay.manifest.runId,
      ...(frozen.replayExperience ? { replayExperience: frozen.replayExperience } : {}),
      task: frozen.task, workspace: secondWorkspace, allowShell: false, noSession: true,
      setup: { source: "disabled", commands: [] }, dataDirectory, runtime: createFakeRuntime(secondWorkspace.workspace) });
    expect(capturedPrompts[2]).toBe(capturedPrompts[1]);
    expect(JSON.parse(await readFile(join(second.directory, "comparison.json"), "utf8"))).toMatchObject({
      status: "verification_passed"
    });
    await discardManagedWorkspace(originalWorkspace);
    await discardManagedWorkspace(replayWorkspace);
    await discardManagedWorkspace(secondWorkspace);
  }, 30_000);
});
