import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../evaluation/store.js";
import { publicTask, type SweTask } from "./swe-mini.js";
import { bridge, scorePatch } from "./swe-container.js";
import { fileHash, sealFiles, verifyFiles, type FileSeal } from "./swe-candidate-storage.js";

export interface CandidatePreflightDependencies { scorePatch: typeof scorePatch; bridge: typeof bridge }
interface Entry { taskId: string; red: string; gold: string }
interface Preflight { protocolSha256: string; entries: Entry[]; files: FileSeal }
const harmlessPatch = "diff --git a/.picode-preflight b/.picode-preflight\nnew file mode 100644\nindex 0000000..f2ba8f8\n--- /dev/null\n+++ b/.picode-preflight\n@@ -0,0 +1 @@\n+baseline\n";
const scoreId = /^qa-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-(red|gold)$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

function assertInput(protocolSha256: string, tasks: SweTask[]): void {
  if (!/^[a-f0-9]{64}$/.test(protocolSha256)) throw new Error("预检协议哈希无效");
  tasks.forEach(publicTask);
  if (tasks.length < 2 || tasks.length > 20 || new Set(tasks.map((task) => task.instance_id)).size !== tasks.length) throw new Error("预检需要 2–20 道不重复任务");
}

function exactFields(record: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(record).length === fields.length && fields.every((field) => Object.hasOwn(record, field));
}

function expectedFiles(entries: Entry[]): string[] {
  return entries.flatMap(({ red, gold }) => [`${red}.patch`, `${red}.score.json`, `${gold}.score.json`]).sort();
}

function parsePreflight(value: unknown, protocolSha256: string, tasks: SweTask[]): Preflight {
  if (!isRecord(value) || !exactFields(value, ["protocolSha256", "entries", "files"]) || value.protocolSha256 !== protocolSha256 ||
    !Array.isArray(value.entries) || value.entries.length !== tasks.length || !isRecord(value.files)) throw new Error("预检协议或完整任务集合无效");
  const taskIds = new Set(tasks.map((task) => task.instance_id)), usedIds = new Set<string>();
  const entries: Entry[] = value.entries.map((entry: unknown) => {
    if (!isRecord(entry) || !exactFields(entry, ["taskId", "red", "gold"]) || typeof entry.taskId !== "string" ||
      !taskIds.delete(entry.taskId) || typeof entry.red !== "string" || typeof entry.gold !== "string" ||
      !scoreId.test(entry.red) || !scoreId.test(entry.gold) || !entry.red.endsWith("-red") || !entry.gold.endsWith("-gold") ||
      entry.red.slice(0, -4) !== entry.gold.slice(0, -5) || usedIds.has(entry.red) || usedIds.has(entry.gold)) throw new Error("预检任务或评分 ID 重复、缺失或无效");
    usedIds.add(entry.red); usedIds.add(entry.gold);
    return { taskId: entry.taskId, red: entry.red, gold: entry.gold };
  });
  const files: FileSeal = {};
  for (const [file, hash] of Object.entries(value.files)) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("预检文件哈希无效");
    files[file] = hash;
  }
  if (taskIds.size || JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(expectedFiles(entries))) throw new Error("预检封存文件集合不完整或存在额外文件");
  return { protocolSha256, entries, files };
}

async function readJson(root: string, file: string): Promise<unknown> {
  await fileHash(root, file);
  return JSON.parse(await readFile(join(root, file), "utf8")) as unknown;
}

async function verifyEvidence(root: string, preflight: Preflight): Promise<string[]> {
  const issues = await verifyFiles(root, preflight.files);
  if (issues.length) return issues;
  for (const entry of preflight.entries) {
    for (const arm of ["red", "gold"] as const) {
      const score = await readJson(root, `${entry[arm]}.score.json`);
      if (!isRecord(score) || score.completed !== true || score.resolved !== (arm === "gold") ||
        (Object.hasOwn(score, "officialCompleted") && score.officialCompleted !== true)) issues.push(`预检评分未满足红失败/金成功：${entry.taskId}/${arm}`);
    }
    if (await readFile(join(root, `${entry.red}.patch`), "utf8") !== harmlessPatch) issues.push(`预检红基线补丁不匹配：${entry.taskId}`);
  }
  return issues;
}

/** 只读取原始文件重算，不相信缓存的通过标志或不完整文件集合。 */
export async function verifyCandidatePreflight(root: string, protocolSha256: string, tasks: SweTask[]): Promise<string[]> {
  try {
    assertInput(protocolSha256, tasks);
    const preflight = parsePreflight(await readJson(root, "preflight.json"), protocolSha256, tasks);
    return await verifyEvidence(root, preflight);
  } catch { return ["预检证据缺失、损坏或与冻结协议不一致"]; }
}

/** 由批次锁串行调用；没有最终封存的中断预检可重做，旧随机 ID 产物始终保留。 */
export async function ensureCandidatePreflight(root: string, protocolSha256: string, tasks: SweTask[], dependencies: CandidatePreflightDependencies = { scorePatch, bridge }): Promise<void> {
  assertInput(protocolSha256, tasks);
  const path = join(root, "preflight.json");
  let exists = false;
  try { await lstat(path); exists = true; } catch (error) { if (!missing(error)) throw error; }
  if (exists) {
    const issues = await verifyCandidatePreflight(root, protocolSha256, tasks);
    if (issues.length) throw new Error(issues.join("; "));
    return;
  }
  const entries: Entry[] = [];
  for (const task of tasks) {
    const id = `qa-${randomUUID()}`, red = `${id}-red`, gold = `${id}-gold`;
    const redScore = await dependencies.scorePatch(root, task.instance_id, harmlessPatch, red);
    if (redScore.completed !== true || redScore.resolved !== false) throw new Error(`红基线预检失败：${task.instance_id}`);
    await dependencies.bridge(root, ["evaluate", task.instance_id, "gold", gold]);
    const entry: Entry = { taskId: task.instance_id, red, gold };
    entries.push(entry);
    const partial: Preflight = { protocolSha256, entries: [entry], files: await sealFiles(root, expectedFiles([entry])) };
    const issues = await verifyEvidence(root, partial);
    if (issues.length) throw new Error(issues.join("; "));
  }
  const preflight: Preflight = { protocolSha256, entries, files: await sealFiles(root, expectedFiles(entries)) };
  const issues = await verifyEvidence(root, preflight);
  if (issues.length) throw new Error(issues.join("; "));
  await writeJsonAtomic(path, preflight);
}
