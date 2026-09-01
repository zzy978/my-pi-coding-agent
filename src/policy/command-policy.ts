export interface CommandPolicyResult {
  allowed: boolean;
  requiresApproval?: boolean;
  reason?: string;
}

const BLOCKED_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+(?:commit|push|rebase|merge|cherry-pick|tag)\b/i, reason: "Git history and remote mutations are blocked" },
  { pattern: /\b(?:sudo|runas)\b/i, reason: "privilege escalation is blocked" },
  { pattern: /\b(?:diskpart|format(?:\.com)?|shutdown)\b/i, reason: "system-level command is blocked" },
  { pattern: /(?:^|[;&|]\s*)cd\s+(?:\.\.(?:[\\/]|\s|$)|[A-Za-z]:[\\/]|[\\/]{1,2})/i, reason: "changing to a directory outside the workspace is blocked" }
];

const APPROVAL_REQUIRED_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(?:rm|unlink|rmdir|rimraf)(?:\.exe)?(?:\s|$)/i, reason: "shell command deletes files or directories" },
  { pattern: /\bshred\b/i, reason: "shell command destroys file contents" },
  { pattern: /\b(?:Remove-Item|Clear-Content)\b/i, reason: "PowerShell command deletes files or file contents" },
  { pattern: /\b(?:del|erase|rd|ri)(?:\s|$)/i, reason: "shell command deletes files or directories" },
  { pattern: /\bfind\b[^\n]*(?:-delete\b|-exec\s+(?:rm|rmdir|unlink)\b)/i, reason: "find command deletes matched paths" },
  { pattern: /\bgit\s+(?:rm\b|reset\s+--hard\b|clean\s+[^\n]*(?:-[^\s]*f[^\s]*|--force\b)|checkout\b|restore\b|switch\b)/i, reason: "Git command can discard files or working-tree changes" },
  { pattern: /\b(?:robocopy\b[^\n]*(?:\/MIR|\/PURGE)|rsync\b[^\n]*--delete)\b/i, reason: "synchronization command can delete destination files" },
  { pattern: /\b(?:npm|pnpm)\s+run\s+clean\b|\byarn\s+(?:run\s+)?clean\b|\bmake\s+clean\b/i, reason: "cleanup script can delete generated files" },
  { pattern: /(?:\bfs\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b|\bshutil\.rmtree\b|\bos\.(?:remove|unlink|rmdir)\b|\bPath\([^\n]*\)\.(?:unlink|rmdir)\b|\[(?:System\.)?IO\.(?:File|Directory)\]::Delete\b)/i, reason: "inline program deletes files or directories" }
];

export function checkCommand(command: string): CommandPolicyResult {
  if (!command.trim()) return { allowed: false, reason: "empty command" };
  for (const blocked of BLOCKED_COMMANDS) {
    if (blocked.pattern.test(command)) return { allowed: false, reason: blocked.reason };
  }
  for (const gated of APPROVAL_REQUIRED_COMMANDS) {
    if (gated.pattern.test(command)) {
      return { allowed: true, requiresApproval: true, reason: gated.reason };
    }
  }
  return { allowed: true };
}
