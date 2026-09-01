import { resolve } from "node:path";

export interface CliOptions {
  workspace: string;
  task?: string;
  taskFile?: string;
  verifyCommands: string[];
  setupCommands: string[];
  noSetup: boolean;
  allowedPaths: string[];
  continueSession: boolean;
  noSession: boolean;
  shellEnabled: boolean;
  shellExplicit: boolean;
  record: boolean;
  listRuns: boolean;
  showRunId?: string;
  replayRunId?: string;
  json: boolean;
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
  const setupCommands: string[] = [];
  let noSetup = false;
  const allowedPaths: string[] = [];
  let continueSession = false;
  let noSession = false;
  let legacyInPlace = false;
  let shellEnabled = true;
  let shellExplicit = false;
  let record = false;
  let listRuns = false;
  let showRunId: string | undefined;
  let replayRunId: string | undefined;
  let json = false;
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
      case "--setup":
        setupCommands.push(takeValue(args, index, arg));
        index += 1;
        break;
      case "--no-setup":
        noSetup = true;
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
        legacyInPlace = true;
        break;
      case "--unsafe-shell":
        if (shellExplicit && !shellEnabled) throw new CliUsageError("Use either --unsafe-shell or --no-shell, not both");
        shellEnabled = true;
        shellExplicit = true;
        break;
      case "--no-shell":
        if (shellExplicit && shellEnabled) throw new CliUsageError("Use either --unsafe-shell or --no-shell, not both");
        shellEnabled = false;
        shellExplicit = true;
        break;
      case "--record":
        record = true;
        break;
      case "--list-runs":
        listRuns = true;
        break;
      case "--show-run":
        showRunId = takeValue(args, index, arg);
        index += 1;
        break;
      case "--replay":
        replayRunId = takeValue(args, index, arg);
        index += 1;
        break;
      case "--json":
        json = true;
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
  const managementModes = [listRuns, Boolean(showRunId), Boolean(replayRunId)].filter(Boolean).length;
  if (managementModes > 1) throw new CliUsageError("Use only one of --list-runs, --show-run, or --replay");
  if (record && managementModes > 0) throw new CliUsageError("--record cannot be combined with run management options");
  if (noSetup && setupCommands.length > 0) throw new CliUsageError("--setup cannot be combined with --no-setup");
  if (record && !task && !taskFile) throw new CliUsageError("--record requires --task or --task-file");
  if (record && (legacyInPlace || continueSession)) throw new CliUsageError("--record requires a fresh managed worktree");
  if (replayRunId && (positionalWorkspace || workspace !== cwd || task || taskFile || verifyCommands.length || setupCommands.length || noSetup || allowedPaths.length || legacyInPlace || continueSession || noSession)) {
    throw new CliUsageError("--replay restores workspace and TaskSpec from the manifest; only a Shell override may be added");
  }
  if ((listRuns || showRunId) && (record || task || taskFile || verifyCommands.length || setupCommands.length || noSetup || allowedPaths.length || legacyInPlace || continueSession || noSession || shellExplicit)) {
    throw new CliUsageError("Run listing and inspection cannot be combined with execution options");
  }
  if (json && !(listRuns || showRunId)) throw new CliUsageError("--json requires --list-runs or --show-run");

  return {
    workspace: resolve(cwd, workspace),
    ...(task ? { task } : {}),
    ...(taskFile ? { taskFile: resolve(cwd, taskFile) } : {}),
    verifyCommands,
    setupCommands,
    noSetup,
    allowedPaths,
    continueSession,
    noSession,
    shellEnabled,
    shellExplicit,
    record,
    listRuns,
    ...(showRunId ? { showRunId } : {}),
    ...(replayRunId ? { replayRunId } : {}),
    json,
    doctor,
    help,
    version
  };
}
