import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Json, sha256Text } from "../evaluation/schema.js";
import { writeJsonAtomic } from "../evaluation/store.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { parseCandidateSnapshot } from "../experience/candidate.js";
import { ensureSearchIndex, createRetrievalCompletion, type IndexModelOptions, type SearchIndexRecord } from "../experience/retrieval-index.js";
import { selectIndexedGuidance } from "../experience/retrieval-service.js";
import type { SearchCard } from "../experience/retrieval.js";
import { publicTask, type SweTask } from "./swe-mini.js";
import type { Arm, LibraryEntry, Retrieval } from "./swe-holdout.js";

interface Options extends IndexModelOptions {
  root: string; tasks: SweTask[]; entries: LibraryEntry[];
  catalogSha256: string; librarySha256: string; sourceSha256: string;
}
type Selection = Awaited<ReturnType<typeof selectIndexedGuidance>>;
interface Snapshot {
  version: 2; binding: string; indexes: SearchIndexRecord[];
  tasks: Record<string, { status: "pending" | "completed"; result: Selection | null }>;
  completed: boolean;
}
async function optionalJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

const activeRoots = new Set<string>();
/** 同进程拒绝重复准备；CLI 的 batch.lock 负责跨进程互斥。 */
export async function freezeHoldoutRetrieval(options: Options): Promise<Awaited<ReturnType<typeof freezeRetrieval>>> {
  const key = resolve(options.root);
  if (activeRoots.has(key)) throw new Error("Holdout retrieval preparation already active");
  activeRoots.add(key);
  try { return await freezeRetrieval(options); } finally { activeRoots.delete(key); }
}

/** 只在首次准备时请求模型。所有请求先写 pending；中断和失败不自动重试。 */
async function freezeRetrieval(options: Options): Promise<{ retrieval: Record<string, Retrieval>; metadata: { method: string; snapshotSha256: string; binding: string } }> {
  const tasks = options.tasks.map(publicTask);
  const binding = sha256Json({ version: 2, catalog: options.catalogSha256, library: options.librarySha256,
    source: options.sourceSha256, tasks, entries: options.entries, model: options.model,
    baseUrlSha256: sha256Text(options.modelConfig?.baseUrl ?? "provider-default"),
    timeout: options.modelConfig?.synthesisTimeoutMs ?? null, maxTokens: options.modelConfig?.synthesisMaxOutputTokens ?? null });
  const file = join(options.root, "retrieval-v2.json");
  const stored = await optionalJson<{ snapshot: Snapshot; sha256: string }>(file);
  if (stored && (stored.sha256 !== sha256Json(stored.snapshot) || stored.snapshot.version !== 2 || stored.snapshot.binding !== binding)) throw new Error("Frozen V2 retrieval binding drift");
  const snapshot: Snapshot = stored?.snapshot ?? { version: 2, binding, indexes: [], tasks: {}, completed: false };
  const save = async () => writeJsonAtomic(file, { snapshot, sha256: sha256Json(snapshot) });
  if (!snapshot.completed) {
    const complete = options.complete ?? createRetrievalCompletion(options);
    await save();
    // Index records have their own durable pending/failure state and candidate/model binding.
    snapshot.indexes = [];
    for (const entry of options.entries) {
      parseCandidateSnapshot(entry.candidate);
      snapshot.indexes.push(await ensureSearchIndex(entry, join(options.root, "retrieval-index", `${entry.candidate.id}.json`), options));
    }
    await save();
    const cards = snapshot.indexes.filter((index) => index.status === "completed" && index.card).map((index) => index.card as SearchCard);
    for (const task of tasks) {
      const previous = snapshot.tasks[task.instance_id];
      if (previous?.status === "completed") continue;
      let result: Selection;
      if (previous?.status === "pending") {
        result = { selection: { candidate: null, selectedIds: [], reasons: [] }, ranking: [], decisions: [], error: "Interrupted applicability request; usage unknown; not retried" };
      } else {
        snapshot.tasks[task.instance_id] = { status: "pending", result: null }; await save();
        try { result = await selectIndexedGuidance({ problem_statement: task.problem_statement }, options.entries, cards, complete); }
        catch (error) {
          result = { selection: { candidate: null, selectedIds: [], reasons: [] }, ranking: [], decisions: [],
            error: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 2000) };
        }
      }
      snapshot.tasks[task.instance_id] = { status: "completed", result }; await save();
    }
    snapshot.completed = true; await save();
  }
  if (Object.keys(snapshot.tasks).length !== tasks.length) throw new Error("Frozen V2 task set drift");
  const retrieval: Record<string, Retrieval> = {};
  for (const task of tasks) {
    const item = snapshot.tasks[task.instance_id];
    if (item?.status !== "completed" || !item.result) throw new Error("Frozen V2 task selection missing");
    const { selection, ranking } = item.result;
    retrieval[task.instance_id] = { selected: selection.selectedIds.map((id) => {
      const rank = ranking.find((rank) => rank.id === id);
      if (!rank) throw new Error("Frozen V2 selection ranking drift");
      return rank;
    }), candidate: selection.candidate ? parseCandidateSnapshot(selection.candidate) : null };
  }
  const retrievalPath = join(options.root, "retrieval.json"), prior = await optionalJson<unknown>(retrievalPath);
  if (prior !== null && sha256Json(prior) !== sha256Json(retrieval)) throw new Error("Frozen retrieval drift");
  if (prior === null) await writeJsonAtomic(retrievalPath, retrieval);
  return { retrieval, metadata: { method: "V2-BM25-Top8-conditions-initial-dedup-Top2", snapshotSha256: sha256Json(snapshot), binding } };
}

export function holdoutCandidate(retrieval: Record<string, Retrieval>, instanceId: string, arm: Arm): Retrieval["candidate"] {
  const selection = retrieval[instanceId];
  if (!selection) throw new Error("Missing frozen holdout selection");
  return arm === "experience" ? selection.candidate : null;
}
