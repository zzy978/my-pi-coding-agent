import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunReport } from "../src/report/report.js";
import { parseTaskSpec } from "../src/task/task-spec.js";
import { runVerification } from "../src/verifier/verifier.js";
import { discardManagedWorkspace, listChangedFiles, prepareWorkspace, resolveGitRoot, WorkspaceError } from "../src/workspace/git.js";
import { initializeGitRepository } from "./helpers/git-repository.js";

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
    expect(result.branch).toMatch(/^agent\//);
    await expect(readFile(join(result.workspace, "README.md"), "utf8")).resolves.toContain("Fixture");
    await discardManagedWorkspace(result);
    await expect(access(result.workspace)).rejects.toThrow();
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

  it("writes machine-readable and human-readable run reports", async () => {
    const { parent, repository } = await temporaryRepository();
    const task = parseTaskSpec({ id: "report", objective: "write report", verify: [process.platform === "win32" ? "exit 0" : "true"] });
    const verification = await runVerification(repository, task);
    const paths = await writeRunReport({
      version: 1,
      createdAt: "2026-08-27T12:34:56.000Z",
      task,
      workspace: { sourceRoot: repository, workspace: repository, branch: "main", managedWorktree: false },
      sessionId: "session-test",
      verification
    }, join(parent, "agent-data"));
    await expect(readFile(paths.jsonPath, "utf8")).resolves.toContain('"sessionId": "session-test"');
    await expect(readFile(paths.markdownPath, "utf8")).resolves.toContain("# Coding Agent Run");
  });
});
