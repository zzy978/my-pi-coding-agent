import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashToolDefinition,
  createLocalBashOperations,
  createLocalPowerShellOperations,
  defineTool,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition
} from "@earendil-works/pi-coding-agent";
import { checkCommand } from "./command-policy.js";
import { commandPolicyDiagnostic } from "./command-diagnostics.js";
import { assertReadablePath, assertWritablePath } from "./path-policy.js";

interface ShellApprovalRequest {
  command: string;
  reason: string;
}

type ShellApprovalHandler = (request: ShellApprovalRequest) => Promise<boolean>;

// Resolve existing ancestors so links cannot hide protected paths, including new files.
export async function assertFilesystemPath(workspace: string, targetPath: string, writable = false): Promise<string> {
  const check = (path: string) => writable
    ? assertWritablePath(workspace, path)
    : assertReadablePath(workspace, path);
  const absolutePath = check(targetPath);
  let existingAncestor = absolutePath;
  while (true) {
    try {
      const realTarget = await realpath(existingAncestor);
      check(resolve(realTarget, relative(existingAncestor, absolutePath)));
      return absolutePath;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
}

async function safeReadablePath(workspace: string, targetPath: string): Promise<string> {
  return assertFilesystemPath(workspace, targetPath);
}

async function safeWritablePath(workspace: string, targetPath: string): Promise<string> {
  const safePath = await assertFilesystemPath(workspace, targetPath, true);
  try {
    const metadata = await stat(safePath);
    if (metadata.isFile() && metadata.nlink > 1) {
      throw new Error(`Refusing to modify a file with multiple hard links: ${targetPath}`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return safePath;
}

export function createApprovalGatedShellOperations(
  operations: BashOperations,
  requestApproval: ShellApprovalHandler
): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const policy = checkCommand(command);
      if (!policy.allowed) {
        throw new Error(commandPolicyDiagnostic(command, policy));
      }
      if (policy.requiresApproval) {
        const approved = await requestApproval({
          command,
          reason: policy.reason ?? "shell command may delete data"
        });
        if (!approved) throw new Error(commandPolicyDiagnostic(command, policy, true));
      }
      return operations.exec(command, cwd, options);
    }
  };
}

export function createSafeToolDefinitions(
  workspace: string,
  includeShell = true,
  requestApproval: ShellApprovalHandler = () => Promise.resolve(false)
): ToolDefinition[] {
  const read = createReadToolDefinition(workspace, {
    operations: {
      readFile: async (absolutePath) => readFile(await safeReadablePath(workspace, absolutePath)),
      access: async (absolutePath) => access(await safeReadablePath(workspace, absolutePath), constants.R_OK)
    }
  });
  const write = createWriteToolDefinition(workspace, {
    operations: {
      mkdir: async (directory) => {
        const safeDirectory = await assertFilesystemPath(workspace, directory, true);
        await mkdir(safeDirectory, { recursive: true });
      },
      writeFile: async (absolutePath, content) => writeFile(await safeWritablePath(workspace, absolutePath), content, "utf8")
    }
  });
  const edit = createEditToolDefinition(workspace, {
    operations: {
      readFile: async (absolutePath) => readFile(await safeWritablePath(workspace, absolutePath)),
      access: async (absolutePath) => access(await safeWritablePath(workspace, absolutePath), constants.R_OK | constants.W_OK),
      writeFile: async (absolutePath, content) => writeFile(await safeWritablePath(workspace, absolutePath), content, "utf8")
    }
  });
  const shellOperations = createApprovalGatedShellOperations(
    process.platform === "win32" ? createLocalPowerShellOperations() : createLocalBashOperations(),
    requestApproval
  );
  const shell = process.platform === "win32"
    ? createPowerShellToolDefinition(workspace, { operations: shellOperations })
    : createBashToolDefinition(workspace, { operations: shellOperations });
  const fileTools: ToolDefinition[] = [
    defineTool(read),
    defineTool(createGrepToolDefinition(workspace)),
    defineTool(createFindToolDefinition(workspace)),
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
    })),
    defineTool(edit),
    defineTool(write)
  ];
  return includeShell ? [fileTools[0]!, defineTool(shell), ...fileTools.slice(1)] : fileTools;
}
