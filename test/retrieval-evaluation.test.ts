import { describe, expect, it } from "vitest";
import {
  evaluateRetrieval,
  type EvaluationTask,
  type PairLabel
} from "../src/experience/retrieval-evaluation.js";

function label(
  taskId: string,
  candidateId: string,
  verdict: PairLabel["verdict"],
  origin: PairLabel["origin"] = "human"
): PairLabel {
  return {
    taskId,
    candidateId,
    verdict,
    reason: `${taskId}/${candidateId}/${verdict}`,
    origin,
    taskQuotes: [`task:${taskId}`],
    experienceQuotes: [`candidate:${candidateId}`]
  };
}

describe("evaluateRetrieval", () => {
  it("computes complete-library metrics from only the requested label origin", () => {
    const tasks: EvaluationTask[] = [
      { taskId: "task-1", v1: ["a", "b"], v2: ["a"] },
      { taskId: "task-2", v1: ["b"], v2: ["c"] },
      { taskId: "task-3", v1: [], v2: ["a"] }
    ];
    const candidates = ["a", "b", "c"];
    const humanLabels: PairLabel[] = [
      label("task-1", "a", "direct"),
      label("task-1", "b", "general"),
      label("task-1", "c", "inapplicable"),
      label("task-2", "a", "general"),
      label("task-2", "b", "inapplicable"),
      label("task-2", "c", "direct"),
      label("task-3", "a", "inapplicable"),
      label("task-3", "b", "inapplicable"),
      label("task-3", "c", "inapplicable")
    ];
    const modelLabels = [label("task-1", "a", "inapplicable", "model")];

    expect(evaluateRetrieval(tasks, candidates, [...humanLabels, ...modelLabels], "human")).toEqual({
      origin: "human",
      taskCount: 3,
      librarySize: 3,
      labelCount: 9,
      historicalPairCount: 3,
      historicalLabeledCount: 3,
      allLibraryLabelsComplete: true,
      v1: {
        selectedCount: 3,
        labeledCount: 3,
        unlabeledCount: 0,
        directCount: 1,
        generalCount: 1,
        inapplicableCount: 1,
        unknownCount: 0,
        precision: 1 / 3,
        labeledPrecision: 1 / 3,
        taskCoverage: 2 / 3,
        selectedPerTask: 1,
        conditionalHitRate: 1 / 2,
        fullLibraryRecall: 1 / 2,
        falseInjectionRate: 0
      },
      v2: {
        selectedCount: 3,
        labeledCount: 3,
        unlabeledCount: 0,
        directCount: 2,
        generalCount: 0,
        inapplicableCount: 1,
        unknownCount: 0,
        precision: 2 / 3,
        labeledPrecision: 2 / 3,
        taskCoverage: 1,
        selectedPerTask: 1,
        conditionalHitRate: 1,
        fullLibraryRecall: 1,
        falseInjectionRate: 1
      }
    });
  });

  it("keeps omitted labels out of denominators and reports incomplete strict metrics as null", () => {
    const tasks: EvaluationTask[] = [
      { taskId: "task-1", v1: ["a", "b"], v2: ["b"] },
      { taskId: "task-2", v1: [], v2: ["c"] }
    ];
    const labels = [
      label("task-1", "a", "direct", "model"),
      label("task-1", "b", "unknown", "model"),
      label("task-2", "a", "direct", "model")
    ];

    const result = evaluateRetrieval(tasks, ["a", "b", "c"], labels, "model");

    expect(result).toMatchObject({
      labelCount: 3,
      historicalPairCount: 2,
      historicalLabeledCount: 2,
      allLibraryLabelsComplete: false,
      v1: {
        selectedCount: 2,
        labeledCount: 2,
        unlabeledCount: 0,
        directCount: 1,
        unknownCount: 1,
        precision: 1 / 2,
        labeledPrecision: 1 / 2,
        conditionalHitRate: 1 / 2,
        fullLibraryRecall: null,
        falseInjectionRate: null
      },
      v2: {
        selectedCount: 2,
        labeledCount: 1,
        unlabeledCount: 1,
        directCount: 0,
        unknownCount: 1,
        precision: null,
        labeledPrecision: 0,
        conditionalHitRate: null,
        fullLibraryRecall: null,
        falseInjectionRate: null
      }
    });
  });

  it("keeps conditional hit rate unknown when a selected pair cannot be judged", () => {
    const labels = [label("task-1", "a", "direct")];
    const missed = evaluateRetrieval(
      [{ taskId: "task-1", v1: ["a"], v2: ["b"] }],
      ["a", "b"],
      labels,
      "human"
    );
    const hit = evaluateRetrieval(
      [{ taskId: "task-1", v1: ["a"], v2: ["a", "b"] }],
      ["a", "b"],
      labels,
      "human"
    );

    expect(missed.v1.conditionalHitRate).toBe(1);
    expect(missed.v2.precision).toBeNull();
    expect(missed.v2.conditionalHitRate).toBeNull();
    expect(hit.v2.precision).toBeNull();
    expect(hit.v2.conditionalHitRate).toBe(1);
  });

  it("returns null for every rate with a zero denominator", () => {
    const result = evaluateRetrieval([], [], [], "human");

    expect(result.allLibraryLabelsComplete).toBe(true);
    expect(result.v1).toEqual({
      selectedCount: 0,
      labeledCount: 0,
      unlabeledCount: 0,
      directCount: 0,
      generalCount: 0,
      inapplicableCount: 0,
      unknownCount: 0,
      precision: null,
      labeledPrecision: null,
      taskCoverage: null,
      selectedPerTask: null,
      conditionalHitRate: null,
      fullLibraryRecall: null,
      falseInjectionRate: null
    });
    expect(result.v2).toEqual(result.v1);
  });

  it("does not report full-library rates when a complete label matrix still contains unknown", () => {
    const result = evaluateRetrieval(
      [{ taskId: "task-1", v1: ["a"], v2: ["b"] }],
      ["a", "b"],
      [label("task-1", "a", "direct"), label("task-1", "b", "unknown")],
      "human"
    );

    expect(result.allLibraryLabelsComplete).toBe(true);
    expect(result.v1.precision).toBe(1);
    expect(result.v2.precision).toBe(0);
    expect(result.v1.fullLibraryRecall).toBeNull();
    expect(result.v2.fullLibraryRecall).toBeNull();
    expect(result.v1.falseInjectionRate).toBeNull();
    expect(result.v2.falseInjectionRate).toBeNull();
  });

  it.each([
    {
      name: "duplicate task IDs",
      tasks: [
        { taskId: "task-1", v1: [], v2: [] },
        { taskId: "task-1", v1: [], v2: [] }
      ],
      candidates: ["a"],
      labels: [],
      error: /Duplicate task ID/
    },
    {
      name: "duplicate library candidate IDs",
      tasks: [{ taskId: "task-1", v1: [], v2: [] }],
      candidates: ["a", "a"],
      labels: [],
      error: /Duplicate library candidate/
    },
    {
      name: "duplicate candidates within one retrieval group",
      tasks: [{ taskId: "task-1", v1: ["a", "a"], v2: [] }],
      candidates: ["a"],
      labels: [],
      error: /Duplicate v1 candidate/
    },
    {
      name: "a selected candidate outside the library",
      tasks: [{ taskId: "task-1", v1: ["missing"], v2: [] }],
      candidates: ["a"],
      labels: [],
      error: /Unknown selected candidate/
    },
    {
      name: "a label for an unknown task",
      tasks: [{ taskId: "task-1", v1: [], v2: [] }],
      candidates: ["a"],
      labels: [label("missing", "a", "direct")],
      error: /Unknown label task/
    },
    {
      name: "a label for an unknown candidate",
      tasks: [{ taskId: "task-1", v1: [], v2: [] }],
      candidates: ["a"],
      labels: [label("task-1", "missing", "direct")],
      error: /Unknown label candidate/
    },
    {
      name: "duplicate labels from the same origin",
      tasks: [{ taskId: "task-1", v1: [], v2: [] }],
      candidates: ["a"],
      labels: [label("task-1", "a", "direct"), label("task-1", "a", "general")],
      error: /Duplicate label/
    },
    {
      name: "an invalid verdict at the runtime boundary",
      tasks: [{ taskId: "task-1", v1: [], v2: [] }],
      candidates: ["a"],
      labels: [{ ...label("task-1", "a", "direct"), verdict: "winner" }] as unknown as PairLabel[],
      error: /Invalid label verdict/
    }
  ])("rejects $name", ({ tasks, candidates, labels, error }) => {
    expect(() => evaluateRetrieval(tasks, candidates, labels, "human")).toThrow(error);
  });
});
