interface Word {
  text: string;
  separator: boolean;
}

// A bounded invocation scanner, not a shell interpreter or security sandbox.
// Quoted arguments remain opaque unless a known launcher executes their contents.
function words(command: string): Word[] {
  const result: Word[] = [];
  let text = "";
  let quote = "";
  const flush = () => {
    if (text) result.push({ text, separator: false });
    text = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = "";
      else if ((character === "`" || character === "\\") && command[index + 1] === quote) {
        text += command[++index];
      } else text += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/[;|&\n\r(){}]/.test(character)) {
      flush();
      result.push({ text: character, separator: true });
    } else if (/\s|[<>]/.test(character)) {
      flush();
    } else text += character;
  }
  flush();
  return result;
}

function executable(value: string): string {
  return value.replace(/\/\?.*$/, "").split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function invokesFormat(command: string, depth: number): boolean {
  if (depth > 12) return true; // Refuse opaque, excessively nested launchers.
  const tokens = words(command.replace(/%[A-Za-z_][A-Za-z0-9_]*%/g, " "));
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token.separator) segments.push([]);
    else segments.at(-1)!.push(token.text);
  }
  return segments.some((segment) => {
    // Shell assignment prefixes do not change the executable position.
    while (segment[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[0])) segment.shift();
    if (!segment.length) return false;
    const name = executable(segment[0]!);
    if (/^format(?:\.(?:com|exe))?$/.test(name)) return true;
    if (/^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash|sh)$/.test(name)) {
      const flag = segment.findIndex((word) => /^(?:\/[ck]|-command|-c|-lc|-cl)$/i.test(word));
      return flag >= 0 && invokesFormat(segment.slice(flag + 1).join(" "), depth + 1);
    }
    if (name === "start-process") {
      const flag = segment.findIndex((word) => /^-filepath$/i.test(word));
      return invokesFormat(segment.slice(flag >= 0 ? flag + 1 : 1).join(" "), depth + 1);
    }
    if (/^(?:docker|podman)$/.test(name) && /^(?:exec|run)$/.test(segment[1] ?? "")) {
      const shell = segment.findIndex((word, index) => index > 1 && /^(?:bash|sh|cmd|powershell|pwsh)$/.test(executable(word)));
      return shell >= 0 && invokesFormat(segment.slice(shell).join(" "), depth + 1);
    }
    if (/^(?:node(?:\.exe)?|python(?:3|\.exe)?)$/.test(name)) {
      const flag = segment.findIndex((word) => /^(?:-e|--eval|-c)$/.test(word));
      const script = segment[flag + 1];
      if (flag >= 0 && script) {
        // Only literal process-launch arguments, not arbitrary source identifiers.
        for (const match of script.matchAll(/\b(?:execSync|exec|execFileSync|execFile|spawnSync|spawn|system|Popen|run)\s*\(\s*(['"])(.*?)\1/gs)) {
          if (invokesFormat(match[2]!, depth + 1)) return true;
        }
      }
    }
    return false;
  });
}

export function invokesDiskFormat(command: string): boolean {
  return invokesFormat(command, 0);
}
