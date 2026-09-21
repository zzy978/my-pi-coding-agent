import { mkdir, readFile, writeFile, open, unlink, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readModelConfig } from "../model-config.js";
import { sha256Json, sha256Text, type RunUsage } from "../evaluation/schema.js";
import { writeJsonAtomic } from "../evaluation/store.js";
import { ensureDataDirectories } from "../runtime/data-dir.js";
import { analyzeRun } from "../experience/service.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { publicTask, freezeGuidance, assertPhaseReady, assertResumeB, summarizeRounds, regradeIncompleteTrials, type SweTask, type SweTrial, type FrozenGuidance } from "./swe-mini.js";
import { bridge, prepareImages, preflightTasks, scorePatch, EVALUATOR_IMAGE } from "./swe-container.js";
import { docker } from "./swe-process.js";
import { runSweTask, recoverTrial } from "./swe-run.js";

interface Catalog { dataset: string; revision: string; harness: string; tasks: Array<SweTask & { image: string }> }
interface Batch {
  schemaVersion: 1; id: string; fingerprint: string; status: string;
  r0: SweTrial[]; b: SweTrial[]; guidance: Record<string, FrozenGuidance>;
  synthesis: Record<string, { id: string | null; status: string; usage: RunUsage | null }>;
  current: { phase: "R0" | "B" | "synthesis"; instanceId: string; runId?: string } | null;
}

async function sourceHash(): Promise<string> {
  const content: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, item.name);
      if (item.isDirectory()) await walk(file);
      else if (/\.(ts|py)$/.test(file)) content.push(file, await readFile(file, "utf8"));
    }
  };
  await walk("src"); await walk("benchmarks/swe-mini");
  content.push(await readFile("package-lock.json", "utf8"));
  return sha256Text(content.join("\n"));
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "status";
  if (!["prepare", "run", "resume-b", "status"].includes(mode) || process.argv.length > 4) throw new Error("Usage: npm run benchmark:swe-mini -- prepare|run|resume-b|status [data-root]");
  const root = resolve(process.argv[3] ?? ".picoding/benchmarks/swe-mini-r0-b-v1");
  const data = join(root, "agent-data");
  await mkdir(root, { recursive: true });
  const statePath = join(root, "batch.json");
  const load = async () => JSON.parse(await readFile(statePath, "utf8")) as Batch;
  if (mode === "resume-b") {
    const existing = await load();
    const catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as Catalog;
    assertResumeB(catalog.tasks.map((task) => task.instance_id), existing.r0);
    if (existing.current?.phase === "R0") throw new Error("Cannot resume B with an unfinished R0 attempt");
  }
  if (mode === "status") {
    try {
      const state = await load(); console.log(JSON.stringify({ status: state.status, r0: state.r0.length, b: state.b.length, experiences: Object.keys(state.synthesis).length, current: state.current }, null, 2));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const count = async (file: string) => {
        try { return Object.keys(JSON.parse(await readFile(join(root, file), "utf8")) as object).length; }
        catch (e) { if (e instanceof Error && "code" in e && e.code === "ENOENT") return 0; throw e; }
      };
      console.log(JSON.stringify({ status: "preparing-or-not-started", imagesPrepared: await count("images.json"), preflightCompleted: await count("preflight.json"), r0: 0, b: 0 }, null, 2));
    }
    return;
  }
  const lockPath = join(root, "batch.lock");
  const lock = await open(lockPath, "wx");
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    if (mode === "prepare") {
      try { await readFile(join(root, "catalog.json")); } catch { await bridge(root, ["prepare"]); }
      const catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as Catalog;
      catalog.tasks.forEach(publicTask);
      await prepareImages(root, catalog.tasks);
      await preflightTasks(root, catalog.tasks);
      console.log("PREPARED 50 tasks and pinned images"); return;
    }
    const config = readModelConfig();
    config.taskTimeoutMs ||= 900_000;
    if (!config.provider || !config.modelId) throw new Error("Explicit configured provider/model required");
    const catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as Catalog;
    const tasks = catalog.tasks.map(publicTask), ids = tasks.map((t) => t.instance_id);
    if (ids.length !== 50 || new Set(ids).size !== 50) throw new Error("Expected 50 unique tasks");
    const images = await prepareImages(root, catalog.tasks);
    await preflightTasks(root, tasks);
    const frozen = { catalogSha256: sha256Json(catalog), images, sourceSha256: await sourceHash(), evaluator: (await docker(["image", "inspect", "--format", "{{.Id}}", EVALUATOR_IMAGE])).stdout.trim(),
      model: { provider: config.provider, id: config.modelId, baseUrlSha256: sha256Text(config.baseUrl ?? "provider-default"), requestTimeoutMs: config.requestTimeoutMs,
        maxOutputTokens: config.maxOutputTokens, taskTimeoutMs: config.taskTimeoutMs, synthesisTimeoutMs: config.synthesisTimeoutMs, synthesisMaxOutputTokens: config.synthesisMaxOutputTokens },
      thinkingLevel: "high", tools: ["bash"], selection: "first-proposer-candidate", imageSource: "ghcr.io/epoch-research", protocol: "same-task-r0-b-v1" };
    let batch: Batch;
    try { batch = await load(); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      batch = { schemaVersion: 1, id: randomUUID(), fingerprint: sha256Json(frozen), status: "ready", r0: [], b: [], guidance: {}, synthesis: {}, current: null };
      await writeJsonAtomic(join(root, "protocol.json"), frozen);
    }
    if (batch.fingerprint !== sha256Json(frozen)) throw new Error("Protocol drift; use a new batch root, do not mix rounds");
    process.env.PI_TUI_AGENT_DATA_DIR = data;
    await ensureDataDirectories(data);
    const save = async () => {
      await writeJsonAtomic(statePath, batch);
      const report = summarizeRounds(ids, batch.r0, batch.b);
      const synthesisKnownTokens = Object.values(batch.synthesis).reduce((s, v) => s + (v.usage?.total ?? 0), 0);
      const synthesisComplete = Object.keys(batch.synthesis).length === 50 && Object.values(batch.synthesis).every((v) => (v.status === "completed" && v.usage !== null) || v.status.startsWith("skipped"));
      const totalWorkflowTokens = synthesisComplete && report.r0.totalTokens !== null && report.b.totalTokens !== null
        ? report.r0.totalTokens + synthesisKnownTokens + report.b.totalTokens : null;
      await writeJsonAtomic(join(root, "summary.json"), { ...report, synthesis: batch.synthesis, synthesisKnownTokens, totalWorkflowTokens, status: batch.status });
      const percent = (x: number) => (x * 100).toFixed(1) + "%";
      await writeFile(join(root, "report.md"), `# SWE-bench Mini 同题经验复用\n\n状态：${batch.status}。固定 50 题，R0 与 B 前后比较；模型随机性未被独立对照排除，不代表未见任务泛化。\n\n| 指标 | R0 | B |\n| --- | ---: | ---: |\n| 已完成任务 | ${report.r0.completed} | ${report.b.completed} |\n| 已评分任务 | ${report.r0.scored} | ${report.b.scored} |\n| 修复通过 | ${report.r0.passed}/50 | ${report.b.passed}/50 |\n| 固定分母通过率 | ${percent(report.r0.successRate)} | ${percent(report.b.successRate)} |\n| 已记录 token | ${report.r0.knownTokens} | ${report.b.knownTokens} |\n\n改善 ${report.transitions.improved} 题；退化 ${report.transitions.regressed} 题；尚不可配对 ${report.transitions.unpaired} 题。复盘已知 token：${synthesisKnownTokens}，缺失 usage 不代表零。费用为 SDK 估算，实际账单可能不同。\n\n| 任务 | R0 | B | B-R0 token |\n| --- | --- | --- | ---: |\n${report.rows.map((r) => `| ${r.id} | ${r.r0?.resolved ?? "未知"} | ${r.b?.resolved ?? "未知"} | ${r.tokenDelta ?? "未知"} |`).join("\n")}\n`);
    };
    if (batch.current) {
      if (batch.current.runId && batch.current.phase !== "synthesis") {
        const trial = await recoverTrial(data, batch.current.runId);
        (batch.current.phase === "R0" ? batch.r0 : batch.b).push(trial); batch.current = null;
      } else throw new Error("Interrupted attempt has unknown outcome; inspect artifacts before retrying paid work");
    }
    await save();
    // Scoring retries reuse the saved patch and never repeat the model request.
    await regradeIncompleteTrials([...batch.r0, ...batch.b], async (trial) => {
      const patch = await readFile(join(data, "runs", trial.runId, "model.patch"), "utf8");
      const score = await scorePatch(root, trial.instanceId, patch, `rescore-${randomUUID()}`);
      if (!score.completed) throw new Error(`Scoring still incomplete: ${trial.instanceId}`);
      await writeJsonAtomic(join(data, "runs", trial.runId, "regrade.json"), { ...score, note: "评分恢复；原始运行证据不改写，模型未重跑。" });
      return score.resolved;
    });
    await save();
    const runRound = async (phase: "R0" | "B") => {
      const trials = phase === "R0" ? batch.r0 : batch.b;
      batch.status = phase;
      for (const task of tasks) {
        if (trials.some((t) => t.instanceId === task.instance_id)) continue;
        batch.current = { phase, instanceId: task.instance_id }; await save();
        console.log(`${phase} START ${task.instance_id}`);
        const trial = await runSweTask({ task, image: images[task.instance_id]!, root, data, config, phase,
          candidate: phase === "B" ? batch.guidance[task.instance_id]!.candidate : null,
          started: async (runId) => { batch.current = { phase, instanceId: task.instance_id, runId }; await save(); } });
        trials.push(trial); batch.current = null; await save();
        console.log(`${phase} RESULT ${JSON.stringify(trial)}`);
        if (trial.resolved === null || (trial.executionError && !trial.executionError.includes("Model task phase timed out"))) {
          batch.status = "stopped-infrastructure"; await save();
          throw new Error("Stopped after infrastructure/model error; inspect the saved run before continuing");
        }
      }
    };
    if (mode !== "resume-b") await runRound("R0");
    batch.status = "synthesis";
    for (const trial of batch.r0) {
      if (batch.synthesis[trial.instanceId]) continue;
      batch.current = { phase: "synthesis", instanceId: trial.instanceId }; await save();
      if (trial.resolved === null || trial.executionError) {
        batch.synthesis[trial.instanceId] = { id: null, status: "skipped-invalid-execution", usage: null };
        batch.guidance[trial.instanceId] = freezeGuidance([]);
      } else {
        const experience = await analyzeRun(trial.runId, data, { reviewMode: "proposer", minSuccessToolCalls: 0, modelConfig: config });
        batch.synthesis[trial.instanceId] = { id: experience.id, status: experience.synthesis.status, usage: experience.synthesis.usage ?? null };
        batch.guidance[trial.instanceId] = freezeGuidance(experience.candidates);
      }
      batch.current = null; await save(); console.log(`SYNTHESIS ${trial.instanceId} ${batch.synthesis[trial.instanceId]!.status}`);
    }
    assertPhaseReady(ids, batch.r0.map((t) => t.instanceId), batch.guidance);
    const frozenPath = join(root, "guidance.json");
    try { if (sha256Json(JSON.parse(await readFile(frozenPath, "utf8"))) !== sha256Json(batch.guidance)) throw new Error("Frozen guidance drift"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") await writeJsonAtomic(frozenPath, batch.guidance); else throw error; }
    await runRound("B");
    if ([...batch.r0, ...batch.b].some((t) => t.resolved === null)) throw new Error("Cannot complete with missing scores");
    batch.status = "completed"; await save(); console.log("COMPLETED R0=50 B=50");
  } finally { await lock.close(); await unlink(lockPath); }
}

main().catch((error: unknown) => { console.error(redactSensitiveText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
