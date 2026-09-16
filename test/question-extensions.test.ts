import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import question from "../src/runtime/extensions/question.js";
import questionnaire from "../src/runtime/extensions/questionnaire.js";

function registered(factory: (pi: ExtensionAPI) => void): ToolDefinition {
  let tool: ToolDefinition | undefined;
  factory({ registerTool: (definition: ToolDefinition) => { tool = definition; } } as ExtensionAPI);
  if (!tool) throw new Error("Tool not registered");
  return tool;
}

interface Widget { handleInput(data: string): void; render(width: number): string[]; dispose?(): void }
function uiContext(onWidget: (widget: Widget) => void, mode = "tui"): ExtensionContext {
  const identity = (text: string) => text;
  return {
    mode,
    hasUI: mode === "tui",
    ui: {
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => Widget) => new Promise((resolve) => {
        const widget = factory({ requestRender: vi.fn() }, {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: identity, italic: identity, strikethrough: identity
        }, {}, resolve);
        onWidget(widget);
      })
    }
  } as unknown as ExtensionContext;
}

const one = { question: "选择范围", options: [{ label: "当前文件" }, { label: "整个项目" }] };
const multiple = { questions: [
  { id: "scope", prompt: "选择范围", options: [{ value: "file", label: "当前文件" }] },
  { id: "tests", prompt: "选择验证", options: [{ value: "unit", label: "单元测试" }] }
] };

describe("interactive question tools", () => {
  it("selects a single answer, supports custom text, and cancels without inventing an answer", async () => {
    const tool = registered(question);
    const selected = await tool.execute("q", one, undefined, undefined, uiContext((widget) => { widget.handleInput("\u001b[B"); widget.handleInput("\r"); }));
    expect(selected.details).toMatchObject({ answer: "整个项目", wasCustom: false });
    const custom = await tool.execute("q", one, undefined, undefined, uiContext((widget) => {
      widget.handleInput("\u001b[B"); widget.handleInput("\u001b[B"); widget.handleInput("\r");
      widget.handleInput("只检查解析器"); widget.handleInput("\r");
    }));
    expect(custom.details).toMatchObject({ answer: "只检查解析器", wasCustom: true });
    const cancelled = await tool.execute("q", one, undefined, undefined, uiContext((widget) => widget.handleInput("\u001b")));
    expect(cancelled.details).toMatchObject({ answer: null });
  });

  it("requires all multi-question answers before submission and returns stable IDs", async () => {
    const tool = registered(questionnaire);
    const result = await tool.execute("qs", multiple, undefined, undefined, uiContext((widget) => {
      widget.handleInput("\r"); widget.handleInput("\r"); widget.handleInput("\r");
    }));
    expect(result.details).toMatchObject({ cancelled: false, answers: [{ id: "scope", value: "file" }, { id: "tests", value: "unit" }] });
    expect(tool.executionMode).toBe("sequential");
  });

  it.each([question, questionnaire])("handles non-TUI and aborted calls without opening a dialog", async (factory) => {
    const tool = registered(factory);
    const params = factory === question ? one : multiple;
    const opened = vi.fn();
    await tool.execute("q", params, undefined, undefined, uiContext(opened, "print"));
    expect(opened).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await tool.execute("q", params, controller.signal, undefined, uiContext(opened));
    expect(opened).not.toHaveBeenCalled();
  });

  it.each([question, questionnaire])("closes a pending dialog when the agent is aborted", async (factory) => {
    const tool = registered(factory);
    const controller = new AbortController();
    const result = await tool.execute("q", factory === question ? one : multiple, controller.signal, undefined,
      uiContext(() => controller.abort()));
    expect(result.details).toMatchObject(factory === question ? { answer: null } : { cancelled: true });
  });

  it("rejects duplicate IDs and unanswerable questions before opening UI", async () => {
    const tool = registered(questionnaire);
    const opened = vi.fn();
    for (const questions of [
      [multiple.questions[0], multiple.questions[0]],
      [{ id: "empty", prompt: "无法选择", options: [], allowOther: false }]
    ]) {
      const result = await tool.execute("q", { questions }, undefined, undefined, uiContext(opened));
      expect(result.details).toMatchObject({ cancelled: true });
    }
    expect(opened).not.toHaveBeenCalled();
  });

  it.each([question, questionnaire])("wraps Chinese text after a terminal resize", async (factory) => {
    const tool = registered(factory);
    await tool.execute("q", factory === question ? one : multiple, undefined, undefined, uiContext((widget) => {
      widget.render(90);
      const lines = widget.render(18);
      expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
      expect(stripTerminalSequences(lines.join("\n"))).toContain("选择范围");
      widget.handleInput("\u001b");
    }));
  });
});
