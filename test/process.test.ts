import { describe, expect, it } from "vitest";
import { runProcess } from "../src/runtime/process.js";

describe("runProcess", () => {
  it("captures exit status and bounded output", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('abcdefghij')"], {
      cwd: process.cwd(),
      maxOutputBytes: 5,
      timeoutMs: 5_000
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("abcde");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("terminates a process after its deadline", async () => {
    const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: process.cwd(),
      timeoutMs: 100
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
  });
});
