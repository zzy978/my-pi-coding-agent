import { parseRunManifest, parseRunResult, sha256Json, sha256Text, type RunManifest } from "../evaluation/schema.js";
import type { RunBundle } from "../evaluation/store.js";
import { parseCandidateSnapshot, renderCandidatePrompt, type CandidateSnapshot } from "../experience/candidate.js";
import { isAllowedChangedPath } from "../policy/path-policy.js";
import { taskPolicyText } from "../policy/policy-extension.js";
import { formatTaskPrompt } from "../task/task-spec.js";
import { publicTask, type SweTask, type SweTrial } from "./swe-mini.js";

export type SweFrozenConfiguration = Pick<RunManifest, "task" | "agent" | "setup" | "policy" | "contextFiles" | "verifier">;
export interface SweCandidateProtocol {
  candidate: CandidateSnapshot;
  sourceTask: SweTask;
  tasks: Array<{ task: SweTask; image: string; imageId: string; configuration: SweFrozenConfiguration; configurationSha256: string }>;
  pairs: number;
}
export interface SweCandidateRunEvidence {
  taskId: string;
  pairIndex: number;
  arm: "control" | "treatment";
  runId: string;
  bundle: RunBundle;
  imageId: string;
  benchmark: {
    phase: "control" | "experience";
    instanceId: string;
    image: string;
    container: string;
    toolset: string;
    candidate: CandidateSnapshot | null;
    promptSha256: string;
    policySha256: string;
  };
  trial: SweTrial;
  score: { completed: boolean; resolved: boolean | null; emptyPatch?: boolean };
  modelPatch: string;
  modelPatchSha256: string;
}
export interface SweCandidateEvidence { runs: SweCandidateRunEvidence[]; integrityIssues: string[] }
export interface SweCandidateTaskAudit {
  taskId: string;
  completedPairs: number;
  pairedWins: number;
  pairedLosses: number;
  controlPassed: number;
  treatmentPassed: number;
  outcome: "incomplete" | "improved" | "regressed" | "unchanged";
}
export interface SweCandidateAudit {
  /** 只表示证据门槛通过，不执行或代表人工晋升。 */
  eligible: boolean;
  reasons: string[];
  tasks: SweCandidateTaskAudit[];
  totals: { runs: number; completedPairs: number; pairedWins: number; pairedLosses: number };
  usage: { knownTokens: number; knownCost: number; totalTokens: number | null; totalCost: number | null;
    input: number; output: number; cacheRead: number; cacheWrite: number };
}

export function sweRunConfiguration(manifest: RunManifest): SweFrozenConfiguration {
  return { task: manifest.task, agent: manifest.agent, ...(manifest.setup ? { setup: manifest.setup } : {}),
    policy: manifest.policy, contextFiles: manifest.contextFiles, verifier: manifest.verifier };
}

export function sweConfigurationSha256(manifest: RunManifest): string {
  return sha256Json(sweRunConfiguration(manifest));
}

function assertEvidence(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function problemIdentity(task: SweTask): string {
  return sha256Json([task.repo, task.problem_statement.trim().replace(/\s+/g, " ").toLowerCase()]);
}

export function assertSweCandidateProtocol(protocol: SweCandidateProtocol): void {
  parseCandidateSnapshot(protocol.candidate);
  publicTask(protocol.sourceTask);
  assertEvidence(Number.isInteger(protocol.pairs) && protocol.pairs >= 3 && protocol.pairs <= 20, "每题需要 3–20 对运行");
  assertEvidence(protocol.tasks.length >= 2 && protocol.tasks.length <= 20, "需要 2–20 道不同问题");
  const ids = new Set<string>(), problems = new Set<string>();
  let commonConfiguration: string | undefined;
  for (const frozen of protocol.tasks) {
    const task = publicTask(frozen.task);
    assertEvidence(task.repo === protocol.sourceTask.repo, "任务仓库与候选来源不同");
    assertEvidence(!ids.has(task.instance_id) && !problems.has(problemIdentity(task)), "重复问题不能作为跨任务证据");
    ids.add(task.instance_id); problems.add(problemIdentity(task));
    if (task.instance_id === protocol.sourceTask.instance_id) assertEvidence(sha256Json(task) === sha256Json(protocol.sourceTask), "来源任务内容漂移");
    assertEvidence(frozen.image.trim() && /^sha256:[a-f0-9]{64}$/.test(frozen.imageId), "缺少固定镜像身份");
    assertEvidence(frozen.configurationSha256 === sha256Json(frozen.configuration), "冻结配置哈希不匹配");
    const { task: configuredTask, verifier, agent, policy, setup, contextFiles } = frozen.configuration;
    const common = sha256Json({ verifier, agent, policy, setup, contextFiles });
    assertEvidence(commonConfiguration === undefined || commonConfiguration === common, "跨任务模型、工具或验证配置漂移");
    commonConfiguration = common;
    assertEvidence(agent.modelConfig, "缺少冻结模型上限与地址指纹");
    assertEvidence(configuredTask.content.id === task.instance_id && configuredTask.content.objective.includes(task.problem_statement.trim()), "配置未绑定公开任务");
    assertEvidence(verifier.commands.length === 1 && verifier.commands[0]?.command === "swebench-official-evaluation", "必须使用官方验证器");
    assertEvidence(agent.sessionMode === "ephemeral" && contextFiles.length === 0 && setup?.source === "disabled" && setup.commands.length === 0 && policy.allowShell, "配置不满足 SWE 独立执行约束");
  }
  assertEvidence(protocol.tasks.some(({ task }) => task.instance_id !== protocol.sourceTask.instance_id && problemIdentity(task) !== problemIdentity(protocol.sourceTask)), "缺少非来源问题");
}

export function assertSweCandidateRun(protocol: SweCandidateProtocol, run: SweCandidateRunEvidence): boolean {
  const frozen = protocol.tasks.find(({ task }) => task.instance_id === run.taskId);
  assertEvidence(frozen, "未知任务");
  assertEvidence(Number.isInteger(run.pairIndex) && run.pairIndex >= 0 && run.pairIndex < protocol.pairs, "配对索引越界");
  assertEvidence(run.arm === "control" || run.arm === "treatment", "未知实验臂");
  const manifest = parseRunManifest(run.bundle.manifest);
  const result = parseRunResult(run.bundle.result);
  assertEvidence(run.runId === manifest.runId && run.runId === result.runId && run.runId === run.trial.runId, "运行 ID 绑定不一致");
  assertEvidence(result.manifestSha256 === sha256Json(run.bundle.manifest), "结果的 manifest 哈希不匹配");
  assertEvidence(manifest.kind === "run" && !manifest.replayOf && !manifest.experiment && !manifest.replayable && !result.workspace.managedWorktree, "证据并非新鲜 SWE 容器运行");
  assertEvidence(manifest.baselineCommit === frozen.task.base_commit && result.workspace.baselineCommit === frozen.task.base_commit, "任务基线漂移");
  assertEvidence(sweConfigurationSha256(manifest) === frozen.configurationSha256, "运行配置漂移");
  const { benchmark, trial, score } = run;
  assertEvidence(benchmark.instanceId === run.taskId && trial.instanceId === run.taskId, "公开任务身份不一致");
  assertEvidence(benchmark.image === frozen.image && run.imageId === frozen.imageId && benchmark.container.trim(), "镜像或容器身份不一致");
  assertEvidence(benchmark.toolset === "isolated-bash" && benchmark.phase === (run.arm === "control" ? "control" : "experience"), "实验阶段或工具集漂移");
  const candidate = run.arm === "treatment" ? protocol.candidate : null;
  if (benchmark.candidate) parseCandidateSnapshot(benchmark.candidate);
  assertEvidence(sha256Json(candidate) === sha256Json(benchmark.candidate), "实验臂候选内容不一致");
  const base = formatTaskPrompt(manifest.task.content, manifest.task.content.objective);
  assertEvidence(benchmark.promptSha256 === sha256Text(candidate ? renderCandidatePrompt(base, candidate) : base), "实际提示哈希不匹配");
  assertEvidence(benchmark.policySha256 === sha256Text(taskPolicyText(manifest.task.content)), "策略提示哈希不匹配");
  assertEvidence(run.modelPatchSha256 === sha256Text(run.modelPatch), "模型补丁哈希不匹配");
  assertEvidence(result.status !== "execution_failed" && trial.executionError === null && !trial.evaluationError, "执行或评分基础设施失败");
  assertEvidence(score.completed && typeof score.resolved === "boolean" && trial.resolved === score.resolved, "官方评分不完整或与 trial 不一致");
  assertEvidence(!score.emptyPatch || !run.modelPatch.trim(), "空补丁标记不一致");
  const verification = result.verification;
  assertEvidence(verification?.configured && verification.commands.length === 1 && !verification.changeAuditUnavailable, "缺少完整验证证据");
  assertEvidence(!verification.disallowedChangedFiles.length && verification.changedFiles.every((file) => isAllowedChangedPath(file)), "检测到受保护文件修改");
  const command = verification.commands[0]!;
  assertEvidence(command.command === "swebench-official-evaluation" && command.status === (score.resolved ? "passed" : "failed") && command.exitCode === (score.resolved ? 0 : 1), "官方评分与验证命令不一致");
  const output: unknown = JSON.parse(command.stdout);
  assertEvidence(output && typeof output === "object" && "resolved" in output && output.resolved === score.resolved, "验证输出与官方评分不一致");
  const passed = result.status === "verification_passed";
  assertEvidence(passed === score.resolved && verification.success === passed, "实际运行状态与官方评分不一致");
  assertEvidence(trial.durationMs === result.durationMs && (trial.usage === null || sha256Json(trial.usage) === sha256Json(result.usage)), "trial 用量或耗时不一致");
  return passed;
}

export function auditSweCandidate(protocol: SweCandidateProtocol, evidence: SweCandidateEvidence): SweCandidateAudit {
  const reasons = [...evidence.integrityIssues];
  try { assertSweCandidateProtocol(protocol); } catch { reasons.push("冻结协议无效：任务、候选、镜像或配置未满足门槛"); }
  const slots = new Map<string, boolean>();
  const runIds = new Set<string>(), containers = new Set<string>(), seenSlots = new Set<string>();
  const usage: SweCandidateAudit["usage"] = { knownTokens: 0, knownCost: 0, totalTokens: null, totalCost: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let usageComplete = evidence.runs.length === protocol.tasks.length * protocol.pairs * 2;
  for (const run of evidence.runs) {
    const key = `${run.taskId}:${run.pairIndex}:${run.arm}`;
    const duplicateRun = runIds.has(run.runId);
    const duplicate = duplicateRun || containers.has(run.benchmark.container) || seenSlots.has(key);
    if (!duplicateRun) try {
      const result = parseRunResult(run.bundle.result);
      usage.knownTokens += result.usage.total; usage.knownCost += result.usage.cost;
      for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) usage[field] += result.usage[field];
      if (run.trial.usage === null || run.trial.usageComplete !== true || sha256Json(run.trial.usage) !== sha256Json(result.usage)) usageComplete = false;
    } catch { usageComplete = false; }
    runIds.add(run.runId); containers.add(run.benchmark.container); seenSlots.add(key);
    if (duplicate) { reasons.push(`重复运行、容器或槽位：${run.runId}`); usageComplete = false; slots.delete(key); continue; }
    try { slots.set(key, assertSweCandidateRun(protocol, run)); }
    catch { reasons.push(`运行证据无效或不完整：${run.runId}`); }
  }
  const tasks = protocol.tasks.map(({ task }): SweCandidateTaskAudit => {
    let completedPairs = 0, pairedWins = 0, pairedLosses = 0, controlPassed = 0, treatmentPassed = 0;
    // 无效协议的 pairs 不能触发无界循环。
    for (let pair = 0; pair < Math.min(Math.max(protocol.pairs, 0), 20); pair++) {
      const control = slots.get(`${task.instance_id}:${pair}:control`), treatment = slots.get(`${task.instance_id}:${pair}:treatment`);
      if (control === undefined || treatment === undefined) continue;
      completedPairs++; controlPassed += Number(control); treatmentPassed += Number(treatment);
      pairedWins += Number(!control && treatment); pairedLosses += Number(control && !treatment);
    }
    const outcome = completedPairs !== protocol.pairs ? "incomplete" : pairedLosses ? "regressed" : pairedWins ? "improved" : "unchanged";
    if (outcome === "incomplete") reasons.push(`配对证据不完整：${task.instance_id}`);
    if (pairedLosses) reasons.push(`存在配对退化：${task.instance_id}`);
    return { taskId: task.instance_id, completedPairs, pairedWins, pairedLosses, controlPassed, treatmentPassed, outcome };
  });
  const totals = { runs: runIds.size, completedPairs: 0, pairedWins: 0, pairedLosses: 0 };
  for (const task of tasks) for (const key of ["completedPairs", "pairedWins", "pairedLosses"] as const) totals[key] += task[key];
  if (!totals.pairedWins) reasons.push("未观察到候选带来的配对改善");
  if (usageComplete) { usage.totalTokens = usage.knownTokens; usage.totalCost = usage.knownCost; }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], tasks, totals, usage };
}
