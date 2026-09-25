import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { listActiveCandidates } from "../experience/promotions.js";
import { selectTaskExperience } from "../experience/retrieval-service.js";
import { toRetrievalEntry } from "../experience/retrieval-index.js";
import { loadCandidate } from "../experience/store.js";
import { assertArtifactId, parseCandidateSnapshot, renderCandidatePrompt, type ExperienceCandidate } from "../experience/candidate.js";
import type { ModelConfig } from "../model-config.js";
import { formatTaskPrompt } from "../task/task-spec.js";
import { resolveGitRoot } from "../workspace/git.js";
import { assertRecordableTask } from "./redaction.js";
import { loadRunBundle } from "./store.js";
import { parseReplayExperience, sha256Json, sha256Text,
  type ReplayExperienceContext, type RunManifest } from "./schema.js";

interface ReplayExperienceDependencies {
  loadCandidate?: typeof loadCandidate;
  loadRunBundle?: typeof loadRunBundle;
  listActiveCandidates?: typeof listActiveCandidates;
  selectTaskExperience?: typeof selectTaskExperience;
}

async function repositoryIdentity(path: string): Promise<string> {
  const canonical = await realpath(await resolveGitRoot(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** Resolve a fixed candidate pool, then freeze the task-based decision before any replay prompt. */
export async function selectReplayExperience(
  source: RunManifest,
  dataDirectory: string,
  candidateIds: string[],
  modelConfig?: ModelConfig,
  dependencies: ReplayExperienceDependencies = {}
): Promise<ReplayExperienceContext> {
  if (source.kind !== "run" || source.experiment || source.replayExperience) {
    throw new Error("Task-based replay selection requires a plain original run; experimental and replay inputs are frozen");
  }
  if (!source.task.content.verify.length) throw new Error("Task-based replay selection requires a configured verifier");
  assertRecordableTask(source.task.content);
  const getCandidate = dependencies.loadCandidate ?? loadCandidate;
  const getRun = dependencies.loadRunBundle ?? loadRunBundle;
  const getActive = dependencies.listActiveCandidates ?? listActiveCandidates;
  const select = dependencies.selectTaskExperience ?? selectTaskExperience;
  const repository = await repositoryIdentity(source.sourceRepository);
  const pool = async (): Promise<ExperienceCandidate[]> => {
    const candidates = candidateIds.length
      ? await Promise.all(candidateIds.map((id) => getCandidate(id, dataDirectory)))
      : await getActive(source.sourceRepository, dataDirectory);
    const sorted = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(sorted.map((item) => item.id)).size !== sorted.length) throw new Error("Duplicate replay candidate ID");
    for (const candidate of sorted) {
      parseCandidateSnapshot(candidate);
      const evidence = await getRun(candidate.sourceRunId, dataDirectory);
      if (await repositoryIdentity(evidence.manifest.sourceRepository) !== repository) {
        throw new Error(`Replay candidate ${candidate.id} belongs to another repository`);
      }
    }
    return sorted;
  };
  const candidates = await pool();
  const poolSha256 = sha256Json(candidates);
  const selection = await select({ objective: source.task.content.objective, candidates, dataDirectory,
    model: { ...source.agent.model }, ...(modelConfig ? { modelConfig } : {}) });
  if (sha256Json(await pool()) !== poolSha256) throw new Error("Replay candidate pool changed during selection");
  assertArtifactId(selection.auditId);
  const auditPath = join(dataDirectory, "reports", "retrieval", `${selection.auditId}.json`);
  const auditText = await readFile(auditPath, "utf8");
  const audit = JSON.parse(auditText) as { auditId?: unknown; status?: unknown; querySha256?: unknown;
    poolSha256?: unknown; selection?: { selectedIds?: unknown; candidate?: unknown } };
  if (audit.auditId !== selection.auditId || audit.status !== selection.status ||
    audit.querySha256 !== sha256Text(source.task.content.objective) ||
    audit.poolSha256 !== sha256Json(candidates.map(toRetrievalEntry)) ||
    sha256Json(audit.selection?.selectedIds) !== sha256Json(selection.selectedIds) ||
    sha256Json(audit.selection?.candidate) !== sha256Json(selection.candidate)) {
    throw new Error("Replay experience selection audit does not match the frozen decision");
  }
  if (selection.selectedIds.some((id) => !candidates.some((candidate) => candidate.id === id))) {
    throw new Error("Replay experience selected an unknown candidate");
  }
  const basePrompt = formatTaskPrompt(source.task.content, source.task.content.objective);
  const effectivePromptSha256 = sha256Text(selection.candidate
    ? renderCandidatePrompt(basePrompt, selection.candidate) : basePrompt);
  return parseReplayExperience({ mode: "auto", status: selection.status, poolSha256, auditId: selection.auditId,
    auditSha256: sha256Text(auditText), selectedIds: selection.selectedIds,
    ...(selection.candidate ? { candidate: selection.candidate } : {}), effectivePromptSha256 }, source.task.content);
}
