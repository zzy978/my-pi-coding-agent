import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";
import { handleLearningManagement } from "../src/learning-cli.js";

vi.mock("../src/experiment/store.js", () => ({
  loadExperiment: () => Promise.resolve({
    id: "experiment-1", sourceRunId: "source-1", candidate: { id: "candidate-1", contentSha256: "a".repeat(64) },
    pairsCompleted: 0, pairsRequested: 3, outcome: "inconclusive", scopeViolations: 0,
    metrics: { control: { passed: 0, runs: 0, tokens: 0, cost: 0 }, treatment: { passed: 0, runs: 0, tokens: 0, cost: 0 }, pairedWins: 0, pairedLosses: 0 },
    errors: ["provider failure\u001b[2J\u202e"], isolationDifferences: ["unsafe\u001b[31m"], trials: []
  }), listExperiments: () => Promise.resolve([])
}));

afterEach(() => vi.restoreAllMocks());
describe("learning command terminal output", () => {
  it("does not execute terminal or bidi control sequences in model error text", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleLearningManagement(parseCliArgs(["--show-experiment", "experiment-1"]), "unused");
    const text = output.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toContain("provider failure");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u202e");
  });

  it("keeps valid JSON inspection output with escaped rather than active controls", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleLearningManagement(parseCliArgs(["--show-experiment", "experiment-1", "--json"]), "unused");
    const text = String(output.mock.calls[0]?.[0]);
    expect(text).not.toContain("\u001b");
    expect(JSON.parse(text)).toMatchObject({ outcome: "inconclusive" });
  });
});
