import { randomUUID } from "node:crypto";
import { sha256Json, sha256Text } from "../evaluation/schema.js";
import { loadRunBundle } from "../evaluation/store.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { assertRegularDirectory } from "./artifact-io.js";
import { join } from "node:path";
import { classifyRun, type ReviewSelection } from "./classifier.js";
import { collectEvidence } from "./evidence.js";
import { parseExperienceBundle, parseSynthesisOutput, parseSynthesisUsage, type ExperienceBundle } from "./schema.js";
import { stripUnsafeControls } from "./candidate.js";
import { saveExperience } from "./store.js";
import { synthesizeExperience, type Synthesize } from "./synthesizer.js";
import { parseReviewOutput, reviewExperience, toProposal, type Review, type ReviewMode } from "./review.js";
import { indexExperience, type RetrievalCompletion } from "./retrieval-index.js";
import type { ModelConfig } from "../model-config.js";

export type IndexExperience = (bundle: ExperienceBundle, dataDirectory: string,
  options?: { complete?: RetrievalCompletion; modelConfig?: ModelConfig }) => Promise<void>;
export interface AnalyzeOptions extends ReviewSelection {
  synthesize?: Synthesize;
  review?: Review;
  reviewMode?: ReviewMode;
  index?: IndexExperience;
  indexComplete?: RetrievalCompletion;
  modelConfig?: ModelConfig;
}

function safeError(error: unknown): string {
  return stripUnsafeControls(redactSensitiveText(error instanceof Error ? error.message : String(error))).slice(0, 2_000) || "Experience stage failed";
}

export async function analyzeRun(runId: string, dataDirectory: string, dependencies: AnalyzeOptions = {}): Promise<ExperienceBundle> {
  const mode = dependencies.reviewMode ?? "proposer";
  if (!["proposer", "critic", "compare"].includes(mode)) throw new Error("Invalid review mode");
  // Verify roots before the older run store can traverse them.
  await assertRegularDirectory(dataDirectory);
  await assertRegularDirectory(join(dataDirectory, "runs"));
  const source = await loadRunBundle(runId, dataDirectory);
  const collected = await collectEvidence(source, dataDirectory);
  const observation = classifyRun(source, collected, dependencies);
  const now = new Date().toISOString();
  let bundle: ExperienceBundle = {
    schemaVersion: 2, id: randomUUID(), createdAt: now, sourceRunId: source.manifest.runId, sourceRepository: source.manifest.sourceRepository,
    sourceManifestSha256: sha256Json(source.manifest), ...(source.result ? { sourceResultSha256: sha256Json(source.result) } : {}),
    taskSha256: source.manifest.task.sha256, observation, evidence: collected.evidence, warnings: collected.warnings, candidates: [],
    synthesis: { status: "skipped", generatorVersion: 2, model: { ...source.manifest.agent.model }, thinkingLevel: "high", startedAt: now, completedAt: now }
  };
  if (observation.eligibility === "eligible") {
    try {
      const response = await (dependencies.synthesize ?? synthesizeExperience)({ observation, evidence: collected.evidence, model: source.manifest.agent.model, dataDirectory,
        ...(dependencies.modelConfig ? { modelConfig: dependencies.modelConfig } : {}) });
      if (response.usage) bundle.synthesis.usage = parseSynthesisUsage(response.usage);
      if (response.error) throw new Error(response.error);
      const proposed = parseSynthesisOutput(response.text, collected.evidence);
      bundle = { ...bundle, ...proposed, candidates: proposed.candidates.map((candidate) => ({ ...candidate, id: randomUUID(),
        sourceRunId: source.manifest.runId, sourceExperienceId: bundle.id, createdAt: now, contentSha256: sha256Text(candidate.content), rendererVersion: 1 })),
      synthesis: { ...bundle.synthesis, status: "completed", completedAt: new Date().toISOString() } };
      // Treat invalid structured model metadata exactly like malformed text, before any candidate can be stored.
      bundle = parseExperienceBundle(bundle);
    } catch (error) {
      delete bundle.card;
      delete bundle.noCandidateReason;
      bundle.candidates = [];
      bundle.synthesis = { ...bundle.synthesis, status: "failed", error: safeError(error), completedAt: new Date().toISOString() };
    }
  }
  bundle = parseExperienceBundle(bundle);
  if (mode !== "proposer") {
    let proposerBinding = {};
    if (mode === "compare") {
      await saveExperience(bundle, dataDirectory);
      try {
        const index = dependencies.index ?? indexExperience;
        await index(bundle, dataDirectory, { ...(dependencies.indexComplete ? { complete: dependencies.indexComplete } : {}),
          ...(dependencies.modelConfig ? { modelConfig: dependencies.modelConfig } : {}) });
      } catch { /* Index failure is retained in its sidecar when possible; experience evidence remains valid. */ }
      proposerBinding = { proposerExperienceId: bundle.id, proposerExperienceSha256: sha256Json(bundle) };
      const id = randomUUID();
      bundle = { ...bundle, id, candidates: bundle.candidates.map((candidate) => ({ ...candidate, id: randomUUID(), sourceExperienceId: id })) };
    }
    const proposals = bundle.candidates.map(toProposal);
    const reviewStarted = new Date().toISOString();
    bundle.review = { mode, status: "skipped", proposals, proposalsSha256: sha256Json(proposals), decisions: [],
      startedAt: reviewStarted, completedAt: reviewStarted, ...proposerBinding };
    if (proposals.length && bundle.card) {
      try {
        const response = await (dependencies.review ?? reviewExperience)({ observation, evidence: collected.evidence, model: source.manifest.agent.model,
          dataDirectory, ...(dependencies.modelConfig ? { modelConfig: dependencies.modelConfig } : {}),
          proposals: structuredClone(proposals), card: structuredClone(bundle.card) });
        if (response.usage) bundle.review.usage = parseSynthesisUsage(response.usage);
        if (response.error) throw new Error(response.error);
        const decisions = parseReviewOutput(response.text, proposals, collected.evidence);
        bundle.review.status = "completed";
        bundle.review.decisions = decisions;
        bundle.candidates = bundle.candidates.filter((_candidate, index) => decisions.some((decision) => decision.candidateIndex === index && decision.verdict === "accept"));
        if (!bundle.candidates.length) bundle.noCandidateReason = "Critic 拒绝了全部提案，审查理由保留供复核。";
      } catch (error) {
        bundle.review.status = "failed";
        bundle.review.error = safeError(error);
        bundle.review.decisions = [];
        bundle.candidates = [];
        bundle.noCandidateReason = "Critic 未能完成有效审查，本次不放行候选。";
      }
      bundle.review.completedAt = new Date().toISOString();
    }
  }
  bundle = parseExperienceBundle(bundle);
  await saveExperience(bundle, dataDirectory);
  try {
    const index = dependencies.index ?? indexExperience;
    await index(bundle, dataDirectory, { ...(dependencies.indexComplete ? { complete: dependencies.indexComplete } : {}),
      ...(dependencies.modelConfig ? { modelConfig: dependencies.modelConfig } : {}) });
  } catch { /* Search indexing is supplementary and must not invalidate an immutable experience. */ }
  return bundle;
}
