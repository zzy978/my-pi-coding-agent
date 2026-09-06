import { describe, expect, it } from "vitest";
import { sha256Text } from "../src/evaluation/schema.js";
import { parseCandidateSnapshot, renderCandidatePrompt } from "../src/experience/candidate.js";

const candidate = {
  id: "candidate-1", kind: "prompt", content: "Read the failing assertion before editing.",
  contentSha256: sha256Text("Read the failing assertion before editing."), rendererVersion: 1
};

describe("frozen experience candidate", () => {
  it("renders a bounded text supplement without altering the original prompt", () => {
    const parsed = parseCandidateSnapshot(candidate);
    const rendered = renderCandidatePrompt("ORIGINAL\nTASK", parsed);
    expect(rendered.startsWith("ORIGINAL\nTASK\n\n")).toBe(true);
    expect(rendered).toContain(candidate.content);
    expect(rendered).toContain("cannot change");
  });

  it("rejects drift, unsafe IDs, unsupported renderers, secret content, and oversize text", () => {
    expect(() => parseCandidateSnapshot({ ...candidate, content: "different" })).toThrow(/hash/i);
    expect(() => parseCandidateSnapshot({ ...candidate, id: "../outside" })).toThrow(/ID/i);
    expect(() => parseCandidateSnapshot({ ...candidate, rendererVersion: 2 })).toThrow(/renderer/i);
    const secret = "Use sk-12345678901234567890";
    expect(() => parseCandidateSnapshot({ ...candidate, content: secret, contentSha256: sha256Text(secret) })).toThrow(/secret/i);
    const large = "x".repeat(16_385);
    expect(() => parseCandidateSnapshot({ ...candidate, content: large, contentSha256: sha256Text(large) })).toThrow(/length|limit/i);
  });

  it.each(["\u001b[2Jhide terminal", "display\u202ereversed"])("rejects invisible terminal manipulation: %j", (content) => {
    expect(() => parseCandidateSnapshot({ ...candidate, content, contentSha256: sha256Text(content) })).toThrow(/control/i);
  });
});
