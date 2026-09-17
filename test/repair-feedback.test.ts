import { describe, expect, it } from "vitest";
import { formatRepairPrompt, repairStopReason } from "../src/verifier/repair.js";
import { parseTaskSpec } from "../src/task/task-spec.js";
import type { VerificationReport } from "../src/verifier/verifier.js";

function failed(): VerificationReport {
  return { configured: true, success: false, changedFiles: [], disallowedChangedFiles: [], commands: [{
    command: "npm test", status: "failed", exitCode: 1, stdout: "", stderr: "assertion failed", durationMs: 1, outputTruncated: false
  }] };
}
describe("repair evidence", () => {
  it("only continues for actionable failures within the limit", () => {
    expect(repairStopReason(failed(), 0, 2)).toBeUndefined();
    expect(repairStopReason(failed(), 2, 2)).toBe("limit");
    expect(repairStopReason(failed(), 0, 0)).toBe("disabled");
    expect(repairStopReason({ ...failed(), success: true }, 0, 2)).toBe("passed");
    expect(repairStopReason({ ...failed(), configured: false, commands: [] }, 0, 2)).toBe("no_verifier");
    expect(repairStopReason({ ...failed(), changeAuditUnavailable: true }, 0, 2)).toBe("audit_unavailable");
    expect(repairStopReason({ ...failed(), disallowedChangedFiles: [".env"] }, 0, 2)).toBe("protected_changes");
    for (const command of [{ ...failed().commands[0]!, status: "timed_out" as const }, { ...failed().commands[0]!, exitCode: null }]) {
      expect(repairStopReason({ ...failed(), commands: [command] }, 0, 2)).toBe("verifier_unavailable");
    }
  });
  it("redacts credentials before truncation and bounds all evidence", () => {
    const report = failed();
    report.commands[0]!.stdout = "x".repeat(995) + " Bearer fake-secret-value\u001b[2J";
    report.commands[0]!.stderr = '{"apiKey":"fake-json-key-value"}\u202e' + "y".repeat(25_000);
    report.commands = Array.from({ length: 100 }, () => ({ ...report.commands[0]! }));
    const prompt = formatRepairPrompt(parseTaskSpec({ objective: "修复解析器" }), report, 1, 2);
    expect(prompt).not.toContain("fake-secret-value");
    expect(prompt).not.toContain("fake-json-key-value");
    expect(prompt).not.toContain("\u001b");
    expect(prompt).not.toContain("\u202e");
    expect(prompt.length).toBeLessThan(28_000);
    expect(prompt).toContain('"omittedCommandCount": 92');
  });
});
