import { describe, expect, it, vi } from "vitest";
import { ShellApprovalGate } from "../src/policy/shell-approval.js";

describe("shell approval gate", () => {
  it("denies safely when no interactive handler is attached", async () => {
    const gate = new ShellApprovalGate();
    await expect(gate.request({ command: "rm file", reason: "deletion" })).resolves.toBe(false);
  });

  it("serializes concurrent approval requests", async () => {
    const gate = new ShellApprovalGate();
    const resolvers: Array<(approved: boolean) => void> = [];
    const handler = vi.fn(() => new Promise<boolean>((resolve) => resolvers.push(resolve)));
    gate.setHandler(handler);

    const first = gate.request({ command: "rm one", reason: "deletion" });
    const second = gate.request({ command: "rm two", reason: "deletion" });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    resolvers[0]?.(true);
    await expect(first).resolves.toBe(true);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    resolvers[1]?.(false);
    await expect(second).resolves.toBe(false);
  });
});
