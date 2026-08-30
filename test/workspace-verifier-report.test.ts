import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunReport } from "../src/report/report.js";
import { parseTaskSpec } from "../src/task/task-spec.js";
import { runVerification } from "../src/verifier/verifier.js";
import { discardManagedWorkspace, listChangedFiles, prepareWorkspace, resolveCommit, resolveGitRoot, WorkspaceError } from "../src/workspace/git.js";
import { initializeGitRepository } from "./helpers/git-repository.js";
import { runProcess } from "../src/runtime/process.js";

const temporaryDirectories: string[] = [];

async function temporaryRepository(): Promise<{ parent: string; repository: string }> {
  const parent = await mkdtemp(join(tmpdir(), "pi-agent-repo-"));
  temporaryDirectories.push(parent);
  const repository = join(parent, "source");
  await initializeGitRepository(repository);
  return { parent, repository };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })));
});

describe("Git workspace", () => {
  it("rejects a path that is not inside a Git repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-agent-non-git-"));
    temporaryDirectories.push(directory);
    await expect(prepareWorkspace(directory, { inPlace: false, dataDirectory: join(directory, "data") }))
      .rejects.toThrow("is not inside a Git repository");
  });

  it("resolves a repository and lists tracked plus untracked changes", async () => {
    const { repository } = await temporaryRepository();
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "README.md"), "changed\n", "utf8");
    await writeFile(join(repository, "src", "new.ts"), "export {};\n", "utf8");
    await expect(resolveGitRoot(join(repository, "src"))).resolves.toBe(repository);
    await expect(listChangedFiles(repository)).resolves.toEqual(["README.md", "src/new.ts"]);
  });

  it("refuses managed isolation when the source checkout is dirty", async () => {
    const { parent, repository } = await temporaryRepository();
    await writeFile(join(repository, "dirty.txt"), "dirty\n", "utf8");
    await expect(prepareWorkspace(repository, { inPlace: false, dataDirectory: join(parent, "data") }))
      .rejects.toThrowError(WorkspaceError);
  });

  it("creates an isolated branch and worktree for a clean source", async () => {
    const { parent, repository } = await temporaryRepository();
    const result = await prepareWorkspace(repository, { inPlace: false, dataDirectory: join(parent, "data") });
    expect(result.sourceRoot).toBe(repository);
    expect(result.workspace).not.toBe(repository);
    expect(result.managedWorktree).toBe(true);
    expect(result.baselineCommit).toBe(await resolveCommit(repository));
    expect(result.branch).toMatch(/^agent\//);
    await expect(readFile(join(result.workspace, "README.md"), "utf8")).resolves.toContain("Fixture");
    await discardManagedWorkspace(result);
    await expect(access(result.workspace)).rejects.toThrow();
  });

  it("creates replay worktrees at an exact historical commit and rejects a missing baseline", async () => {
    const { parent, repository } = await temporaryRepository();
    const baseline = await resolveCommit(repository);
    await writeFile(join(repository, "README.md"), "# Later\n", "utf8");
    let result = await runProcess("git", ["add", "README.md"], { cwd: repository });
    expect(result.exitCode).toBe(0);
    result = await runProcess("git", ["commit", "-m", "later"], { cwd: repository });
    expect(result.exitCode).toBe(0);

    const first = await prepareWorkspace(repository, {
      inPlace: false,
      dataDirectory: join(parent, "data"),
      baselineCommit: baseline,
      branchPrefix: "replay"
    });
    const second = await prepareWorkspace(repository, {
      inPlace: false,
      dataDirectory: join(parent, "data"),
      baselineCommit: baseline,
      branchPrefix: "replay"
    });
    expect(first.workspace).not.toBe(second.workspace);
    expect(first.branch).toMatch(/^replay\//);
    expect(await resolveCommit(first.workspace)).toBe(baseline);
    await expect(readFile(join(first.workspace, "README.md"), "utf8")).resolves.toContain("Fixture");
    await expect(prepareWorkspace(repository, {
      inPlace: false,
      dataDirectory: join(parent, "data"),
      baselineCommit: "f".repeat(40)
    })).rejects.toThrow("Git commit does not exist");
    await discardManagedWorkspace(first);
    await discardManagedWorkspace(second);
  });
});

describe("verification and reports", () => {
  it("requires configured passing commands and rejects out-of-scope changes", async () => {
    const { repository } = await temporaryRepository();
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src", "ok.ts"), "export {};\n", "utf8");
    await writeFile(join(repository, "outside.txt"), "no\n", "utf8");
    const task = parseTaskSpec({
      id: "verify-scope",
      objective: "test verifier",
      allowedPaths: ["src/**"],
      verify: [process.platform === "win32" ? "exit 0" : "true"]
    });
    const report = await runVerification(repository, task);
    expect(report.commands[0]?.status).toBe("passed");
    expect(report.disallowedChangedFiles).toEqual(["outside.txt"]);
    expect(report.success).toBe(false);
  });

  it("audits files created by verification commands", async () => {
    const { repository } = await temporaryRepository();
    const task = parseTaskSpec({
      id: "verify-side-effect",
      objective: "detect verifier side effects",
      allowedPaths: ["src/**"],
      verify: [process.platform === "win32" ? "echo generated>generated.txt" : "printf generated > generated.txt"]
    });
    const report = await runVerification(repository, task);
    expect(report.commands[0]?.status).toBe("passed");
    expect(report.changedFiles).toContain("generated.txt");
    expect(report.disallowedChangedFiles).toContain("generated.txt");
    expect(report.success).toBe(false);
  });

  it("audits both sides of a Git rename", async () => {
    const { repository } = await temporaryRepository();
    await writeFile(join(repository, "secret.txt"), "secret\n", "utf8");
    let result = await runProcess("git", ["add", "secret.txt"], { cwd: repository });
    expect(result.exitCode).toBe(0);
    result = await runProcess("git", ["commit", "-m", "add secret"], { cwd: repository });
    expect(result.exitCode).toBe(0);
    await mkdir(join(repository, "src"));
    result = await runProcess("git", ["mv", "secret.txt", "src/secret.txt"], { cwd: repository });
    expect(result.exitCode).toBe(0);
    const task = parseTaskSpec({
      id: "rename-scope",
      objective: "detect rename source",
      allowedPaths: ["src/**"],
      verify: [process.platform === "win32" ? "exit 0" : "true"]
    });
    const report = await runVerification(repository, task);
    expect(report.changedFiles).toEqual(["secret.txt", "src/secret.txt"]);
    expect(report.disallowedChangedFiles).toEqual(["secret.txt"]);
    expect(report.success).toBe(false);
  });

  it("writes machine-readable and human-readable run reports", async () => {
    const { parent, repository } = await temporaryRepository();
    const task = parseTaskSpec({ id: "report", objective: "write report", verify: [process.platform === "win32" ? "exit 0" : "true"] });
    const verification = await runVerification(repository, task);
    const paths = await writeRunReport({
      version: 1,
      createdAt: "2026-08-27T12:34:56.000Z",
      task,
      workspace: { sourceRoot: repository, workspace: repository, branch: "main", managedWorktree: false, baselineCommit: "0".repeat(40) },
      sessionId: "session-test",
      verification
    }, join(parent, "agent-data"));
    await expect(readFile(paths.jsonPath, "utf8")).resolves.toContain('"sessionId": "session-test"');
    await expect(readFile(paths.markdownPath, "utf8")).resolves.toContain("# Coding Agent Run");
  });

  it("preserves stdout, stderr, and embedded Markdown fences in reports", async () => {
    const { parent, repository } = await temporaryRepository();
    const task = parseTaskSpec({ id: "markdown-output", objective: "report output", verify: ["unused"] });
    const paths = await writeRunReport({
      version: 1,
      createdAt: "2026-08-27T12:34:56.000Z",
      task,
      workspace: { sourceRoot: repository, workspace: repository, branch: "main", managedWorktree: false, baselineCommit: "0".repeat(40) },
      sessionId: "session-markdown",
      verification: {
        configured: true,
        success: false,
        changedFiles: [],
        disallowedChangedFiles: [],
        commands: [{
          command: "tool --value `x`",
          status: "failed",
          exitCode: 1,
          stdout: "stdout with ``` fence",
          stderr: "stderr evidence",
          outputTruncated: false,
          durationMs: 1
        }]
      }
    }, join(parent, "markdown-report"));
    const markdown = await readFile(paths.markdownPath, "utf8");
    expect(markdown).toContain("stdout with ``` fence");
    expect(markdown).toContain("stderr evidence");
    expect(markdown).toContain("````text");
  });

  it("redacts sensitive verifier commands from every report projection", async () => {
    const { parent, repository } = await temporaryRepository();
    const task = parseTaskSpec({ id: "redaction", objective: "safe objective", verify: ["Get-Content .env"] });
    const paths = await writeRunReport({
      version: 1,
      createdAt: "2026-08-27T12:34:56.000Z",
      task,
      workspace: { sourceRoot: repository, workspace: repository, branch: "main", managedWorktree: false, baselineCommit: "0".repeat(40) },
      sessionId: "session-redaction",
      verification: {
        configured: true,
        success: false,
        changedFiles: [],
        disallowedChangedFiles: [],
        commands: [{
          command: "Get-Content .env",
          status: "failed",
          exitCode: 1,
          stdout: "API_KEY=do-not-store",
          stderr: "",
          outputTruncated: false,
          durationMs: 1
        }]
      }
    }, join(parent, "redacted-report"));
    const serialized = `${await readFile(paths.jsonPath, "utf8")}\n${await readFile(paths.markdownPath, "utf8")}`;
    expect(serialized).not.toContain("Get-Content .env");
    expect(serialized).not.toContain("do-not-store");
    expect(serialized).toContain("REDACTED SENSITIVE VERIFIER");
  });
});
