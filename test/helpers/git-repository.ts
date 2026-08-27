import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../../src/runtime/process.js";

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

export async function initializeGitRepository(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await git(directory, "init");
  await git(directory, "config", "user.name", "Pi Agent Test");
  await git(directory, "config", "user.email", "pi-agent-test@example.invalid");
  await writeFile(join(directory, "README.md"), "# Fixture\n", "utf8");
  await git(directory, "add", "README.md");
  await git(directory, "commit", "-m", "initial fixture");
}

