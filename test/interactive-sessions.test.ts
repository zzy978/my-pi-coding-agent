import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PiRuntime, PiRuntimeOptions } from "../src/runtime/pi-runtime.js";

const runtimeMocks = vi.hoisted(() => ({
  create: vi.fn<(options: PiRuntimeOptions) => Promise<PiRuntime>>()
}));

vi.mock("../src/runtime/pi-runtime.js", () => ({
  PiRuntime: { create: runtimeMocks.create }
}));

import { InteractiveSessionController } from "../src/runtime/interactive-sessions.js";
import { INTERACTIVE_TASK_OBJECTIVE } from "../src/task/task-spec.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  runtimeMocks.create.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 3
  })));
});

async function controllerFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-interactive-sessions-"));
  temporaryDirectories.push(root);
  const sourceRoot = join(root, "source");
  const workspace = join(root, "worktree");
  await Promise.all([mkdir(sourceRoot), mkdir(workspace)]);
  const controller = await InteractiveSessionController.create({
    workspace,
    sourceRoot,
    getTask: () => ({
      id: "session-test",
      objective: "test sessions",
      allowedPaths: ["**/*"],
      verify: [],
      doneWhen: []
    }),
    allowShell: false,
    dataDirectory: join(root, "data")
  });
  return { controller, workspace };
}

function runtimeFixture(sessionFile: string | undefined, sessionId = "55555555-5555-4555-8555-555555555555") {
  const appendCustomEntry = vi.fn<(customType: string, data?: unknown) => string>(() => "entry-id");
  const getEntries = vi.fn(() => []);
  let conversationObjective = INTERACTIVE_TASK_OBJECTIVE;
  let disposeHandler: (() => void) | undefined;
  const dispose = vi.fn(() => disposeHandler?.());
  const onDispose = vi.fn((handler: () => void) => { disposeHandler = handler; });
  return {
    runtime: {
      hasAvailableModel: true,
      session: { sessionManager: { appendCustomEntry, getEntries }, sessionFile, sessionId },
      get conversationObjective() { return conversationObjective; },
      setConversationObjective: vi.fn((objective: string) => { conversationObjective = objective; }),
      dispose,
      onDispose
    },
    appendCustomEntry,
    dispose
  };
}

describe("InteractiveSessionController", () => {
  it("creates persistent sessions in the source-workspace session directory and records their scope", async () => {
    const { controller, workspace } = await controllerFixture();
    const fixture = runtimeFixture("new.jsonl");
    runtimeMocks.create.mockResolvedValue(fixture.runtime as unknown as PiRuntime);

    await controller.create({ type: "new" }, {
      model: { provider: "provider", id: "model" },
      thinkingLevel: "medium",
      objective: "startup objective"
    });

    const createOptions = runtimeMocks.create.mock.calls[0]?.[0];
    expect(createOptions).toMatchObject({
      workspace,
      noSession: false,
      continueSession: false,
      requestedModel: { provider: "provider", id: "model" },
      thinkingLevel: "medium"
    });
    expect(createOptions?.sessionDirectory).toContain(join("sessions", ""));
    expect(fixture.appendCustomEntry.mock.calls[0]?.[0]).toBe("pi-tui-session");
    const marker = fixture.appendCustomEntry.mock.calls[0]?.[1] as { sourceRoot?: unknown; objective?: unknown } | undefined;
    expect(typeof marker?.sourceRoot).toBe("string");
    expect(marker?.objective).toBe("startup objective");
    expect(await controller.list()).toEqual([
      expect.objectContaining({
        id: "55555555-5555-4555-8555-555555555555",
        materialized: false
      })
    ]);
  });

  it("keeps temporary sessions in memory and opens stored sessions with a cwd override", async () => {
    const { controller, workspace } = await controllerFixture();
    const temporary = runtimeFixture(undefined);
    const opened = runtimeFixture("stored.jsonl", "44444444-4444-4444-8444-444444444444");
    const pending = runtimeFixture("pending.jsonl", "88888888-8888-4888-8888-888888888888");
    runtimeMocks.create
      .mockResolvedValueOnce(temporary.runtime as unknown as PiRuntime)
      .mockResolvedValueOnce(opened.runtime as unknown as PiRuntime)
      .mockResolvedValueOnce(pending.runtime as unknown as PiRuntime);

    await controller.create({ type: "temporary" });
    await controller.create({
      type: "open",
      session: {
        id: "44444444-4444-4444-8444-444444444444",
        path: "stored.jsonl",
        cwd: "old-worktree",
        created: new Date("2026-08-30T00:00:00.000Z"),
        modified: new Date("2026-08-31T00:00:00.000Z"),
        messageCount: 2,
        firstMessage: "old task",
        allMessagesText: "old task",
        materialized: true,
        objective: "stored objective"
      }
    });
    await controller.create({
      type: "open",
      session: {
        id: "88888888-8888-4888-8888-888888888888",
        path: "not-materialized.jsonl",
        cwd: "old-worktree",
        created: new Date("2026-08-31T00:00:00.000Z"),
        modified: new Date("2026-08-31T00:00:00.000Z"),
        messageCount: 0,
        firstMessage: "(no messages)",
        allMessagesText: "",
        materialized: false
      }
    });

    expect(runtimeMocks.create.mock.calls[0]?.[0]).toMatchObject({
      workspace,
      noSession: true,
      continueSession: false
    });
    expect(runtimeMocks.create.mock.calls[0]?.[0]).not.toHaveProperty("sessionDirectory");
    expect(runtimeMocks.create.mock.calls[1]?.[0]).toMatchObject({
      workspace,
      noSession: false,
      continueSession: false,
      sessionFile: "stored.jsonl"
    });
    expect(runtimeMocks.create.mock.calls[1]?.[0]).toHaveProperty("sessionDirectory");
    expect(runtimeMocks.create.mock.calls[2]?.[0]).toMatchObject({
      workspace,
      sessionId: "88888888-8888-4888-8888-888888888888"
    });
    expect(runtimeMocks.create.mock.calls[2]?.[0]).not.toHaveProperty("sessionFile");
    expect(temporary.appendCustomEntry).not.toHaveBeenCalled();
    expect(opened.appendCustomEntry).not.toHaveBeenCalled();
    expect(temporary.runtime.conversationObjective).toBe(INTERACTIVE_TASK_OBJECTIVE);
    expect(opened.runtime.conversationObjective).toBe("stored objective");
    expect(pending.runtime.conversationObjective).toBe(INTERACTIVE_TASK_OBJECTIVE);
  });

  it("persists objective updates without changing the host task safety configuration", async () => {
    const { controller } = await controllerFixture();
    const fixture = runtimeFixture("objective.jsonl");
    runtimeMocks.create.mockResolvedValue(fixture.runtime as unknown as PiRuntime);
    const runtime = await controller.create({ type: "new" });

    await controller.updateObjective(runtime, "target session objective");

    expect(runtime.conversationObjective).toBe("target session objective");
    expect(fixture.appendCustomEntry).toHaveBeenLastCalledWith("pi-tui-session", expect.objectContaining({
      objective: "target session objective"
    }));
    expect(await controller.list()).toEqual([
      expect.objectContaining({ objective: "target session objective" })
    ]);
  });

  it("disposes a runtime when session-scope initialization fails", async () => {
    const { controller } = await controllerFixture();
    const fixture = runtimeFixture("new.jsonl");
    fixture.appendCustomEntry.mockImplementation(() => { throw new Error("record failed"); });
    runtimeMocks.create.mockResolvedValue(fixture.runtime as unknown as PiRuntime);

    await expect(controller.create({ type: "new" })).rejects.toThrow("record failed");
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });
});
