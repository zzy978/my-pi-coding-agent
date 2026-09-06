import { describe, expect, it } from "vitest";
import { runProcess, runShellCommand } from "../src/runtime/process.js";

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

describe("runShellCommand", () => {
  it("executes quoted verifier code and preserves its failing exit status", async () => {
    const result = await runShellCommand('node -e "process.stdout.write(\'verifier-ran\'); process.exit(7)"', {
      cwd: process.cwd(), timeoutMs: 5_000
    });
    expect(result.stdout).toBe("verifier-ran");
    expect(result.exitCode).toBe(7);
  });

  it("supports a quoted executable path and an argument containing spaces", async () => {
    const result = await runShellCommand(`"${process.execPath}" -e "process.stdout.write(process.argv[1])" "two words"`, {
      cwd: process.cwd(), timeoutMs: 5_000
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("two words");
    expect(result.exitCode).toBe(0);
  });
});
