import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { createPiInteractiveRuntime } from "../src/runtime/pi-interactive.js";
import { createInteractiveTask } from "../src/task/task-spec.js";
import { SessionPicker } from "../src/tui/session-picker.js";
import type { StoredSessionInfo } from "../src/runtime/session-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("full Pi interactive runtime", () => {
  it("keeps long session summaries on bounded rows and supports arrow-key selection", () => {
    const base: Omit<StoredSessionInfo, "id" | "path" | "firstMessage"> = {
      cwd: "D:\\Agent",
      created: new Date("2026-09-01T00:00:00Z"),
      modified: new Date("2026-09-01T00:00:00Z"),
      messageCount: 1,
      allMessagesText: "",
      materialized: true
    };
    const sessions: StoredSessionInfo[] = [
      {
        ...base,
        id: "first-session",
        path: "first.jsonl",
        objective: "为我创建一个 python 文件，并为我运行",
        firstMessage: `<skill>\n${"非常长的多行提示".repeat(30)}`
      },
      { ...base, id: "second-session", path: "second.jsonl", firstMessage: "second task" }
    ];
    const picker = new SessionPicker(sessions);
    let selected: StoredSessionInfo | undefined;
    picker.onSelect = (session) => {
      selected = session;
    };

    const rendered = picker.render(80);
    expect(rendered.every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(stripTerminalSequences(rendered.join("\n"))).toContain("为我创建");
    picker.handleInput("\u001b[B");
    picker.handleInput("\r");
    expect(selected?.id).toBe("second-session");
  });

  it("loads project resources and exposes the complete guarded coding tool set", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-full-interactive-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const dataDirectory = join(root, "data");
    await Promise.all([
      mkdir(join(workspace, ".pi", "extensions"), { recursive: true }),
      mkdir(join(workspace, ".pi", "skills", "demo"), { recursive: true }),
      mkdir(join(workspace, ".pi", "prompts"), { recursive: true }),
      mkdir(join(workspace, ".pi", "themes"), { recursive: true }),
      mkdir(join(dataDirectory, "agent"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(
        join(workspace, ".pi", "extensions", "demo.js"),
        "export default function (pi) { pi.registerCommand('project-demo', { description: 'demo', handler: async () => {} }); }\n",
        "utf8"
      ),
      writeFile(
        join(workspace, ".pi", "skills", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: Demo project skill\n---\nUse the demo workflow.\n",
        "utf8"
      ),
      writeFile(
        join(workspace, ".pi", "prompts", "review.md"),
        "---\ndescription: Review changes\n---\nReview the current changes.\n",
        "utf8"
      )
    ]);
    const bundledTheme = join(
      process.cwd(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "modes",
      "interactive",
      "theme",
      "dark.json"
    );
    const theme = JSON.parse(await readFile(bundledTheme, "utf8")) as { name: string };
    theme.name = "project-demo";
    await writeFile(join(workspace, ".pi", "themes", "project-demo.json"), `${JSON.stringify(theme)}\n`, "utf8");

    const runtime = await createPiInteractiveRuntime({
      workspace: {
        sourceRoot: workspace,
        workspace,
        branch: "main",
        managedWorktree: false,
        baselineCommit: "0".repeat(40)
      },
      task: createInteractiveTask({}),
      allowShell: true,
      continueSession: false,
      noSession: true,
      dataDirectory
    });
    try {
      await runtime.session.bindExtensions({ mode: "print" });
      const shell = process.platform === "win32" ? "powershell" : "bash";
      expect(runtime.session.getActiveToolNames()).toEqual([
        "read", shell, "grep", "find", "ls", "edit", "write"
      ]);
      expect(runtime.services.resourceLoader.getExtensions().errors).toEqual([]);
      expect(runtime.services.resourceLoader.getExtensions().extensions.length).toBeGreaterThanOrEqual(3);
      expect(runtime.services.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain("demo");
      expect(runtime.services.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name)).toContain("review");
      expect(runtime.services.resourceLoader.getThemes().themes.map((loadedTheme) => loadedTheme.name)).toContain("project-demo");
      expect(runtime.services.agentDir).toBe(join(dataDirectory, "agent"));
      expect(runtime.session.extensionRunner.getRegisteredCommands().map((command) => command.name)).toEqual(
        expect.arrayContaining(["task", "allow", "verify-add", "run", "verify", "diff", "status", "sessions", "temp"])
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps persistent workspace sessions exclusively locked and releases them on dispose", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-full-session-lock-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const agentDirectory = join(root, "agent");
    const dataDirectory = join(root, "data");
    await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
    const baseOptions = {
      workspace: {
        sourceRoot: workspace,
        workspace,
        branch: "main",
        managedWorktree: false,
        baselineCommit: "0".repeat(40)
      },
      task: createInteractiveTask({}),
      allowShell: false,
      noSession: false,
      dataDirectory,
      agentDirectory
    };
    const first = await createPiInteractiveRuntime({ ...baseOptions, continueSession: false });
    await first.session.bindExtensions({ mode: "print" });
    const firstSessionId = first.session.sessionId;
    await first.session.reload();
    await expect(createPiInteractiveRuntime({ ...baseOptions, continueSession: true }))
      .rejects.toThrow("already active");
    await first.dispose();
    const resumed = await createPiInteractiveRuntime({ ...baseOptions, continueSession: true });
    await resumed.session.bindExtensions({ mode: "print" });
    expect(resumed.session.sessionId).toBe(firstSessionId);
    await resumed.dispose();
  });

  it("persists the session objective while keeping current task safety settings independent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-full-session-objective-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const agentDirectory = join(root, "agent");
    const dataDirectory = join(root, "data");
    await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
    const workspaceInfo = {
      sourceRoot: workspace,
      workspace,
      branch: "main",
      managedWorktree: false,
      baselineCommit: "0".repeat(40)
    };
    const firstTask = createInteractiveTask({ allowedPaths: ["src/**"] });
    const first = await createPiInteractiveRuntime({
      workspace: workspaceInfo,
      task: firstTask,
      allowShell: false,
      continueSession: false,
      noSession: false,
      dataDirectory,
      agentDirectory
    });
    await first.session.bindExtensions({ mode: "print" });
    await first.session.prompt("/task repair the selected parser");
    await first.session.prompt("/allow test/**");
    await first.session.prompt("/verify-add npm test");
    const firstSessionId = first.session.sessionId;
    expect(firstTask).toMatchObject({
      objective: "repair the selected parser",
      allowedPaths: ["src/**", "test/**"],
      verify: [{ command: "npm test", timeoutMs: 120_000 }]
    });
    await first.dispose();

    const resumedTask = createInteractiveTask({
      allowedPaths: ["resumed/**"],
      verifyCommands: ["npm run check"]
    });
    const resumed = await createPiInteractiveRuntime({
      workspace: workspaceInfo,
      task: resumedTask,
      allowShell: false,
      continueSession: true,
      noSession: false,
      dataDirectory,
      agentDirectory
    });
    try {
      await resumed.session.bindExtensions({ mode: "print" });
      expect(resumed.session.sessionId).toBe(firstSessionId);
      expect(resumedTask).toMatchObject({
        objective: "repair the selected parser",
        allowedPaths: ["resumed/**"],
        verify: [{ command: "npm run check", timeoutMs: 120_000 }]
      });
    } finally {
      await resumed.dispose();
    }
  });
});
