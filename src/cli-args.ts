import { resolve } from "node:path";

export interface CliOptions {
  workspace: string;
  task?: string;
  taskFile?: string;
  verifyCommands: string[];
  allowedPaths: string[];
  continueSession: boolean;
  noSession: boolean;
  inPlace: boolean;
  doctor: boolean;
  help: boolean;
  version: boolean;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return value;
}

export function parseCliArgs(args: string[], cwd = process.cwd()): CliOptions {
  let workspace = cwd;
  let positionalWorkspace: string | undefined;
  let task: string | undefined;
  let taskFile: string | undefined;
  const verifyCommands: string[] = [];
  const allowedPaths: string[] = [];
  let continueSession = false;
  let noSession = false;
  let inPlace = false;
  let doctor = false;
  let help = false;
  let version = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--cwd":
      case "-C":
        workspace = takeValue(args, index, arg);
        index += 1;
        break;
      case "--task":
      case "-t":
        task = takeValue(args, index, arg);
        index += 1;
        break;
      case "--task-file":
        taskFile = takeValue(args, index, arg);
        index += 1;
        break;
      case "--verify":
        verifyCommands.push(takeValue(args, index, arg));
        index += 1;
        break;
      case "--allow":
        allowedPaths.push(takeValue(args, index, arg));
        index += 1;
        break;
      case "--continue":
      case "-c":
        continueSession = true;
        break;
      case "--no-session":
        noSession = true;
        break;
      case "--in-place":
        inPlace = true;
        break;
      case "--doctor":
        doctor = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--version":
      case "-v":
        version = true;
        break;
      default:
        if (arg?.startsWith("-")) throw new CliUsageError(`Unknown option: ${arg}`);
        if (positionalWorkspace) throw new CliUsageError(`Unexpected argument: ${arg}`);
        positionalWorkspace = arg;
    }
  }

  if (task && taskFile) throw new CliUsageError("Use either --task or --task-file, not both");
  if (continueSession && noSession) throw new CliUsageError("--continue cannot be combined with --no-session");
  if (positionalWorkspace && workspace !== cwd) {
    throw new CliUsageError("Use either a positional workspace or --cwd, not both");
  }
  if (positionalWorkspace) workspace = positionalWorkspace;

  return {
    workspace: resolve(cwd, workspace),
    ...(task ? { task } : {}),
    ...(taskFile ? { taskFile: resolve(cwd, taskFile) } : {}),
    verifyCommands,
    allowedPaths,
    continueSession,
    noSession,
    inPlace,
    doctor,
    help,
    version
  };
}
