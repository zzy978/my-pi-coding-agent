import { sha256Text } from "../evaluation/schema.js";
import { assertArtifactId, assertNoSecrets, parseCandidateSnapshot, type CandidateSnapshot } from "./candidate.js";
import { assertPublicRetrievalText } from "./retrieval-text.js";

export interface RetrievalTask { problem_statement: string }
export interface RetrievalEntry {
  title: string; applicability: string[]; contraindications: string[]; candidate: CandidateSnapshot;
}

export type Verdict = "direct" | "general" | "inapplicable" | "unknown";
type Stage = "initial" | "after_inspection" | "after_error";
export interface SearchCard {
  candidateId: string; contentSha256: string; mechanism: string; triggers: string[]; exclusions: string[];
  action: string; stage: Stage; keywords: string[]; sourceQuotes: string[];
}
export interface RankedCandidate { id: string; score: number; matchedTerms: number }
export interface ApplicabilityDecision {
  candidateId: string; verdict: Verdict; reason: string; taskQuotes: string[]; experienceQuotes: string[];
  contraindication: "absent" | "present" | "unknown"; stage: Stage; redundantWith: string | null;
}
export interface GuidanceSelection {
  candidate: CandidateSnapshot | null; selectedIds: string[];
  reasons: Array<{ candidateId: string; selected: boolean; reason: string }>;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid retrieval object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error("Unexpected or missing retrieval fields");
  }
  return record;
}
function text(value: unknown, limit: number, validate = assertNoSecrets): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("Invalid retrieval text length");
  validate(value);
  return value;
}
function texts(value: unknown, maxItems: number, maxLength: number, minItems = 0, validate = assertNoSecrets): string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) throw new Error("Invalid retrieval text array");
  return value.map((item) => text(item, maxLength, validate));
}
function stage(value: unknown): Stage {
  if (value !== "initial" && value !== "after_inspection" && value !== "after_error") throw new Error("Invalid retrieval stage");
  return value;
}
function quotes(value: unknown, source: string, minimum = 0, validate = assertNoSecrets): string[] {
  const result = texts(value, 8, 2000, minimum, validate);
  if (result.some((quote) => !source.includes(quote))) throw new Error("Retrieval quote is not an exact source excerpt");
  return result;
}
export function validatedTask(input: RetrievalTask): RetrievalTask {
  return { problem_statement: text(input?.problem_statement, 64_000, assertPublicRetrievalText) };
}

/** 只拼接来源字段，不改写、折叠空格或添加标签；供模型引用与确切子串校验。 */
export function sourceText(entry: RetrievalEntry): string {
  const candidate = parseCandidateSnapshot(entry.candidate);
  return [text(entry.title, 2000), ...texts(entry.applicability, 40, 2000),
    ...texts(entry.contraindications, 40, 2000), candidate.content].join("\n");
}
function validatedLibrary(library: RetrievalEntry[]): Map<string, RetrievalEntry> {
  if (!Array.isArray(library)) throw new Error("Invalid retrieval library");
  const entries = new Map<string, RetrievalEntry>();
  for (const entry of library) {
    sourceText(entry);
    if (entries.has(entry.candidate.id)) throw new Error("Duplicate retrieval candidate ID");
    entries.set(entry.candidate.id, entry);
  }
  return entries;
}

export function parseSearchCard(value: unknown, entry: RetrievalEntry): SearchCard {
  const source = sourceText(entry);
  const record = object(value, ["candidateId", "contentSha256", "mechanism", "triggers", "exclusions", "action", "stage", "keywords", "sourceQuotes"]);
  const candidateId = assertArtifactId(record.candidateId);
  if (candidateId !== entry.candidate.id || record.contentSha256 !== entry.candidate.contentSha256) throw new Error("Search card candidate binding mismatch");
  const keywords = texts(record.keywords, 32, 120, 1, assertPublicRetrievalText);
  if (keywords.some((keyword) => !/[a-z\p{Script=Han}]/iu.test(keyword))) throw new Error("Search keywords need Chinese or English terms");
  return { candidateId, contentSha256: entry.candidate.contentSha256, mechanism: text(record.mechanism, 2000, assertPublicRetrievalText),
    triggers: texts(record.triggers, 16, 1000, 0, assertPublicRetrievalText), exclusions: texts(record.exclusions, 16, 1000, 0, assertPublicRetrievalText), action: text(record.action, 2000, assertPublicRetrievalText),
    stage: stage(record.stage), keywords, sourceQuotes: quotes(record.sourceQuotes, source, 1, assertPublicRetrievalText) };
}

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const stopwords = new Set("a an the and or if for from to of in on with by at as is are be this that it its not should can could would will have has had do does did when then than into after before use using used code fix issue test tests error file run check need new current expected actual value values true false none return def self import class python please following function method 的 了 和 是 在 将 请 需要 问题 一个 进行 可以 以及".split(" "));
function terms(value: string): string[] {
  const normalized = value.toLowerCase();
  const english = normalized.match(/[a-z][a-z0-9_]*/g) ?? [];
  const chinese = Array.from(segmenter.segment(normalized))
    .filter((part) => part.isWordLike && /\p{Script=Han}/u.test(part.segment)).map((part) => part.segment);
  return [...english, ...chinese].filter((word) => word.length > 1 && !stopwords.has(word));
}

/** 独立 V2 BM25（k1=1.2、b=0.75）；只召回有词命中的有效检索卡，不改动 V1。 */
export function rankGuidance(input: RetrievalTask, library: RetrievalEntry[], cards: SearchCard[], limit = 8): RankedCandidate[] {
  const task = validatedTask(input);
  const entries = validatedLibrary(library);
  if (!Number.isInteger(limit) || limit < 1 || limit > 8 || !Array.isArray(cards)) throw new Error("Invalid retrieval limit or cards");
  const seen = new Set<string>();
  const docs = cards.map((value) => {
    const entry = entries.get(value.candidateId);
    if (!entry || seen.has(value.candidateId)) throw new Error("Unknown or duplicate search card");
    seen.add(value.candidateId);
    const card = parseSearchCard(value, entry);
    const words = terms([card.mechanism, ...card.triggers, ...card.exclusions, card.action, ...card.keywords].join("\n"));
    const frequencies = new Map<string, number>();
    for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    return { id: card.candidateId, length: words.length, frequencies };
  });
  const query = new Set(terms(task.problem_statement));
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length) || 1;
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) for (const word of doc.frequencies.keys()) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
  return docs.map((doc): RankedCandidate => {
    let score = 0, matchedTerms = 0;
    for (const word of query) {
      const frequency = doc.frequencies.get(word) ?? 0;
      if (!frequency) continue;
      matchedTerms++;
      const count = documentFrequency.get(word)!;
      const idf = Math.log(1 + (docs.length - count + 0.5) / (count + 0.5));
      score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.length / average));
    }
    return { id: doc.id, score, matchedTerms };
  }).filter((doc) => doc.matchedTerms > 0 && doc.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

function decisionsFrom(value: unknown, task: RetrievalTask, entries: RetrievalEntry[], complete: boolean): ApplicabilityDecision[] {
  const library = validatedLibrary(entries);
  if (!Array.isArray(value) || value.length > entries.length || (complete && value.length !== entries.length)) throw new Error("Every applicability candidate requires exactly one decision");
  const order = new Map(entries.map((entry, index) => [entry.candidate.id, index]));
  const seen = new Set<string>();
  const decisions = value.map((item): ApplicabilityDecision => {
    const record = object(item, ["candidateId", "verdict", "reason", "taskQuotes", "experienceQuotes", "contraindication", "stage", "redundantWith"]);
    const candidateId = assertArtifactId(record.candidateId);
    const entry = library.get(candidateId);
    if (!entry || seen.has(candidateId)) throw new Error("Unknown or duplicate applicability candidate");
    seen.add(candidateId);
    const verdict = record.verdict;
    if (verdict !== "direct" && verdict !== "general" && verdict !== "inapplicable" && verdict !== "unknown") throw new Error("Invalid applicability verdict");
    const contraindication = record.contraindication;
    if (contraindication !== "absent" && contraindication !== "present" && contraindication !== "unknown") throw new Error("Invalid contraindication assessment");
    const redundantWith = record.redundantWith === null ? null : assertArtifactId(record.redundantWith);
    if (redundantWith !== null && (!order.has(redundantWith) || order.get(redundantWith)! >= order.get(candidateId)!)) throw new Error("Redundancy must reference an earlier input candidate");
    return { candidateId, verdict, reason: text(record.reason, 2000), taskQuotes: quotes(record.taskQuotes, task.problem_statement, verdict === "direct" ? 1 : 0, assertPublicRetrievalText),
      experienceQuotes: quotes(record.experienceQuotes, sourceText(entry), verdict === "direct" ? 1 : 0),
      contraindication, stage: stage(record.stage), redundantWith };
  });
  return decisions.sort((a, b) => order.get(a.candidateId)! - order.get(b.candidateId)!);
}

/** 校验可观察的绑定和引句；不把文本结构校验等同于语义正确。 */
export function parseApplicability(value: string, input: RetrievalTask, entries: RetrievalEntry[]): ApplicabilityDecision[] {
  const task = validatedTask(input);
  const record = object(JSON.parse(text(value, 128_000)) as unknown, ["decisions"]);
  return decisionsFrom(record.decisions, task, entries, true);
}

export function selectGuidance(input: RetrievalTask, library: RetrievalEntry[], ranking: RankedCandidate[], decisions: ApplicabilityDecision[]): GuidanceSelection {
  const task = validatedTask(input);
  const entries = validatedLibrary(library);
  if (!Array.isArray(ranking) || ranking.length > 8) throw new Error("Invalid retrieval ranking");
  const seenRanks = new Set<string>();
  const rankedEntries = ranking.map((rank) => {
    object(rank, ["id", "score", "matchedTerms"]);
    const entry = entries.get(rank.id);
    if (!entry || seenRanks.has(rank.id) || !Number.isFinite(rank.score) || rank.score <= 0 || !Number.isSafeInteger(rank.matchedTerms) || rank.matchedTerms < 1) throw new Error("Invalid, unknown or duplicate ranked candidate");
    seenRanks.add(rank.id);
    return entry;
  });
  const checked = new Map(decisionsFrom(decisions, task, rankedEntries, false).map((decision) => [decision.candidateId, decision]));
  const result: GuidanceSelection = { candidate: null, selectedIds: [], reasons: [] };
  const sections: string[] = [], hashes = new Set<string>();
  let length = 0;
  const hasSelectedEquivalent = (decision: ApplicabilityDecision): boolean => {
    // 引用已验证为严格指向更早项，遍历不会形成循环。
    let previous = decision.redundantWith;
    while (previous !== null) {
      const ancestor = entries.get(previous)!;
      if (result.selectedIds.includes(previous) || hashes.has(ancestor.candidate.contentSha256)) return true;
      previous = checked.get(previous)?.redundantWith ?? null;
    }
    return false;
  };
  for (const entry of rankedEntries) {
    const candidate = entry.candidate, decision = checked.get(candidate.id);
    const section = `### Source guidance ${candidate.id}\n${candidate.content}`;
    const nextLength = length + (sections.length ? 2 : 0) + section.length;
    let rejection: string | null = null;
    if (!decision) rejection = "缺失适用性决策，未注入";
    else if (decision.verdict !== "direct") rejection = `未判为直接适用（${decision.verdict}）`;
    else if (decision.contraindication !== "absent") rejection = `禁忌条件未排除（${decision.contraindication}）`;
    else if (decision.stage !== "initial") rejection = `需要后续证据阶段（${decision.stage}）`;
    else if (hasSelectedEquivalent(decision)) rejection = "与已选经验冗余";
    else if (hashes.has(candidate.contentSha256)) rejection = "与已选经验正文重复";
    else if (result.selectedIds.length >= 2) rejection = "已达到两条注入上限";
    else if (nextLength > 9000) rejection = "完整正文将超过9000字符上限";
    const selected = rejection === null;
    result.reasons.push({ candidateId: candidate.id, selected, reason: [rejection ?? "直接适用且符合初始注入条件", decision?.reason].filter(Boolean).join("：") });
    if (selected) {
      result.selectedIds.push(candidate.id); sections.push(section); hashes.add(candidate.contentSha256); length = nextLength;
    }
  }
  if (sections.length) {
    const content = sections.join("\n\n"), contentSha256 = sha256Text(content);
    result.candidate = parseCandidateSnapshot({ id: `retrieved-v2-${contentSha256.slice(0, 24)}`, kind: "strategy", content, contentSha256, rendererVersion: 1 });
  }
  return result;
}
