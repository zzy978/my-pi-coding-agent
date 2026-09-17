import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { limitSessionDuration } from "../src/runtime/session-duration.js";

afterEach(() => vi.useRealTimers());

function sessionFixture() {
  let listener: Parameters<AgentSession["subscribe"]>[0] | undefined;
  const calls: string[] = [];
  const session = {
    isStreaming: false,
    subscribe: (callback: Parameters<AgentSession["subscribe"]>[0]) => { listener = callback; return () => { listener = undefined; }; },
    abortRetry: () => { calls.push("retry"); },
    abortCompaction: () => { calls.push("compaction"); },
    abort: () => { calls.push("abort"); return Promise.resolve(); },
    dispose: () => { calls.push("dispose"); }
  };
  return { session, calls, emit: (type: "agent_start" | "agent_settled") => listener?.({ type }) };
}

describe("interactive task deadline", () => {
  it("ends the model deadline before host verification and preserves a newer turn timer", async () => {
    vi.useFakeTimers();
    const f = sessionFixture();
    const settled = limitSessionDuration(f.session, 100);
    f.emit("agent_start");
    await vi.advanceTimersByTimeAsync(50);
    settled();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls).toEqual([]);
    f.session.isStreaming = true;
    f.emit("agent_start");
    f.emit("agent_settled"); // Late subscriber notification from the previous turn.
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls).toEqual(["retry", "compaction", "abort"]);
    f.session.dispose();
  });
  it("keeps the original deadline across requests and retries", async () => {
    vi.useFakeTimers();
    const f = sessionFixture();
    limitSessionDuration(f.session, 100);
    f.emit("agent_start");
    await vi.advanceTimersByTimeAsync(60);
    f.emit("agent_start");
    await vi.advanceTimersByTimeAsync(40);
    expect(f.calls).toEqual(["retry", "compaction", "abort"]);
    f.session.dispose();
  });

  it("clears deadlines after completion and disposal, while zero leaves a task unlimited", async () => {
    vi.useFakeTimers();
    const f = sessionFixture();
    limitSessionDuration(f.session, 100);
    f.emit("agent_start");
    await vi.advanceTimersByTimeAsync(50);
    f.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls).toEqual([]);
    f.emit("agent_start");
    f.session.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls).toEqual(["dispose"]);
    const unlimited = sessionFixture();
    limitSessionDuration(unlimited.session, 0);
    unlimited.emit("agent_start");
    await vi.advanceTimersByTimeAsync(10000);
    expect(unlimited.calls).toEqual([]);
  });
});
