import { resolve } from "node:path";
import type { ReviewMode } from "./experience/review.js";

export type LearningOptions =
  | { mode: "analyze"; runId: string; reviewMode?: ReviewMode; minSuccessToolCalls?: number; force?: boolean }
  | { mode: "list-experiences" | "list-experiments" | "list-promotions" }
  | { mode: "show-experience" | "show-experiment" | "show-review-comparison"; id: string }
  | { mode: "experiment"; runId: string; candidateId: string; pairs: number }
  | { mode: "promote"; candidateId: string; evidenceIds: string[]; approved: boolean }
  | { mode: "revoke"; candidateId: string; approved: boolean };

export interface CliOptions {
  workspace: string;
  task?: string;
  taskFile?: string;
  verifyCommands: string[];
  maxRepairAttempts?: number;
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
  diagnostics: boolean;
  help: boolean;
  version: boolean;
  learning?: LearningOptions;
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
  let maxRepairAttempts: number | undefined;
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
  let diagnostics = false;
  let help = false;
  let version = false;
  let learningFlag: string | undefined;
  let learningId: string | undefined;
  let candidateId: string | undefined;
  let pairs: number | undefined;
  const evidenceIds: string[] = [];
  let approved = false;
  let explicitWorkspace = false;
  let reviewMode: ReviewMode | undefined;
  let minSuccessToolCalls: number | undefined;
  let forceReview = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--cwd":
      case "-C":
        explicitWorkspace = true;
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
      case "--max-repair-attempts": {
        const value = takeValue(args, index, arg);
        if (maxRepairAttempts !== undefined || !/^[0-5]$/.test(value)) {
          throw new CliUsageError("--max-repair-attempts 必须为 0–5，且只能指定一次");
        }
        maxRepairAttempts = Number(value);
        index += 1;
        break;
      }
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
      case "--analyze-run":
      case "--show-experience":
      case "--show-review-comparison":
      case "--experiment":
      case "--show-experiment":
      case "--promote-candidate":
      case "--revoke-candidate":
      case "--list-experiences":
      case "--list-experiments":
      case "--list-promotions":
        if (learningFlag) throw new CliUsageError("Use only one experience/experiment command");
        learningFlag = arg;
        if (!arg.startsWith("--list-")) {
          learningId = takeValue(args, index, arg);
          index += 1;
        }
        break;
      case "--review-mode": {
        const value = takeValue(args, index, arg);
        if (reviewMode !== undefined || !["proposer", "critic", "compare"].includes(value)) throw new CliUsageError("--review-mode must be proposer, critic or compare, specified once");
        reviewMode = value as ReviewMode;
        index += 1;
        break;
      }
      case "--min-success-tool-calls": {
        const value = takeValue(args, index, arg);
        if (minSuccessToolCalls !== undefined || !/^\d+$/.test(value) || Number(value) > 10_000) throw new CliUsageError("--min-success-tool-calls must be between 0 and 10000, specified once");
        minSuccessToolCalls = Number(value);
        index += 1;
        break;
      }
      case "--force-review":
        if (forceReview) throw new CliUsageError("--force-review may only be specified once");
        forceReview = true;
        break;
      case "--candidate":
        if (candidateId) throw new CliUsageError("--candidate may only be specified once");
        candidateId = takeValue(args, index, arg);
        index += 1;
        break;
      case "--pairs": {
        const value = takeValue(args, index, arg);
        if (pairs !== undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20) {
          throw new CliUsageError("--pairs must be an integer between 1 and 20, specified once");
        }
        pairs = Number(value);
        index += 1;
        break;
      }
      case "--evidence":
        evidenceIds.push(takeValue(args, index, arg));
        index += 1;
        break;
      case "--approve":
        approved = true;
        break;
      case "--doctor":
        doctor = true;
        break;
      case "--diagnostics":
        diagnostics = true;
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
  if (positionalWorkspace && explicitWorkspace) {
    throw new CliUsageError("Use either a positional workspace or --cwd, not both");
  }
  if (positionalWorkspace) workspace = positionalWorkspace;
  const managementModes = [listRuns, Boolean(showRunId), Boolean(replayRunId)].filter(Boolean).length;
  if (maxRepairAttempts !== undefined && (managementModes || diagnostics || doctor || learningFlag)) {
    throw new CliUsageError("--max-repair-attempts 仅支持普通交互或新的 --record 任务");
  }
  if (diagnostics && (managementModes || record || doctor || learningFlag || task || taskFile || verifyCommands.length ||
    setupCommands.length || noSetup || allowedPaths.length || legacyInPlace || continueSession || noSession)) {
    throw new CliUsageError("--diagnostics 不能与执行参数或其他运行模式组合");
  }
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
  if ((candidateId || pairs !== undefined) && learningFlag !== "--experiment") {
    throw new CliUsageError("--candidate and --pairs require --experiment");
  }
  if (evidenceIds.length && learningFlag !== "--promote-candidate") throw new CliUsageError("--evidence requires --promote-candidate");
  if (approved && learningFlag !== "--promote-candidate" && learningFlag !== "--revoke-candidate") {
    throw new CliUsageError("--approve requires --promote-candidate or --revoke-candidate");
  }
  let learning: LearningOptions | undefined;
  if ((reviewMode !== undefined || minSuccessToolCalls !== undefined || forceReview) && learningFlag !== "--analyze-run") throw new CliUsageError("Review selection options require --analyze-run");
  if (learningFlag) {
    if (managementModes || record || doctor || task || taskFile || verifyCommands.length || setupCommands.length || noSetup ||
      allowedPaths.length || legacyInPlace || continueSession || noSession || shellExplicit) {
      throw new CliUsageError("Experience commands cannot be combined with other modes or execution overrides");
    }
    if ((positionalWorkspace || explicitWorkspace) && learningFlag !== "--list-promotions") {
      throw new CliUsageError("This command restores its repository from recorded evidence; do not pass a workspace");
    }
    switch (learningFlag) {
      case "--analyze-run": learning = { mode: "analyze", runId: learningId!, ...(reviewMode ? { reviewMode } : {}),
        ...(minSuccessToolCalls === undefined ? {} : { minSuccessToolCalls }), ...(forceReview ? { force: true } : {}) }; break;
      case "--show-review-comparison": learning = { mode: "show-review-comparison", id: learningId! }; break;
      case "--show-experience": learning = { mode: "show-experience", id: learningId! }; break;
      case "--show-experiment": learning = { mode: "show-experiment", id: learningId! }; break;
      case "--list-experiences": learning = { mode: "list-experiences" }; break;
      case "--list-experiments": learning = { mode: "list-experiments" }; break;
      case "--list-promotions": learning = { mode: "list-promotions" }; break;
      case "--experiment":
        if (!candidateId) throw new CliUsageError("--experiment requires --candidate");
        learning = { mode: "experiment", runId: learningId!, candidateId, pairs: pairs ?? 3 };
        break;
      case "--promote-candidate":
        if (!approved) throw new CliUsageError("--promote-candidate requires explicit human confirmation with --approve");
        if (!evidenceIds.length) throw new CliUsageError("--promote-candidate requires --evidence experiment IDs");
        learning = { mode: "promote", candidateId: learningId!, evidenceIds, approved };
        break;
      case "--revoke-candidate":
        if (!approved) throw new CliUsageError("--revoke-candidate requires explicit human confirmation with --approve");
        learning = { mode: "revoke", candidateId: learningId!, approved };
        break;
    }
  }
  const learningInspection = learning && ["list-experiences", "show-experience", "show-review-comparison", "list-experiments", "show-experiment", "list-promotions"].includes(learning.mode);
  if (json && !(diagnostics || listRuns || showRunId || learningInspection)) {
    throw new CliUsageError("--json requires --list-runs, --show-run, or a read-only experience/experiment inspection");
  }

  return {
    workspace: resolve(cwd, workspace),
    ...(task ? { task } : {}),
    ...(taskFile ? { taskFile: resolve(cwd, taskFile) } : {}),
    verifyCommands,
    ...(maxRepairAttempts === undefined ? {} : { maxRepairAttempts }),
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
    diagnostics,
    help,
    version,
    ...(learning ? { learning } : {})
  };
}
