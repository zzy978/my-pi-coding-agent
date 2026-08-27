import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertFilesystemContained, createSafeToolDefinitions } from "../src/policy/safe-tools.js";

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

  it("keeps shell disabled unless explicitly requested", () => {
    expect(createSafeToolDefinitions(process.cwd(), ["**/*"]).map((tool) => tool.name)).not.toContain(process.platform === "win32" ? "powershell" : "bash");
    expect(createSafeToolDefinitions(process.cwd(), ["**/*"], true).map((tool) => tool.name)).toContain(process.platform === "win32" ? "powershell" : "bash");
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
