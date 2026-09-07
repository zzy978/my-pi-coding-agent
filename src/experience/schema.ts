import { isAbsolute } from "node:path";
import { sha256Text, type RunUsage } from "../evaluation/schema.js";
import { assertArtifactId, assertNoSecrets, parseCandidateSnapshot, type CandidateKind, type ExperienceCandidate } from "./candidate.js";

export type FailureCategory = "none" | "no_verifier" | "setup_failed" | "tool_failed" | "execution_failed" | "verifier_failed" | "verifier_timeout" | "scope_violation" | "unknown";

export interface FailureObservation {
  eligibility: "eligible" | "inconclusive" | "ignored";
  category: FailureCategory;
  stage: "setup" | "execution" | "verification" | "unknown";
  summary: string;
  evidenceRefs: string[];
}

export interface EvidenceItem { ref: string; excerpt: string; sha256: string }
export interface ExperienceCard {
  title: string;
  pattern: string;
  hypotheses: Array<{ text: string; confidence: number; evidenceRefs: string[] }>;
  lessons: string[];
  applicability: string[];
  contraindications: string[];
}

export interface SynthesisMetadata {
  status: "completed" | "skipped" | "failed";
  generatorVersion: 1;
  model: { provider: string; id: string };
  thinkingLevel: string;
  startedAt: string;
  completedAt: string;
  usage?: RunUsage;
  error?: string;
}

export interface ExperienceBundle {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  sourceRunId: string;
  sourceRepository: string;
  sourceManifestSha256: string;
  sourceResultSha256?: string;
  taskSha256: string;
  observation: FailureObservation;
  evidence: EvidenceItem[];
  warnings: string[];
  card?: ExperienceCard;
  candidates: ExperienceCandidate[];
  synthesis: SynthesisMetadata;
}

export interface CandidateProposal {
  kind: CandidateKind;
  title: string;
  content: string;
  applicability: string[];
  contraindications: string[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(record: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields`);
}

function text(value: unknown, label: string, limit = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`${label} has invalid length`);
  assertNoSecrets(value);
  return value;
}

function strings(value: unknown, label: string, maximum = 20, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) throw new Error(`${label} must be a bounded array`);
  return value.map((item) => text(item, label));
}

function timestamp(value: unknown): string {
  const result = text(value, "timestamp", 40);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error("Timestamp must be ISO-8601 UTC");
  return result;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid SHA-256 hash");
  return value;
}

function evidenceReferences(value: unknown, evidence: EvidenceItem[]): string[] {
  const refs = strings(value, "evidenceRefs", 80);
  if (refs.some((ref) => !evidence.some((item) => item.ref === ref))) throw new Error("Unknown evidence reference");
  return refs;
}

function parseCard(value: unknown, evidence: EvidenceItem[]): ExperienceCard {
  const record = object(value, "card");
  keys(record, ["title", "pattern", "hypotheses", "lessons", "applicability", "contraindications"], "card");
  if (!Array.isArray(record.hypotheses) || record.hypotheses.length < 1 || record.hypotheses.length > 8) throw new Error("Card requires 1-8 hypotheses");
  return {
    title: text(record.title, "card.title", 200), pattern: text(record.pattern, "card.pattern"),
    hypotheses: record.hypotheses.map((item) => {
      const hypothesis = object(item, "hypothesis");
      keys(hypothesis, ["text", "confidence", "evidenceRefs"], "hypothesis");
      if (typeof hypothesis.confidence !== "number" || !Number.isFinite(hypothesis.confidence) || hypothesis.confidence < 0 || hypothesis.confidence > 1) throw new Error("Hypothesis confidence must be between 0 and 1");
      return { text: text(hypothesis.text, "hypothesis.text"), confidence: hypothesis.confidence, evidenceRefs: evidenceReferences(hypothesis.evidenceRefs, evidence) };
    }),
    lessons: strings(record.lessons, "lessons"), applicability: strings(record.applicability, "applicability"),
    contraindications: strings(record.contraindications, "contraindications")
  };
}

export function parseSynthesisOutput(source: string, evidence: EvidenceItem[]): { card: ExperienceCard; candidates: CandidateProposal[] } {
  if (source.length > 64_000) throw new Error("Synthesis output exceeds size limit");
  assertNoSecrets(source);
  // Unwrap only a complete response fence; never extract JSON from surrounding prose.
  const trimmed = source.trim();
  const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*)\r?\n```$/i.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("Synthesis output is not strict JSON (expected a JSON object or one complete JSON code fence)"); }
  const record = object(parsed, "synthesis");
  keys(record, ["card", "candidates"], "synthesis");
  if (!Array.isArray(record.candidates) || record.candidates.length < 1 || record.candidates.length > 3) throw new Error("Synthesis must propose 1-3 candidates");
  const candidates = record.candidates.map((item): CandidateProposal => {
    const candidate = object(item, "candidate proposal");
    keys(candidate, ["kind", "title", "content", "applicability", "contraindications"], "candidate proposal");
    if (candidate.kind !== "prompt" && candidate.kind !== "skill" && candidate.kind !== "strategy") throw new Error("Candidate kind is invalid");
    return { kind: candidate.kind, title: text(candidate.title, "candidate.title", 200), content: text(candidate.content, "candidate.content", 16_384),
      applicability: strings(candidate.applicability, "candidate.applicability"), contraindications: strings(candidate.contraindications, "candidate.contraindications") };
  });
  return { card: parseCard(record.card, evidence), candidates };
}

export function parseExperienceCandidate(value: unknown): ExperienceCandidate {
  const record = object(value, "candidate");
  return { ...parseCandidateSnapshot(value), sourceRunId: assertArtifactId(record.sourceRunId), sourceExperienceId: assertArtifactId(record.sourceExperienceId),
    createdAt: timestamp(record.createdAt), title: text(record.title, "candidate.title", 200), applicability: strings(record.applicability, "candidate.applicability"),
    contraindications: strings(record.contraindications, "candidate.contraindications") };
}

export function parseSynthesisUsage(value: unknown): RunUsage {
  const record = object(value, "usage");
  const number = (key: string): number => {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "cost" && !Number.isSafeInteger(value))) throw new Error("Invalid synthesis usage");
    return value;
  };
  return { input: number("input"), output: number("output"), cacheRead: number("cacheRead"), cacheWrite: number("cacheWrite"), total: number("total"), cost: number("cost") };
}

export function parseExperienceBundle(value: unknown): ExperienceBundle {
  const record = object(value, "experience");
  if (record.schemaVersion !== 1) throw new Error("Unsupported experience schema version");
  const id = assertArtifactId(record.id);
  const sourceRunId = assertArtifactId(record.sourceRunId);
  const sourceRepository = text(record.sourceRepository, "sourceRepository");
  if (!isAbsolute(sourceRepository)) throw new Error("Source repository must be absolute");
  if (!Array.isArray(record.evidence) || record.evidence.length > 80 || record.evidence.length === 0) throw new Error("Experience evidence must be bounded and non-empty");
  const evidence = record.evidence.map((item): EvidenceItem => {
    const evidence = object(item, "evidence");
    const excerpt = text(evidence.excerpt, "evidence excerpt", 4_000);
    const digest = hash(evidence.sha256);
    if (sha256Text(excerpt) !== digest) throw new Error("Evidence hash mismatch");
    return { ref: text(evidence.ref, "evidence ref", 200), excerpt, sha256: digest };
  });
  if (new Set(evidence.map((item) => item.ref)).size !== evidence.length) throw new Error("Duplicate evidence reference");
  const observation = object(record.observation, "observation");
  const eligibility = observation.eligibility;
  if (eligibility !== "eligible" && eligibility !== "inconclusive" && eligibility !== "ignored") throw new Error("Invalid observation eligibility");
  const category = observation.category as FailureCategory;
  if (!["none", "no_verifier", "setup_failed", "tool_failed", "execution_failed", "verifier_failed", "verifier_timeout", "scope_violation", "unknown"].includes(category)) throw new Error("Invalid failure category");
  const stage = observation.stage;
  if (stage !== "setup" && stage !== "execution" && stage !== "verification" && stage !== "unknown") throw new Error("Invalid failure stage");
  const synthesis = object(record.synthesis, "synthesis metadata");
  if (synthesis.status !== "completed" && synthesis.status !== "failed" && synthesis.status !== "skipped") throw new Error("Invalid synthesis status");
  if (synthesis.generatorVersion !== 1) throw new Error("Unsupported generator version");
  const model = object(synthesis.model, "generator model");
  if (!Array.isArray(record.candidates) || record.candidates.length > 3) throw new Error("Invalid experience candidates");
  const candidates = record.candidates.map(parseExperienceCandidate);
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) throw new Error("Duplicate candidate ID");
  if (candidates.some((candidate) => candidate.sourceRunId !== sourceRunId || candidate.sourceExperienceId !== id)) throw new Error("Candidate source binding mismatch");
  const card = record.card === undefined ? undefined : parseCard(record.card, evidence);
  if (synthesis.status === "completed" ? (!card || candidates.length === 0 || eligibility !== "eligible") : (card !== undefined || candidates.length !== 0)) throw new Error("Synthesis status contradicts its card or candidates");
  if (eligibility === "eligible" && ["none", "no_verifier", "setup_failed"].includes(category)) throw new Error("Insufficient evidence cannot be eligible");
  return {
    schemaVersion: 1, id, createdAt: timestamp(record.createdAt), sourceRunId, sourceRepository,
    sourceManifestSha256: hash(record.sourceManifestSha256), ...(record.sourceResultSha256 === undefined ? {} : { sourceResultSha256: hash(record.sourceResultSha256) }),
    taskSha256: hash(record.taskSha256), observation: { eligibility, category, stage, summary: text(observation.summary, "observation.summary"), evidenceRefs: evidenceReferences(observation.evidenceRefs, evidence) },
    evidence, warnings: strings(record.warnings, "warnings", 20, true), ...(card ? { card } : {}), candidates,
    synthesis: { status: synthesis.status, generatorVersion: 1, model: { provider: text(model.provider, "model.provider", 200), id: text(model.id, "model.id", 200) },
      thinkingLevel: text(synthesis.thinkingLevel, "thinkingLevel", 100), startedAt: timestamp(synthesis.startedAt), completedAt: timestamp(synthesis.completedAt),
      ...(synthesis.usage === undefined ? {} : { usage: parseSynthesisUsage(synthesis.usage) }), ...(synthesis.error === undefined ? {} : { error: text(synthesis.error, "synthesis.error", 2000) }) }
  };
}
