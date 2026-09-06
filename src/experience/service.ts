import { randomUUID } from "node:crypto";
import { sha256Json, sha256Text } from "../evaluation/schema.js";
import { loadRunBundle } from "../evaluation/store.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { assertRegularDirectory } from "./artifact-io.js";
import { join } from "node:path";
import { classifyFailure } from "./classifier.js";
import { collectEvidence } from "./evidence.js";
import { parseExperienceBundle, parseSynthesisOutput, parseSynthesisUsage, type ExperienceBundle } from "./schema.js";
import { stripUnsafeControls } from "./candidate.js";
import { saveExperience } from "./store.js";
import { synthesizeExperience, type Synthesize } from "./synthesizer.js";

export async function analyzeRun(runId: string, dataDirectory: string, dependencies: { synthesize?: Synthesize } = {}): Promise<ExperienceBundle> {
  // Verify roots before the older run store can traverse them.
  await assertRegularDirectory(dataDirectory);
  await assertRegularDirectory(join(dataDirectory, "runs"));
  const source = await loadRunBundle(runId, dataDirectory);
  const collected = await collectEvidence(source, dataDirectory);
  const observation = classifyFailure(source, collected);
  const now = new Date().toISOString();
  let bundle: ExperienceBundle = {
    schemaVersion: 1, id: randomUUID(), createdAt: now, sourceRunId: source.manifest.runId, sourceRepository: source.manifest.sourceRepository,
    sourceManifestSha256: sha256Json(source.manifest), ...(source.result ? { sourceResultSha256: sha256Json(source.result) } : {}),
    taskSha256: source.manifest.task.sha256, observation, evidence: collected.evidence, warnings: collected.warnings, candidates: [],
    synthesis: { status: "skipped", generatorVersion: 1, model: { ...source.manifest.agent.model }, thinkingLevel: "low", startedAt: now, completedAt: now }
  };
  if (observation.eligibility === "eligible") {
    try {
      const response = await (dependencies.synthesize ?? synthesizeExperience)({ observation, evidence: collected.evidence, model: source.manifest.agent.model, dataDirectory });
      if (response.usage) bundle.synthesis.usage = parseSynthesisUsage(response.usage);
      if (response.error) throw new Error(response.error);
      const proposed = parseSynthesisOutput(response.text, collected.evidence);
      bundle = { ...bundle, card: proposed.card, candidates: proposed.candidates.map((candidate) => ({ ...candidate, id: randomUUID(),
        sourceRunId: source.manifest.runId, sourceExperienceId: bundle.id, createdAt: now, contentSha256: sha256Text(candidate.content), rendererVersion: 1 })),
      synthesis: { ...bundle.synthesis, status: "completed", completedAt: new Date().toISOString() } };
      // Treat invalid structured model metadata exactly like malformed text, before any candidate can be stored.
      bundle = parseExperienceBundle(bundle);
    } catch (error) {
      const safeError = stripUnsafeControls(redactSensitiveText(error instanceof Error ? error.message : String(error))).slice(0, 2_000);
      delete bundle.card;
      bundle.candidates = [];
      bundle.synthesis = { ...bundle.synthesis, status: "failed", error: safeError || "Synthesis failed", completedAt: new Date().toISOString() };
    }
  }
  bundle = parseExperienceBundle(bundle);
  await saveExperience(bundle, dataDirectory);
  return bundle;
}
