import type { CliOptions } from "./cli-args.js";
import { analyzeRun } from "./experience/service.js";
import { loadCandidate, listExperiences, loadExperience } from "./experience/store.js";
import { listPromotions, promoteCandidate, revokeCandidate } from "./experience/promotions.js";
import { runExperiment } from "./experiment/service.js";
import { listExperiments, loadExperiment } from "./experiment/store.js";
import type { ExperimentBundle } from "./experiment/schema.js";
import type { ExperienceBundle } from "./experience/schema.js";
import { stripUnsafeControls } from "./experience/candidate.js";
import { compareReviewPipelines } from "./experience/review-comparison.js";

function print(message: string): void {
  console.log(stripUnsafeControls(message));
}

function showExperience(bundle: ExperienceBundle): void {
  print([
    `经验：${bundle.id}`,
    `来源运行：${bundle.sourceRunId}`,
    `事实判定：${bundle.observation.eligibility} / ${bundle.observation.category}`,
    `摘要：${bundle.observation.summary}`,
    `生成状态：${bundle.synthesis.status}`,
    ...(bundle.noCandidateReason ? [`无候选原因：${bundle.noCandidateReason}`] : []),
    ...(bundle.review ? [`Critic 审查：${bundle.review.status}`,
      ...bundle.review.decisions.map((decision) => `提案 ${decision.candidateIndex + 1}：${decision.verdict}；${decision.reason}；证据：${decision.evidenceRefs.join(", ")}`),
      ...(bundle.review.error ? [`审查错误：${bundle.review.error}`] : []),
      ...(bundle.review.proposerExperienceId ? [`Proposer 对照经验：${bundle.review.proposerExperienceId}`, `查看比较：--show-review-comparison ${bundle.id}`] : [])] : []),
    ...(bundle.synthesis.error ? [`生成错误：${bundle.synthesis.error}`] : []),
    ...(bundle.warnings.length ? [`证据限制：${bundle.warnings.join("；")}`] : []),
    ...(bundle.card ? [`经验卡：${bundle.card.title}`, `模式：${bundle.card.pattern}`,
      ...bundle.card.hypotheses.map((hypothesis) => `假设（置信度 ${hypothesis.confidence}）：${hypothesis.text}\n证据：${hypothesis.evidenceRefs.join(", ")}`),
      ...bundle.card.lessons.map((lesson) => `经验：${lesson}`)] : []),
    ...bundle.candidates.flatMap((candidate) => [
      "", `候选：${candidate.id} (${candidate.kind}) ${candidate.title}`,
      `哈希：${candidate.contentSha256}`, `适用：${candidate.applicability.join("；")}`,
      `禁用场景：${candidate.contraindications.join("；")}`, candidate.content
    ]),
    "候选仅供后续实验，不会自动用于日常会话。"
  ].join("\n"));
}

function showExperiment(bundle: ExperimentBundle): void {
  print([
    `实验：${bundle.id}`,
    `来源运行：${bundle.sourceRunId}`,
    `候选：${bundle.candidate.id} (${bundle.candidate.contentSha256})`,
    `结果：${bundle.outcome}；完成配对 ${bundle.pairsCompleted}/${bundle.pairsRequested}`,
    `对照通过：${bundle.metrics.control.passed}/${bundle.metrics.control.runs}；候选通过：${bundle.metrics.treatment.passed}/${bundle.metrics.treatment.runs}`,
    `配对改善/退化：${bundle.metrics.pairedWins}/${bundle.metrics.pairedLosses}；越界：${bundle.scopeViolations}`,
    `Token：对照 ${bundle.metrics.control.tokens}，候选 ${bundle.metrics.treatment.tokens}`,
    `模型计费估计：对照 ${bundle.metrics.control.cost}，候选 ${bundle.metrics.treatment.cost}`,
    ...bundle.isolationDifferences.map((difference) => `隔离差异：${difference}`),
    ...bundle.errors.map((error) => `错误：${error}`),
    ...bundle.trials.map((trial) => `配对 ${trial.pairIndex + 1} ${trial.arm}：${trial.runId}`),
    "少量配对只能提供观察性证据，不代表统计显著提升。"
  ].join("\n"));
}

export async function handleLearningManagement(options: CliOptions, dataDirectory: string): Promise<number | undefined> {
  const command = options.learning;
  if (!command) return undefined;
  switch (command.mode) {
    case "analyze": {
      const bundle = await analyzeRun(command.runId, dataDirectory, command);
      showExperience(bundle);
      return bundle.synthesis.status === "failed" || bundle.review?.status === "failed" ? 1 : 0;
    }
    case "show-review-comparison": {
      const comparison = await compareReviewPipelines(command.id, dataDirectory);
      if (options.json) console.log(JSON.stringify(comparison, null, 2));
      else print([
        `Proposer：${comparison.proposerExperienceId}；候选 ${comparison.proposer.candidates}；已评测 ${comparison.proposer.evaluatedCandidates}；观察改善 ${comparison.proposer.improvedCandidates}；观察退化 ${comparison.proposer.regressedCandidates}`,
        `Critic：${comparison.criticExperienceId}；状态 ${comparison.criticStatus}；保留 ${comparison.critic.candidates}；已评测 ${comparison.critic.evaluatedCandidates}；观察改善 ${comparison.critic.improvedCandidates}；观察退化 ${comparison.critic.regressedCandidates}`,
        `Proposer 计费估计：${comparison.proposerCost ?? "未知"}；Critic 计费估计：${comparison.criticCost ?? "未知"}`,
        `回顾性可避免评测费用：${comparison.retrospectiveAvoidableEvaluationCost ?? "证据不足"}；质量比较材料${comparison.qualityComparisonAvailable ? "齐全" : "不足"}`,
        ...comparison.proposals.map((proposal) => `提案 ${proposal.index + 1}：${proposal.decision} / ${proposal.assessment}；Proposer 候选 ${proposal.proposerCandidateId}${proposal.criticCandidateId ? `；Critic 候选 ${proposal.criticCandidateId}` : ""}`),
        ...(comparison.unavailableExperimentIds.length ? [`无法核验的实验：${comparison.unavailableExperimentIds.join(", ")}`] : []),
        ...comparison.limitations
      ].join("\n"));
      return 0;
    }
    case "list-experiences": {
      const experiences = await listExperiences(dataDirectory);
      if (options.json) console.log(JSON.stringify(experiences, null, 2));
      else if (!experiences.length) console.log("尚无历史经验。使用 --analyze-run <runId> 提炼。");
      else for (const bundle of experiences) print(`${bundle.id}  ${bundle.observation.category}  ${bundle.synthesis.status}  候选 ${bundle.candidates.length}`);
      return 0;
    }
    case "show-experience": {
      const bundle = await loadExperience(command.id, dataDirectory);
      if (options.json) console.log(JSON.stringify(bundle, null, 2));
      else showExperience(bundle);
      return 0;
    }
    case "experiment": {
      const candidate = await loadCandidate(command.candidateId, dataDirectory);
      console.error(`计划执行 ${command.pairs} 对新鲜运行（最多 ${command.pairs * 2} 次模型任务），不使用历史结果作为对照。`);
      const controller = new AbortController();
      const interrupt = () => { controller.abort(); console.error("正在中止实验并清理当前受管 worktree……"); };
      process.once("SIGINT", interrupt);
      let bundle: ExperimentBundle;
      try {
        bundle = await runExperiment({ sourceRunId: command.runId, candidate, dataDirectory, pairs: command.pairs,
          signal: controller.signal, onStatus: (message) => console.error(stripUnsafeControls(message)) });
      } finally {
        process.removeListener("SIGINT", interrupt);
      }
      showExperiment(bundle);
      return ["observed_improvement", "no_observed_gain"].includes(bundle.outcome) ? 0 : 1;
    }
    case "list-experiments": {
      const experiments = await listExperiments(dataDirectory);
      if (options.json) console.log(JSON.stringify(experiments, null, 2));
      else if (!experiments.length) console.log("尚无候选实验。");
      else for (const experiment of experiments) print(`${experiment.id}  ${experiment.outcome}  ${experiment.pairsCompleted}/${experiment.pairsRequested} 对  ${experiment.candidate.id}`);
      return 0;
    }
    case "show-experiment": {
      const experiment = await loadExperiment(command.id, dataDirectory);
      if (options.json) console.log(JSON.stringify(experiment, null, 2));
      else showExperiment(experiment);
      return 0;
    }
    case "promote": {
      const event = await promoteCandidate({ candidateId: command.candidateId, evidenceIds: command.evidenceIds,
        approved: command.approved, dataDirectory });
      print(`已晋升候选 ${event.candidateId}，内容哈希 ${event.contentSha256}。\n仓库：${event.sourceRepository}\n请在该仓库 TUI 使用 /experience 选择启用；不会自动注入。`);
      return 0;
    }
    case "revoke": {
      const event = await revokeCandidate({ candidateId: command.candidateId, approved: command.approved, dataDirectory });
      print(`已撤销候选 ${event.candidateId}，历史保留。后续不再注入；旧会话中已有文本仍存在，需要干净环境时请新建会话。`);
      return 0;
    }
    case "list-promotions": {
      const history = await listPromotions(options.workspace, dataDirectory);
      if (options.json) console.log(JSON.stringify(history, null, 2));
      else if (!history.length) console.log("当前仓库尚无晋升记录。");
      else for (const event of history) print(`${event.createdAt}  ${event.action}  ${event.candidateId}  ${event.contentSha256}`);
      return 0;
    }
  }
}
