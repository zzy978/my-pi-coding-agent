import { spawn } from "node:child_process";

export interface CommandResult { code: number | null; stdout: string; stderr: string }
export async function command(file: string, args: string[], options: {
  input?: string; timeoutMs?: number; signal?: AbortSignal; onData?: (data: Buffer) => void; acceptFailure?: boolean;
} = {}): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: "pipe" });
    let stdout = "", stderr = "", cancelled = false;
    const cancel = () => { cancelled = true; child.kill(); };
    const timer = setTimeout(cancel, options.timeoutMs ?? 600_000);
    options.signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString()).slice(-8 * 1024 * 1024); options.onData?.(data); });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-128 * 1024); options.onData?.(data); });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
      if (cancelled) reject(new Error("Command cancelled or timed out"));
      else if (code !== 0 && !options.acceptFailure) reject(new Error(`${file} ${args[0]} failed (${code}): ${stderr.slice(-2000)} ${stdout.slice(-1000)}`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

export function docker(args: string[], options: Parameters<typeof command>[2] = {}) { return command("docker", args, options); }
