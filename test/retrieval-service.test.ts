import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sha256Text } from "../src/evaluation/schema.js";
import { selectIndexedGuidance, selectTaskExperience } from "../src/experience/retrieval-service.js";
import type { RetrievalEntry, SearchCard } from "../src/experience/retrieval.js";

const entry: RetrievalEntry = { title: "长度校验", applicability: ["用户名长度"], contraindications: [],
  candidate: { id: "candidate-a", kind: "strategy", content: "检查用户名长度", contentSha256: sha256Text("检查用户名长度"), rendererVersion: 1 } };
const card: SearchCard = { candidateId: entry.candidate.id, contentSha256: entry.candidate.contentSha256,
  mechanism: "用户名长度", triggers: ["用户名长度"], exclusions: [], action: "检查用户名长度", stage: "initial", keywords: ["用户名", "length"], sourceQuotes: ["用户名长度"] };
const task = { problem_statement: "用户名长度出错" };
const decision = { candidateId: entry.candidate.id, verdict: "direct", reason: "同为长度校验", taskQuotes: ["用户名长度"], experienceQuotes: ["用户名长度"], contraindication: "absent", stage: "initial", redundantWith: null };
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20, cost: 0 };

describe("共享经验选择服务", () => {
  it("只发送公开任务和原候选，注入原正文且保存决策", async () => {
    const complete = vi.fn().mockResolvedValue({ text: JSON.stringify({ decisions: [decision] }), usage });
    const publicInput = { ...task, patch: "hidden" };
    const result = await selectIndexedGuidance(publicInput, [entry], [card], complete);
    expect(result.selection.selectedIds).toEqual([entry.candidate.id]);
    expect(result.selection.candidate?.content).toContain(entry.candidate.content);
    expect(result.usage).toEqual(usage);
    expect(JSON.stringify(complete.mock.calls[0]?.[0])).not.toContain("hidden");
  });
  it("无命中不请求，非法任务在任何请求前拒绝", async () => {
    const complete = vi.fn();
    expect((await selectIndexedGuidance({ problem_statement: "quasar" }, [entry], [card], complete)).selection.candidate).toBeNull();
    expect((await selectIndexedGuidance({ problem_statement: "api_key=sk-test-secret-123456789" }, [entry], [card], complete)).error).toBeTruthy();
    expect(complete).not.toHaveBeenCalled();
  });
  it.each(["invalid", JSON.stringify({ decisions: [{ ...decision, taskQuotes: ["伪造"] }] })])("损坏输出零注入且保留费用", async (text) => {
    const result = await selectIndexedGuidance(task, [entry], [card], () => Promise.resolve({ text, usage }));
    expect(result.selection.candidate).toBeNull(); expect(result.error).toBeTruthy(); expect(result.usage).toEqual(usage);
  });
  it("模型错误即使带合法文本也不放行，错误脱敏", async () => {
    const result = await selectIndexedGuidance(task, [entry], [card], () => Promise.resolve({ text: JSON.stringify({ decisions: [decision] }), error: "api_key=sk-test-secret-123456789", usage }));
    expect(result.selection.candidate).toBeNull(); expect(result.error).not.toContain("sk-test-secret"); expect(result.usage).toEqual(usage);
  });
  it("普通任务空库不调用模型，保存可读选择审计且不保存任务原文", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrieval-service-"));
    try {
      vi.stubEnv("PICODE_ENV_FILE", join(root, "missing-env"));
      const complete = vi.fn();
      const result = await selectTaskExperience({ objective: task.problem_statement, candidates: [], dataDirectory: root, model: { provider: "mock", id: "mock" }, complete });
      expect(result.status).toBe("empty"); expect(complete).not.toHaveBeenCalled();
      const audit = await readFile(join(root, "reports", "retrieval", `${result.auditId}.json`), "utf8");
      expect(audit).toContain('"status": "empty"'); expect(audit).not.toContain(task.problem_statement);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
  it("普通任务首次补建索引，后续复用索引并重新检查条件", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrieval-service-"));
    try {
      await mkdir(join(root, "experiences", "experience-a"), { recursive: true });
      const candidate = { ...entry, ...entry.candidate, sourceExperienceId: "experience-a", sourceRunId: "run-a", createdAt: "2026-09-21T00:00:00Z" };
      const complete = vi.fn().mockResolvedValueOnce({ text: JSON.stringify(card), usage })
        .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [decision] }), usage })
        .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [{ ...decision, contraindication: "present" }] }), usage });
      const options = { objective: task.problem_statement, candidates: [candidate], dataDirectory: root, model: { provider: "mock", id: "mock" }, complete };
      const selected = await selectTaskExperience(options);
      expect(selected.status).toBe("selected"); expect(selected.selectedIds).toEqual([candidate.id]);
      expect((await selectTaskExperience(options)).candidate).toBeNull(); expect(complete).toHaveBeenCalledTimes(3);
      const audit = JSON.parse(await readFile(join(root, "reports", "retrieval", `${selected.auditId}.json`), "utf8")) as { decisions: Array<{ taskQuotes: string[] }> };
      expect(audit.decisions[0]?.taskQuotes).toEqual(["用户名长度"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
