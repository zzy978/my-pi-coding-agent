import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";
import { helpText } from "../src/main.js";

describe("experience command arguments", () => {
  it("parses retrospective modes, selection overrides and read-only pipeline comparison", () => {
    expect(parseCliArgs(["--analyze-run", "r", "--review-mode", "compare", "--min-success-tool-calls", "8", "--force-review"]).learning)
      .toEqual({ mode: "analyze", runId: "r", reviewMode: "compare", minSuccessToolCalls: 8, force: true });
    expect(parseCliArgs(["--show-review-comparison", "e", "--json"]).learning).toEqual({ mode: "show-review-comparison", id: "e" });
  });

  it.each([
    ["--review-mode", "critic"], ["--min-success-tool-calls", "2"], ["--force-review"],
    ["--analyze-run", "r", "--review-mode", "unknown"],
    ["--analyze-run", "r", "--review-mode", "critic", "--review-mode", "compare"],
    ["--analyze-run", "r", "--min-success-tool-calls", "-1"],
    ["--analyze-run", "r", "--min-success-tool-calls", "10001"],
    ["--analyze-run", "r", "--min-success-tool-calls", "1.5"],
    ["--show-experience", "e", "--force-review"], ["--show-review-comparison", "e", "--review-mode", "critic"]
  ])("rejects retrospective overrides in the wrong context %j", (...args) => {
    expect(() => parseCliArgs(args)).toThrow();
  });
  it("parses analysis and read-only inspections without an interactive task", () => {
    expect(parseCliArgs(["--analyze-run", "run-1"]).learning).toEqual({ mode: "analyze", runId: "run-1" });
    expect(parseCliArgs(["--show-experience", "exp-1", "--json"]).learning)
      .toEqual({ mode: "show-experience", id: "exp-1" });
    expect(parseCliArgs(["--list-experiments", "--json"]).learning).toEqual({ mode: "list-experiments" });
  });

  it("requires an explicit candidate and validates the pair budget", () => {
    expect(parseCliArgs(["--experiment", "run-1", "--candidate", "candidate-1"]).learning)
      .toEqual({ mode: "experiment", runId: "run-1", candidateId: "candidate-1", pairs: 3 });
    expect(parseCliArgs(["--experiment", "run-1", "--candidate", "candidate-1", "--pairs", "1"]).learning)
      .toMatchObject({ pairs: 1 });
    expect(() => parseCliArgs(["--experiment", "run-1"])).toThrow(/candidate/);
    for (const pairs of ["0", "1.5", "-1", "21", "NaN", "3x"]) {
      expect(() => parseCliArgs(["--experiment", "run-1", "--candidate", "candidate-1", "--pairs", pairs]))
        .toThrow(/pairs/);
    }
  });

  it("parses explicit approval and repeatable evidence for promotion", () => {
    expect(parseCliArgs(["--promote-candidate", "candidate-1", "--evidence", "e1", "--evidence", "e2", "--approve"]).learning)
      .toEqual({ mode: "promote", candidateId: "candidate-1", evidenceIds: ["e1", "e2"], approved: true });
    expect(parseCliArgs(["--revoke-candidate", "candidate-1", "--approve"]).learning)
      .toEqual({ mode: "revoke", candidateId: "candidate-1", approved: true });
    expect(() => parseCliArgs(["--promote-candidate", "candidate-1", "--evidence", "e1"])).toThrow(/approve/);
    expect(() => parseCliArgs(["--revoke-candidate", "candidate-1"])).toThrow(/approve/);
  });

  it.each([
    ["--candidate", "c"], ["--pairs", "3"], ["--approve"], ["--evidence", "e"],
    ["--analyze-run", "r", "--candidate", "c"],
    ["--list-experiences", "--show-experience", "e"],
    ["--list-experiences", "--list-runs"], ["--list-experiments", "--doctor"],
    ["--analyze-run", "r", "--task", "x"], ["--analyze-run", "r", "--no-shell"],
    ["--experiment", "r", "--candidate", "c", "--verify", "x"],
    ["--experiment", "r", "--candidate", "c", "--no-session"],
    ["--replay", "r", "--candidate", "c"],
    ["--analyze-run", "r", "--json"], ["--analyze-run", "r", "--analyze-run", "s"],
    ["--analyze-run", "r", "--cwd", "elsewhere"]
  ])("rejects ambiguous or ignored options: %j", (...args) => {
    expect(() => parseCliArgs(args)).toThrow();
  });

  it("documents all public entry points", () => {
    for (const flag of ["--analyze-run", "--list-experiences", "--show-experience", "--experiment", "--candidate",
      "--pairs", "--list-experiments", "--show-experiment", "--promote-candidate", "--revoke-candidate",
      "--list-promotions", "--evidence", "--approve"]) expect(helpText()).toContain(flag);
  });

  it("rejects two workspace arguments even when --cwd equals the default cwd", () => {
    expect(() => parseCliArgs(["--cwd", process.cwd(), "other", "--list-promotions"])).toThrow(/workspace/);
  });
});
