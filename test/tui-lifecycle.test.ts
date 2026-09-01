import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRuntime } from "../src/runtime/pi-runtime.js";
import { parseTaskSpec } from "../src/task/task-spec.js";

const tuiState = vi.hoisted(() => ({
  inputListeners: [] as Array<(data: string) => { consume: boolean } | undefined>,
  latestEditor: undefined as { disableSubmit: boolean; onSubmit: ((value: string) => void) | undefined } | undefined,
  latestSelectList: undefined as {
    items: Array<{ value: string; label: string }>;
    onSelect: ((item: { value: string; label: string }) => void) | undefined;
    onCancel: (() => void) | undefined;
  } | undefined
}));

const verificationMocks = vi.hoisted(() => ({
  runVerification: vi.fn()
}));

vi.mock("@earendil-works/pi-tui", () => {
  class ComponentContainer {
    children: unknown[] = [];
    addChild(child: unknown): void { this.children.push(child); }
  }
  class TextComponent {
    constructor(public value = "") {}
    setText(value: string): void { this.value = value; }
  }
  class MarkdownComponent extends TextComponent {}
  class EditorComponent {
    disableSubmit = false;
    onSubmit: ((value: string) => void) | undefined;
    constructor() { tuiState.latestEditor = this; }
    setAutocompleteProvider(): void {}
    setText(): void {}
  }
  class MainScreen {
    addChild(): void {}
    setFocus(): void {}
    addInputListener(listener: (data: string) => { consume: boolean } | undefined): void {
      tuiState.inputListeners.push(listener);
    }
    requestRender(): void {}
    showOverlay(): { hide: () => void } { return { hide: () => undefined }; }
    start(): void {}
    stop(): void {}
  }
  return {
    CombinedAutocompleteProvider: class {},
    Container: ComponentContainer,
    Editor: EditorComponent,
    Key: { escape: "escape", ctrl: (key: string) => `ctrl-${key}` },
    Markdown: MarkdownComponent,
    matchesKey: (data: string, key: string) => data === key,
    ProcessTerminal: class {},
    SelectList: class {
      onSelect: ((item: { value: string; label: string }) => void) | undefined;
      onCancel: (() => void) | undefined;
      constructor(public items: Array<{ value: string; label: string }>) { tuiState.latestSelectList = this; }
      handleInput(): void {}
      invalidate(): void {}
      render(): string[] { return []; }
      setSelectedIndex(): void {}
    },
    Spacer: class {},
    Text: TextComponent,
    TuiMainScreen: MainScreen
  };
});

vi.mock("../src/verifier/verifier.js", () => ({
  runVerification: verificationMocks.runVerification,
  formatVerificationSummary: () => "verification"
}));

vi.mock("../src/report/report.js", () => ({
  writeRunReport: vi.fn(() => Promise.resolve({ jsonPath: "report.json", markdownPath: "report.md" }))
}));

describe("TUI turn lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tuiState.inputListeners.length = 0;
    tuiState.latestEditor = undefined;
    tuiState.latestSelectList = undefined;
    verificationMocks.runVerification.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the turn busy and skips verification after abort", async () => {
    let resolvePrompt: (() => void) | undefined;
    const prompt = vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve; }));
    const abort = vi.fn(() => Promise.resolve());
    const runtime = {
      diagnostics: [],
      modelFallbackMessage: undefined,
      session: {
        model: { provider: "test", id: "model" },
        state: { messages: [] },
        sessionId: "session",
        sessionFile: undefined,
        getSessionStats: () => ({ sessionId: "session", tokens: { total: 0 }, cost: 0 })
      },
      subscribe: () => () => undefined,
      prompt,
      abort,
      dispose: vi.fn()
    } as unknown as PiRuntime;
    const { CodingAgentTui } = await import("../src/tui/app.js");
    const task = parseTaskSpec({ id: "abort", objective: "long task", verify: ["npm test"] });
    const app = new CodingAgentTui({
      runtime,
      task,
      workspace: { sourceRoot: process.cwd(), workspace: process.cwd(), branch: "main", managedWorktree: false, baselineCommit: "0".repeat(40) },
      initialPrompt: task.objective
    });

    app.start();
    await vi.runAllTimersAsync();
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("Response-language rule:"));
    expect(tuiState.latestEditor?.disableSubmit).toBe(true);

    tuiState.inputListeners[0]?.("escape");
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(tuiState.latestEditor?.disableSubmit).toBe(true);

    resolvePrompt?.();
    await vi.waitFor(() => expect(tuiState.latestEditor?.disableSubmit).toBe(false));
    expect(verificationMocks.runVerification).not.toHaveBeenCalled();
    await app.shutdown();
  });

  it("passes each interactive user message with the dynamic response-language rule", async () => {
    const prompt = vi.fn(() => Promise.resolve());
    verificationMocks.runVerification.mockResolvedValue({
      configured: true,
      success: true,
      changedFiles: [],
      disallowedChangedFiles: [],
      commands: [{ command: "npm test", status: "passed", exitCode: 0, stdout: "", stderr: "", outputTruncated: false, durationMs: 1 }]
    });
    const runtime = {
      diagnostics: [],
      modelFallbackMessage: undefined,
      session: {
        model: { provider: "test", id: "model" },
        state: { messages: [] },
        sessionId: "session",
        sessionFile: undefined,
        getSessionStats: () => ({ sessionId: "session", tokens: { total: 0 }, cost: 0 })
      },
      subscribe: () => () => undefined,
      prompt,
      abort: vi.fn(() => Promise.resolve()),
      dispose: vi.fn()
    } as unknown as PiRuntime;
    const { CodingAgentTui } = await import("../src/tui/app.js");
    const task = parseTaskSpec({ id: "language", objective: "Interactive coding task", verify: ["npm test"] });
    const app = new CodingAgentTui({
      runtime,
      task,
      workspace: { sourceRoot: process.cwd(), workspace: process.cwd(), branch: "main", managedWorktree: false, baselineCommit: "0".repeat(40) }
    });

    app.start();
    tuiState.latestEditor?.onSubmit?.("请修复 parser.ts 中的错误");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("Current user message:\n请修复 parser.ts 中的错误"));
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("same primary natural language"));
    await vi.waitFor(() => expect(verificationMocks.runVerification).toHaveBeenCalledOnce());
    await app.shutdown();
  });

  it("cancels the scheduled initial prompt during immediate shutdown", async () => {
    const prompt = vi.fn(() => Promise.resolve());
    const runtime = {
      diagnostics: [],
      modelFallbackMessage: undefined,
      session: {
        model: { provider: "test", id: "model" },
        state: { messages: [] },
        sessionId: "session",
        sessionFile: undefined,
        getSessionStats: () => ({ sessionId: "session", tokens: { total: 0 }, cost: 0 })
      },
      subscribe: () => () => undefined,
      prompt,
      abort: vi.fn(() => Promise.resolve()),
      dispose: vi.fn()
    } as unknown as PiRuntime;
    const { CodingAgentTui } = await import("../src/tui/app.js");
    const task = parseTaskSpec({ id: "shutdown", objective: "do not run" });
    const app = new CodingAgentTui({
      runtime,
      task,
      workspace: { sourceRoot: process.cwd(), workspace: process.cwd(), branch: "main", managedWorktree: false, baselineCommit: "0".repeat(40) },
      initialPrompt: task.objective
    });

    app.start();
    await app.shutdown();
    await vi.runAllTimersAsync();
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([
    ["/new", { type: "new" }],
    ["/temp", { type: "temporary" }]
  ] as const)("replaces the active runtime for %s and shuts down only the replacement", async (command, target) => {
    const oldAbort = vi.fn(() => Promise.resolve());
    const oldDispose = vi.fn();
    const oldRuntime = {
      diagnostics: [],
      modelFallbackMessage: undefined,
      session: {
        model: { provider: "test", id: "model" },
        thinkingLevel: "medium",
        state: { messages: [] },
        sessionId: "old-session",
        sessionFile: "old.jsonl",
        getSessionStats: () => ({ sessionId: "old-session", tokens: { total: 0 }, cost: 0 })
      },
      subscribe: () => () => undefined,
      prompt: vi.fn(() => Promise.resolve()),
      abort: oldAbort,
      dispose: oldDispose
    } as unknown as PiRuntime;
    const replacementAbort = vi.fn(() => Promise.resolve());
    const replacementDispose = vi.fn();
    const replacement = {
      diagnostics: [],
      modelFallbackMessage: undefined,
      conversationObjective: "Interactive coding task",
      session: {
        model: { provider: "test", id: "model" },
        thinkingLevel: "medium",
        state: { messages: [] },
        sessionId: "replacement-session",
        sessionFile: target.type === "new" ? "replacement.jsonl" : undefined,
        getSessionStats: () => ({ sessionId: "replacement-session", tokens: { total: 0 }, cost: 0 })
      },
      subscribe: () => () => undefined,
      prompt: vi.fn(() => Promise.resolve()),
      abort: replacementAbort,
      dispose: replacementDispose
    } as unknown as PiRuntime;
    const sessionController = {
      list: vi.fn(() => Promise.resolve([])),
      create: vi.fn(() => Promise.resolve(replacement)),
      continueRecentOrCreate: vi.fn(() => Promise.resolve(replacement)),
      updateObjective: vi.fn(() => Promise.resolve())
    };
    const { CodingAgentTui } = await import("../src/tui/app.js");
    const task = parseTaskSpec({
      id: "switch",
      objective: "previous objective",
      allowedPaths: ["src/**"],
      verify: ["npm test"]
    });
    const app = new CodingAgentTui({
      runtime: oldRuntime,
      sessionController,
      task,
      workspace: { sourceRoot: process.cwd(), workspace: process.cwd(), branch: "main", managedWorktree: false, baselineCommit: "0".repeat(40) }
    });

    app.start();
    tuiState.latestEditor?.onSubmit?.(command);
    await vi.waitFor(() => expect(oldDispose).toHaveBeenCalledOnce());
    expect(sessionController.create).toHaveBeenCalledWith(target, {
      model: { provider: "test", id: "model" },
      thinkingLevel: "medium"
    });
    expect(task.objective).toBe("Interactive coding task");
    expect(task.allowedPaths).toEqual(["src/**"]);
    expect(task.verify).toEqual([{ command: "npm test", timeoutMs: 120_000 }]);

    await app.shutdown();
    expect(oldAbort).not.toHaveBeenCalled();
    expect(oldDispose).toHaveBeenCalledOnce();
    expect(replacementAbort).toHaveBeenCalledOnce();
    expect(replacementDispose).toHaveBeenCalledOnce();
  });

  it("keeps the current runtime usable when replacement creation fails", async () => {
    const abort = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const runtime = {
      diagnostics: [],
      modelFallbackMessage: undefined,
      session: {
        model: { provider: "test", id: "model" },
        thinkingLevel: "medium",
        state: { messages: [] },
        sessionId: "current-session",
        sessionFile: "current.jsonl",
        getSessionStats: () => ({ sessionId: "current-session", tokens: { total: 0 }, cost: 0 })
      },
      subscribe: () => () => undefined,
      prompt: vi.fn(() => Promise.resolve()),
      abort,
      dispose
    } as unknown as PiRuntime;
    const sessionController = {
      list: vi.fn(() => Promise.resolve([])),
      create: vi.fn(() => Promise.reject(new Error("replacement failed"))),
      continueRecentOrCreate: vi.fn(() => Promise.resolve(runtime)),
      updateObjective: vi.fn(() => Promise.resolve())
    };
    const { CodingAgentTui } = await import("../src/tui/app.js");
    const app = new CodingAgentTui({
      runtime,
      sessionController,
      task: parseTaskSpec({ id: "failure", objective: "keep current" }),
      workspace: { sourceRoot: process.cwd(), workspace: process.cwd(), branch: "main", managedWorktree: false, baselineCommit: "0".repeat(40) }
    });

    app.start();
    tuiState.latestEditor?.onSubmit?.("/new");
    await vi.waitFor(() => expect(sessionController.create).toHaveBeenCalledOnce());
    expect(dispose).not.toHaveBeenCalled();
    expect(tuiState.latestEditor?.disableSubmit).toBe(false);

    await app.shutdown();
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("opens /sessions and switches to the selected persistent session", async () => {
    const oldDispose = vi.fn();
    const oldPrompt = vi.fn(() => Promise.resolve());
    const oldRuntime = {
      diagnostics: [],
      modelFallbackMessage: undefined,
      session: {
        model: { provider: "test", id: "model" },
        thinkingLevel: "medium",
        state: { messages: [{ role: "user", content: "为我创建一个散点图" }] },
        sessionId: "old-session",
        sessionFile: "old.jsonl",
        getSessionStats: () => ({ sessionId: "old-session", tokens: { total: 0 }, cost: 0 })
      },
      subscribe: () => () => undefined,
      prompt: oldPrompt,
      abort: vi.fn(() => Promise.resolve()),
      dispose: oldDispose
    } as unknown as PiRuntime;
    const replacementDispose = vi.fn();
    const replacementPrompt = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const replacement = {
      diagnostics: [],
      modelFallbackMessage: undefined,
      conversationObjective: "修复目标 session 的解析器",
      session: {
        model: { provider: "test", id: "model" },
        thinkingLevel: "medium",
        state: { messages: [{ role: "user", content: "请修复 parser.ts" }] },
        sessionId: "selected-session",
        sessionFile: "selected.jsonl",
        getSessionStats: () => ({ sessionId: "selected-session", tokens: { total: 0 }, cost: 0 })
      },
      subscribe: () => () => undefined,
      prompt: replacementPrompt,
      abort: vi.fn(() => Promise.resolve()),
      dispose: replacementDispose
    } as unknown as PiRuntime;
    const selectedSession = {
      id: "selected-session",
      path: "selected.jsonl",
      cwd: process.cwd(),
      created: new Date("2026-08-30T00:00:00.000Z"),
      modified: new Date("2026-08-31T00:00:00.000Z"),
      messageCount: 2,
      firstMessage: "selected task",
      allMessagesText: "selected task",
      materialized: true,
      objective: "修复目标 session 的解析器"
    };
    const sessionController = {
      list: vi.fn(() => Promise.resolve([selectedSession])),
      create: vi.fn(() => Promise.resolve(replacement)),
      continueRecentOrCreate: vi.fn(() => Promise.resolve(replacement)),
      updateObjective: vi.fn(() => Promise.resolve())
    };
    const { CodingAgentTui } = await import("../src/tui/app.js");
    const task = parseTaskSpec({
      id: "picker",
      objective: "为我创建一个散点图",
      allowedPaths: ["src/**"],
      verify: ["npm test"]
    });
    const app = new CodingAgentTui({
      runtime: oldRuntime,
      sessionController,
      task,
      workspace: { sourceRoot: process.cwd(), workspace: process.cwd(), branch: "main", managedWorktree: false, baselineCommit: "0".repeat(40) }
    });

    app.start();
    tuiState.latestEditor?.onSubmit?.("/sessions");
    await vi.waitFor(() => expect(tuiState.latestSelectList).toBeDefined());
    const selectedItem = tuiState.latestSelectList?.items[0];
    if (!selectedItem) throw new Error("Session picker did not expose an item");
    tuiState.latestSelectList?.onSelect?.(selectedItem);

    await vi.waitFor(() => expect(oldDispose).toHaveBeenCalledOnce());
    expect(sessionController.create).toHaveBeenCalledWith({ type: "open", session: selectedSession }, undefined);
    verificationMocks.runVerification.mockResolvedValue({
      configured: true,
      success: true,
      changedFiles: [],
      disallowedChangedFiles: [],
      commands: []
    });
    tuiState.latestEditor?.onSubmit?.("我上一个问题是什么");
    await vi.waitFor(() => expect(replacementPrompt).toHaveBeenCalledOnce());
    const switchedPrompt = replacementPrompt.mock.calls[0]?.[0] ?? "";
    expect(switchedPrompt).toContain("Objective: 修复目标 session 的解析器");
    expect(switchedPrompt).toContain("Current user message:\n我上一个问题是什么");
    expect(switchedPrompt).toContain("Allowed changed paths: src/**");
    expect(switchedPrompt).toContain("Verification commands: npm test");
    expect(switchedPrompt).not.toContain("为我创建一个散点图");
    expect(oldPrompt).not.toHaveBeenCalled();
    expect(task.allowedPaths).toEqual(["src/**"]);
    expect(task.verify).toEqual([{ command: "npm test", timeoutMs: 120_000 }]);
    await app.shutdown();
    expect(replacementDispose).toHaveBeenCalledOnce();
  });
});
