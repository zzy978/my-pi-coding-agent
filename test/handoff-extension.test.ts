import { initTheme, SessionManager, type AgentSessionRuntime, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import handoff, { getHandoffMessages } from "../src/runtime/extensions/handoff.js";

async function runHandoff(options: { edited?: string | null; stopReason?: string; abort?: boolean; fail?: boolean } = {}) {
  initTheme("dark", false);
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const parent = SessionManager.inMemory("D:/example");
  parent.appendMessage({ role: "user", content: "已确定先修复解析器。", timestamp: Date.now() });
  const child = SessionManager.inMemory("D:/example");
  const model = { provider: "fake", id: "test" };
  const completeSimple = vi.fn(() => options.fail ? Promise.reject(new Error("fake secret must not be printed")) : Promise.resolve({
    stopReason: options.stopReason ?? "stop", content: [{ type: "text", text: "已定位解析器，下一步补充测试。" }]
  }));
  const setEditorText = vi.fn();
  const notify = vi.fn();
  const newSession = vi.fn(async (config: Parameters<AgentSessionRuntime["newSession"]>[0]) => {
    await config?.setup?.(child);
    await config?.withSession?.({ ui: { setEditorText, notify } } as unknown as Parameters<NonNullable<NonNullable<Parameters<AgentSessionRuntime["newSession"]>[0]>["withSession"]>>[0]);
    return { cancelled: false };
  });
  const runtime = { services: { modelRuntime: { completeSimple, getModel: () => model } }, newSession } as unknown as AgentSessionRuntime;
  handoff({ registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; } } as unknown as ExtensionAPI, () => runtime);
  const context = {
    mode: "tui", hasUI: true, model, sessionManager: parent,
    ui: {
      notify,
      editor: () => Promise.resolve(options.edited === null ? undefined : options.edited ?? "交接草稿"),
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => { dispose(): void; handleInput(data: string): void }) => new Promise((resolve) => {
        const widget = factory({ requestRender: vi.fn() }, { fg: (_color: string, text: string) => text }, {}, (value) => {
          queueMicrotask(() => widget.dispose());
          resolve(value);
        });
        if (options.abort) widget.handleInput("\u001b");
      })
    }
  } as unknown as ExtensionCommandContext;
  if (!handler) throw new Error("Missing handoff command");
  await handler("为解析器补充测试", context);
  return { completeSimple, newSession, child, setEditorText, notify };
}

describe("handoff extension", () => {
  it("uses host model runtime and creates a draft with the new task objective", async () => {
    const result = await runHandoff();
    expect(result.completeSimple).toHaveBeenCalledOnce();
    expect(result.newSession).toHaveBeenCalledOnce();
    expect(result.setEditorText).toHaveBeenCalledWith("交接草稿");
    expect(result.child.getEntries()).toEqual(expect.arrayContaining([expect.objectContaining({ customType: "pi-tui-session", data: { objective: "为解析器补充测试" } })]));
  });
  it.each([{ edited: null }, { edited: "   " }, { stopReason: "error" }, { stopReason: "length" }, { fail: true }, { abort: true }])("keeps the original session when cancelled or generation fails: %j", async (options) => {
    const result = await runHandoff(options);
    expect(result.newSession).not.toHaveBeenCalled();
    expect(result.setEditorText).not.toHaveBeenCalled();
    expect(JSON.stringify(result.notify.mock.calls)).not.toContain("fake secret");
  });
  it("uses the latest compaction summary and kept messages instead of resurrecting removed context", () => {
    const session = SessionManager.inMemory("D:/example");
    session.appendMessage({ role: "user", content: "旧内容", timestamp: 1 });
    const kept = session.appendMessage({ role: "user", content: "保留内容", timestamp: 2 });
    session.appendCompaction("压缩摘要", kept, 100);
    session.appendMessage({ role: "user", content: "新内容", timestamp: 3 });
    const text = JSON.stringify(getHandoffMessages(session.getBranch()));
    expect(text).toContain("压缩摘要");
    expect(text).toContain("保留内容");
    expect(text).toContain("新内容");
    expect(text).not.toContain("旧内容");
  });
});
