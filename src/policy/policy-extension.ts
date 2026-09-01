import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { TaskSpec } from "../task/task-spec.js";
import { checkCommand } from "./command-policy.js";
import { isAllowedChangedPath, isSensitiveReadPath, relativePathWithin } from "./path-policy.js";

function taskPolicyText(task: TaskSpec): string {
  return `\n\n# Host task policy\n- Work only on task ${task.id}: ${task.objective}\n- Files may be changed only when they match: ${task.allowedPaths.join(", ")}\n- Never edit .git, .env files, or node_modules.\n- Do not commit, push, or rewrite Git history.\n- Shell deletion and destructive working-tree commands require explicit human approval. Never disguise or indirectly encode a deletion to bypass that approval.\n- Verification is performed by the host after the turn. Do not claim success without command evidence.\n- Use the primary natural language of the text under "Current user message" for all prose replies; an explicit language request in that message takes precedence.\n- If a requested action conflicts with these rules, explain the conflict instead of bypassing it.`;
}

export function createPolicyExtension(workspace: string, getTask: () => TaskSpec): InlineExtension {
  return {
    name: "host-policy",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: event.systemPrompt + taskPolicyText(getTask())
      }));

      pi.on("tool_call", (event) => {
        const task = getTask();
        if (event.toolName === "write" || event.toolName === "edit") {
          const inputPath = typeof event.input.path === "string" ? event.input.path : "";
          const relativePath = relativePathWithin(workspace, inputPath);
          if (relativePath === null || !isAllowedChangedPath(relativePath, task.allowedPaths)) {
            return {
              block: true,
              terminate: true,
              reason: `Write blocked by task policy: ${inputPath || "missing path"}`
            };
          }
        }

        if (event.toolName === "read" || event.toolName === "ls") {
          const inputPath = typeof event.input.path === "string" ? event.input.path : ".";
          const relativePath = relativePathWithin(workspace, inputPath);
          if (relativePath === null) {
            return { block: true, reason: `Read blocked outside workspace: ${inputPath}` };
          }
          if (isSensitiveReadPath(relativePath)) {
            return { block: true, reason: `Read blocked for protected path: ${relativePath}` };
          }
        }

        if (event.toolName === "bash" || event.toolName === "powershell") {
          const command = typeof event.input.command === "string" ? event.input.command : "";
          const result = checkCommand(command);
          if (!result.allowed) {
            return { block: true, terminate: true, reason: `Command blocked: ${result.reason ?? "policy violation"}` };
          }
        }
        return undefined;
      });
    }
  };
}
