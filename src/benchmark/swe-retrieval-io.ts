import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import { assertRegularDirectory, isMissing, readArtifactText } from "../experience/artifact-io.js";
import { assertArtifactId, assertNoSecrets, parseCandidateSnapshot } from "../experience/candidate.js";
import { assertPublicRetrievalText } from "../experience/retrieval-text.js";
import { sha256Json, sha256Text } from "../evaluation/schema.js";
import { writeJsonAtomic } from "../evaluation/store.js";
import { retrieveGuidance, type LibraryEntry, type Retrieval } from "./swe-holdout.js";
import { publicTask, type SweTask } from "./swe-mini.js";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 16_384): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error("Invalid public text");
  assertNoSecrets(value); return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid public string array");
  return value.map((item: unknown) => text(item, 2000));
}
export interface RetrievalInputs {
  entries: LibraryEntry[];
  tasks: SweTask[];
  legacy: Record<string, Retrieval>;
  sourceHashes: Record<string, string>;
}
export async function loadRetrievalInputs(source: string): Promise<RetrievalInputs> {
  await assertRegularDirectory(source);
  const raw = await Promise.all(["library.json", "catalog.json", "retrieval.json"].map(async (file) => [file, await readArtifactText(join(source, file), 8_000_000)] as const));
  const sources = Object.fromEntries(raw), sourceHashes = Object.fromEntries(raw.map(([file, value]) => [file, sha256Text(value)]));
  const library = object(JSON.parse(sources["library.json"]!));
  if (!Array.isArray(library.entries) || !library.entries.length || library.entries.length > 500 || library.sha256 !== sha256Json(library.entries)) throw new Error("Frozen library hash mismatch");
  const entries = library.entries.map((value: unknown): LibraryEntry => {
    const entry = object(value);
    return { sourceTaskId: assertArtifactId(entry.sourceTaskId), sourceExperienceId: assertArtifactId(entry.sourceExperienceId), sourceRunId: assertArtifactId(entry.sourceRunId),
      title: text(entry.title, 500), applicability: strings(entry.applicability), contraindications: strings(entry.contraindications), candidate: parseCandidateSnapshot(entry.candidate) };
  });
  if (new Set(entries.map((entry) => entry.candidate.id)).size !== entries.length) throw new Error("Duplicate library candidate ID");
  const catalog = object(JSON.parse(sources["catalog.json"]!));
  if (!Array.isArray(catalog.tasks) || !catalog.tasks.length || catalog.tasks.length > 500) throw new Error("Invalid task catalog");
  const tasks = catalog.tasks.map((task: unknown) => publicTask(task));
  for (const task of tasks) {
    if (task.problem_statement.length > 100_000) throw new Error("Public task exceeds length limit");
    assertPublicRetrievalText(task.problem_statement);
  }
  if (new Set(tasks.map((task) => task.instance_id)).size !== tasks.length) throw new Error("Duplicate task ID");
  const legacy = Object.fromEntries(tasks.map((task) => [task.instance_id, retrieveGuidance(task, entries)]));
  if (sha256Json(JSON.parse(sources["retrieval.json"]!)) !== sha256Json(legacy)) throw new Error("Frozen V1 retrieval drift");
  return { entries, tasks, legacy, sourceHashes };
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function resolvedPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) { if (!isMissing(error)) throw error; return join(await resolvedPath(dirname(path)), relative(dirname(path), path)); }
}
export async function checkOutputPath(source: string, output: string): Promise<void> {
  const a = await realpath(source), b = await resolvedPath(resolve(output));
  if (within(a, b) || within(b, a)) throw new Error("V2 output must be separate from the V1 source tree");
  // Reject junction/symlink components before creating anything under the output.
  let cursor = resolve(output);
  while (dirname(cursor) !== cursor) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Output path cannot contain a link"); }
    catch (error) { if (!isMissing(error)) throw error; }
    cursor = dirname(cursor);
  }
}
export async function readJson(path: string): Promise<unknown> { return JSON.parse(await readArtifactText(path, 12_000_000)) as unknown; }
export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}
export async function writeCheckedJson(path: string, value: unknown): Promise<void> {
  if (await exists(path)) await readArtifactText(path, 12_000_000);
  await assertRegularDirectory(dirname(path));
  await writeJsonAtomic(path, value);
}
export async function withOutputLock<T>(output: string, action: () => Promise<T>): Promise<T> {
  await mkdir(output, { recursive: true }); await assertRegularDirectory(output);
  const lockPath = join(output, "workflow.lock");
  const acquire = async () => {
    try { return await open(lockPath, "wx"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    // Serialize stale-lock reclamation so a second process cannot unlink a newly acquired lock.
    const recoveryPath = join(output, "workflow-recovery.lock"), recovery = await open(recoveryPath, "wx");
    try {
      await recovery.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
      if (!await exists(lockPath)) return await open(lockPath, "wx");
      const previous = object(await readJson(lockPath));
      if (previous.host !== hostname() || typeof previous.pid !== "number" || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("无法安全确认锁的来源；请检查 workflow.lock，不能自动抢占。");
      let dead = false;
      try { process.kill(previous.pid, 0); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") dead = true; else throw error; }
      if (!dead) throw new Error("经验检索任务正在运行（active lock），不能抢占。");
      await unlink(lockPath);
      return await open(lockPath, "wx");
    } finally { await recovery.close(); await unlink(recoveryPath); }
  };
  const lock = await acquire();
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })); return await action(); }
  finally { await lock.close(); await unlink(lockPath); }
}
