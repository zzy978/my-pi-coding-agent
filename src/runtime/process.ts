import { spawn } from "node:child_process";

export interface ProcessResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface RunProcessOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;

function appendBounded(current: string, chunk: Buffer, limit: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(current) >= limit) return { value: current, truncated: chunk.length > 0 };
  const remaining = limit - Buffer.byteLength(current);
  return {
    value: current + chunk.subarray(0, remaining).toString("utf8"),
    truncated: chunk.length > remaining
  };
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The process has already exited.
      }
    }
    return;
  }

  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
}

export async function runProcess(
  executable: string,
  args: string[],
  options: RunProcessOptions
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const displayCommand = [executable, ...args].join(" ");

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void terminateProcessTree(child.pid);
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk, maxOutputBytes);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk, maxOutputBytes);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: displayCommand,
        exitCode,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

export function shellCommand(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command]
    };
  }
  return {
    executable: process.env.SHELL || "/bin/sh",
    args: ["-lc", command]
  };
}

export async function runShellCommand(command: string, options: RunProcessOptions): Promise<ProcessResult> {
  const shell = shellCommand(command);
  const result = await runProcess(shell.executable, shell.args, options);
  return { ...result, command };
}
