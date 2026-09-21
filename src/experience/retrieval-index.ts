import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { sha256Json, sha256Text, type RunUsage } from "../evaluation/schema.js";
import type { ModelConfig } from "../model-config.js";
import type { ExperienceCandidate } from "./candidate.js";
import { assertArtifactId, stripUnsafeControls } from "./candidate.js";
import { assertRegularDirectory, isMissing, readArtifactText } from "./artifact-io.js";
import type { ExperienceBundle } from "./schema.js";
import { parseSynthesisUsage } from "./schema.js";
import { completeExperienceStage, type SynthesisResponse } from "./synthesizer.js";
import { INDEX_PROMPT } from "./retrieval-prompts.js";
import { parseSearchCard, sourceText, type RetrievalEntry, type SearchCard } from "./retrieval.js";

const GENERATOR_VERSION = 1;
const MAX_INDEX_BYTES = 256 * 1024;

export type RetrievalCompletion = (material: unknown, systemPrompt: string) => Promise<SynthesisResponse>;

export interface IndexModelOptions {
  model: { provider: string; id: string };
  dataDirectory: string;
  modelConfig?: ModelConfig;
  complete?: RetrievalCompletion;
}

export interface SearchIndexRecord {
  status: "pending" | "completed" | "failed";
  card: SearchCard | null;
  error: string | null;
  usage: RunUsage | null;
  entrySha256: string;
  model: { provider: string; id: string };
  generatorVersion: number;
  promptSha256: string;
}

export function createRetrievalCompletion(options: Omit<IndexModelOptions, "complete">): RetrievalCompletion {
  return (material, systemPrompt) => completeExperienceStage({
    model: options.model, dataDirectory: options.dataDirectory,
    ...(options.modelConfig ? { modelConfig: options.modelConfig } : {}), reasoning: "low"
  }, material, systemPrompt);
}

const inFlight = new Map<string, Promise<SearchIndexRecord>>();

function safeError(error: unknown): string {
  return stripUnsafeControls(redactSensitiveText(error instanceof Error ? error.message : String(error))).slice(0, 2_000) || "Search index generation failed";
}

function parseModel(value: unknown): { provider: string; id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid search index model binding");
  const model = value as Record<string, unknown>;
  if (typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) throw new Error("Invalid search index model binding");
  return { provider: model.provider, id: model.id };
}

function parseRecord(value: unknown, entry: RetrievalEntry): SearchIndexRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid search index record");
  const record = value as Record<string, unknown>;
  if (record.entrySha256 !== sha256Json(entry)) throw new Error("Search index entry binding hash does not match");
  if (record.generatorVersion !== GENERATOR_VERSION) throw new Error("Unsupported search index generator version");
  if (record.promptSha256 !== sha256Text(INDEX_PROMPT)) throw new Error("Search index prompt binding hash does not match");
  if (record.status !== "pending" && record.status !== "completed" && record.status !== "failed") throw new Error("Invalid search index status");
  const model = parseModel(record.model);
  const usage = record.usage === null ? null : parseSynthesisUsage(record.usage);
  if (record.status === "completed") {
    const card = parseSearchCard(record.card, entry);
    if (record.error !== null) throw new Error("Completed search index cannot contain an error");
    return { status: record.status, card, error: null, usage, entrySha256: record.entrySha256, model,
      generatorVersion: GENERATOR_VERSION, promptSha256: record.promptSha256 };
  }
  if (record.card !== null) throw new Error("Incomplete search index cannot contain a card");
  if (record.status === "failed" && (typeof record.error !== "string" || !record.error)) throw new Error("Failed search index must contain an error");
  if (record.status === "pending" && record.error !== null) throw new Error("Pending search index cannot contain an error");
  return { status: record.status, card: null, error: record.status === "failed" ? record.error as string : null,
    usage, entrySha256: record.entrySha256, model, generatorVersion: GENERATOR_VERSION, promptSha256: record.promptSha256 };
}

async function writeAtomic(filePath: string, value: SearchIndexRecord): Promise<void> {
  const temporary = join(dirname(filePath), `.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, filePath);
}

async function prepareIndexDirectory(filePath: string): Promise<void> {
  const experienceDirectory = dirname(dirname(filePath));
  await assertRegularDirectory(experienceDirectory);
  const retrievalDirectory = dirname(filePath);
  await mkdir(retrievalDirectory, { recursive: true });
  await assertRegularDirectory(retrievalDirectory);
}

export function toRetrievalEntry(candidate: ExperienceCandidate): RetrievalEntry {
  return { title: candidate.title, applicability: [...candidate.applicability], contraindications: [...candidate.contraindications],
    candidate: { id: candidate.id, kind: candidate.kind, content: candidate.content, contentSha256: candidate.contentSha256, rendererVersion: candidate.rendererVersion } };
}

export function candidateIndexPath(candidate: ExperienceCandidate, dataDirectory: string): string {
  return join(dataDirectory, "experiences", assertArtifactId(candidate.sourceExperienceId), "retrieval", `${assertArtifactId(candidate.id)}.json`);
}

export async function loadSearchIndex(entry: RetrievalEntry, filePath: string): Promise<SearchIndexRecord | null> {
  try {
    await assertRegularDirectory(dirname(dirname(filePath)));
    await assertRegularDirectory(dirname(filePath));
    const source = await readArtifactText(filePath, MAX_INDEX_BYTES);
    let value: unknown;
    try { value = JSON.parse(source); } catch { throw new Error("Cannot parse search index JSON"); }
    return parseRecord(value, entry);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function generateIndex(entry: RetrievalEntry, filePath: string, options: IndexModelOptions): Promise<SearchIndexRecord> {
  sourceText(entry);
  await prepareIndexDirectory(filePath);
  const existing = await loadSearchIndex(entry, filePath);
  if (existing) return existing;
  const base = { entrySha256: sha256Json(entry), model: { ...options.model }, generatorVersion: GENERATOR_VERSION,
    promptSha256: sha256Text(INDEX_PROMPT) };
  const pending: SearchIndexRecord = { ...base, status: "pending", card: null, error: null, usage: null };
  try {
    await writeFile(filePath, `${JSON.stringify(pending, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const raced = await loadSearchIndex(entry, filePath);
    if (!raced) throw new Error("Search index disappeared during concurrent generation");
    return raced;
  }
  let final: SearchIndexRecord;
  let usage: RunUsage | null = null;
  try {
    const materialLength = JSON.stringify(entry).length;
    if (materialLength > 64_000) throw new Error("Search index material exceeds the 64000 character size limit");
    const complete = options.complete ?? createRetrievalCompletion(options);
    const response = await complete(entry, INDEX_PROMPT);
    usage = response.usage ? parseSynthesisUsage(response.usage) : null;
    if (response.error) throw new Error(response.error);
    const card = parseSearchCard(JSON.parse(response.text) as unknown, entry);
    final = { ...base, status: "completed", card, error: null, usage };
  } catch (error) {
    final = { ...base, status: "failed", card: null, error: safeError(error), usage };
  }
  await writeAtomic(filePath, final);
  return final;
}

export async function ensureSearchIndex(entry: RetrievalEntry, filePath: string, options: IndexModelOptions): Promise<SearchIndexRecord> {
  const current = inFlight.get(filePath);
  if (current) return parseRecord(await current, entry);
  const operation = generateIndex(entry, filePath, options).finally(() => inFlight.delete(filePath));
  inFlight.set(filePath, operation);
  return await operation;
}

export async function indexExperience(bundle: ExperienceBundle, dataDirectory: string,
  options: { complete?: RetrievalCompletion; modelConfig?: ModelConfig } = {}): Promise<void> {
  await Promise.all(bundle.candidates.map(async (candidate) => {
    const entry = toRetrievalEntry(candidate);
    await ensureSearchIndex(entry, candidateIndexPath(candidate, dataDirectory), {
      model: bundle.synthesis.model, dataDirectory, ...(options.modelConfig ? { modelConfig: options.modelConfig } : {}),
      ...(options.complete ? { complete: options.complete } : {})
    });
  }));
}
