import { basename, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getDataDirectories, getDataDirectory } from "../runtime/data-dir.js";
import { runProcess } from "../runtime/process.js";

export interface WorkspaceInfo {
  sourceRoot: string;
  workspace: string;
  branch: string;
  managedWorktree: boolean;
  baselineCommit: string;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

async function git(cwd: string, args: string[], timeoutMs = 30_000) {
  return runProcess("git", args, { cwd, timeoutMs, maxOutputBytes: 256 * 1024 });
}

export async function resolveGitRoot(inputPath: string): Promise<string> {
  let result;
  try {
    result = await git(inputPath, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    throw new WorkspaceError(`Git could not inspect ${inputPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.exitCode !== 0) throw new WorkspaceError(`${inputPath} is not inside a Git repository`);
  return resolve(result.stdout.trim());
}

export async function currentBranch(cwd: string): Promise<string> {
  const result = await git(cwd, ["branch", "--show-current"]);
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : "(detached)";
}

export async function resolveCommit(cwd: string, revision = "HEAD"): Promise<string> {
  const result = await git(cwd, ["rev-parse", "--verify", `${revision}^{commit}`]);
  const commit = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new WorkspaceError(`Git commit does not exist: ${revision}`);
  }
  return commit.toLowerCase();
}

export async function listChangedFiles(cwd: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-status", "-z", "--find-renames", "HEAD"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  ]);
  if (tracked.exitCode !== 0 || untracked.exitCode !== 0 || tracked.stdoutTruncated || untracked.stdoutTruncated) {
    throw new WorkspaceError("Unable to inspect changed files");
  }
  const trackedTokens = tracked.stdout.split("\0").filter((item) => item.length > 0);
  const trackedPaths: string[] = [];
  for (let index = 0; index < trackedTokens.length;) {
    const status = trackedTokens[index++] ?? "";
    const firstPath = trackedTokens[index++];
    if (firstPath) trackedPaths.push(firstPath);
    if (status.startsWith("R") || status.startsWith("C")) {
      const secondPath = trackedTokens[index++];
      if (secondPath) trackedPaths.push(secondPath);
    }
  }
  const untrackedPaths = untracked.stdout.split("\0").filter((item) => item.length > 0);
  return [...new Set([...trackedPaths, ...untrackedPaths])].sort();
}

export async function prepareWorkspace(sourcePath: string, options: {
  inPlace: boolean;
  dataDirectory?: string;
  baselineCommit?: string;
  branchPrefix?: "agent" | "replay";
}): Promise<WorkspaceInfo> {
  const sourceRoot = await resolveGitRoot(sourcePath);
  const sourceBranch = await currentBranch(sourceRoot);
  const baselineCommit = await resolveCommit(sourceRoot, options.baselineCommit ?? "HEAD");
  if (options.inPlace) {
    if (options.baselineCommit && baselineCommit !== await resolveCommit(sourceRoot)) {
      throw new WorkspaceError("An in-place workspace cannot be prepared from a historical baseline commit");
    }
    return { sourceRoot, workspace: sourceRoot, branch: sourceBranch, managedWorktree: false, baselineCommit };
  }

  const changed = await listChangedFiles(sourceRoot);
  if (changed.length > 0) {
    throw new WorkspaceError(
      `The source repository has ${changed.length} changed file(s). Commit/stash them or pass --in-place explicitly.`
    );
  }

  const slug = basename(sourceRoot).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = randomUUID().slice(0, 8);
  const branch = `${options.branchPrefix ?? "agent"}/${stamp}-${suffix}`;
  const worktreeRoot = getDataDirectories(options.dataDirectory ?? getDataDirectory()).worktree;
  const workspace = join(worktreeRoot, `${slug}-${stamp}-${suffix}`);
  await mkdir(worktreeRoot, { recursive: true });

  const result = await git(sourceRoot, ["worktree", "add", "-b", branch, workspace, baselineCommit], 120_000);
  if (result.exitCode !== 0) {
    throw new WorkspaceError(`Could not create worktree: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { sourceRoot, workspace, branch, managedWorktree: true, baselineCommit };
}

export async function getDiff(cwd: string): Promise<string> {
  const result = await git(cwd, ["diff", "--no-ext-diff", "--stat", "--", "."]);
  if (result.exitCode !== 0) throw new WorkspaceError(result.stderr.trim() || "Unable to read Git diff");
  const changed = await listChangedFiles(cwd);
  return `${result.stdout.trim()}${changed.length ? `\n\nChanged files:\n${changed.map((file) => `- ${file}`).join("\n")}` : "\n\nNo changed files."}`.trim();
}

export async function discardManagedWorkspace(workspace: WorkspaceInfo): Promise<void> {
  if (!workspace.managedWorktree) return;
  const removeWorktree = await git(workspace.sourceRoot, ["worktree", "remove", "--force", workspace.workspace], 120_000);
  if (removeWorktree.exitCode !== 0) {
    throw new WorkspaceError(`Could not remove unused worktree: ${removeWorktree.stderr.trim() || removeWorktree.stdout.trim()}`);
  }
  const removeBranch = await git(workspace.sourceRoot, ["branch", "-D", workspace.branch]);
  if (removeBranch.exitCode !== 0) {
    throw new WorkspaceError(`Could not remove unused branch ${workspace.branch}: ${removeBranch.stderr.trim() || removeBranch.stdout.trim()}`);
  }
}
