export type TuiCommand =
  | { type: "help" }
  | { type: "quit" }
  | { type: "abort" }
  | { type: "verify" }
  | { type: "diff" }
  | { type: "status" }
  | { type: "clear" }
  | { type: "run" }
  | { type: "task"; value: string }
  | { type: "allow"; value: string }
  | { type: "verify-add"; value: string }
  | { type: "unknown"; name: string };

export function parseTuiCommand(input: string): TuiCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const firstSpace = trimmed.indexOf(" ");
  const name = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase();
  const value = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  switch (name) {
    case "help": return { type: "help" };
    case "quit":
    case "exit": return { type: "quit" };
    case "abort": return { type: "abort" };
    case "verify": return { type: "verify" };
    case "diff": return { type: "diff" };
    case "status": return { type: "status" };
    case "clear": return { type: "clear" };
    case "run": return { type: "run" };
    case "task": return { type: "task", value };
    case "allow": return { type: "allow", value };
    case "verify-add": return { type: "verify-add", value };
    default: return { type: "unknown", name };
  }
}

export const COMMAND_HELP = `Commands:
/task <objective>       Set the current task objective
/allow <glob>           Add an allowed changed-path glob
/verify-add <command>   Add a verification command
/run                    Run the current task objective
/verify                 Run verifiers without prompting the model
/diff                   Show changed files and diff statistics
/status                 Show task, model, session, and workspace state
/abort                  Abort the active model turn
/clear                  Clear the visible transcript only
/quit                   Exit safely

Enter text without a slash to send a coding instruction.`;
