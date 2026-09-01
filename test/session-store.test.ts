import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceSessionStore } from "../src/runtime/session-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 3
  })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-session-store-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeSession(directory: string, options: {
  id: string;
  cwd: string;
  timestamp: string;
  message: string;
}): Promise<void> {
  const entries = [
    { type: "session", version: 3, id: options.id, timestamp: options.timestamp, cwd: options.cwd },
    {
      type: "message",
      id: `entry-${options.id}`,
      parentId: null,
      timestamp: options.timestamp,
      message: { role: "user", content: options.message, timestamp: new Date(options.timestamp).getTime() }
    }
  ];
  await writeFile(join(directory, `${options.id}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

describe("WorkspaceSessionStore", () => {
  it("uses a stable source-workspace scope across different effective worktrees", async () => {
    const root = await fixtureRoot();
    const source = join(root, "source");
    await mkdir(source);
    const first = await WorkspaceSessionStore.create(source, join(root, "data"));
    const second = await WorkspaceSessionStore.create(join(source, "."), join(root, "data"));

    expect(second.sessionDirectory).toBe(first.sessionDirectory);
  });

  it("initializes the same workspace atomically under concurrent callers", async () => {
    const root = await fixtureRoot();
    const source = join(root, "source");
    await mkdir(source);

    const stores = await Promise.all(Array.from({ length: 8 }, () => (
      WorkspaceSessionStore.create(source, join(root, "data"))
    )));

    expect(new Set(stores.map((store) => store.sessionDirectory)).size).toBe(1);
  });

  it("lists every materialized session ID for one source workspace newest first", async () => {
    const root = await fixtureRoot();
    const source = join(root, "source");
    await mkdir(source);
    const store = await WorkspaceSessionStore.create(source, join(root, "data"));
    await writeSession(store.sessionDirectory, {
      id: "11111111-1111-4111-8111-111111111111",
      cwd: join(root, "worktree-one"),
      timestamp: "2026-08-30T10:00:00.000Z",
      message: "first task"
    });
    await writeSession(store.sessionDirectory, {
      id: "22222222-2222-4222-8222-222222222222",
      cwd: join(root, "worktree-two"),
      timestamp: "2026-08-31T10:00:00.000Z",
      message: "second task"
    });

    const sessions = await store.list();

    expect(sessions.map((session) => session.id)).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111"
    ]);
    expect(sessions[0]).toMatchObject({ firstMessage: "second task", messageCount: 1 });
  });

  it("keeps different source workspaces isolated", async () => {
    const root = await fixtureRoot();
    const firstSource = join(root, "first");
    const secondSource = join(root, "second");
    await Promise.all([mkdir(firstSource), mkdir(secondSource)]);
    const first = await WorkspaceSessionStore.create(firstSource, join(root, "data"));
    const second = await WorkspaceSessionStore.create(secondSource, join(root, "data"));
    await writeSession(first.sessionDirectory, {
      id: "33333333-3333-4333-8333-333333333333",
      cwd: firstSource,
      timestamp: "2026-08-31T10:00:00.000Z",
      message: "only first"
    });

    expect(first.sessionDirectory).not.toBe(second.sessionDirectory);
    expect((await first.list()).map((session) => session.id)).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(await second.list()).toEqual([]);
  });

  it("records an empty session ID before Pi materializes its JSONL file", async () => {
    const root = await fixtureRoot();
    const source = join(root, "source");
    await mkdir(source);
    const store = await WorkspaceSessionStore.create(source, join(root, "data"));
    await store.record({
      id: "66666666-6666-4666-8666-666666666666",
      path: join(store.sessionDirectory, "pending.jsonl"),
      cwd: join(root, "worktree"),
      objective: "pending objective"
    });

    expect(await store.list()).toEqual([
      expect.objectContaining({
        id: "66666666-6666-4666-8666-666666666666",
        materialized: false,
        messageCount: 0,
        objective: "pending objective"
      })
    ]);
  });

  it("merges the latest recorded objective into a materialized session", async () => {
    const root = await fixtureRoot();
    const source = join(root, "source");
    await mkdir(source);
    const store = await WorkspaceSessionStore.create(source, join(root, "data"));
    const id = "99999999-9999-4999-8999-999999999999";
    const sessionPath = join(store.sessionDirectory, `${id}.jsonl`);
    await writeSession(store.sessionDirectory, {
      id,
      cwd: source,
      timestamp: "2026-08-31T10:00:00.000Z",
      message: "target history"
    });
    await store.record({ id, path: sessionPath, cwd: source, objective: "first objective" });
    await store.record({ id, path: sessionPath, cwd: source, objective: "latest objective" });

    expect(await store.list()).toEqual([
      expect.objectContaining({ id, materialized: true, objective: "latest objective" })
    ]);
  });

  it("prevents two runtimes from owning the same session and releases on dispose", async () => {
    const root = await fixtureRoot();
    const source = join(root, "source");
    await mkdir(source);
    const store = await WorkspaceSessionStore.create(source, join(root, "data"));
    const release = store.acquire("77777777-7777-4777-8777-777777777777");

    expect(() => store.acquire("77777777-7777-4777-8777-777777777777"))
      .toThrow("already active in another process");
    release();
    const releaseAgain = store.acquire("77777777-7777-4777-8777-777777777777");
    expect(releaseAgain).toBeTypeOf("function");
    releaseAgain();
  });
});
