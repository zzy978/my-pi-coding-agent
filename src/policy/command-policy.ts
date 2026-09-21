import { invokesDiskFormat } from "./format-command.js";
import { gitCommandRisk } from "./git-command.js";

export interface CommandPolicyResult {
  allowed: boolean;
  requiresApproval?: boolean;
  reason?: string;
  ruleId?: string;
  onDeny?: "continue" | "stop";
}

const BLOCKED_COMMANDS: Array<{ id: string; pattern: RegExp; reason: string }> = [
  { id: "privilege-escalation", pattern: /\b(?:sudo|runas)\b/i, reason: "privilege escalation is blocked" },
  { id: "system-command", pattern: /\b(?:diskpart|shutdown|Format-Volume)\b/i, reason: "system-level command is blocked" },
];

const APPROVAL_REQUIRED_COMMANDS: Array<{ id: string; pattern: RegExp; reason: string }> = [
  { id: "delete-files", pattern: /\b(?:rm|unlink|rmdir|rimraf)(?:\.exe)?(?:\s|$)/i, reason: "shell command deletes files or directories" },
  { id: "shred-files", pattern: /\bshred\b/i, reason: "shell command destroys file contents" },
  { id: "powershell-delete", pattern: /\b(?:Remove-Item|Clear-Content)\b/i, reason: "PowerShell command deletes files or file contents" },
  { id: "delete-alias", pattern: /\b(?:del|erase|rd|ri)(?:\s|$)/i, reason: "shell command deletes files or directories" },
  { id: "find-delete", pattern: /\bfind\b[^\n]*(?:-delete\b|-exec\s+(?:rm|rmdir|unlink)\b)/i, reason: "find command deletes matched paths" },
  { id: "git-discard", pattern: /\bgit\s+(?:rm\b|reset\s+--hard\b|clean\s+[^\n]*(?:-[^\s]*f[^\s]*|--force\b)|checkout\b|restore\b|switch\b)/i, reason: "Git command can discard files or working-tree changes" },
  { id: "sync-delete", pattern: /\b(?:robocopy\b[^\n]*(?:\/MIR|\/PURGE)|rsync\b[^\n]*--delete)\b/i, reason: "synchronization command can delete destination files" },
  { id: "cleanup-script", pattern: /\b(?:npm|pnpm)\s+run\s+clean\b|\byarn\s+(?:run\s+)?clean\b|\bmake\s+clean\b/i, reason: "cleanup script can delete generated files" },
  { id: "inline-delete", pattern: /(?:\bfs\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b|\bshutil\.rmtree\b|\bos\.(?:remove|unlink|rmdir)\b|\bPath\([^\n]*\)\.(?:unlink|rmdir)\b|\[(?:System\.)?IO\.(?:File|Directory)\]::Delete\b)/i, reason: "inline program deletes files or directories" }
];

export function checkCommand(command: string): CommandPolicyResult {
  if (!command.trim()) return { allowed: false, reason: "empty command", ruleId: "empty-command", onDeny: "continue" };
  if (invokesDiskFormat(command)) return { allowed: false, ruleId: "disk-format", reason: "disk formatting command is blocked", onDeny: "stop" };
  for (const blocked of BLOCKED_COMMANDS) {
    if (blocked.pattern.test(command)) return { allowed: false, reason: blocked.reason, ruleId: blocked.id, onDeny: "stop" };
  }
  const gitRisk = gitCommandRisk(command);
  if (/\bgit\s+(?:commit|push|rebase|merge|cherry-pick)\b/i.test(command) || gitRisk === "git-history") {
    return { allowed: false, ruleId: "git-history", reason: "Git history and remote mutations are blocked; unsupported tag syntax is denied", onDeny: "continue" };
  }
  if (gitRisk === "git-discard") {
    return { allowed: true, requiresApproval: true, ruleId: "git-discard", reason: "Git command can discard files or working-tree changes" };
  }
  for (const gated of APPROVAL_REQUIRED_COMMANDS) {
    if (gated.pattern.test(command)) {
      return { allowed: true, requiresApproval: true, reason: gated.reason, ruleId: gated.id };
    }
  }
  return { allowed: true };
}
