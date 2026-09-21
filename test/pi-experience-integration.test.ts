import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as promotions from "../src/experience/promotions.js";
import * as retrieval from "../src/experience/retrieval-service.js";
import type { ExperienceCandidate } from "../src/experience/candidate.js";
import { readModelConfig } from "../src/model-config.js";
import { createPiInteractiveRuntime } from "../src/runtime/pi-interactive.js";
import { createInteractiveTask } from "../src/task/task-spec.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("wires automatic retrieval to the current Pi model and frozen startup config, and skips planning", async () => {
  const root = await mkdtemp(join(tmpdir(), "picode-experience-runtime-"));
  directories.push(root);
  const content = "先验证失败是否可稳定重现，再修改最小相关代码。";
  const candidate: ExperienceCandidate = { id: "candidate-one", kind: "strategy", content,
    contentSha256: createHash("sha256").update(content).digest("hex"), rendererVersion: 1,
    sourceRunId: "source-run", sourceExperienceId: "experience-one", createdAt: "2026-09-05T00:00:00.000Z",
    title: "最小回归修复", applicability: ["可复现的测试失败"], contraindications: [] };
  vi.spyOn(promotions, "listActiveCandidates").mockResolvedValue([candidate]);
  const requests: Parameters<typeof retrieval.selectTaskExperience>[0][] = [];
  vi.spyOn(retrieval, "selectTaskExperience").mockImplementation((request) => {
    requests.push(request);
    return Promise.resolve({ candidate, selectedIds: [candidate.id], reasons: [], auditId: "audit-one", status: "selected" });
  });
  const config = readModelConfig({ path: null, env: { PICODE_MODEL_PROVIDER: "openai", PICODE_MODEL_ID: "gpt-4o", PICODE_MODEL_API_KEY: "fake-test-key" } });
  const originalTimeout = config.synthesisTimeoutMs;
  const runtime = await createPiInteractiveRuntime({
    workspace: { sourceRoot: root, workspace: root, branch: "main", baselineCommit: "0".repeat(40), managedWorktree: false },
    task: createInteractiveTask({}), allowShell: false, continueSession: false, noSession: true,
    dataDirectory: join(root, "data"), modelConfig: config
  });
  try {
    await runtime.session.bindExtensions({ mode: "print" });
    config.synthesisTimeoutMs = originalTimeout + 100;
    const emit = () => runtime.session.extensionRunner.emitBeforeAgentStart("修复当前解析器", undefined, "任务边界", { cwd: root });
    const result = await emit();
    expect(result?.messages?.some((message) => message.customType === "host-experience")).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ objective: "修复当前解析器", candidates: [candidate],
      model: { provider: "openai", id: "gpt-4o" }, modelConfig: { synthesisTimeoutMs: originalTimeout } });
    await runtime.session.prompt("/plan");
    const planned = await emit();
    expect(planned?.messages?.some((message) => message.customType === "host-experience")).not.toBe(true);
    expect(requests).toHaveLength(1);
    await runtime.session.prompt("/experience off");
    await emit();
    expect(requests).toHaveLength(1);
  } finally {
    await runtime.dispose();
  }
});
