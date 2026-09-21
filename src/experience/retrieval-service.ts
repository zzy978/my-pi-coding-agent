import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { sha256Json, sha256Text, type RunUsage } from "../evaluation/schema.js";
import { assertRegularDirectory } from "./artifact-io.js";
import { assertNoSecrets, parseCandidateSnapshot, stripUnsafeControls, type ExperienceCandidate } from "./candidate.js";
import { candidateIndexPath, createRetrievalCompletion, ensureSearchIndex, toRetrievalEntry,
  type IndexModelOptions, type SearchIndexRecord, type RetrievalCompletion } from "./retrieval-index.js";
import { SELECTION_PROMPT } from "./retrieval-prompts.js";
import { parseApplicability, rankGuidance, selectGuidance, validatedTask,
  type ApplicabilityDecision, type GuidanceSelection, type RankedCandidate, type RetrievalEntry, type RetrievalTask, type SearchCard } from "./retrieval.js";
import { parseSynthesisUsage } from "./schema.js";

export interface IndexedSelection {
  selection: GuidanceSelection; ranking: RankedCandidate[]; decisions: ApplicabilityDecision[];
  usage?: RunUsage; error?: string;
}
export interface TaskExperienceSelection extends GuidanceSelection {
  auditId: string; status: "selected" | "empty" | "failed"; error?: string;
}
const emptySelection = (): GuidanceSelection => ({ candidate: null, selectedIds: [], reasons: [] });
function safeError(error: unknown): string {
  return stripUnsafeControls(redactSensitiveText(error instanceof Error ? error.message : String(error))).slice(0, 2000) || "Experience retrieval failed";
}

/** 所有入口共享公开输入、严格证据校验和零注入降级；不持久化、不改写原候选。 */
export async function selectIndexedGuidance(input: RetrievalTask, entries: RetrievalEntry[], cards: SearchCard[], complete: RetrievalCompletion): Promise<IndexedSelection> {
  const result: IndexedSelection = { selection: emptySelection(), ranking: [], decisions: [] };
  try {
    const task = validatedTask(input);
    result.ranking = rankGuidance(task, entries, cards);
    if (!result.ranking.length) return result;
    const shortlist = result.ranking.map(({ id }) => entries.find((entry) => entry.candidate.id === id)!);
    const material = { task, candidates: shortlist.map((entry) => ({ title: entry.title, applicability: entry.applicability,
      contraindications: entry.contraindications, candidate: parseCandidateSnapshot(entry.candidate) })) };
    if (JSON.stringify(material).length > 64_000) throw new Error("Retrieval material exceeds the 64000 character size limit");
    const response = await complete(material, SELECTION_PROMPT);
    if (response.usage) result.usage = parseSynthesisUsage(response.usage);
    if (response.error) throw new Error(response.error);
    result.decisions = parseApplicability(response.text, task, shortlist);
    result.selection = selectGuidance(task, entries, result.ranking, result.decisions);
  } catch (error) { result.error = safeError(error); result.selection = emptySelection(); }
  return result;
}

/** candidates 必须由宿主提供同仓库有效晋升池；异步后宿主还需复核晋升和任务状态。 */
export async function selectTaskExperience(options: IndexModelOptions & { objective: string; candidates: ExperienceCandidate[] }): Promise<TaskExperienceSelection> {
  const auditId = randomUUID();
  const indexes: Array<{ candidateId: string; status: SearchIndexRecord["status"] | "unavailable"; error?: string; usage?: RunUsage }> = [];
  let result: IndexedSelection = { selection: emptySelection(), ranking: [], decisions: [] };
  let entries: RetrievalEntry[] = [];
  try {
    const task = validatedTask({ problem_statement: options.objective });
    assertNoSecrets(options.model.provider); assertNoSecrets(options.model.id);
    entries = options.candidates.map(toRetrievalEntry);
    // Validate the entire pool before any index request, including duplicate IDs.
    rankGuidance(task, entries, []);
    const modelOptions: IndexModelOptions = options;
    const complete = options.complete ?? createRetrievalCompletion(modelOptions);
    const cards: SearchCard[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      try {
        const index = await ensureSearchIndex(entry, candidateIndexPath(options.candidates[i]!, options.dataDirectory), modelOptions);
        indexes.push({ candidateId: entry.candidate.id, status: index.status, ...(index.error ? { error: safeError(index.error) } : {}), ...(index.usage ? { usage: index.usage } : {}) });
        if (index.status === "completed" && index.card) cards.push(index.card);
      } catch (error) { indexes.push({ candidateId: entry.candidate.id, status: "unavailable", error: safeError(error) }); }
    }
    result = await selectIndexedGuidance(task, entries, cards, complete);
    if (entries.length && !cards.length) result.error = "没有可用检索索引，未注入经验";
  } catch (error) { result.error = safeError(error); }
  const status = result.error ? "failed" : result.selection.candidate ? "selected" : "empty";
  const response: TaskExperienceSelection = { ...result.selection, auditId, status, ...(result.error ? { error: result.error } : {}) };
  // 不单独保存原始任务字段或完整配置；有界证据引文可能包含短任务全文。
  const audit = { schemaVersion: 1, auditId, createdAt: new Date().toISOString(), status,
    querySha256: sha256Text(options.objective), poolSha256: sha256Json(entries),
    model: { provider: safeError(options.model.provider), id: safeError(options.model.id) },
    promptSha256: sha256Text(SELECTION_PROMPT), indexes, ...result };
  await assertRegularDirectory(options.dataDirectory);
  const reports = join(options.dataDirectory, "reports");
  await mkdir(reports, { recursive: true }); await assertRegularDirectory(reports);
  const directory = join(reports, "retrieval");
  await mkdir(directory, { recursive: true }); await assertRegularDirectory(directory);
  const temporary = join(directory, `.${auditId}.tmp`);
  await writeFile(temporary, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, join(directory, `${auditId}.json`));
  return response;
}
