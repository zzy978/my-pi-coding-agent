import { describe, expect, it } from "vitest";
import { summarizeToolResult, redactSensitiveText } from "../src/evaluation/redaction.js";

describe("observable tool result summaries", () => {
  it("does not corrupt already redacted JSON embedded inside another JSON string", () => {
    const value = JSON.stringify({ resultSummary: 'RECOVERY VERIFIED {"apiKey":"[REDACTED]"}' });
    expect(redactSensitiveText(value)).toBe(value);
  });
  it.each([
    '{"password":"fake-review-private-123", "apiKey": "fake-review-api-456"}',
    "Server says password='initial fake review private value'",
    'Server says Authorization: Basic fake-review-basic-123',
    '{"nested":{"access_token":"fake-review-nested-123"}}'
  ])("redacts structured and quoted credentials before storing tool text: %s", (source) => {
    const summary = summarizeToolResult({ content: [{ type: "text", text: source }] });
    expect(summary).not.toContain("fake");
    expect(summary).toContain("REDACTED");
    expect(redactSensitiveText(summary)).toBe(summary);
  });

  it("keeps useful text while excluding images, arbitrary metadata and reasoning", () => {
    expect(summarizeToolResult({ content: [{ type: "image", data: "private-image" }, { type: "thinking", thinking: "private-reason" },
      { type: "text", text: "Test passed\n3 cases\u001b[2J" }], details: { password: "private-details" } })).toBe("Test passed\n3 cases[2J");
    expect(summarizeToolResult(null)).toBe("");
  });

  it("redacts whole values crossing the output limit before truncation", () => {
    const prefix = "x".repeat(980);
    const summary = summarizeToolResult({ content: [{ type: "text", text: `${prefix}\npassword="fake sensitive value spanning boundary"` }] });
    expect(summary.length).toBeLessThanOrEqual(1000);
    expect(summary).not.toContain("fake");
  });
});
