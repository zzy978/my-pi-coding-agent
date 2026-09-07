import { describe, expect, it } from "vitest";
import { parseSynthesisOutput } from "../src/experience/schema.js";

const evidence = [{ ref: "result.json#/status", excerpt: "failed", sha256: "a".repeat(64) }];
const markdown = "## 排查步骤\n1. 阅读失败断言。\n\n```powershell\nGet-Location\n```";
const proposal = {
  card: { title: "排查", pattern: "工具失败", hypotheses: [{ text: "可能存在路径错误", confidence: 0.5, evidenceRefs: ["result.json#/status"] }],
    lessons: ["检查错误"], applicability: ["工具失败"], contraindications: ["工具正常"] },
  candidates: [{ kind: "strategy", title: "检查路径", content: markdown, applicability: ["工具失败"], contraindications: ["工具正常"] }]
};
const json = JSON.stringify(proposal);

describe("experience response format compatibility", () => {
  it.each([json, ` \n\`\`\`json\n${json}\n\`\`\`\n`, `\`\`\`\n${json}\n\`\`\``, `\`\`\`JSON\r\n${json}\r\n\`\`\``])("preserves Markdown content in a complete response %#", (source) => {
    expect(parseSynthesisOutput(source, evidence)).toEqual(proposal);
  });

  it.each([
    `Here is the answer:\n\`\`\`json\n${json}\n\`\`\``,
    `\`\`\`json\n${json}\n\`\`\`\nExplanation`,
    `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``,
    `\`\`\`yaml\n${json}\n\`\`\``,
    `\`\`\`json\n${json}`,
    `\`\`\`json\n{"card":}\n\`\`\``,
    `${json}\n${json}`
  ])("rejects ambiguous or malformed response %#", (source) => {
    expect(() => parseSynthesisOutput(source, evidence)).toThrow(/JSON/);
  });

  it("still validates evidence references inside a fence", () => {
    expect(() => parseSynthesisOutput(`\`\`\`json\n${json.replace("result.json#/status", "unknown-ref")}\n\`\`\``, evidence)).toThrow(/evidence/i);
  });

  it("still rejects incomplete structure, secrets and oversized fenced responses", () => {
    expect(() => parseSynthesisOutput("```json\n{}\n```", evidence)).toThrow();
    expect(() => parseSynthesisOutput(`\`\`\`json\n${json.replace("检查路径", "sk-12345678901234567890")}\n\`\`\``, evidence)).toThrow(/secret/i);
    expect(() => parseSynthesisOutput(`\`\`\`json\n${" ".repeat(64_000)}${json}\n\`\`\``, evidence)).toThrow(/size limit/);
  });
});
