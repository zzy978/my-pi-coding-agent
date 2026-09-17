import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";
import { parseTaskSpec } from "../src/task/task-spec.js";

describe("repair configuration", () => {
  it("keeps explicit zero and positive limits in task snapshots", () => {
    expect(parseTaskSpec({ objective: "test", maxRepairAttempts: 0 })).toMatchObject({ maxRepairAttempts: 0 });
    expect(parseTaskSpec({ objective: "test", maxRepairAttempts: 2 })).toMatchObject({ maxRepairAttempts: 2 });
    expect(parseTaskSpec({ objective: "legacy" })).not.toHaveProperty("maxRepairAttempts");
  });
  it.each([-1, 6, 1.5, "2", null])("rejects invalid task limit %s", (limit) => {
    expect(() => parseTaskSpec({ objective: "test", maxRepairAttempts: limit })).toThrow();
  });
  it("accepts explicit CLI limits", () => {
    expect(parseCliArgs(["--max-repair-attempts", "0"])).toMatchObject({ maxRepairAttempts: 0 });
    expect(parseCliArgs(["--max-repair-attempts", "2"])).toMatchObject({ maxRepairAttempts: 2 });
  });
  it.each(["-1", "6", "1.5", "NaN"])("rejects invalid CLI limit %s", (value) => {
    expect(() => parseCliArgs(["--max-repair-attempts", value])).toThrow();
  });
  it.each(["--diagnostics", "--doctor", "--list-runs", "--replay", "--list-experiences"])("rejects repair override with %s", (mode) => {
    expect(() => parseCliArgs([mode, ...(mode === "--replay" ? ["run-id"] : []), "--max-repair-attempts", "2"])).toThrow();
  });
});
