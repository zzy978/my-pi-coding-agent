import { mkdir, open, readFile, readdir, statfs, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Json, sha256Text } from "../evaluation/schema.js";
import { loadRunBundle, writeJsonAtomic } from "../evaluation/store.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { stripUnsafeControls } from "../experience/candidate.js";
import { analyzeRun } from "../experience/service.js";
import { candidateIndexPath, loadSearchIndex, toRetrievalEntry } from "../experience/retrieval-index.js";
import { readModelConfig, type ModelConfig } from "../model-config.js";
import { ensureDataDirectories } from "../runtime/data-dir.js";
import { docker } from "./swe-process.js";
import { EVALUATOR_IMAGE, prepareImages, preflightTasks } from "./swe-container.js";
import { recoverTrial, runSweTask } from "./swe-run.js";
import { publicTask, type SweTask, type SweTrial } from "./swe-mini.js";
import { assertVerifiedCoverage, executeVerifiedTasks, experienceSkipReason, selectDiverseTasks, VERIFIED_REVISION, VERIFIED_SEED,
  type VerifiedState, type VerifiedSynthesis } from "./swe-verified.js";

interface Catalog { dataset: string; revision: string; seed: string; tasks: Array<SweTask & { image: string }> }
const safeError = (error: unknown) => stripUnsafeControls(redactSensitiveText(error instanceof Error ? error.message : String(error))).slice(0, 2000);
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function optionalJson<T>(path: string): Promise<T | null> {
  try { return await json<T>(path); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
async function sourceFingerprint(): Promise<string> {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (/\.(ts|py)$/.test(item.name)) files[path] = sha256Text(await readFile(path, "utf8"));
    }
  };
  await walk("src"); await walk("benchmarks/swe-mini");
  files["package-lock.json"] = sha256Text(await readFile("package-lock.json", "utf8"));
  return sha256Json(files);
}
async function checkDisk(root: string): Promise<void> {
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize < 15 * 1024 ** 3) throw new Error("Disk free space below 15 GiB; paused before next image/model request");
}

export async function analyzeVerifiedTrial(trial: SweTrial, data: string, config: ModelConfig): Promise<VerifiedSynthesis> {
  const source = await loadRunBundle(trial.runId, data);
  if (!source.result || source.manifest.task.content.id !== trial.instanceId) throw new Error("Missing or mismatched trial evidence");
  const skip = experienceSkipReason({ resolved: trial.resolved, executionError: trial.executionError, toolCallCount: source.result.toolCallCount });
  if (skip) return { status: skip, experienceId: null, candidateIds: [], usage: null };
  const experience = await analyzeRun(trial.runId, data, { reviewMode: "proposer", minSuccessToolCalls: 6, modelConfig: config });
  const indexes = await Promise.all(experience.candidates.map(async (candidate) => {
    try {
      const index = await loadSearchIndex(toRetrievalEntry(candidate), candidateIndexPath(candidate, data));
      return { candidateId: candidate.id, status: index?.status ?? "missing", usage: index?.usage ?? null };
    } catch { return { candidateId: candidate.id, status: "unavailable", usage: null }; }
  }));
  return { status: experience.synthesis.status, experienceId: experience.id, candidateIds: experience.candidates.map((candidate) => candidate.id),
    usage: experience.synthesis.usage ?? null, indexes };
}

export async function runVerifiedCli(args: string[]): Promise<void> {
  const mode = args[0] ?? "status";
  if (!["catalog", "run", "status"].includes(mode) || args.length !== 2 || args[1]!.startsWith("--")) throw new Error("Usage: benchmark:swe-verified -- catalog|run|status <new-batch-root>");
  const root = resolve(args[1]!), data = join(root, "agent-data"), statePath = join(root, "batch.json");
  if (mode === "status") {
    console.log(JSON.stringify(await optionalJson<VerifiedState>(statePath) ?? { status: "not-started" }, null, 2)); return;
  }
  await mkdir(root, { recursive: true });
  const lockPath = join(root, "batch.lock"), lock = await open(lockPath, "wx");
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    if (mode === "catalog") {
      const rows = await json<unknown[]>(join(root, "dataset-private.json"));
      const excluded = (await json<{ tasks: unknown[] }>(join(root, "excluded.json"))).tasks.map(publicTask);
      const tasks = selectDiverseTasks(rows, excluded);
      assertVerifiedCoverage(tasks);
      const selection = { dataset: "princeton-nlp/SWE-bench_Verified", revision: VERIFIED_REVISION, seed: VERIFIED_SEED,
        excludedSha256: sha256Json(excluded), tasks };
      const prior = await optionalJson<unknown>(join(root, "selection.json"));
      if (prior && sha256Json(prior) !== sha256Json(selection)) throw new Error("Frozen selection drift");
      if (!prior) await writeJsonAtomic(join(root, "selection.json"), selection);
      await docker(["run", "--rm", "--entrypoint", "python", "--mount", `type=bind,source=${resolve("benchmarks/swe-mini")},target=/bridge,readonly`,
        "--mount", `type=bind,source=${root},target=/data`, EVALUATOR_IMAGE, "/bridge/selected.py"], { timeoutMs: 120_000 });
      const counts: Record<string, number> = {};
      for (const task of tasks) counts[task.repo] = (counts[task.repo] ?? 0) + 1;
      await writeFile(join(root, "tasks.md"), `# SWE-Verified 50题任务清单\n\n固定种子：${VERIFIED_SEED}。排除历史题目，按仓库均衡轮转；仅一轮无经验运行。\n\n| 仓库 | 题数 |\n| --- | ---: |\n${Object.entries(counts).map(([repo, count]) => `| ${repo} | ${count} |`).join("\n")}\n\n| 序号 | 仓库 | 任务 |\n| ---: | --- | --- |\n${tasks.map((task, index) => `| ${index + 1} | ${task.repo} | ${task.instance_id} |`).join("\n")}\n`);
      console.log(JSON.stringify({ selected: tasks.length, repositories: counts })); return;
    }
    const catalog = await json<Catalog>(join(root, "catalog.json"));
    const selection = await json<{ tasks: SweTask[]; excludedSha256: string }>(join(root, "selection.json"));
    const tasks = catalog.tasks.map(publicTask);
    assertVerifiedCoverage(tasks);
    if (catalog.dataset !== "princeton-nlp/SWE-bench_Verified" || catalog.revision !== VERIFIED_REVISION || tasks.length !== 50 ||
      new Set(tasks.map((task) => task.instance_id)).size !== 50 || sha256Json(tasks) !== sha256Json(selection.tasks)) throw new Error("Invalid Verified catalog/selection binding");
    const config = readModelConfig();
    if (!config.provider || !config.modelId) throw new Error("Explicit configured provider/model required");
    const privateHashes = Object.fromEntries(await Promise.all(tasks.map(async (task) => [task.instance_id, sha256Text(await readFile(join(root, "private", `${task.instance_id}.json`), "utf8"))] as const)));
    const protocol = { version: 1, kind: "verified-diverse50-single-round", catalogSha256: sha256Json(catalog), selectionSha256: sha256Json(selection), privateHashes,
      sourceSha256: await sourceFingerprint(), evaluator: (await docker(["image", "inspect", "--format", "{{.Id}}", EVALUATOR_IMAGE])).stdout.trim(),
      model: { provider: config.provider, id: config.modelId, baseUrlSha256: sha256Text(config.baseUrl ?? "provider-default"), requestTimeoutMs: config.requestTimeoutMs,
        maxOutputTokens: config.maxOutputTokens, taskTimeoutMs: config.taskTimeoutMs, synthesisTimeoutMs: config.synthesisTimeoutMs, synthesisMaxOutputTokens: config.synthesisMaxOutputTokens },
      thinkingLevel: "high", tools: ["bash"], candidate: null, taskExecutions: 50,
      reviewMode: "proposer", minSuccessToolCalls: 6, strictSuccessMinimum: true, recoveryException: false, critic: false,
      imageSource: "ghcr.io/epoch-research", imageBinding: "images.json and per-run benchmark.json", minimumFreeGiB: 15 };
    const fingerprint = sha256Json(protocol), protocolPath = join(root, "protocol.json");
    const priorProtocol = await optionalJson<unknown>(protocolPath);
    if (priorProtocol && sha256Json(priorProtocol) !== fingerprint) throw new Error("Protocol drift; refusing to mix paid runs");
    let state = await optionalJson<VerifiedState>(statePath);
    if (!state) {
      if (priorProtocol) throw new Error("Missing batch state for existing protocol; refusing paid retry");
      let existingRuns: string[] = [];
      try { existingRuns = await readdir(join(data, "runs")); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      if (existingRuns.length) throw new Error("Existing run evidence without batch state; refusing paid retry");
    }
    if (state && (!priorProtocol || state.fingerprint !== fingerprint || state.schemaVersion !== 1)) throw new Error("Invalid state/protocol binding");
    if (!priorProtocol) await writeJsonAtomic(protocolPath, protocol);
    state ??= { schemaVersion: 1, fingerprint, status: "ready", trials: [], synthesis: {}, current: null };
    const batch = state;
    await ensureDataDirectories(data);
    const save = async () => {
      await writeJsonAtomic(statePath, batch);
      const synthesis = Object.values(batch.synthesis), indexes = synthesis.flatMap((item) => item.indexes ?? []);
      const summary = { status: batch.status, taskCount: 50, completed: batch.trials.length, scored: batch.trials.filter((trial) => trial.resolved !== null).length,
        passed: batch.trials.filter((trial) => trial.resolved === true).length, experiences: synthesis.filter((item) => item.experienceId).length,
        candidates: synthesis.reduce((sum, item) => sum + item.candidateIds.length, 0), synthesisCompleted: synthesis.length,
        successfulUnder6Skipped: synthesis.filter((item) => item.status === "skipped-success-under-6").length, current: batch.current,
        runKnownTokens: batch.trials.reduce((sum, trial) => sum + (trial.usage?.total ?? 0), 0),
        synthesisKnownTokens: synthesis.reduce((sum, item) => sum + (item.usage?.total ?? 0), 0),
        indexKnownTokens: indexes.reduce((sum, item) => sum + (item.usage?.total ?? 0), 0),
        note: "已知用量不是完整费用；缺失用量保持未知。单轮结果不证明经验增益。" };
      // summary is a rebuildable view; only the authoritative checkpoint gates requests.
      try { await writeJsonAtomic(join(root, "summary.json"), summary); }
      catch (error) { console.warn(`Summary refresh failed; batch.json remains authoritative: ${safeError(error)}`); }
    };
    let images: Record<string, string> = {};
    try {
      await save();
      await executeVerifiedTasks(tasks, batch, { save,
        prepare: async (task) => {
          await checkDisk(root);
          console.log(`PREPARE ${task.instance_id}`);
          images = await prepareImages(root, [catalog.tasks.find((item) => item.instance_id === task.instance_id)!]);
          await preflightTasks(root, [task]);
          await checkDisk(root);
        },
        run: async (task, started) => {
          console.log(`R0 START ${task.instance_id}`);
          const trial = await runSweTask({ task, image: images[task.instance_id]!, root, data, config, phase: "R0", candidate: null, started });
          console.log(`R0 RESULT ${JSON.stringify(trial)}`); return trial;
        },
        recover: async (instanceId, runId) => {
          const metadata = await json<{ phase: string; instanceId: string; candidate: unknown; image: string }>(join(data, "runs", runId, "benchmark.json"));
          const pinned = await json<Record<string, string>>(join(root, "images.json"));
          if (metadata.phase !== "R0" || metadata.instanceId !== instanceId || metadata.candidate !== null || metadata.image !== pinned[instanceId]) throw new Error("Recovered run binding mismatch");
          return recoverTrial(data, runId);
        },
        analyze: async (trial) => {
          console.log(`SYNTHESIS START ${trial.instanceId}`);
          const result = await analyzeVerifiedTrial(trial, data, config);
          console.log(`SYNTHESIS RESULT ${trial.instanceId} ${result.status} candidates=${result.candidateIds.length}`); return result;
        }
      });
    } catch (error) { batch.status = "stopped"; await save(); await writeJsonAtomic(join(root, "last-error.json"), { at: new Date().toISOString(), error: safeError(error), current: batch.current }); throw error; }
    console.log("COMPLETED runs=50 critic=false strictSuccessMinimum=6");
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runVerifiedCli(process.argv.slice(2)).catch((error: unknown) => { console.error(safeError(error)); process.exitCode = 1; });
}
