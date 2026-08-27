import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  defineTool,
  createEditToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition
} from "@earendil-works/pi-coding-agent";
import { assertReadablePath, assertWritablePath, relativePathWithin } from "./path-policy.js";

async function assertFilesystemContained(workspace: string, targetPath: string): Promise<string> {
  const realWorkspace = await realpath(workspace);
  let existingAncestor = targetPath;
  while (true) {
    try {
      const realTarget = await realpath(existingAncestor);
      if (relativePathWithin(realWorkspace, realTarget) === null) {
        throw new Error(`Path resolves outside the workspace through a symbolic link: ${targetPath}`);
      }
      return targetPath;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
}

async function safeReadablePath(workspace: string, targetPath: string): Promise<string> {
  return assertFilesystemContained(workspace, assertReadablePath(workspace, targetPath));
}

async function safeWritablePath(workspace: string, targetPath: string, allowedPaths: string[]): Promise<string> {
  return assertFilesystemContained(workspace, assertWritablePath(workspace, targetPath, allowedPaths));
}

export function createSafeToolDefinitions(workspace: string, allowedPaths: string[]): ToolDefinition[] {
  const read = createReadToolDefinition(workspace, {
    operations: {
      readFile: async (absolutePath) => readFile(await safeReadablePath(workspace, absolutePath)),
      access: async (absolutePath) => access(await safeReadablePath(workspace, absolutePath), constants.R_OK)
    }
  });
  const write = createWriteToolDefinition(workspace, {
    operations: {
      mkdir: async (directory) => {
        const safeDirectory = await assertFilesystemContained(workspace, assertReadablePath(workspace, directory));
        await mkdir(safeDirectory, { recursive: true });
      },
      writeFile: async (absolutePath, content) => writeFile(await safeWritablePath(workspace, absolutePath, allowedPaths), content, "utf8")
    }
  });
  const edit = createEditToolDefinition(workspace, {
    operations: {
      readFile: async (absolutePath) => readFile(await safeWritablePath(workspace, absolutePath, allowedPaths)),
      access: async (absolutePath) => access(await safeWritablePath(workspace, absolutePath, allowedPaths), constants.R_OK | constants.W_OK),
      writeFile: async (absolutePath, content) => writeFile(await safeWritablePath(workspace, absolutePath, allowedPaths), content, "utf8")
    }
  });
  const shell = process.platform === "win32"
    ? createPowerShellToolDefinition(workspace)
    : createBashToolDefinition(workspace);
  return [
    defineTool(read),
    defineTool(shell),
    defineTool(edit),
    defineTool(write),
    defineTool(createLsToolDefinition(workspace, {
      operations: {
        exists: async (absolutePath) => {
          try {
            await access(await safeReadablePath(workspace, absolutePath));
            return true;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          }
        },
        stat: async (absolutePath) => stat(await safeReadablePath(workspace, absolutePath)),
        readdir: async (absolutePath) => readdir(await safeReadablePath(workspace, absolutePath))
      }
    }))
  ];
}
