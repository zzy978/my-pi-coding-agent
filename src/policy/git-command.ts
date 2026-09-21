interface Word {
  value: string;
  start: number;
  end: number;
  literal: boolean;
}

// 只识别有限的 Git 调用形式；不是 Shell 解释器。
function parseCommand(command: string): { segments: Word[][]; ambiguous: boolean } {
  const result: Word[][] = [[]];
  let word: Word | undefined;
  let quote = "";
  let ambiguous = false;
  const flush = (end: number): void => {
    if (word) {
      word.end = end;
      result.at(-1)!.push(word);
      word = undefined;
    }
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (!quote && /[;|&\n\r(){}]/.test(char)) {
      flush(index);
      result.push([]);
      continue;
    }
    if (!quote && /\s/.test(char)) { flush(index); continue; }
    word ??= { value: "", start: index, end: index, literal: true };
    if (char === quote) { quote = ""; continue; }
    if (!quote && (char === "'" || char === '"')) { quote = char; continue; }
    // PowerShell/Bash 插值、命令替换和重定向不属于可证明的只读例外。
    if (quote !== "'" && /[$`<>]/.test(char)) word.literal = false;
    if (quote !== "'" && /[$`]/.test(char)) ambiguous = true;
    if (quote !== "'" && char === "\\" && /[\s'";|&]/.test(command[index + 1] ?? "")) {
      // Bash 和 PowerShell 对反斜线的解释不同，不能将此形式认作查询例外。
      word.literal = false;
      ambiguous = true;
      word.value += command[++index];
    } else word.value += char;
  }
  if (quote && word) word.literal = false;
  flush(command.length);
  return { segments: result, ambiguous: ambiguous || Boolean(quote) };
}

function isGit(word: Word): boolean {
  return /^(?:git|git\.exe)$/i.test(word.value.split(/[\\/]/).at(-1) ?? "");
}

function subcommandIndex(words: Word[]): number {
  let index = 1;
  while (index < words.length) {
    const value = words[index]!.value;
    if (value === "--no-pager") { index++; continue; }
    if (value === "-C" && words[index + 1]) { index += 2; continue; }
    return index;
  }
  return index;
}

const HISTORY_COMMANDS = new Set(["commit", "push", "rebase", "merge", "cherry-pick"]);
const DISCARD_COMMANDS = new Set(["rm", "checkout", "restore", "switch"]);

function discardsChanges(subcommand: string, args: Word[]): boolean {
  return DISCARD_COMMANDS.has(subcommand)
    || (subcommand === "reset" && args.some((word) => word.value === "--hard"))
    || (subcommand === "clean" && args.some((word) => word.value === "--force" || /^-[^-]*f/.test(word.value)));
}

export function gitCommandRisk(command: string): "git-history" | "git-discard" | undefined {
  const allowedPrefixes: Array<{ start: number; end: number }> = [];
  let requiresApproval = false;
  const parsed = parseCommand(command);
  for (const words of parsed.segments) {
    const first = words[0];
    if (!first || !isGit(first)) continue;
    const index = subcommandIndex(words);
    const subcommand = words[index];
    if (!subcommand) continue;
    const args = words.slice(index + 1);
    if (HISTORY_COMMANDS.has(subcommand.value)) return "git-history";
    if (discardsChanges(subcommand.value, args)) requiresApproval = true;
    if (subcommand.value !== "tag") {
      // 无法解析全局参数时，不能将其后可能的写入或丢弃操作放行。
      if (subcommand.value.startsWith("-") && args.some((word) =>
        ["tag", "reset", "clean"].includes(word.value) || HISTORY_COMMANDS.has(word.value) || DISCARD_COMMANDS.has(word.value))) {
        return "git-history";
      }
      continue;
    }
    if (words.some((word) => !word.literal)) return "git-history";
    const listing = args[0]?.value === "-l" || args[0]?.value === "--list";
    if (args.length && (!listing || args.slice(1).some((word) => word.value.startsWith("-")))) return "git-history";
    allowedPrefixes.push({ start: first.start, end: subcommand.end });
  }
  // 后续片段里的动态展开或跨 Shell 转义也可能隐藏写入，不能被查询例外遮蔽。
  if (allowedPrefixes.length && parsed.ambiguous) return "git-history";
  // 保留旧规则对包装脚本、引号中的调用等形式的拒绝；只豁免完整识别的查询。
  for (const match of command.matchAll(/\bgit(?:\.exe)?\s+tag\b/gi)) {
    if (!allowedPrefixes.some((range) => match.index >= range.start && match.index < range.end)) return "git-history";
  }
  return requiresApproval ? "git-discard" : undefined;
}
