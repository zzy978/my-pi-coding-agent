export interface PairLabel {
  taskId: string;
  candidateId: string;
  verdict: "direct" | "general" | "inapplicable" | "unknown";
  reason: string;
  origin: "model" | "human";
  taskQuotes: string[];
  experienceQuotes: string[];
}

export interface EvaluationTask {
  taskId: string;
  v1: string[];
  v2: string[];
}

export interface RetrievalVariantEvaluation {
  /** Number of task/candidate pairs selected by this retrieval variant. */
  selectedCount: number;
  /** Selected pairs with a label from the requested origin; unknown is still an explicit label. */
  labeledCount: number;
  unlabeledCount: number;
  directCount: number;
  generalCount: number;
  inapplicableCount: number;
  unknownCount: number;
  /** Direct pairs divided by all selections, available only when every selection is labeled. */
  precision: number | null;
  /** Direct pairs divided by labeled selections; unknown counts as non-direct. */
  labeledPrecision: number | null;
  /** Share of tasks receiving at least one selection. */
  taskCoverage: number | null;
  selectedPerTask: number | null;
  /** Hit rate among tasks whose pool has a known direct pair; null if any selected outcome is unjudged. */
  conditionalHitRate: number | null;
  /** Recall over every direct pair; available only for a complete library without unknown verdicts. */
  fullLibraryRecall: number | null;
  /** Injection rate for tasks with no direct pair; available only for a complete library without unknown verdicts. */
  falseInjectionRate: number | null;
}

export interface RetrievalEvaluation {
  origin: "model" | "human";
  taskCount: number;
  librarySize: number;
  /** Number of labels from origin; labels from the other origin never fill this evaluation. */
  labelCount: number;
  /** Number of pairs selected by V1, including pairs without a label. */
  historicalPairCount: number;
  /** V1 pairs with a label from origin; unknown is counted as labeled. */
  historicalLabeledCount: number;
  /** Whether every task/candidate pair has a label from origin, including explicit unknown labels. */
  allLibraryLabelsComplete: boolean;
  v1: RetrievalVariantEvaluation;
  v2: RetrievalVariantEvaluation;
}

type Variant = "v1" | "v2";
type LabelByCandidate = Map<string, PairLabel>;
type LabelIndex = Map<string, LabelByCandidate>;

const verdicts = new Set<PairLabel["verdict"]>(["direct", "general", "inapplicable", "unknown"]);
const origins = new Set<PairLabel["origin"]>(["model", "human"]);

function requireIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertUnique(values: string[], message: (value: string) => string): void {
  const seen = new Set<string>();
  for (const value of values) {
    requireIdentifier(value, "Candidate ID");
    if (seen.has(value)) throw new Error(message(value));
    seen.add(value);
  }
}

function indexLabels(labels: PairLabel[], taskIds: Set<string>, candidateIds: Set<string>): Map<PairLabel["origin"], LabelIndex> {
  const result = new Map<PairLabel["origin"], LabelIndex>([["model", new Map()], ["human", new Map()]]);
  for (const item of labels) {
    if (!origins.has(item.origin)) throw new Error(`Invalid label origin: ${String(item.origin)}`);
    if (!verdicts.has(item.verdict)) throw new Error(`Invalid label verdict: ${String(item.verdict)}`);
    if (!taskIds.has(item.taskId)) throw new Error(`Unknown label task: ${item.taskId}`);
    if (!candidateIds.has(item.candidateId)) throw new Error(`Unknown label candidate: ${item.candidateId}`);
    const byTask = result.get(item.origin);
    if (!byTask) throw new Error(`Invalid label origin: ${String(item.origin)}`);
    let byCandidate = byTask.get(item.taskId);
    if (!byCandidate) {
      byCandidate = new Map();
      byTask.set(item.taskId, byCandidate);
    }
    if (byCandidate.has(item.candidateId)) {
      throw new Error(`Duplicate label for ${item.origin}/${item.taskId}/${item.candidateId}`);
    }
    byCandidate.set(item.candidateId, item);
  }
  return result;
}

function findLabel(index: LabelIndex, taskId: string, candidateId: string): PairLabel | undefined {
  return index.get(taskId)?.get(candidateId);
}

function evaluateVariant(
  variant: Variant,
  tasks: EvaluationTask[],
  labels: LabelIndex,
  allLibraryLabelsComplete: boolean,
  hasUnknownLibraryLabel: boolean
): RetrievalVariantEvaluation {
  let selectedCount = 0;
  let labeledCount = 0;
  let directCount = 0;
  let generalCount = 0;
  let inapplicableCount = 0;
  let unknownCount = 0;
  let coveredTasks = 0;

  for (const task of tasks) {
    const selected = task[variant];
    selectedCount += selected.length;
    if (selected.length > 0) coveredTasks += 1;
    for (const candidateId of selected) {
      const pair = findLabel(labels, task.taskId, candidateId);
      if (!pair) continue;
      labeledCount += 1;
      if (pair.verdict === "direct") directCount += 1;
      else if (pair.verdict === "general") generalCount += 1;
      else if (pair.verdict === "inapplicable") inapplicableCount += 1;
      else unknownCount += 1;
    }
  }

  const tasksWithDirect = tasks.filter((task) => {
    const reviewed = labels.get(task.taskId);
    return reviewed ? [...reviewed.values()].some((pair) => pair.verdict === "direct") : false;
  });
  const conditionalOutcomes = tasksWithDirect.map((task): "hit" | "miss" | "unknown" => {
    const selected = task[variant];
    if (selected.some((candidateId) => findLabel(labels, task.taskId, candidateId)?.verdict === "direct")) return "hit";
    if (selected.some((candidateId) => {
      const pair = findLabel(labels, task.taskId, candidateId);
      return pair === undefined || pair.verdict === "unknown";
    })) return "unknown";
    return "miss";
  });
  const completeKnownLibrary = allLibraryLabelsComplete && !hasUnknownLibraryLabel;
  const allDirectPairs = completeKnownLibrary
    ? [...labels.values()].reduce((count, byCandidate) =>
      count + [...byCandidate.values()].filter((pair) => pair.verdict === "direct").length, 0)
    : 0;
  const tasksWithoutDirect = completeKnownLibrary
    ? tasks.filter((task) => ![...(labels.get(task.taskId)?.values() ?? [])].some((pair) => pair.verdict === "direct"))
    : [];

  return {
    selectedCount,
    labeledCount,
    unlabeledCount: selectedCount - labeledCount,
    directCount,
    generalCount,
    inapplicableCount,
    unknownCount,
    precision: selectedCount > 0 && labeledCount === selectedCount ? directCount / selectedCount : null,
    labeledPrecision: labeledCount > 0 ? directCount / labeledCount : null,
    taskCoverage: tasks.length > 0 ? coveredTasks / tasks.length : null,
    selectedPerTask: tasks.length > 0 ? selectedCount / tasks.length : null,
    conditionalHitRate: conditionalOutcomes.length > 0 && !conditionalOutcomes.includes("unknown")
      ? conditionalOutcomes.filter((outcome) => outcome === "hit").length / conditionalOutcomes.length
      : null,
    fullLibraryRecall: completeKnownLibrary && allDirectPairs > 0 ? directCount / allDirectPairs : null,
    falseInjectionRate: completeKnownLibrary && tasksWithoutDirect.length > 0
      ? tasksWithoutDirect.filter((task) => task[variant].length > 0).length / tasksWithoutDirect.length
      : null
  };
}

export function evaluateRetrieval(
  tasks: EvaluationTask[],
  candidateIds: string[],
  labels: PairLabel[],
  origin: "model" | "human"
): RetrievalEvaluation {
  if (!origins.has(origin)) throw new Error(`Invalid evaluation origin: ${String(origin)}`);
  assertUnique(candidateIds, (candidateId) => `Duplicate library candidate: ${candidateId}`);
  const candidateSet = new Set(candidateIds);
  const taskSet = new Set<string>();
  for (const task of tasks) {
    requireIdentifier(task.taskId, "Task ID");
    if (taskSet.has(task.taskId)) throw new Error(`Duplicate task ID: ${task.taskId}`);
    taskSet.add(task.taskId);
    for (const variant of ["v1", "v2"] as const) {
      assertUnique(task[variant], (candidateId) => `Duplicate ${variant} candidate for ${task.taskId}: ${candidateId}`);
      for (const candidateId of task[variant]) {
        if (!candidateSet.has(candidateId)) throw new Error(`Unknown selected candidate for ${task.taskId}/${variant}: ${candidateId}`);
      }
    }
  }

  const labelsByOrigin = indexLabels(labels, taskSet, candidateSet);
  const selectedLabels = labelsByOrigin.get(origin);
  if (!selectedLabels) throw new Error(`Invalid evaluation origin: ${String(origin)}`);
  const allLibraryLabelsComplete = tasks.every((task) =>
    candidateIds.every((candidateId) => findLabel(selectedLabels, task.taskId, candidateId) !== undefined));
  const selectedOriginLabels = [...selectedLabels.values()].flatMap((byCandidate) => [...byCandidate.values()]);
  const hasUnknownLibraryLabel = selectedOriginLabels.some((item) => item.verdict === "unknown");
  const historicalPairCount = tasks.reduce((count, task) => count + task.v1.length, 0);
  const historicalLabeledCount = tasks.reduce((count, task) => count + task.v1.filter((candidateId) =>
    findLabel(selectedLabels, task.taskId, candidateId) !== undefined).length, 0);

  return {
    origin,
    taskCount: tasks.length,
    librarySize: candidateIds.length,
    labelCount: selectedOriginLabels.length,
    historicalPairCount,
    historicalLabeledCount,
    allLibraryLabelsComplete,
    v1: evaluateVariant("v1", tasks, selectedLabels, allLibraryLabelsComplete, hasUnknownLibraryLabel),
    v2: evaluateVariant("v2", tasks, selectedLabels, allLibraryLabelsComplete, hasUnknownLibraryLabel)
  };
}
