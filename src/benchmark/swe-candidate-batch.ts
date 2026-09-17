import { cp, lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { readModelConfig } from "../model-config.js";
import { sha256Json, sha256Text } from "../evaluation/schema.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { loadRunBundle, writeJsonAtomic } from "../evaluation/store.js";
import { loadCandidate, loadExperience } from "../experience/store.js";
import { parseCandidateSnapshot } from "../experience/candidate.js";
import { ensureDataDirectories } from "../runtime/data-dir.js";
import { EVALUATOR_IMAGE } from "./swe-container.js";
import { docker } from "./swe-process.js";
import { publicTask, type SweTask } from "./swe-mini.js";
import { runSweTask, recoverTrial } from "./swe-run.js";
import { assertSweCandidateProtocol, assertSweCandidateRun, auditSweCandidate, sweRunConfiguration, sweConfigurationSha256, type SweCandidateProtocol, type SweCandidateRunEvidence } from "./swe-candidate-evidence.js";
import { executeCandidatePairs, type CandidateBatch, type CandidateSlot } from "./swe-candidate-state.js";
import { assertRuntimeEntry, sealFiles, treeFiles, verifyFiles, type FileSeal } from "./swe-candidate-storage.js";
import { ensureCandidatePreflight, verifyCandidatePreflight } from "./swe-candidate-preflight.js";

interface Selection { benchmarkRoot: string; instanceId: string; sourceRunId: string }
export interface AuditRequest {
  root: string; sourceData: string; candidateId: string; tasks: Selection[];
  selectionReason: string;
}
interface Protocol extends SweCandidateProtocol {
  version: 1; kind: "swe-single-candidate-audit"; createdAt: string; selectionReason: string;
  sourceExperienceId: string; sourceRunId: string; sourceFiles: FileSeal;
  runtimeFiles: FileSeal; runtimeSha256: string; evaluatorImageId: string;
  images: Record<string, string>;
}
interface Binding { slot: CandidateSlot; runId: string; files: FileSeal; imageId: string; missing: string[] }
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function exclusiveJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

/** 准备不调用模型；原始记录只读，执行源码及实际依赖复制到新快照。 */
export async function prepareCandidateAudit(request: AuditRequest): Promise<string> {
  const root = resolve(request.root);
  if (request.tasks.length !== 2) throw new Error("This audit requires exactly two preselected tasks");
  const candidate = await loadCandidate(request.candidateId, resolve(request.sourceData));
  const experience = await loadExperience(candidate.sourceExperienceId, resolve(request.sourceData));
  const original = await loadRunBundle(candidate.sourceRunId, resolve(request.sourceData));
  if (!original.result || !experience.candidates.some((entry) => sha256Json(entry) === sha256Json(candidate))) throw new Error("Source candidate binding failed");
  if (experience.sourceRunId !== original.manifest.runId || experience.sourceManifestSha256 !== sha256Json(original.manifest) ||
    experience.sourceResultSha256 !== sha256Json(original.result) || experience.taskSha256 !== original.manifest.task.sha256) throw new Error("Experience source evidence hashes mismatch");
  const selected = await Promise.all(request.tasks.map(async (selection) => {
    const source = resolve(selection.benchmarkRoot);
    const catalog = await json<{ tasks: Array<SweTask & { image: string }> }>(join(source, "catalog.json"));
    const task = catalog.tasks.find((task) => task.instance_id === selection.instanceId);
    if (!task) throw new Error("Task missing from source catalog");
    const privateTask = await json<unknown>(join(source, "private", `${task.instance_id}.json`));
    if (sha256Json(publicTask(privateTask)) !== sha256Json(publicTask(task))) throw new Error("Private scoring task differs from public task");
    const run = await loadRunBundle(selection.sourceRunId, join(source, "agent-data"));
    const images = await json<Record<string, string>>(join(source, "images.json"));
    if (run.manifest.task.content.id !== task.instance_id || run.manifest.baselineCommit !== task.base_commit) throw new Error("Task source run mismatch");
    const image = images[task.instance_id];
    if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Task image missing");
    return { source, task, run, image };
  }));
  const sourceEntry = selected.find((entry) => entry.run.manifest.runId === candidate.sourceRunId);
  if (!sourceEntry) throw new Error("A must be the actual source task/run of this candidate");
  if (sha256Json(sourceEntry.run.manifest) !== sha256Json(original.manifest) || sha256Json(sourceEntry.run.result) !== sha256Json(original.result)) throw new Error("Source run content mismatch");
  const frozenTasks = selected.map(({ task, run, image }) => {
    const configuration = sweRunConfiguration(run.manifest);
    return { task: publicTask(task), image, imageId: image, configuration, configurationSha256: sha256Json(configuration) };
  });
  const draft: SweCandidateProtocol = { candidate: parseCandidateSnapshot(candidate), sourceTask: publicTask(sourceEntry.task), tasks: frozenTasks, pairs: 3 };
  assertSweCandidateProtocol(draft);
  await mkdir(root); // Existing output is never overwritten.
  await mkdir(join(root, "private")); await mkdir(join(root, "sources")); await mkdir(join(root, "bindings"));
  await cp(join(resolve(request.sourceData), "experiences", candidate.sourceExperienceId), join(root, "sources", "experience"), { recursive: true, errorOnExist: true, force: false });
  await exclusiveJson(join(root, "sources", "candidate.json"), candidate);
  for (const { source, task, run } of selected) {
    await cp(join(source, "private", `${task.instance_id}.json`), join(root, "private", `${task.instance_id}.json`), { errorOnExist: true, force: false });
    await exclusiveJson(join(root, "sources", `${task.instance_id}.manifest.json`), run.manifest);
    await exclusiveJson(join(root, "sources", `${task.instance_id}.result.json`), run.result);
  }
  const images = Object.fromEntries(selected.map(({ task, image }) => [task.instance_id, image]));
  await exclusiveJson(join(root, "images.json"), images);
  await exclusiveJson(join(root, "catalog.json"), { tasks: selected.map(({ task }) => task) });
  const runtime = join(root, "runtime"); await mkdir(runtime);
  for (const folder of ["src", "benchmarks/swe-mini", "node_modules"]) {
    console.log(`SNAPSHOT ${folder}`);
    await cp(resolve(folder), join(runtime, folder), { recursive: true, errorOnExist: true, force: false });
  }
  for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) await cp(resolve(file), join(runtime, file), { errorOnExist: true, force: false });
  console.log("HASH runtime");
  const runtimeFiles = await sealFiles(runtime, await treeFiles(runtime));
  const sourcePaths = ["images.json", "catalog.json", ...(await treeFiles(root, "sources")), ...(await treeFiles(root, "private"))];
  const sourceFiles = await sealFiles(root, sourcePaths);
  const sourceProtocol = await json<{ evaluator: string }>(join(sourceEntry.source, "protocol.json"));
  const protocol: Protocol = { ...draft, version: 1, kind: "swe-single-candidate-audit", createdAt: new Date().toISOString(),
    selectionReason: request.selectionReason, sourceExperienceId: candidate.sourceExperienceId, sourceRunId: candidate.sourceRunId,
    sourceFiles, runtimeFiles, runtimeSha256: sha256Json(runtimeFiles), evaluatorImageId: sourceProtocol.evaluator, images };
  await exclusiveJson(join(root, "protocol.json"), protocol);
  const batch: CandidateBatch = { version: 1, protocolSha256: sha256Json(protocol), status: "ready", trials: [], current: null };
  await exclusiveJson(join(root, "batch.json"), batch);
  await ensureDataDirectories(join(root, "agent-data"));
  return root;
}

async function readProtocol(root: string): Promise<{ protocol: Protocol; batch: CandidateBatch }> {
  const protocol = await json<Protocol>(join(root, "protocol.json"));
  const batch = await json<CandidateBatch>(join(root, "batch.json"));
  if (protocol.version !== 1 || protocol.kind !== "swe-single-candidate-audit" || batch.protocolSha256 !== sha256Json(protocol) ||
    protocol.runtimeSha256 !== sha256Json(protocol.runtimeFiles)) throw new Error("Frozen protocol hash mismatch");
  assertSweCandidateProtocol(protocol);
  return { protocol, batch };
}

async function integrity(root: string, protocol: Protocol): Promise<string[]> {
  const issues = [...await verifyFiles(root, protocol.sourceFiles), ...await verifyFiles(join(root, "runtime"), protocol.runtimeFiles)];
  const actual = await treeFiles(join(root, "runtime"));
  if (sha256Json(actual.sort()) !== sha256Json(Object.keys(protocol.runtimeFiles).sort())) issues.push("执行快照出现额外或缺失文件");
  return issues;
}

async function sealRun(root: string, slot: CandidateSlot, runId: string, imageId: string): Promise<void> {
  const names = ["manifest.json", "result.json", "benchmark.json", "trial.json", "model.patch", "verification.json", "trace.jsonl"];
  const present: string[] = [], missing: string[] = [];
  for (const file of [...names.map((name) => `agent-data/runs/${runId}/${name}`), `${runId}.score.json`, `${runId}.patch`]) {
    try { await lstat(join(root, file)); present.push(file); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") missing.push(file); else throw error; }
  }
  const files = await sealFiles(root, present);
  await exclusiveJson(join(root, "bindings", `${runId}.json`), { slot, runId, imageId, files, missing } satisfies Binding);
}

export async function auditCandidateBatch(rootInput: string): Promise<ReturnType<typeof auditSweCandidate>> {
  const root = resolve(rootInput); const { protocol, batch } = await readProtocol(root);
  const issues = await integrity(root, protocol); const runs: SweCandidateRunEvidence[] = [];
  issues.push(...await verifyCandidatePreflight(root, batch.protocolSha256, protocol.tasks.map((entry) => entry.task)));
  try { issues.push(...await json<string[]>(join(root, "runtime-issues.json"))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const entries = [...batch.trials];
  if (batch.current?.runId && !entries.some((entry) => entry.trial.runId === batch.current?.runId)) {
    try { const trial = await recoverTrial(join(root, "agent-data"), batch.current.runId); entries.push({ ...batch.current, trial }); }
    catch { issues.push(`未完成请求用量未知：${batch.current.runId}`); }
  }
  for (const entry of entries) {
    const { runId } = entry.trial;
    try {
      let binding: Binding;
      try { binding = await json<Binding>(join(root, "bindings", `${runId}.json`)); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        issues.push(`运行尚未完整封存：${runId}`);
        binding = { slot: { taskId: entry.taskId, pairIndex: entry.pairIndex, arm: entry.arm }, runId,
          imageId: protocol.images[entry.taskId] ?? "", files: {}, missing: [`${runId}.score.json`, `${runId}.patch`] };
      }
      if (binding.runId !== runId || sha256Json(binding.slot) !== sha256Json({ taskId: entry.taskId, pairIndex: entry.pairIndex, arm: entry.arm })) throw new Error("Slot binding mismatch");
      issues.push(...await verifyFiles(root, binding.files));
      issues.push(...binding.missing.map((file) => `运行缺少产物：${file}`));
      const directory = join(root, "agent-data", "runs", runId);
      const bundle = await loadRunBundle(runId, join(root, "agent-data"));
      const trial = await recoverTrial(join(root, "agent-data"), runId);
      if (sha256Json(trial) !== sha256Json(entry.trial)) throw new Error("Trial checkpoint mismatch");
      const modelPatch = await readFile(join(directory, "model.patch"), "utf8");
      const scoredPatch = `${runId}.patch`;
      if (!binding.missing.includes(scoredPatch) && modelPatch !== await readFile(join(root, scoredPatch), "utf8")) throw new Error("Scored patch differs from model patch");
      // Existing tests are human-reviewed rather than silently counted as valid verifier evidence.
      if (/^diff --git a\/(?:tests?\/|.*\/tests?\/)/m.test(modelPatch)) issues.push(`需检查测试文件改动：${runId}`);
      runs.push({ taskId: entry.taskId, pairIndex: entry.pairIndex, arm: entry.arm, runId, bundle,
        benchmark: await json(join(directory, "benchmark.json")), trial,
        score: binding.missing.includes(`${runId}.score.json`) ? { completed: false, resolved: null } : await json(join(root, `${runId}.score.json`)),
        imageId: binding.imageId, modelPatch, modelPatchSha256: binding.files[`agent-data/runs/${runId}/model.patch`] ?? "" });
    } catch (error) { issues.push(`${runId}：${error instanceof Error ? error.message : String(error)}`); }
  }
  if (batch.current) issues.push("存在未完成运行，不能排除已付费请求");
  const audit = auditSweCandidate(protocol, { runs, integrityIssues: issues });
  await writeJsonAtomic(join(root, "audit.json"), { ...audit, reviewedAt: new Date().toISOString(), protocolSha256: batch.protocolSha256,
    promotionExecuted: false, legacyPromotionCliCompatible: false,
    limitation: "SWE 独立证据审核不创建本地 Git worktree 晋升事件；该证据不能直接传入旧 --promote-candidate。" });
  await writeFile(join(root, "report.md"), `# 单候选 A＋B 资格审核\n\n候选：${protocol.candidate.id}。\n\n${protocol.selectionReason}\n\nSWE 证据门槛：${audit.eligible ? "满足" : "未满足"}。人工晋升：未执行。\n\n| 任务 | 完整配对 | 改善 | 退化 | 结果 |\n| --- | ---: | ---: | ---: | --- |\n${audit.tasks.map((t) => `| ${t.taskId} | ${t.completedPairs}/${protocol.pairs} | ${t.pairedWins} | ${t.pairedLosses} | ${t.outcome} |`).join("\n")}\n\n${audit.reasons.map((r) => `- ${r}`).join("\n")}\n\n实际已记录运行：${audit.totals.runs}。已知 Token：${audit.usage.knownTokens}；已知 SDK 费用：${audit.usage.knownCost}。未知用量不按零计算，SDK 费用不等于账单。\n\n每题三对是工程门槛，不能证明稳定泛化。SWE 审核不创建本地 Git 晋升事件，也不能直接传入旧 --promote-candidate；无论成绩如何，本报告都不是已晋升证明。\n\n原始证据在 agent-data/runs、bindings 及各运行 score.json；protocol.json 固定候选、任务、配置与镜像。\n`);
  return audit;
}

export async function runCandidateBatch(rootInput: string): Promise<void> {
  const root = resolve(rootInput); const lockPath = join(root, ".lock"); const lock = await open(lockPath, "wx");
  await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), owner: randomUUID() }));
  try {
    const { protocol, batch } = await readProtocol(root);
    await assertRuntimeEntry(root, import.meta.url, process.cwd());
    const assertFrozen = async () => {
      const issues = await integrity(root, protocol);
      if (issues.length) throw new Error(issues.join("; "));
      for (const [taskId, image] of Object.entries(protocol.images)) {
        const catalog = await json<{ tasks: Array<SweTask & { image: string }> }>(join(root, "catalog.json"));
        const tag = catalog.tasks.find((task) => task.instance_id === taskId)?.image;
        if (!tag || (await docker(["image", "inspect", "--format", "{{.Id}}", tag])).stdout.trim() !== image) throw new Error(`Image drift: ${taskId}`);
      }
      if ((await docker(["image", "inspect", "--format", "{{.Id}}", EVALUATOR_IMAGE])).stdout.trim() !== protocol.evaluatorImageId) throw new Error("Evaluator image drift");
    };
    await assertFrozen();
    const model = protocol.tasks[0]!.configuration.agent;
    const limits = model.modelConfig;
    if (!limits || limits.taskTimeoutMs <= 0) throw new Error("Missing finite recorded model limits");
    const local = readModelConfig();
    if (local.provider !== model.model.provider || local.modelId !== model.model.id || !local.baseUrl || sha256Text(local.baseUrl) !== limits.baseUrlSha256) throw new Error("Configured model or endpoint differs from frozen source");
    const config = { ...local, requestTimeoutMs: limits.requestTimeoutMs, maxOutputTokens: limits.maxOutputTokens, taskTimeoutMs: limits.taskTimeoutMs };
    const data = join(root, "agent-data"); process.env.PI_TUI_AGENT_DATA_DIR = data;
    await ensureCandidatePreflight(root, batch.protocolSha256, protocol.tasks.map((entry) => entry.task));
    const save = async () => { await writeJsonAtomic(join(root, "batch.json"), batch); };
    await executeCandidatePairs(protocol.tasks.map((entry) => entry.task.instance_id), protocol.pairs, batch, { save,
      recover: async (slot) => {
        let binding: Binding;
        try { binding = await json<Binding>(join(root, "bindings", `${slot.runId}.json`)); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          const checkpoint = await json<{ slot: CandidateSlot; runId: string; protocolSha256: string }>(join(root, "bindings", `${slot.runId}.started.json`));
          if (checkpoint.runId !== slot.runId || checkpoint.protocolSha256 !== batch.protocolSha256 || sha256Json(checkpoint.slot) !== sha256Json({ taskId: slot.taskId, pairIndex: slot.pairIndex, arm: slot.arm })) throw new Error("Unsealed recovery start mismatch");
          const bundle = await loadRunBundle(slot.runId, data); const frozen = protocol.tasks.find((entry) => entry.task.instance_id === slot.taskId)!;
          if (!bundle.result || sweConfigurationSha256(bundle.manifest) !== frozen.configurationSha256) throw new Error("Incomplete recovery evidence");
          await recoverTrial(data, slot.runId); // Must be complete; never rerun an unknown model call.
          await sealRun(root, checkpoint.slot, slot.runId, frozen.imageId);
          binding = await json<Binding>(join(root, "bindings", `${slot.runId}.json`));
        }
        if (sha256Json(binding.slot) !== sha256Json({ taskId: slot.taskId, pairIndex: slot.pairIndex, arm: slot.arm })) throw new Error("Recovery slot mismatch");
        const issues = await verifyFiles(root, binding.files); if (issues.length) throw new Error(issues.join("; "));
        return recoverTrial(data, slot.runId);
      },
      run: async (slot, started) => {
        await assertFrozen();
        const preflightIssues = await verifyCandidatePreflight(root, batch.protocolSha256, protocol.tasks.map((entry) => entry.task));
        if (preflightIssues.length) throw new Error(preflightIssues.join("; "));
        const frozen = protocol.tasks.find((entry) => entry.task.instance_id === slot.taskId)!;
        console.log(`START ${slot.taskId} pair=${slot.pairIndex + 1} ${slot.arm}`);
        const trial = await runSweTask({ task: frozen.task, image: frozen.imageId, root, data, config,
          phase: slot.arm === "control" ? "control" : "experience", candidate: slot.arm === "treatment" ? protocol.candidate : null,
          expectedConfigurationSha256: frozen.configurationSha256,
          started: async (runId) => {
            await exclusiveJson(join(root, "bindings", `${runId}.started.json`), { slot, runId, protocolSha256: batch.protocolSha256 });
            await started(runId);
          } });
        await sealRun(root, slot, trial.runId, frozen.imageId);
        if (trial.executionError === null && trial.evaluationError == null && trial.resolved !== null) {
          const directory = join(data, "runs", trial.runId);
          const binding = await json<Binding>(join(root, "bindings", `${trial.runId}.json`));
          assertSweCandidateRun(protocol, { ...slot, runId: trial.runId, bundle: await loadRunBundle(trial.runId, data),
            imageId: frozen.imageId, trial, benchmark: await json(join(directory, "benchmark.json")),
            score: await json(join(root, `${trial.runId}.score.json`)), modelPatch: await readFile(join(directory, "model.patch"), "utf8"),
            modelPatchSha256: binding.files[`agent-data/runs/${trial.runId}/model.patch`] ?? "" });
        }
        console.log(`RESULT ${slot.taskId} pair=${slot.pairIndex + 1} ${slot.arm} resolved=${trial.resolved} run=${trial.runId}`);
        return trial;
      }
    });
  } catch (error) {
    await writeJsonAtomic(join(root, "runtime-issues.json"), [redactSensitiveText(error instanceof Error ? error.message : String(error))]);
    throw error;
  } finally {
    await lock.close(); await unlink(lockPath);
    await auditCandidateBatch(root);
  }
}
