import { expect, it } from "vitest";
import { serializeEvidence } from "../src/experience/evidence.js";
import { assertNoSecrets } from "../src/experience/candidate.js";
import { assertResumeB } from "../src/benchmark/swe-mini.js";

it("序列化后仍可通过敏感内容校验，保留普通诊断", () => {
  const excerpt = serializeEvidence({ resultSummary: "data = {'password': 'fixture-password'}\nnormal diagnostic" });
  expect(excerpt).not.toContain("fixture-password");
  expect(excerpt).toContain("normal diagnostic");
  expect(() => assertNoSecrets(excerpt)).not.toThrow();
  expect(() => assertNoSecrets("password=fixture-password")).toThrow();
});

it("仅复盘和B恢复要求完整且唯一的50题已评分R0", () => {
  const ids = Array.from({ length: 50 }, (_, i) => String(i));
  const trials = ids.map((instanceId) => ({ instanceId, resolved: false }));
  expect(() => assertResumeB(ids, trials)).not.toThrow();
  expect(() => assertResumeB(ids, trials.slice(1))).toThrow();
  expect(() => assertResumeB(ids, [...trials.slice(1), trials[1]!])).toThrow();
  expect(() => assertResumeB(ids, [{ instanceId: "0", resolved: null }, ...trials.slice(1)])).toThrow();
});
