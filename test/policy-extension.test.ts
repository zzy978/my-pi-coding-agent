import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPolicyExtension } from "../src/policy/policy-extension.js";
import { parseTaskSpec } from "../src/task/task-spec.js";

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown>;
type SelectHandler = (title: string, options: string[]) => Promise<string | undefined>;

async function policyHandlers(): Promise<Map<string, EventHandler>> {
  const handlers = new Map<string, EventHandler>();
  const api = {
    on: (event: string, handler: unknown) => {
      const registered = handler as (event: unknown, context: ExtensionContext) => unknown;
      handlers.set(event, (payload, context) => Promise.resolve(registered(payload, context)));
    }
  } as unknown as ExtensionAPI;
  const extension = createPolicyExtension(
    process.cwd(),
    () => parseTaskSpec({ id: "policy", objective: "test policy" }),
    { allowShell: true, interactiveShellApproval: true }
  );
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory(api);
  return handlers;
}

function eventHandler(handlers: Map<string, EventHandler>, name: string): EventHandler {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Missing ${name} handler`);
  return handler;
}

function extensionContext(select: SelectHandler, hasUI = true): ExtensionContext {
  return {
    hasUI,
    signal: undefined,
    ui: { select }
  } as unknown as ExtensionContext;
}

describe("interactive policy extension", () => {
  it("puts denial first and renders destructive commands without terminal control characters", async () => {
    const handlers = await policyHandlers();
    const select = vi.fn<SelectHandler>(() => Promise.resolve("Approve once"));
    const command = "Remove-Item build -Recurse\u001b[31m\u202etest";

    await expect(eventHandler(handlers, "tool_call")({
      type: "tool_call",
      toolName: "powershell",
      input: { command }
    }, extensionContext(select))).resolves.toBeUndefined();

    expect(select).toHaveBeenCalledOnce();
    expect(select.mock.calls[0]?.[1]).toEqual(["Deny", "Approve once"]);
    const title = select.mock.calls[0]?.[0] ?? "";
    expect(title).toContain("\\u001b");
    expect(title).toContain("\\u202e");
    expect(title).not.toContain("\u001b");
  });

  it("denies destructive tool and user Shell commands when no interactive UI exists", async () => {
    const handlers = await policyHandlers();
    const select = vi.fn<SelectHandler>(() => Promise.resolve("Approve once"));
    const context = extensionContext(select, false);

    await expect(eventHandler(handlers, "tool_call")({
      type: "tool_call",
      toolName: "powershell",
      input: { command: "Remove-Item build -Recurse" }
    }, context)).resolves.toEqual(expect.objectContaining({ block: true }));
    const userBashResult = await eventHandler(handlers, "user_bash")({
      type: "user_bash",
      command: "rm -rf build"
    }, context) as { result?: { exitCode?: unknown } };
    expect(userBashResult.result?.exitCode).toBe(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("serializes concurrent approval prompts and treats every non-approval choice as denial", async () => {
    const handlers = await policyHandlers();
    const resolvers: Array<(choice: string | undefined) => void> = [];
    const select = vi.fn<SelectHandler>(() => new Promise((resolve) => resolvers.push(resolve)));
    const handler = eventHandler(handlers, "tool_call");
    const context = extensionContext(select);
    const first = handler({
      type: "tool_call",
      toolName: "powershell",
      input: { command: "Remove-Item one -Recurse" }
    }, context);
    const second = handler({
      type: "tool_call",
      toolName: "powershell",
      input: { command: "Remove-Item two -Recurse" }
    }, context);

    await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
    resolvers[0]?.("Approve once");
    await expect(first).resolves.toBeUndefined();
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));
    resolvers[1]?.(undefined);
    await expect(second).resolves.toEqual(expect.objectContaining({ block: true }));
  });
});
