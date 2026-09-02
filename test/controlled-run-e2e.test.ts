import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { executeControlledRun } from "../src/evaluation/runner.js";
import { loadRunBundle } from "../src/evaluation/store.js";
import type { ControlledPiRuntime } from "../src/runtime/controlled-pi-runtime.js";
import { parseTaskSpec } from "../src/task/task-spec.js";
import { discardManagedWorkspace, prepareWorkspace } from "../src/workspace/git.js";
import { initializeGitRepository } from "./helpers/git-repository.js";

const temporaryDirectories: string[] = [];
const capturedPrompts: string[] = [];

afterEach(async () => {
  capturedPrompts.length = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});

function createFakeRuntime(workspace: string): ControlledPiRuntime {
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
      prompt: async (text: string) => {
        capturedPrompts.push(text);
        emit({ type: "agent_start" } as AgentSessionEvent);
        emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hidden" } } as AgentSessionEvent);
        emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "write", args: { path: "result.txt", content: "done\nSECRET" } } as AgentSessionEvent);
        await writeFile(join(workspace, "result.txt"), "done\n", "utf8");
        emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "write", isError: false, result: { content: [{ type: "text", text: "done\nSECRET" }] } } as AgentSessionEvent);
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
});
