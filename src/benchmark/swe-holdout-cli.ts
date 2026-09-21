import { mkdir, readFile, readdir, writeFile, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readModelConfig } from "../model-config.js";
import { sha256Json, sha256Text } from "../evaluation/schema.js";
import { loadRunBundle, writeJsonAtomic } from "../evaluation/store.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { loadExperience } from "../experience/store.js";
import { parseCandidateSnapshot } from "../experience/candidate.js";
import { ensureDataDirectories } from "../runtime/data-dir.js";
import { publicTask, type SweTask, type FrozenGuidance, type SweTrial } from "./swe-mini.js";
import { bridge, prepareImages, preflightTasks, EVALUATOR_IMAGE, scorePatch } from "./swe-container.js";
import { docker } from "./swe-process.js";
import { runSweTask, recoverTrial } from "./swe-run.js";
import { HOLDOUT_SEED, QUOTAS, validateHoldoutTasks, retrieveGuidance, holdoutSummary, type LibraryEntry, type Retrieval } from "./swe-holdout.js";
import { executePairs, applyRegrade, type HoldoutState } from "./swe-holdout-state.js";
import { freezeHoldoutRetrieval, holdoutCandidate } from "./swe-holdout-retrieval.js";

interface Catalog { dataset: string; revision: string; tasks: Array<SweTask & { image: string }> }
interface Library { entries: LibraryEntry[]; sha256: string; sourceProtocol: {
  model: { provider: string; id: string; baseUrlSha256: string; requestTimeoutMs: number; maxOutputTokens: number; taskTimeoutMs: number };
}; sourceCatalogSha256: string }
async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
async function exists(file: string): Promise<boolean> {
  try { await readFile(file); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
async function fingerprintSources(): Promise<string> {
  const contents: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, item.name);
      if (item.isDirectory()) await walk(file);
      else if (/\.(ts|py)$/.test(file)) contents.push(file, await readFile(file, "utf8"));
    }
  };
  await walk("src"); await walk("benchmarks/swe-mini");
  contents.push(await readFile("package-lock.json", "utf8"));
  return sha256Text(contents.join("\n"));
}

async function initialize(root: string, source: string): Promise<void> {
  if (!await exists(join(root, "library.json"))) {
    const catalog = await json<Catalog>(join(source, "catalog.json"));
    const batch = await json<{ r0: SweTrial[]; guidance: Record<string, FrozenGuidance>; synthesis: Record<string, { id: string | null }> }>(join(source, "batch.json"));
    const entries: LibraryEntry[] = [];
    for (const task of catalog.tasks) {
      const frozen = batch.guidance[task.instance_id];
      if (!frozen || frozen.sha256 !== sha256Json(frozen.candidate)) throw new Error("Mini guidance hash mismatch");
      if (!frozen.candidate) continue;
      const candidate = parseCandidateSnapshot(frozen.candidate);
      const experienceId = batch.synthesis[task.instance_id]?.id;
      if (!experienceId) throw new Error("Missing source experience");
      const experience = await loadExperience(experienceId, join(source, "agent-data"));
      const first = experience.candidates[0];
      const trial = batch.r0.find((item) => item.instanceId === task.instance_id);
      if (!first || sha256Json(parseCandidateSnapshot(first)) !== sha256Json(candidate) || !trial || experience.sourceRunId !== trial.runId) throw new Error("Source first-candidate binding mismatch");
      const run = await loadRunBundle(trial.runId, join(source, "agent-data"));
      if (!run.result || experience.sourceManifestSha256 !== sha256Json(run.manifest) || experience.sourceResultSha256 !== sha256Json(run.result)) throw new Error("Source experience evidence drift");
      entries.push({ sourceTaskId: task.instance_id, sourceExperienceId: experienceId, sourceRunId: trial.runId,
        title: first.title, applicability: first.applicability, contraindications: first.contraindications, candidate });
    }
    if (entries.length !== 39 || new Set(entries.map((entry) => entry.candidate.id)).size !== 39) throw new Error("Expected the 39 frozen Mini first candidates");
    const sourceProtocol = await json<Library["sourceProtocol"]>(join(source, "protocol.json"));
    await writeJsonAtomic(join(root, "source-catalog.json"), catalog);
    await writeJsonAtomic(join(root, "library.json"), { entries, sha256: sha256Json(entries), sourceProtocol, sourceCatalogSha256: sha256Json(catalog) });
  }
  if (!await exists(join(root, "catalog.json"))) await bridge(root, ["prepare-holdout"]);
}

export async function runHoldoutCli(args: string[]): Promise<void> {
  const mode = args[0] ?? "status";
  if (!["catalog", "prepare", "run", "status"].includes(mode) || args.length > 3 || args.slice(1).some((arg) => arg.startsWith("--"))) throw new Error("Usage: npm run benchmark:swe-holdout -- catalog|prepare|run|status [data-root] [mini-root]");
  const root = resolve(args[1] ?? ".picoding/benchmarks/swe-holdout-v2");
  const source = resolve(args[2] ?? ".picoding/benchmarks/swe-mini-r0-b-v1");
  if (root === source) throw new Error("Holdout output must not overwrite Mini");
  const statePath = join(root, "batch.json");
  if (mode === "status") {
    if (await exists(statePath)) {
      const state = await json<HoldoutState>(statePath);
      console.log(JSON.stringify({ status: state.status, control: state.control.length, experience: state.experience.length, current: state.current }, null, 2));
    } else {
      const count = async (file: string) => await exists(join(root, file)) ? Object.keys(await json<object>(join(root, file))).length : 0;
      console.log(JSON.stringify({ status: "preparing-or-not-started", images: await count("images.json"), preflight: await count("preflight.json"), control: 0, experience: 0 }, null, 2));
    }
    return;
  }
  await mkdir(root, { recursive: true });
  const lockPath = join(root, "batch.lock"), lock = await open(lockPath, "wx");
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), mode }));
  try {
    await initialize(root, source);
    const catalog = await json<Catalog>(join(root, "catalog.json"));
    const sourceCatalog = await json<Catalog>(join(root, "source-catalog.json"));
    const library = await json<Library>(join(root, "library.json"));
    if (sha256Json(library.entries) !== library.sha256 || sha256Json(sourceCatalog) !== library.sourceCatalogSha256) throw new Error("Frozen library or source catalog drift");
    const tasks = catalog.tasks.map(publicTask);
    validateHoldoutTasks(tasks, sourceCatalog.tasks);
    const protocolPath = join(root, "protocol.json");
    const previousProtocol = await exists(protocolPath) ? await json<{ version: number }>(protocolPath) : null;
    if (previousProtocol && previousProtocol.version !== 1 && previousProtocol.version !== 2) throw new Error("Unknown holdout protocol version");
    if (previousProtocol?.version === 2 && (!await exists(join(root, "retrieval-v2.json")) || !await exists(join(root, "retrieval.json")))) throw new Error("Frozen V2 retrieval missing; refusing regeneration");
    if (previousProtocol?.version === 1 && await exists(join(root, "retrieval-v2.json"))) throw new Error("Do not mix V1 and V2 holdout protocols");
    // Unstarted V1 catalogs already have retrieval.json; preserve their old semantics too.
    const legacy = previousProtocol?.version === 1 || (!previousProtocol && await exists(join(root, "retrieval.json")) && !await exists(join(root, "retrieval-v2.json")));
    const retrievalPath = join(root, "retrieval.json");
    let retrieval: Record<string, Retrieval> = {};
    if (legacy) {
      retrieval = Object.fromEntries(tasks.map((task) => [task.instance_id, retrieveGuidance(task, library.entries)]));
      if (await exists(retrievalPath)) {
        if (sha256Json(await json(retrievalPath)) !== sha256Json(retrieval)) throw new Error("Frozen retrieval drift");
      } else await writeJsonAtomic(retrievalPath, retrieval);
    }
    if (mode === "catalog" && !legacy) {
      console.log(`CATALOG tasks=${tasks.length} library=${library.entries.length} retrieval=pending-prepare`);
      await writeFile(join(root, "tasks.md"), `# 新任务清单\n\n固定种子：${HOLDOUT_SEED}。V2 检索将在 prepare/run 阶段冻结。\n\n| 仓库 | 任务 |\n| --- | --- |\n${tasks.map((task) => `| ${task.repo} | ${task.instance_id} |`).join("\n")}\n`);
      return;
    }
    if (legacy && (mode === "catalog" || mode === "prepare")) {
      console.log(`CATALOG tasks=${tasks.length} library=${library.entries.length} retrieved=${Object.values(retrieval).filter((item) => item.candidate).length}`);
      if (mode === "prepare") {
        await prepareImages(root, catalog.tasks); await preflightTasks(root, tasks);
        console.log("PREPARED 40 tasks: baseline red, reference green");
      }
      return;
    }
    const config = readModelConfig(), sourceModel = library.sourceProtocol.model;
    if (config.provider !== sourceModel.provider || config.modelId !== sourceModel.id || sha256Text(config.baseUrl ?? "provider-default") !== sourceModel.baseUrlSha256) throw new Error("Configured model differs from Mini source model");
    config.requestTimeoutMs = sourceModel.requestTimeoutMs; config.maxOutputTokens = sourceModel.maxOutputTokens; config.taskTimeoutMs = sourceModel.taskTimeoutMs;
    const sourceSha256 = await fingerprintSources();
    const frozen = legacy ? null : await freezeHoldoutRetrieval({ root, tasks, entries: library.entries,
      catalogSha256: sha256Json(catalog), librarySha256: sha256Json(library), sourceSha256,
      model: { provider: sourceModel.provider, id: sourceModel.id }, dataDirectory: join(root, "agent-data"), modelConfig: config });
    if (frozen) retrieval = frozen.retrieval;
    console.log(`CATALOG tasks=${tasks.length} library=${library.entries.length} retrieved=${Object.values(retrieval).filter((item) => item.candidate).length}`);
    await writeFile(join(root, "tasks.md"), `# 新任务清单\n\n固定种子：${HOLDOUT_SEED}。与 Mini 的任务 ID 和规范化问题文本不重合。\n\n| 仓库 | 任务 | 检索经验数 |\n| --- | --- | ---: |\n${tasks.map((task) => `| ${task.repo} | ${task.instance_id} | ${retrieval[task.instance_id]!.selected.length} |`).join("\n")}\n`);
    if (mode === "catalog") return;
    const images = await prepareImages(root, catalog.tasks);
    await preflightTasks(root, tasks);
    console.log("PREPARED 40 tasks: baseline red, reference green");
    if (mode === "prepare") return;
    const privateHashes = Object.fromEntries(await Promise.all(tasks.map(async (task) => [task.instance_id, sha256Text(await readFile(join(root, "private", `${task.instance_id}.json`), "utf8"))] as const)));
    const protocol = { version: legacy ? 1 : 2, kind: "frozen-mini-library-holdout", seed: HOLDOUT_SEED, quotas: QUOTAS,
      catalogSha256: sha256Json(catalog), librarySha256: sha256Json(library), retrievalSha256: sha256Json(retrieval), privateHashes,
      sourceSha256, images, evaluator: (await docker(["image", "inspect", "--format", "{{.Id}}", EVALUATOR_IMAGE])).stdout.trim(),
      model: sourceModel, thinkingLevel: "high", tools: ["bash"], order: "alternate-control-first-experience-first", taskCount: 40, runCount: 80,
      retrieval: frozen ? { ...frozen.metadata, model: { provider: sourceModel.provider, id: sourceModel.id, baseUrlSha256: sourceModel.baseUrlSha256,
        timeoutMs: config.synthesisTimeoutMs, maxOutputTokens: config.synthesisMaxOutputTokens } }
        : { method: "BM25", k1: 1.2, b: 0.75, minimumMatchedTerms: 2, topK: 3, maxCharacters: 9000 } };
    let state: HoldoutState;
    if (await exists(statePath)) state = await json<HoldoutState>(statePath);
    else {
      state = { schemaVersion: 1, fingerprint: sha256Json(protocol), status: "ready", control: [], experience: [], current: null };
      if (!previousProtocol) await writeJsonAtomic(join(root, "protocol.json"), protocol);
    }
    if (state.fingerprint !== sha256Json(protocol) || sha256Json(await json(join(root, "protocol.json"))) !== sha256Json(protocol)) throw new Error("Protocol drift: do not mix runs");
    const data = join(root, "agent-data"); process.env.PI_TUI_AGENT_DATA_DIR = data; await ensureDataDirectories(data);
    const save = async () => {
      await writeJsonAtomic(statePath, state);
      const summary = holdoutSummary(tasks, state.control, state.experience);
      await writeJsonAtomic(join(root, "summary.json"), { status: state.status, librarySize: library.entries.length, retrievalCoverage: Object.values(retrieval).filter((entry) => entry.candidate).length, ...summary });
      const groups = [["全部新任务", summary.overall], ["原仓库新问题", summary.sameRepository], ["新仓库问题", summary.newRepository]] as const;
      const costGroups = [["全部完整usage", summary.overall.completeUsagePairs], ["两臂均成功", summary.overall.bothPassedUsagePairs]] as const;
      await writeFile(join(root, "report.md"), `# Mini经验库泛化对照\n\n状态：${state.status}。40题，每题两臂各运行一次；部分结果不是最终成功率。经验库与检索规则冻结，新任务不复盘。\n\n| 分组 | 无经验通过 | 经验库通过 | 改善 | 退化 | 已配对 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${groups.map(([label, group]) => `| ${label} | ${group.control.passed}/${group.taskCount} | ${group.experience.passed}/${group.taskCount} | ${group.transitions.improved} | ${group.transitions.regressed} | ${group.taskCount - group.transitions.unpaired} |`).join("\n")}\n\n| 成本口径 | 完整配对数 | 无经验token | 经验库token | 变化 |\n| --- | ---: | ---: | ---: | ---: |\n${costGroups.map(([label, cost]) => { return `| ${label} | ${cost.count} | ${cost.control} | ${cost.experience} | ${cost.percentChange === null ? "未知" : cost.percentChange.toFixed(2) + "%"} |`; }).join("\n")}\n\ntoken包含缓存读取；未知usage不补零。历史Mini经验构建成本未计入本次推理增量成本，经验文本输入成本已包含。V2索引和适用性筛选的额外用量单独保存在retrieval-v2.json，不计入上表修复运行token；未知用量不补零。每题每组一次运行，不能排除随机波动；模型预训练是否见过这些公开题目未知。\n\n| 任务 | 无经验 | 经验库 | 经验条数 | token差 |\n| --- | --- | --- | ---: | ---: |\n${summary.overall.rows.map((row) => `| ${row.id} | ${row.r0?.resolved ?? "未知"} | ${row.b?.resolved ?? "未知"} | ${retrieval[row.id]!.selected.length} | ${row.tokenDelta ?? "未知"} |`).join("\n")}\n`);
    };
    await save();
    // Existing incomplete scores reuse their patches; this never invokes a model.
    for (const trial of [...state.control, ...state.experience]) if (trial.resolved === null) {
      const patch = await readFile(join(data, "runs", trial.runId, "model.patch"), "utf8");
      const score = await scorePatch(root, trial.instanceId, patch, `regrade-${randomUUID()}`);
      if (!score.completed) throw new Error("Scoring infrastructure still unavailable");
      await writeJsonAtomic(join(data, "runs", trial.runId, "regrade.json"), score);
      applyRegrade(trial, score.resolved); await save();
    }
    await executePairs(tasks, state, { save,
      recover: async (instanceId, arm, runId) => {
        const metadata = await json<{ phase: string; instanceId: string; candidate: Retrieval["candidate"] }>(join(data, "runs", runId, "benchmark.json"));
        if (metadata.phase !== arm || metadata.instanceId !== instanceId || sha256Json(metadata.candidate) !== sha256Json(holdoutCandidate(retrieval, instanceId, arm))) throw new Error("Recovered run binding mismatch");
        return recoverTrial(data, runId);
      },
      run: async (task, arm, started) => {
        console.log(`${arm} START ${task.instance_id}`);
        const trial = await runSweTask({ task, image: images[task.instance_id]!, root, data, config, phase: arm, candidate: holdoutCandidate(retrieval, task.instance_id, arm), started });
        console.log(`${arm} RESULT ${JSON.stringify(trial)}`); return trial;
      }
    });
    console.log("COMPLETED control=40 experience=40");
  } finally { await lock.close(); await unlink(lockPath); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runHoldoutCli(process.argv.slice(2)).catch((error: unknown) => { console.error(redactSensitiveText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
}
