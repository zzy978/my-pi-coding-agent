import { parseCandidateSnapshot, type CandidateSnapshot } from "../experience/candidate.js";
import { sha256Text, sha256Json } from "../evaluation/schema.js";
import { publicTask, summarizeRounds, type SweTask, type SweTrial } from "./swe-mini.js";

export const HOLDOUT_SEED = "mini-transfer-v1";
export const QUOTAS: Record<string, number> = { "django/django": 10, "sphinx-doc/sphinx": 10, "pytest-dev/pytest": 5, "psf/requests": 5, "scikit-learn/scikit-learn": 5, "sympy/sympy": 5 };
export const SAME_REPOSITORIES = ["django/django", "sphinx-doc/sphinx"];
export type Arm = "control" | "experience";
export interface LibraryEntry {
  sourceTaskId: string; sourceExperienceId: string; sourceRunId: string;
  title: string; applicability: string[]; contraindications: string[]; candidate: CandidateSnapshot;
}
export interface Retrieval {
  selected: Array<{ id: string; score: number; matchedTerms: number }>;
  candidate: CandidateSnapshot | null;
}

const stopwords = new Set("a an the and or if for from to of in on with by at as is are be this that it its not should can could would will have has had do does did when then than into after before use using used code fix issue test tests error file run check need new current expected actual value values true false none return def self import class python please following function method".split(" "));
function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((term) => !stopwords.has(term));
}
export function normalizedProblem(task: SweTask): string { return task.problem_statement.toLowerCase().replace(/\s+/g, " ").trim(); }

export function validateHoldoutTasks(tasks: SweTask[], sources: SweTask[]): void {
  tasks.forEach(publicTask); sources.forEach(publicTask);
  const sourceIds = new Set(sources.map((task) => task.instance_id));
  const problems = new Set(sources.map(normalizedProblem));
  if (tasks.length !== 40 || new Set(tasks.map((task) => task.instance_id)).size !== 40) throw new Error("Expected 40 unique holdout tasks");
  for (const task of tasks) {
    const problem = normalizedProblem(task);
    if (sourceIds.has(task.instance_id) || problems.has(problem)) throw new Error("Source overlap or duplicate problem");
    problems.add(problem);
    if (!(task.repo in QUOTAS)) throw new Error("Unexpected holdout repository");
  }
  for (const [repo, count] of Object.entries(QUOTAS)) if (tasks.filter((task) => task.repo === repo).length !== count) throw new Error("Repository quota mismatch");
}

/** Fixed BM25: k1=1.2, b=0.75; minimum two informative shared terms. No model call. */
export function retrieveGuidance(input: SweTask, library: LibraryEntry[]): Retrieval {
  const task = publicTask(input);
  const query = new Set(terms(`${task.repo} ${task.problem_statement}`));
  const docs = library.map((entry) => {
    const candidate = parseCandidateSnapshot(entry.candidate);
    const words = terms(`${entry.title} ${entry.applicability.join(" ")} ${candidate.content}`);
    return { candidate, words, unique: new Set(words) };
  });
  const average = docs.reduce((sum, doc) => sum + doc.words.length, 0) / Math.max(docs.length, 1) || 1;
  const ranked = docs.map((doc) => {
    let score = 0, matchedTerms = 0;
    for (const word of query) {
      const frequency = doc.words.filter((value) => value === word).length;
      if (!frequency) continue;
      matchedTerms++;
      const documentFrequency = docs.filter((value) => value.unique.has(word)).length;
      const idf = Math.log(1 + (docs.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
      score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.words.length / average));
    }
    return { ...doc, score, matchedTerms };
  }).filter((doc) => doc.matchedTerms >= 2 && doc.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
  const selected: Retrieval["selected"] = [], sections: string[] = [], seen = new Set<string>();
  let length = 0;
  for (const doc of ranked) {
    const section = `### Source guidance ${doc.candidate.id}\n${doc.candidate.content}`;
    if (seen.has(doc.candidate.contentSha256) || length + section.length + 2 > 9000) continue;
    selected.push({ id: doc.candidate.id, score: doc.score, matchedTerms: doc.matchedTerms });
    sections.push(section); length += section.length + 2; seen.add(doc.candidate.contentSha256);
    if (selected.length === 3) break;
  }
  if (!selected.length) return { selected, candidate: null };
  const content = sections.join("\n\n");
  return { selected, candidate: parseCandidateSnapshot({ id: `retrieved-${sha256Json(selected).slice(0, 24)}`, kind: "strategy", content, contentSha256: sha256Text(content), rendererVersion: 1 }) };
}

export function pairedSchedule(tasks: SweTask[]): Array<{ instanceId: string; arm: Arm }> {
  return tasks.flatMap((task, index) => (index % 2 ? ["experience", "control"] as const : ["control", "experience"] as const)
    .map((arm) => ({ instanceId: task.instance_id, arm })));
}

export function validateTrial(trial: SweTrial, instanceId: string, runId: string): SweTrial {
  if (trial.instanceId !== instanceId || trial.runId !== runId ||
    (trial.resolved !== null && typeof trial.resolved !== "boolean") ||
    !Number.isFinite(trial.durationMs) || trial.durationMs < 0 ||
    (trial.executionError !== null && typeof trial.executionError !== "string") ||
    (trial.evaluationError !== undefined && trial.evaluationError !== null && typeof trial.evaluationError !== "string") ||
    (trial.usageComplete !== undefined && typeof trial.usageComplete !== "boolean")) throw new Error("Invalid recovered trial");
  if (trial.usage !== null && [trial.usage.input, trial.usage.output, trial.usage.cacheRead, trial.usage.cacheWrite, trial.usage.total, trial.usage.cost].some((n) => !Number.isFinite(n) || n < 0)) throw new Error("Invalid trial usage");
  return trial;
}

export function holdoutSummary(tasks: SweTask[], control: SweTrial[], experience: SweTrial[]) {
  const group = (subset: SweTask[]) => {
    const ids = subset.map((task) => task.instance_id);
    if (!ids.length) return null;
    const summary = summarizeRounds(ids, control.filter((trial) => ids.includes(trial.instanceId)), experience.filter((trial) => ids.includes(trial.instanceId)));
    const pairs = summary.rows.filter((row) => row.r0?.usage && row.b?.usage && row.r0.usageComplete !== false && row.b.usageComplete !== false);
    const costs = (rows: typeof pairs) => {
      const left = rows.reduce((sum, row) => sum + row.r0!.usage!.total, 0), right = rows.reduce((sum, row) => sum + row.b!.usage!.total, 0);
      return { count: rows.length, control: left, experience: right, percentChange: left ? (right / left - 1) * 100 : null };
    };
    return { taskCount: ids.length, control: summary.r0, experience: summary.b, transitions: summary.transitions,
      completeUsagePairs: costs(pairs), bothPassedUsagePairs: costs(pairs.filter((row) => row.category === "bothPassed")),
      durationMs: { control: summary.rows.reduce((sum, row) => sum + (row.r0?.durationMs ?? 0), 0), experience: summary.rows.reduce((sum, row) => sum + (row.b?.durationMs ?? 0), 0) }, rows: summary.rows };
  };
  return { overall: group(tasks)!, sameRepository: group(tasks.filter((task) => SAME_REPOSITORIES.includes(task.repo)))!, newRepository: group(tasks.filter((task) => !SAME_REPOSITORIES.includes(task.repo)))! };
}
