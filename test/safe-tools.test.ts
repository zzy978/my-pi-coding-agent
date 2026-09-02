import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFilesystemContained, createApprovalGatedShellOperations, createSafeToolDefinitions } from "../src/policy/safe-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("filesystem containment", () => {
  it("accepts a new path below an existing workspace ancestor", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-agent-containment-"));
    temporaryDirectories.push(parent);
    const workspace = join(parent, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    const target = join(workspace, "src", "new", "index.ts");
    await expect(assertFilesystemContained(workspace, target)).resolves.toBe(target);
  });

  it("rejects a symbolic-link escape", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-agent-containment-"));
    temporaryDirectories.push(parent);
    const workspace = join(parent, "workspace");
    const outside = join(parent, "outside");
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(outside, join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
    await expect(assertFilesystemContained(workspace, join(workspace, "link", "secret.txt")))
      .rejects.toThrow("symbolic link");
  });

  it("includes shell by default and supports an explicit opt-out", () => {
    const shell = process.platform === "win32" ? "powershell" : "bash";
    expect(createSafeToolDefinitions(process.cwd(), ["**/*"]).map((tool) => tool.name))
      .toEqual(["read", shell, "grep", "find", "ls", "edit", "write"]);
    expect(createSafeToolDefinitions(process.cwd(), ["**/*"], false).map((tool) => tool.name))
      .toEqual(["read", "grep", "find", "ls", "edit", "write"]);
  });

  it("runs ordinary commands but gates deletion before spawning a process", async () => {
    const exec = vi.fn(() => Promise.resolve({ exitCode: 0 }));
    const approve = vi.fn(() => Promise.resolve(false));
    const operations = createApprovalGatedShellOperations({ exec }, approve);
    const options = { onData: vi.fn() };

    await expect(operations.exec("npm test", process.cwd(), options)).resolves.toEqual({ exitCode: 0 });
    expect(approve).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledOnce();

    await expect(operations.exec("Remove-Item ./build -Recurse -Force", process.cwd(), options))
      .rejects.toThrow("explicit human approval");
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ command: "Remove-Item ./build -Recurse -Force" }));
    expect(exec).toHaveBeenCalledOnce();

    approve.mockResolvedValueOnce(true);
    await expect(operations.exec("rm -rf ./build", process.cwd(), options)).resolves.toEqual({ exitCode: 0 });
    expect(exec).toHaveBeenCalledTimes(2);

    await expect(operations.exec("sudo rm -rf ./build", process.cwd(), options)).rejects.toThrow("privilege escalation");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("refuses to edit a hard-linked file", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-agent-hardlink-"));
    temporaryDirectories.push(parent);
    const workspace = join(parent, "workspace");
    const outside = join(parent, "outside.txt");
    await mkdir(workspace);
    await writeFile(outside, "outside\n", "utf8");
    const inside = join(workspace, "inside.txt");
    await link(outside, inside);
    const writeTool = createSafeToolDefinitions(workspace, ["**/*"]).find((tool) => tool.name === "write");
    await expect(writeTool?.execute("call", { path: "inside.txt", content: "changed\n" }, undefined, undefined, {} as never))
      .rejects.toThrow("hard links");
    await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
  });
});
