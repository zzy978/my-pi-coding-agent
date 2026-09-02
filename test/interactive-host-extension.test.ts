import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type AgentSessionRuntime,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInteractiveHostExtension } from "../src/runtime/interactive-host-extension.js";
import type { WorkspaceSessionStore } from "../src/runtime/session-store.js";
import { createInteractiveTask } from "../src/task/task-spec.js";

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown>;
type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 3
  })));
});

function context(sessionManager: SessionManager): ExtensionCommandContext {
  return {
    sessionManager,
    model: undefined,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn()
    }
  } as unknown as ExtensionCommandContext;
}

describe("interactive host extension", () => {
  it("restores the selected objective when switching to an empty recorded session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-session-switch-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const sessionDirectory = join(root, "sessions");
    await Promise.all([mkdir(workspace), mkdir(sessionDirectory)]);
    const selectedId = "99999999-9999-4999-8999-999999999999";
    const selectedObjective = "repair the selected parser";
    const task = createInteractiveTask({});
    const pendingSessionObjectives = new Map<string, string>();
    const events = new Map<string, EventHandler>();
    const commands = new Map<string, CommandHandler>();
    const store = {
      sourceRoot: workspace,
      sessionDirectory,
      list: vi.fn(() => Promise.resolve([{
        id: selectedId,
        path: join(sessionDirectory, "not-materialized.jsonl"),
        cwd: workspace,
        created: new Date("2026-09-01T00:00:00Z"),
        modified: new Date("2026-09-02T00:00:00Z"),
        messageCount: 0,
        firstMessage: "(no messages)",
        allMessagesText: "",
        materialized: false,
        objective: selectedObjective
      }])),
      record: vi.fn(() => Promise.resolve())
    } as unknown as WorkspaceSessionStore;
    const currentSession = SessionManager.inMemory(workspace);
    const switchSession = vi.fn(async (path: string) => {
      expect(pendingSessionObjectives.get(selectedId)).toBe(selectedObjective);
      const targetSession = SessionManager.open(path, sessionDirectory, workspace);
      const sessionStart = events.get("session_start");
      if (!sessionStart) throw new Error("Missing session_start handler");
      await sessionStart({ type: "session_start", reason: "resume" }, context(targetSession));
      return { cancelled: false };
    });
    const runtimeHost = { switchSession } as unknown as AgentSessionRuntime;
    const api = {
      on: (event: string, handler: unknown) => {
        const registered = handler as (event: unknown, context: ExtensionContext) => unknown;
        events.set(event, (payload, handlerContext) => Promise.resolve(registered(payload, handlerContext)));
      },
      registerCommand: (name: string, options: unknown) => {
        commands.set(name, (options as { handler: CommandHandler }).handler);
      },
      appendEntry: vi.fn(),
      sendUserMessage: vi.fn()
    } as unknown as ExtensionAPI;
    const extension = createInteractiveHostExtension({
      task,
      workspace: {
        sourceRoot: workspace,
        workspace,
        branch: "main",
        managedWorktree: false,
        baselineCommit: "0".repeat(40)
      },
      store,
      getRuntimeHost: () => runtimeHost,
      temporarySessionFiles: new Set(),
      pendingSessionObjectives,
      dataDirectory: join(root, "data"),
      temporaryDirectory: join(root, "data", "temp"),
      consumeInitialObjectiveOverride: () => undefined
    });
    const factory = typeof extension === "function" ? extension : extension.factory;
    await factory(api);
    const sessionsCommand = commands.get("sessions");
    if (!sessionsCommand) throw new Error("Missing sessions command");

    await sessionsCommand(selectedId, context(currentSession));

    expect(switchSession).toHaveBeenCalledOnce();
    expect(task.objective).toBe(selectedObjective);
    expect(pendingSessionObjectives).toEqual(new Map());
  });

  it("creates temporary sessions under the configured runtime data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-temp-session-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const dataDirectory = join(root, ".picoding");
    const temporaryDirectory = join(dataDirectory, "temp");
    await mkdir(workspace);
    const commands = new Map<string, CommandHandler>();
    const switchedPaths: string[] = [];
    const runtimeHost = {
      switchSession: vi.fn((path: string) => {
        switchedPaths.push(path);
        return Promise.resolve({ cancelled: false });
      })
    } as unknown as AgentSessionRuntime;
    const api = {
      on: vi.fn(),
      registerCommand: (name: string, options: unknown) => {
        commands.set(name, (options as { handler: CommandHandler }).handler);
      },
      appendEntry: vi.fn(),
      sendUserMessage: vi.fn()
    } as unknown as ExtensionAPI;
    const extension = createInteractiveHostExtension({
      task: createInteractiveTask({}),
      workspace: {
        sourceRoot: workspace,
        workspace,
        branch: "main",
        managedWorktree: false,
        baselineCommit: "0".repeat(40)
      },
      store: { sourceRoot: workspace } as WorkspaceSessionStore,
      getRuntimeHost: () => runtimeHost,
      temporarySessionFiles: new Set(),
      pendingSessionObjectives: new Map(),
      dataDirectory,
      temporaryDirectory,
      consumeInitialObjectiveOverride: () => undefined
    });
    const factory = typeof extension === "function" ? extension : extension.factory;
    await factory(api);
    const tempCommand = commands.get("temp");
    if (!tempCommand) throw new Error("Missing temp command");

    await tempCommand("", context(SessionManager.inMemory(workspace)));

    expect(switchedPaths).toHaveLength(1);
    expect(switchedPaths[0]?.startsWith(temporaryDirectory)).toBe(true);
    await expect(readdir(temporaryDirectory)).resolves.toHaveLength(1);
  });
});
