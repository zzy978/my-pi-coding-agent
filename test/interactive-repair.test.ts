import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInteractiveHostExtension } from "../src/runtime/interactive-host-extension.js";
import type { WorkspaceSessionStore } from "../src/runtime/session-store.js";
import { parseTaskSpec } from "../src/task/task-spec.js";
import { initializeGitRepository } from "./helpers/git-repository.js";

const roots: string[] = [];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 3 })));
});

async function harness(limit = 2, transformFeedback = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-interactive-repair-"));
  roots.push(root);
  const workspace = join(root, "repo");
  await initializeGitRepository(workspace);
  const task = parseTaskSpec({ objective: "修复 result.txt", maxRepairAttempts: limit,
    verify: ["node -e \"process.exit(require('fs').existsSync('result.txt')?0:1)\""] });
  const events = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
  const sent: string[] = [];
  const notices: string[] = [];
  let planning = false;
  const ctx = { sessionManager: SessionManager.inMemory(workspace),
    model: { provider: "fake", id: "fake" }, isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify: (text: string) => notices.push(text), setStatus: vi.fn() }
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}) => { await events.get(name)?.(event, ctx); };
  const extension = createInteractiveHostExtension({ task,
    workspace: { workspace, sourceRoot: workspace, managedWorktree: false, branch: "main", baselineCommit: "0".repeat(40) },
    store: { record: () => Promise.resolve() } as unknown as WorkspaceSessionStore,
    getRuntimeHost: () => ({} as AgentSessionRuntime), temporarySessionFiles: new Set(), pendingSessionObjectives: new Map(),
    dataDirectory: join(root, "data"), temporaryDirectory: join(root, "temp"),
    consumeInitialObjectiveOverride: () => undefined, isPlanning: () => planning });
  const api = { on: (name: string, handler: Handler) => events.set(name, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) => commands.set(name, command.handler),
    appendEntry: vi.fn(), sendUserMessage: (text: string) => {
      sent.push(text);
      void emit("input", { source: "extension", text: transformFeedback ? `扩展改写：${text}` : text });
    }
  } as unknown as ExtensionAPI;
  await (typeof extension === "function" ? extension : extension.factory)(api);
  await emit("input", { source: "interactive", text: "请修复" });
  const finish = async (stopReason = "stop") => {
    await emit("agent_end", { messages: [{ role: "assistant", stopReason, content: [{ type: "text", text: "done" }] }] });
    await emit("agent_settled");
  };
  const command = async (name: string, text: string) => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`Command not registered: ${name}`);
    await handler(text, ctx);
  };
  return { root, workspace, task, ctx, sent, notices, emit, finish, command, plan: () => { planning = true; } };
}

describe("interactive verification repair", () => {
  it("feeds failure evidence back, verifies the repaired file and stops on success", async () => {
    const h = await harness();
    await h.finish();
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toContain("exitCode");
    await writeFile(join(h.workspace, "result.txt"), "fixed");
    await h.finish();
    expect(h.sent).toHaveLength(1);
    const reports = (await readdir(join(h.root, "data", "reports"))).filter((name) => name.endsWith(".json"));
    const results = await Promise.all(reports.map(async (name) => JSON.parse(await readFile(join(h.root, "data", "reports", name), "utf8")) as { verification: { success: boolean } }));
    expect(results.map((result) => result.verification.success).sort()).toEqual([false, true]);
  });
  it("exhausts the limit without resetting it on extension follow-ups", async () => {
    const h = await harness(1);
    await h.finish();
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    await h.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.sent).toHaveLength(1);
    expect(h.notices.join("\n")).toContain("上限");
  });
  it("preserves the repair budget when an earlier input extension transforms feedback", async () => {
    const h = await harness(1, true);
    await h.finish();
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    await h.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.sent).toHaveLength(1);
  });
  it.each(["aborted", "error", "length"])("does not restart an agent ending with %s", async (reason) => {
    const h = await harness();
    await h.finish(reason);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.sent).toEqual([]);
  });
  it("manual verification does not launch a model and off cancels a scheduled repair", async () => {
    const h = await harness();
    await h.command("verify", "");
    expect(h.sent).toEqual([]);
    await h.finish();
    await h.command("repair", "off");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.sent).toEqual([]);
  });
  it("manual verification cancels an already scheduled automatic continuation", async () => {
    const h = await harness();
    await h.finish();
    await h.command("verify", "");
    expect(h.sent).toEqual([]);
  });
  it.each([["input", "interactive"], ["input", "extension"], ["session_start", "interactive"]])("invalidates scheduled feedback on %s from %s", async (event, source) => {
    const h = await harness();
    await h.finish();
    await h.emit(event, event === "input" ? { source, text: "新任务" } : { reason: "new" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.sent).toEqual([]);
  });
  it("does not verify or repair in planning mode", async () => {
    const h = await harness();
    h.plan();
    await h.finish();
    expect(h.sent).toEqual([]);
    await expect(readdir(join(h.root, "data", "reports"))).rejects.toThrow();
  });
  it("verifies a newer turn after an older verification completes", async () => {
    const h = await harness(1);
    h.task.verify = [{ command: "node -e \"setTimeout(()=>process.exit(1),200)\"", timeoutMs: 1_000 }];
    await h.emit("input", { source: "interactive", text: "开始" });
    const old = h.finish();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.emit("input", { source: "interactive", text: "新一轮" });
    const current = h.finish();
    await Promise.all([old, current]);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
  });
});
