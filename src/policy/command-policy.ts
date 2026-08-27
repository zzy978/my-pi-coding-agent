export interface CommandPolicyResult {
  allowed: boolean;
  reason?: string;
}

const BLOCKED_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+[^\n]*(?:-rf|-fr|--recursive)/i, reason: "recursive forced deletion is blocked" },
  { pattern: /\bRemove-Item\b[^\n]*(?:-Recurse[^\n]*-Force|-Force[^\n]*-Recurse)/i, reason: "recursive forced deletion is blocked" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard is blocked" },
  { pattern: /\bgit\s+clean\s+[^\n]*-[^\s]*f/i, reason: "git clean -f is blocked" },
  { pattern: /\bgit\s+(?:checkout|restore|switch)\b/i, reason: "commands that replace the working tree or branch are blocked" },
  { pattern: /\bgit\s+(?:commit|push|rebase|merge|cherry-pick|tag)\b/i, reason: "Git history and remote mutations are blocked" },
  { pattern: /\brmdir\s+[^\n]*(?:\/s|--ignore-fail-on-non-empty)/i, reason: "recursive directory deletion is blocked" },
  { pattern: /\b(?:sudo|runas)\b/i, reason: "privilege escalation is blocked" },
  { pattern: /\b(?:diskpart|format(?:\.com)?|shutdown)\b/i, reason: "system-level command is blocked" },
  { pattern: /(?:^|[;&|]\s*)cd\s+(?:\.\.(?:[\\/]|\s|$)|[A-Za-z]:[\\/]|[\\/]{1,2})/i, reason: "changing to a directory outside the workspace is blocked" }
];

export function checkCommand(command: string): CommandPolicyResult {
  if (!command.trim()) return { allowed: false, reason: "empty command" };
  for (const blocked of BLOCKED_COMMANDS) {
    if (blocked.pattern.test(command)) return { allowed: false, reason: blocked.reason };
  }
  return { allowed: true };
}
