import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256Json } from "../evaluation/schema.js";
import { loadRunBundle } from "../evaluation/store.js";
import { loadExperiment } from "../experiment/store.js";
import type { ExperimentBundle, ExperimentOutcome } from "../experiment/schema.js";
import { assertRegularDirectory, isMissing } from "./artifact-io.js";
import { loadExperience } from "./store.js";
import { toProposal } from "./review.js";

export interface ProposalEvaluation {
  index: number;
  proposerCandidateId: string;
  criticCandidateId?: string;
  decision: "accept" | "reject" | "unavailable";
  experiments: Array<{ id: string; outcome: ExperimentOutcome; pairsCompleted: number; cost: number }>;
  assessment: "untested" | "observed_improvement" | "observed_regression" | "no_observed_gain" | "inconclusive";
}
interface PipelineMetrics { candidates: number; evaluatedCandidates: number; improvedCandidates: number; regressedCandidates: number }
export interface ReviewComparison {
  proposerExperienceId: string;
  criticExperienceId: string;
  criticStatus: string;
  proposer: PipelineMetrics;
  critic: PipelineMetrics;
  proposals: ProposalEvaluation[];
  proposerCost: number | null;
  criticCost: number | null;
  retrospectiveAvoidableEvaluationCost: number | null;
  qualityComparisonAvailable: boolean;
  unavailableExperimentIds: string[];
  limitations: string[];
}

async function experimentsForComparison(dataDirectory: string): Promise<{ experiments: ExperimentBundle[]; unavailable: string[] }> {
  const root = join(dataDirectory, "experiments");
  let entries;
  try {
    await assertRegularDirectory(root);
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) { if (isMissing(error)) return { experiments: [], unavailable: [] }; throw error; }
  if (entries.length > 10_000) throw new Error("Too many experiments for bounded comparison");
  const experiments: ExperimentBundle[] = [];
  const unavailable: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try { experiments.push(await loadExperiment(entry.name, dataDirectory)); }
    catch { unavailable.push(entry.name); }
  }
  return { experiments, unavailable };
}

function metrics(proposals: ProposalEvaluation[]): PipelineMetrics {
  const evaluated = proposals.filter((proposal) => ["observed_improvement", "observed_regression", "no_observed_gain"].includes(proposal.assessment));
  return { candidates: proposals.length, evaluatedCandidates: evaluated.length,
    improvedCandidates: evaluated.filter((proposal) => proposal.assessment === "observed_improvement").length,
    regressedCandidates: evaluated.filter((proposal) => proposal.assessment === "observed_regression").length };
}

/** Shadow comparison: evaluates the same fixed proposals before and after critic filtering. */
export async function compareReviewPipelines(experienceId: string, dataDirectory: string): Promise<ReviewComparison> {
  const critic = await loadExperience(experienceId, dataDirectory);
  const review = critic.review;
  if (review?.mode !== "compare" || !review.proposerExperienceId) throw new Error("Experience is not a paired review comparison");
  const proposer = await loadExperience(review.proposerExperienceId, dataDirectory);
  if (proposer.review || sha256Json(proposer) !== review.proposerExperienceSha256 ||
    proposer.sourceRunId !== critic.sourceRunId || proposer.sourceManifestSha256 !== critic.sourceManifestSha256 ||
    proposer.sourceResultSha256 !== critic.sourceResultSha256 || proposer.sourceRepository !== critic.sourceRepository || proposer.taskSha256 !== critic.taskSha256 ||
    sha256Json(proposer.evidence) !== sha256Json(critic.evidence) || sha256Json(proposer.card ?? null) !== sha256Json(critic.card ?? null) ||
    sha256Json(proposer.synthesis) !== sha256Json(critic.synthesis) ||
    sha256Json(proposer.candidates.map(toProposal)) !== review.proposalsSha256) throw new Error("Review comparison source binding mismatch");
  const source = await loadRunBundle(proposer.sourceRunId, dataDirectory);
  if (sha256Json(source.manifest) !== proposer.sourceManifestSha256 ||
    (source.result ? sha256Json(source.result) : undefined) !== proposer.sourceResultSha256) throw new Error("Review comparison run evidence changed");
  const { experiments, unavailable } = await experimentsForComparison(dataDirectory);
  const acceptedIndices = review.decisions.filter((decision) => decision.verdict === "accept").map((decision) => decision.candidateIndex);
  const proposals = proposer.candidates.map((candidate, index): ProposalEvaluation => {
    const decision = review.decisions.find((decision) => decision.candidateIndex === index)?.verdict ?? "unavailable";
    const reviewed = decision === "accept" ? critic.candidates[acceptedIndices.indexOf(index)] : undefined;
    const matching = experiments.filter((experiment) => experiment.sourceRepository === proposer.sourceRepository &&
      (experiment.candidate.id === candidate.id || experiment.candidate.id === reviewed?.id) &&
      experiment.candidate.contentSha256 === candidate.contentSha256 && experiment.candidate.kind === candidate.kind &&
      experiment.candidate.rendererVersion === candidate.rendererVersion);
    const assessed = matching.filter((experiment) => experiment.pairsCompleted >= 3 && ["observed_improvement", "no_observed_gain", "observed_regression"].includes(experiment.outcome));
    const uncertain = matching.some((experiment) => experiment.pairsCompleted < 3 || ["inconclusive", "invalid_isolation"].includes(experiment.outcome));
    const assessment = assessed.some((experiment) => experiment.outcome === "observed_regression") ? "observed_regression"
      : uncertain ? "inconclusive" : !assessed.length ? "untested"
      : assessed.some((experiment) => experiment.outcome === "observed_improvement") ? "observed_improvement" : "no_observed_gain";
    return { index, proposerCandidateId: candidate.id, ...(reviewed ? { criticCandidateId: reviewed.id } : {}), decision, assessment,
      experiments: matching.map((experiment) => ({ id: experiment.id, outcome: experiment.outcome, pairsCompleted: experiment.pairsCompleted,
        cost: experiment.metrics.control.cost + experiment.metrics.treatment.cost })) };
  });
  const rejected = proposals.filter((proposal) => proposal.decision === "reject");
  const known = (proposal: ProposalEvaluation): boolean => !["untested", "inconclusive"].includes(proposal.assessment);
  return {
    proposerExperienceId: proposer.id, criticExperienceId: critic.id, criticStatus: review.status,
    proposer: metrics(proposals), critic: metrics(proposals.filter((proposal) => proposal.decision === "accept")), proposals,
    proposerCost: proposer.synthesis.usage?.cost ?? (proposer.synthesis.status === "skipped" ? 0 : null),
    criticCost: review.usage?.cost ?? (review.status === "skipped" ? 0 : null),
    retrospectiveAvoidableEvaluationCost: review.status === "completed" && unavailable.length === 0 && rejected.every(known)
      ? rejected.reduce((sum, proposal) => sum + proposal.experiments.reduce((cost, experiment) => cost + experiment.cost, 0), 0) : null,
    qualityComparisonAvailable: review.status === "completed" && proposals.length > 0 && unavailable.length === 0 && proposals.every(known),
    unavailableExperimentIds: unavailable,
    limitations: [
      "同批提案在审查前后的回顾性筛选比较；接受提案内容不变，可共享相同候选内容的有效实验结果。",
      "审查接受率不等于有效率；只有每项至少三对完整运行的实验参与改善/退化统计，晋升仍需跨任务证据与人工批准。",
      "可避免评测费用是假设先过滤再评测时的回顾性金额，不是实际节省；零计费按运行记录报告，不证明免费。",
      "当前实验改善判定仍以通过/失败为主，耗时或 token 降低不会单独获得晋升资格。"
    ]
  };
}
