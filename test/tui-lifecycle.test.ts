import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiRuntime } from "../src/runtime/pi-runtime.js";
import { parseTaskSpec } from "../src/task/task-spec.js";

const tuiState = vi.hoisted(() => ({
  inputListeners: [] as Array<(data: string) => { consume: boolean } | undefined>,
  latestEditor: undefined as { disableSubmit: boolean } | undefined
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
      workspace: { sourceRoot: process.cwd(), workspace: process.cwd(), branch: "main", managedWorktree: false },
      initialPrompt: task.objective
    });

    app.start();
    await vi.runAllTimersAsync();
    expect(prompt).toHaveBeenCalledOnce();
    expect(tuiState.latestEditor?.disableSubmit).toBe(true);

    tuiState.inputListeners[0]?.("escape");
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(tuiState.latestEditor?.disableSubmit).toBe(true);

    resolvePrompt?.();
    await vi.waitFor(() => expect(tuiState.latestEditor?.disableSubmit).toBe(false));
    expect(verificationMocks.runVerification).not.toHaveBeenCalled();
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
      workspace: { sourceRoot: process.cwd(), workspace: process.cwd(), branch: "main", managedWorktree: false },
      initialPrompt: task.objective
    });

    app.start();
    await app.shutdown();
    await vi.runAllTimersAsync();
    expect(prompt).not.toHaveBeenCalled();
  });
});
