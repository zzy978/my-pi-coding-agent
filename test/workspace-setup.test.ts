import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessResult } from "../src/runtime/process.js";
import { runProcess } from "../src/runtime/process.js";
import { discardManagedWorkspace, prepareWorkspace } from "../src/workspace/git.js";
import {
  prepareReadyWorkspace,
  prepareReadyCurrentWorkspace,
  resolveSetupPlan,
  runWorkspaceSetup,
  setupPreferenceFromCli,
  WorkspaceSetupError
} from "../src/workspace/setup.js";
import { initializeGitRepository } from "./helpers/git-repository.js";

const temporaryDirectories: string[] = [];

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: "npm ci --ignore-scripts",
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
    ...overrides
  };
}

async function repositoryWithPackageLock(): Promise<{ parent: string; repository: string }> {
  const parent = await mkdtemp(join(tmpdir(), "pi-agent-setup-"));
  temporaryDirectories.push(parent);
  const repository = join(parent, "source");
  await initializeGitRepository(repository);
  await writeFile(join(repository, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(join(repository, "package.json"), `${JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    scripts: { preinstall: "node -e \"require('fs').writeFileSync('setup-script-ran.txt','ran')\"" }
  })}\n`, "utf8");
  await writeFile(join(repository, "package-lock.json"), `${JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "1.0.0", hasInstallScript: true } }
  })}\n`, "utf8");
  let result = await runProcess("git", ["add", ".gitignore", "package.json", "package-lock.json"], { cwd: repository });
  expect(result.exitCode).toBe(0);
  result = await runProcess("git", ["commit", "-m", "add package files"], { cwd: repository });
  expect(result.exitCode).toBe(0);
  return { parent, repository };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});

describe("workspace setup", () => {
  it("prepares interactive work directly in a dirty current checkout without automatic setup", async () => {
    const { repository } = await repositoryWithPackageLock();
    await writeFile(join(repository, "existing-change.txt"), "preserve\n", "utf8");

    const ready = await prepareReadyCurrentWorkspace(repository, { mode: "auto" });

    expect(ready.workspace).toMatchObject({
      sourceRoot: repository,
      workspace: repository,
      managedWorktree: false
    });
    expect(ready.setup).toEqual({ source: "auto", commands: [] });
    await expect(access(join(repository, "existing-change.txt"))).resolves.toBeUndefined();
  });

  it("auto-detects package-lock.json only for managed worktrees", async () => {
    const { parent, repository } = await repositoryWithPackageLock();
    const managed = await prepareWorkspace(repository, { inPlace: false, dataDirectory: join(parent, "data") });
    await expect(resolveSetupPlan(managed, { mode: "auto" })).resolves.toEqual({
      source: "auto",
      commands: [{ command: "npm ci --ignore-scripts", timeoutMs: 600_000 }]
    });
    await expect(resolveSetupPlan({ ...managed, workspace: repository, managedWorktree: false }, { mode: "auto" }))
      .resolves.toEqual({ source: "auto", commands: [] });
    await discardManagedWorkspace(managed);
  });

  it("runs a real npm ci before returning a ready managed worktree", async () => {
    const { parent, repository } = await repositoryWithPackageLock();
    const ready = await prepareReadyWorkspace(
      repository,
      { inPlace: false, dataDirectory: join(parent, "data") },
      { mode: "auto" }
    );
    expect(ready.setup).toEqual({
      source: "auto",
      commands: [{ command: "npm ci --ignore-scripts", timeoutMs: 600_000 }]
    });
    await expect(access(join(ready.workspace.workspace, "setup-script-ran.txt"))).rejects.toThrow();
    await discardManagedWorkspace(ready.workspace);
  });

  it("runs explicit setup instead of auto setup and supports disabling it", async () => {
    const { parent, repository } = await repositoryWithPackageLock();
    const managed = await prepareWorkspace(repository, { inPlace: false, dataDirectory: join(parent, "data") });
    const runCommand = vi.fn((command: string) => Promise.resolve(processResult({ command })));
    const explicit = setupPreferenceFromCli(["npm run prepare"], false);
    await expect(runWorkspaceSetup(managed, explicit, { runCommand })).resolves.toEqual({
      source: "explicit",
      commands: [{ command: "npm run prepare", timeoutMs: 600_000 }]
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0]?.[0]).toBe("npm run prepare");
    await expect(runWorkspaceSetup(managed, setupPreferenceFromCli([], true), { runCommand }))
      .resolves.toEqual({ source: "disabled", commands: [] });
    expect(runCommand).toHaveBeenCalledOnce();
    await discardManagedWorkspace(managed);
  });

  it("fails on command errors and setup-created Git changes", async () => {
    const { parent, repository } = await repositoryWithPackageLock();
    const managed = await prepareWorkspace(repository, { inPlace: false, dataDirectory: join(parent, "data") });
    await expect(runWorkspaceSetup(managed, { mode: "auto" }, {
      runCommand: () => Promise.resolve(processResult({ exitCode: 2, stderr: "install failed" }))
    })).rejects.toThrowError(WorkspaceSetupError);

    await expect(runWorkspaceSetup(managed, { mode: "auto" }, {
      runCommand: async () => {
        await writeFile(join(managed.workspace, "generated.txt"), "unexpected\n", "utf8");
        return processResult();
      }
    })).rejects.toThrow("generated.txt");
    await discardManagedWorkspace(managed);
  });

  it("redacts host secrets from setup failure output", async () => {
    vi.stubEnv("SETUP_API_KEY", "setup-secret-value-12345");
    const { parent, repository } = await repositoryWithPackageLock();
    const managed = await prepareWorkspace(repository, { inPlace: false, dataDirectory: join(parent, "data") });
    let message = "";
    try {
      await runWorkspaceSetup(managed, { mode: "auto" }, {
        runCommand: () => Promise.resolve(processResult({ exitCode: 1, stderr: "setup-secret-value-12345" }))
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("[REDACTED:SETUP_API_KEY]");
    expect(message).not.toContain("setup-secret-value-12345");
    await discardManagedWorkspace(managed);
  });

  it("removes the managed worktree when setup fails before runtime creation", async () => {
    const { parent, repository } = await repositoryWithPackageLock();
    const dataDirectory = join(parent, "data");
    await expect(prepareReadyWorkspace(
      repository,
      { inPlace: false, dataDirectory },
      { mode: "explicit", commands: [{ command: "npm run missing-setup-script", timeoutMs: 10_000 }] }
    )).rejects.toThrow("exited with code 1");

    const worktreeRoot = join(dataDirectory, "worktrees");
    const entries = await access(worktreeRoot).then(async () => {
      const { readdir } = await import("node:fs/promises");
      return readdir(worktreeRoot);
    }).catch(() => [] as string[]);
    expect(entries).toEqual([]);
    const branches = await runProcess("git", ["branch", "--list", "agent/*"], { cwd: repository });
    expect(branches.stdout.trim()).toBe("");
  });
});
