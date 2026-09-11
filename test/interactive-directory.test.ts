import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareReadyCurrentWorkspace } from "../src/workspace/setup.js";
import { getDiff, listChangedFiles, prepareWorkspace } from "../src/workspace/git.js";
import { runProcess } from "../src/runtime/process.js";
import { createInteractiveTask } from "../src/task/task-spec.js";
import { formatVerificationSummary, runVerification } from "../src/verifier/verifier.js";
import { writeRunReport } from "../src/report/report.js";
import { initializeGitRepository } from "./helpers/git-repository.js";
import { runDoctor } from "../src/doctor.js";
import * as processTools from "../src/runtime/process.js";

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "picode-directory-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});

describe("interactive directory workspaces", () => {
  it("treats missing Git as optional for interactive startup and doctor", async () => {
    const directory = await temporaryDirectory();
    const original = processTools.runProcess;
    vi.spyOn(processTools, "runProcess").mockImplementation((command, args, options) => {
      if (command === "git") return Promise.reject(new Error("spawn git ENOENT"));
      return original(command, args, options);
    });
    expect((await prepareReadyCurrentWorkspace(directory, { mode: "auto" })).workspace.gitUnavailable).toBe(true);
    const checks = await runDoctor(directory, join(directory, "agent"));
    expect(checks.find((check) => check.name === "git")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "repository")?.ok).toBe(true);
  });

  it("runs explicit setup in an ordinary directory and propagates failures", async () => {
    const directory = await temporaryDirectory();
    const ready = await prepareReadyCurrentWorkspace(directory, { mode: "explicit", commands: [{ command: 'node -e "require(\'fs\').writeFileSync(\'setup.txt\', process.cwd())"', timeoutMs: 5000 }] });
    expect(await readFile(join(directory, "setup.txt"), "utf8")).toBe(directory);
    expect(ready.setup.source).toBe("explicit");
    await expect(prepareReadyCurrentWorkspace(directory, { mode: "explicit", commands: [{ command: 'node -e "process.exit(1)"', timeoutMs: 5000 }] })).rejects.toThrow(/failed/);
    expect(await readFile(join(directory, "setup.txt"), "utf8")).toBe(directory);
  });
  it("opens an ordinary directory without creating a repository or automatically running setup", async () => {
    const directory = await temporaryDirectory();
    const ready = await prepareReadyCurrentWorkspace(directory, { mode: "auto" });
    expect(ready.workspace).toMatchObject({ workspace: directory, sourceRoot: directory, managedWorktree: false, baselineCommit: "" });
    expect(ready.setup.commands).toEqual([]);
    await expect(access(join(directory, ".git"))).rejects.toThrow();
    await expect(prepareWorkspace(directory, { inPlace: false })).rejects.toThrow(/Git/);
  });

  it("keeps a repository subdirectory as cwd while auditing protected changes across the repository", async () => {
    const directory = await temporaryDirectory();
    await initializeGitRepository(directory);
    const subdirectory = join(directory, "子目录 with spaces");
    await mkdir(subdirectory);
    const ready = await prepareReadyCurrentWorkspace(subdirectory, { mode: "auto" });
    expect(ready.workspace.workspace).toBe(subdirectory);
    expect(ready.workspace.sourceRoot).toBe(directory);
    const task = createInteractiveTask({ verifyCommands: ['node -e "console.log(process.cwd())"'] });
    await writeFile(join(directory, ".env.test"), "fixture");
    const report = await runVerification(subdirectory, task);
    expect(report.commands[0]?.stdout.trim()).toBe(subdirectory);
    expect(report.disallowedChangedFiles).toContain(".env.test");
    expect(report.success).toBe(false);
  });

  it("supports unborn repositories and audits both staged and untracked files", async () => {
    const directory = await temporaryDirectory();
    expect((await runProcess("git", ["init"], { cwd: directory })).exitCode).toBe(0);
    await writeFile(join(directory, "staged.txt"), "fixture");
    expect((await runProcess("git", ["add", "staged.txt"], { cwd: directory })).exitCode).toBe(0);
    await writeFile(join(directory, "untracked.txt"), "fixture");
    const ready = await prepareReadyCurrentWorkspace(directory, { mode: "auto" });
    expect(ready.workspace.baselineCommit).toBe("");
    expect(await listChangedFiles(directory)).toEqual(["staged.txt", "untracked.txt"]);
    await expect(prepareWorkspace(directory, { inPlace: false })).rejects.toThrow(/commit/);
  });

  it("rejects a file or missing path instead of treating it as a workspace", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "file.txt");
    await writeFile(file, "fixture");
    await expect(prepareReadyCurrentWorkspace(file, { mode: "auto" })).rejects.toThrow();
    await expect(prepareReadyCurrentWorkspace(join(directory, "missing"), { mode: "auto" })).rejects.toThrow();
  });

  it("does not turn a damaged Git index into a clean audit", async () => {
    const directory = await temporaryDirectory();
    await initializeGitRepository(directory);
    await writeFile(join(directory, ".git", "index"), "broken fixture index");
    const task = createInteractiveTask({ verifyCommands: ['node -e "process.exit(0)"'] });
    await expect(runVerification(directory, task)).rejects.toThrow();
    const report = await runVerification(directory, task, undefined, { allowUnavailableGit: true });
    expect(report.changeAuditUnavailable).toBe(true);
    expect(report.success).toBe(false);
  });

  it("runs verifiers and writes honest reports without Git, while strict evaluation still rejects missing audit evidence", async () => {
    const directory = await temporaryDirectory();
    const task = createInteractiveTask({ verifyCommands: ['node -e "console.log(process.cwd())"'] });
    const report = await runVerification(directory, task, undefined, { allowUnavailableGit: true });
    expect(report.commands[0]?.status).toBe("passed");
    expect(report.commands[0]?.stdout.trim()).toBe(directory);
    expect(report.changeAuditUnavailable).toBe(true);
    expect(report.success).toBe(false);
    expect(formatVerificationSummary(report)).toContain("变更审计不可用");
    const ready = await prepareReadyCurrentWorkspace(directory, { mode: "auto" });
    const paths = await writeRunReport({ version: 1, createdAt: new Date().toISOString(), task, workspace: ready.workspace, sessionId: "fixture", verification: report }, join(directory, "data"));
    const markdown = await readFile(paths.markdownPath, "utf8");
    expect(markdown).toContain("变更审计不可用");
    expect(markdown).not.toContain("No changed files.");
    expect(markdown).not.toContain("\nNone.");
    expect(await getDiff(directory, { allowUnavailableGit: true })).toContain("Git");
    await expect(runVerification(directory, task)).rejects.toThrow();
    const failing = await runVerification(directory, createInteractiveTask({ verifyCommands: ['node -e "process.exit(1)"'] }), undefined, { allowUnavailableGit: true });
    expect(failing.commands[0]?.status).toBe("failed");
    expect(failing.success).toBe(false);
  });
});
