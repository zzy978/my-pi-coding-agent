import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFilesystemPath, createApprovalGatedShellOperations, createSafeToolDefinitions } from "../src/policy/safe-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("filesystem path protection", () => {
  it("accepts a new path below an existing workspace ancestor", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-agent-containment-"));
    temporaryDirectories.push(parent);
    const workspace = join(parent, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    const target = join(workspace, "src", "new", "index.ts");
    await expect(assertFilesystemPath(workspace, target)).resolves.toBe(target);
  });

  it("accepts a symbolic link to an external directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-agent-containment-"));
    temporaryDirectories.push(parent);
    const workspace = join(parent, "workspace");
    const outside = join(parent, "outside");
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(outside, join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
    await expect(assertFilesystemPath(workspace, join(workspace, "link", "secret.txt")))
      .resolves.toBe(join(workspace, "link", "secret.txt"));
  });

  it("reads, writes and edits outside the workspace without a whitelist", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-agent-external-"));
    temporaryDirectories.push(parent);
    const workspace = join(parent, "workspace");
    await mkdir(workspace);
    const tools = createSafeToolDefinitions(workspace);
    const invoke = (name: string, input: Record<string, unknown>) => {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error(name);
      return tool.execute("call", input, undefined, undefined, {} as never);
    };
    const target = join(parent, "other", "new.txt");
    await invoke("write", { path: target, content: "before\n" });
    await invoke("edit", { path: "../other/new.txt", edits: [{ oldText: "before", newText: "after" }] });
    expect(JSON.stringify(await invoke("read", { path: target }))).toContain("after");
    expect(JSON.stringify(await invoke("ls", { path: "../other" }))).toContain("new.txt");
    await expect(readFile(target, "utf8")).resolves.toBe("after\n");
  });

  it("protects external sensitive paths and symbolic-link targets", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-agent-protected-"));
    temporaryDirectories.push(parent);
    const workspace = join(parent, "workspace");
    const protectedDirectory = join(parent, ".git");
    await Promise.all([mkdir(workspace), mkdir(protectedDirectory)]);
    await symlink(protectedDirectory, join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
    await expect(assertFilesystemPath(workspace, join(parent, ".env"))).rejects.toThrow("protected");
    await expect(assertFilesystemPath(workspace, join(workspace, "link", "new.txt"), true)).rejects.toThrow("not allowed");
    await expect(assertFilesystemPath(workspace, join(parent, "node_modules", "new.txt"), true)).rejects.toThrow("not allowed");
  });

  it("includes shell by default and supports an explicit opt-out", () => {
    const shell = process.platform === "win32" ? "powershell" : "bash";
    expect(createSafeToolDefinitions(process.cwd()).map((tool) => tool.name))
      .toEqual(["read", shell, "grep", "find", "ls", "edit", "write"]);
    expect(createSafeToolDefinitions(process.cwd(), false).map((tool) => tool.name))
      .toEqual(["read", "grep", "find", "ls", "edit", "write"]);
  });

  it("reports the matching rule and redacted command without executing it", async () => {
    const exec = vi.fn(() => Promise.resolve({ exitCode: 0 }));
    const operations = createApprovalGatedShellOperations({ exec }, () => Promise.resolve(false));
    let message = "";
    try {
      await operations.exec('format D: --token "private value here"\u001b[31m', process.cwd(), { onData: vi.fn() });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("disk-format");
    expect(message).toContain("format D:");
    expect(message).not.toContain("private value here");
    expect(message).not.toContain("\u001b");
    expect(exec).not.toHaveBeenCalled();
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
    const writeTool = createSafeToolDefinitions(workspace).find((tool) => tool.name === "write");
    await expect(writeTool?.execute("call", { path: "inside.txt", content: "changed\n" }, undefined, undefined, {} as never))
      .rejects.toThrow("hard links");
    await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
  });
});
