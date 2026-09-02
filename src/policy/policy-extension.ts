import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { TaskSpec } from "../task/task-spec.js";
import { checkCommand } from "./command-policy.js";
import { isAllowedChangedPath, isSensitiveReadPath, relativePathWithin } from "./path-policy.js";

export interface PolicyExtensionOptions {
  allowShell?: boolean;
  interactiveShellApproval?: boolean;
}

export function taskPolicyText(task: TaskSpec): string {
  return `\n\n# Host task policy\n- Work only on task ${task.id}: ${task.objective}\n- Files may be changed only when they match: ${task.allowedPaths.join(", ")}\n- Verification commands: ${task.verify.map((item) => item.command).join("; ") || "not configured"}\n- Completion criteria: ${task.doneWhen.join("; ") || "not configured"}\n- Never edit .git, .env files, or node_modules.\n- Do not commit, push, or rewrite Git history.\n- Shell deletion and destructive working-tree commands require explicit human approval. Never disguise or indirectly encode a deletion to bypass that approval.\n- Verification is performed by the host after the turn. Do not claim success without command evidence.\n- Use the primary natural language of the current user message for all prose replies; an explicit language request takes precedence.\n- If a requested action conflicts with these rules, explain the conflict instead of bypassing it.`;
}

function deniedShellResult(message: string) {
  return { output: message, exitCode: 1, cancelled: false, truncated: false };
}

function visibleCommand(command: string, maximum = 1_200): string {
  let visible = "";
  for (const character of command) {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafeControl = (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069);
    const rendered = unsafeControl ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
    if (visible.length + rendered.length > maximum) return `${visible.slice(0, maximum - 1)}…`;
    visible += rendered;
  }
  return visible;
}

export function createPolicyExtension(
  workspace: string,
  getTask: () => TaskSpec,
  options: PolicyExtensionOptions = {}
): InlineExtension {
  const allowShell = options.allowShell ?? true;
  return {
    name: "host-policy",
    hidden: true,
    factory: (pi) => {
      let approvalQueue: Promise<void> = Promise.resolve();
      const requestShellApproval = (ctx: ExtensionContext, reason: string | undefined, command: string): Promise<boolean> => {
        const decision = approvalQueue.then(async () => {
          if (!ctx.hasUI) return false;
          const choice = await ctx.ui.select(
            `Approve destructive command?\n${reason ?? "This command may delete or discard data."}\n\n${visibleCommand(command)}`,
            ["Deny", "Approve once"],
            ctx.signal ? { signal: ctx.signal } : undefined
          );
          return choice === "Approve once";
        });
        approvalQueue = decision.then(() => undefined, () => undefined);
        return decision;
      };

      pi.on("before_agent_start", (event) => ({
        systemPrompt: event.systemPrompt + taskPolicyText(getTask())
      }));

      pi.on("tool_call", async (event, ctx) => {
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

        if (["read", "grep", "find", "ls"].includes(event.toolName)) {
          const inputPath = "path" in event.input && typeof event.input.path === "string" ? event.input.path : ".";
          const relativePath = relativePathWithin(workspace, inputPath);
          if (relativePath === null) {
            return { block: true, reason: `Read blocked outside workspace: ${inputPath}` };
          }
          if (isSensitiveReadPath(relativePath)) {
            return { block: true, reason: `Read blocked for protected path: ${relativePath}` };
          }
        }

        if (event.toolName === "bash" || event.toolName === "powershell") {
          if (!allowShell) {
            return { block: true, terminate: true, reason: "Shell is disabled for this run" };
          }
          const command = typeof event.input.command === "string" ? event.input.command : "";
          const result = checkCommand(command);
          if (!result.allowed) {
            return { block: true, terminate: true, reason: `Command blocked: ${result.reason ?? "policy violation"}` };
          }
          if (result.requiresApproval && options.interactiveShellApproval) {
            if (!ctx.hasUI) {
              return { block: true, reason: "Destructive Shell command requires interactive approval" };
            }
            const approved = await requestShellApproval(ctx, result.reason, command);
            if (!approved) return { block: true, reason: "Destructive Shell command was denied" };
          }
        }
        return undefined;
      });

      pi.on("user_bash", async (event, ctx) => {
        if (!allowShell) return { result: deniedShellResult("Shell is disabled for this run") };
        const result = checkCommand(event.command);
        if (!result.allowed) {
          return { result: deniedShellResult(`Command blocked: ${result.reason ?? "policy violation"}`) };
        }
        if (!result.requiresApproval) return undefined;
        if (!options.interactiveShellApproval || !ctx.hasUI) {
          return { result: deniedShellResult("Destructive Shell command requires interactive approval") };
        }
        const approved = await requestShellApproval(ctx, result.reason, event.command);
        return approved ? undefined : { result: deniedShellResult("Destructive Shell command was denied") };
      });
    }
  };
}
