import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPresets } from "../src/runtime/extensions/preset.js";
import { extractTodoItems, markCompletedSteps } from "../src/runtime/extensions/plan-mode/utils.js";
import { createPiInteractiveRuntime } from "../src/runtime/pi-interactive.js";
import { createInteractiveTask } from "../src/task/task-spec.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("workflow presets and plans", () => {
  it("hands off from a temporary session into a saveable host-managed session", async () => {
    const root = await mkdtemp(join(tmpdir(), "picode-temp-handoff-"));
    directories.push(root);
    const task = createInteractiveTask({});
    const runtime = await createPiInteractiveRuntime({
      workspace: { workspace: root, sourceRoot: root, branch: "", baselineCommit: "", managedWorktree: false, gitUnavailable: true },
      task, allowShell: false, continueSession: false, noSession: false, dataDirectory: join(root, "data")
    });
    try {
      await runtime.session.bindExtensions({ mode: "print" });
      await runtime.session.prompt("/temp");
      await runtime.session.bindExtensions({ mode: "print" });
      const temporaryFile = runtime.session.sessionFile;
      runtime.session.sessionManager.appendMessage({ role: "user", content: "待交接的上下文", timestamp: Date.now() });
      const runner = runtime.session.extensionRunner;
      const command = runner.getCommand("handoff");
      const ctx = runner.createCommandContext();
      const model = ctx.modelRegistry.getAll()[0];
      if (!command || !model) throw new Error("Missing handoff command or model metadata");
      await command.handler("继续实现", {
        ...ctx, mode: "tui", hasUI: true, model,
        ui: { ...ctx.ui, custom: () => Promise.resolve("交接摘要") as never, editor: () => Promise.resolve("交接摘要") }
      });
      await runtime.session.bindExtensions({ mode: "print" });
      expect(runtime.session.sessionFile).not.toBe(temporaryFile);
      expect(runtime.session.sessionFile).not.toContain(`${join(root, "data", "temp")}`);
      expect(task.objective).toBe("继续实现");
      expect(() => runtime.session.sessionManager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "模拟交接后回复" }],
        api: "openai-completions", provider: "fake", model: "test", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      })).not.toThrow();
      const handoffId = runtime.session.sessionId;
      await runtime.session.prompt("/temp");
      await runtime.session.bindExtensions({ mode: "print" });
      await runtime.session.prompt(`/sessions ${handoffId}`);
      await runtime.session.bindExtensions({ mode: "print" });
      expect(runtime.session.sessionId).toBe(handoffId);
      expect(task.objective).toBe("继续实现");
    } finally { await runtime.dispose(); }
  });
  it("merges global/project presets and rejects malformed input without echoing its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "picode-presets-"));
    directories.push(root);
    const global = join(root, "global.json");
    const project = join(root, "project.json");
    await writeFile(global, JSON.stringify({ review: { tools: ["read"] }, global: { instructions: "global" } }));
    await writeFile(project, JSON.stringify({ review: { tools: [] } }));
    expect(await loadPresets([global, project], {})).toEqual({ review: { tools: [] }, global: { instructions: "global" } });
    for (const invalid of ['{ secret', '[]', '{"bad":{"tools":"write"}}', '{"bad":{"provider":"fake"}}']) {
      await writeFile(project, invalid);
      await expect(loadPresets([project], {})).rejects.toThrow();
    }
  });

  it("keeps no-shell enforced, restores selected presets on resume, and persists clearing a preset", async () => {
    const root = await mkdtemp(join(tmpdir(), "picode-preset-session-"));
    directories.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pi"), { recursive: true });
    await writeFile(join(workspace, ".pi", "presets.json"), JSON.stringify({
      empty: { tools: [] },
      invalid: { tools: ["powershell", "bash"] },
      missingModel: { provider: "not-a-provider", model: "not-a-model", tools: [] }
    }));
    const task = createInteractiveTask({});
    const options = {
      workspace: { workspace, sourceRoot: workspace, branch: "", baselineCommit: "", managedWorktree: false, gitUnavailable: true },
      task, allowShell: false, continueSession: false, noSession: false, dataDirectory: join(root, "data")
    };
    const first = await createPiInteractiveRuntime(options);
    try {
      await first.session.bindExtensions({ mode: "print" });
      // Pi materializes a persistent session only after its first assistant message.
      first.session.sessionManager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "模拟已有对话" }],
        api: "openai-completions", provider: "fake", model: "test", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      });
      const original = first.session.getActiveToolNames();
      await first.session.prompt("/preset invalid");
      expect(first.session.getActiveToolNames()).toEqual(original);
      await first.session.prompt("/preset missingModel");
      expect(first.session.getActiveToolNames()).toEqual(original);
      await first.session.prompt("/preset empty");
      expect(first.session.getActiveToolNames()).toEqual([]);
    } finally { await first.dispose(); }
    const resumed = await createPiInteractiveRuntime({ ...options, continueSession: true });
    try {
      await resumed.session.bindExtensions({ mode: "print" });
      expect(resumed.session.getActiveToolNames()).toEqual([]);
      await resumed.session.prompt("/preset off");
      expect(resumed.session.getActiveToolNames()).toContain("write");
      expect(resumed.session.getActiveToolNames()).not.toContain("powershell");
      expect(resumed.session.getActiveToolNames()).not.toContain("bash");
      await resumed.session.reload();
      await resumed.session.bindExtensions({ mode: "print" });
      expect(resumed.session.getActiveToolNames()).toContain("write");
      await resumed.newSession();
      await resumed.session.bindExtensions({ mode: "print" });
      expect(resumed.session.getActiveToolNames()).toContain("write");
    } finally { await resumed.dispose(); }
  });

  it("extracts Chinese and English numbered plans and records only matching completion markers", () => {
    for (const title of ["计划：", "## 实施计划", "**Plan:**"]) {
      const items = extractTodoItems(`${title}\n1. 阅读代码\n2. 添加测试\n## 其他\n1. 不属于计划`);
      expect(items.map((item) => item.text)).toEqual(["阅读代码", "添加测试"]);
      markCompletedSteps("[DONE:2] [DONE:999]", items);
      expect(items.map((item) => item.completed)).toEqual([false, true]);
    }
    expect(extractTodoItems("普通回答\n1. 一个列表")).toEqual([]);
  });
});
