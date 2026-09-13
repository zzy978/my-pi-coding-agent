import { resolve } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeExperience, type SynthesisInput } from "../src/experience/synthesizer.js";
import { readModelConfig } from "../src/model-config.js";

type Model = ReturnType<ModelRuntime["getAvailableSnapshot"]>[number];
type Message = Awaited<ReturnType<ModelRuntime["completeSimple"]>>;

const model: Model = {
  id: "test-model", name: "Test", provider: "test-provider", api: "openai-completions", baseUrl: "https://invalid.example",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 8_000
};
const answer: Message = {
  role: "assistant", api: "openai-completions", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 1,
  content: [{ type: "thinking", thinking: "private reasoning must never be persisted" }, { type: "text", text: "{\"card\":{}}" }],
  usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } }
};
const input: SynthesisInput = {
  observation: { eligibility: "eligible", category: "verifier_failed", stage: "verification", summary: "Verifier failed", evidenceRefs: ["result.json#/status"] },
  evidence: [{ ref: "result.json#/status", excerpt: "verification_failed", sha256: "a".repeat(64) }],
  model: { provider: model.provider, id: model.id }, dataDirectory: resolve("isolated-data")
};

afterEach(() => vi.unstubAllEnvs());

describe("isolated experience synthesis", () => {
  it("uses a frozen batch configuration instead of later environment edits", async () => {
    const frozen = readModelConfig({ path: null, env: { PICODE_SYNTHESIS_MAX_OUTPUT_TOKENS: "321" } });
    vi.stubEnv("PICODE_SYNTHESIS_MAX_OUTPUT_TOKENS", "789");
    await synthesizeExperience({ ...input, modelConfig: frozen }, () => Promise.resolve({
      getAvailableSnapshot: () => [model], completeSimple: (_model, _context, options) => {
        expect(options?.maxTokens).toBe(321); return Promise.resolve(answer);
      }
    }));
  });
  it("uses independent synthesis limits and the source model despite a different default", async () => {
    vi.stubEnv("PICODE_SYNTHESIS_TIMEOUT_MS", "2345");
    vi.stubEnv("PICODE_SYNTHESIS_MAX_OUTPUT_TOKENS", "123");
    vi.stubEnv("PICODE_MODEL_PROVIDER", "other-provider");
    vi.stubEnv("PICODE_MODEL_ID", "other-model");
    const output = await synthesizeExperience(input, () => Promise.resolve({
      getAvailableSnapshot: () => [model],
      completeSimple: (selected, _context, options) => {
        expect(selected.id).toBe("test-model");
        expect(selected.maxTokens).toBe(123);
        expect(options).toMatchObject({ timeoutMs: 2345, maxTokens: 123 });
        return Promise.resolve(answer);
      }
    }));
    expect(output.text).toBe('{"card":{}}');
  });
  it("rejects oversized evidence before opening a model runtime", async () => {
    await expect(synthesizeExperience({ ...input, evidence: [{ ...input.evidence[0]!, excerpt: "x".repeat(70_000) }] }, () => Promise.resolve({
      getAvailableSnapshot: () => [model], completeSimple: () => Promise.resolve(answer)
    }))).rejects.toThrow(/size|limit/);
  });

  it("sends only bounded evidence to a tool-free stateless completion and retains only final text and usage", async () => {
    const output = await synthesizeExperience(input, (configuration) => {
      expect(configuration?.allowModelNetwork).toBe(false);
      expect(configuration?.authPath).toContain("isolated-data");
      return Promise.resolve({
        getAvailableSnapshot: () => [model],
        completeSimple: (selected, context, options) => {
          expect(selected.id).toBe("test-model");
          expect(context.tools).toEqual([]);
          expect(context.messages).toHaveLength(1);
          expect(context.messages[0]?.content).toContain("verification_failed");
          expect(JSON.stringify(context)).not.toContain("isolated-data");
          expect(options).toMatchObject({ toolChoice: "none", reasoning: "high", maxRetries: 0 });
          return Promise.resolve(answer);
        }
      });
    });
    expect(output).toEqual({ text: "{\"card\":{}}", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.003 } });
    expect(JSON.stringify(output)).not.toContain("private reasoning");
  });

  it("never silently substitutes a different available model", async () => {
    await expect(synthesizeExperience(input, () => Promise.resolve({
      getAvailableSnapshot: () => [{ ...model, id: "other-model" }],
      completeSimple: () => Promise.reject(new Error("Unexpected generation"))
    }))).rejects.toThrow("Source model is unavailable");
  });

  it("treats provider failure as failure even when a text JSON body is present", async () => {
    const output = await synthesizeExperience(input, () => Promise.resolve({
      getAvailableSnapshot: () => [model],
      completeSimple: () => Promise.resolve({ ...answer, stopReason: "error", errorMessage: "Bearer fake-sensitive-value" })
    }));
    expect(output.text).toBe("");
    expect(output.error).toContain("error");
    expect(output.usage?.cost).toBe(0.003);
    expect(JSON.stringify(output)).not.toContain("fake-sensitive-value");
  });
});
