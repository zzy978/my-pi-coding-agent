import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ExperienceCandidate } from "../src/experience/candidate.js";
import type { TaskExperienceSelection } from "../src/experience/retrieval-service.js";
import { createExperienceExtension, type ExperienceExtensionOptions } from "../src/runtime/experience-extension.js";

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown>;
type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;
function candidate(content = "先验证失败是否可稳定重现，再修改最小相关代码。"): ExperienceCandidate {
  return { id: "candidate-one", kind: "strategy", content,
    contentSha256: createHash("sha256").update(content).digest("hex"), rendererVersion: 1,
    sourceRunId: "source-run", sourceExperienceId: "experience-one", createdAt: "2026-09-05T00:00:00.000Z",
    title: "最小回归修复", applicability: ["可复现的测试失败"], contraindications: ["未配置验证器"] };
}
function selection(value = candidate()): TaskExperienceSelection {
  return { candidate: value, selectedIds: [value.id], reasons: [], auditId: "audit-one", status: "selected" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function harness(settings: Partial<ExperienceExtensionOptions> = {}, withRetrieval = true) {
  const events = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const notifications: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const state = { objective: "宿主任务", session: "session-one", planning: false, active: [candidate()] };
  const requests: Array<{ objective: string; ids: string[] }> = [];
  const context = {
    model: { provider: "test", id: "model-one" },
    sessionManager: { getSessionId: () => state.session },
    hasUI: true,
    ui: { notify: (message: string) => { notifications.push(message); },
      setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); } }
  } as unknown as ExtensionCommandContext;
  const api = { on: (name: string, handler: unknown) => {
    const registered = handler as (event: unknown, ctx: ExtensionContext) => unknown;
    events.set(name, (event, ctx) => Promise.resolve(registered(event, ctx)));
  }, registerCommand: (name: string, options: { handler: CommandHandler }) => { commands.set(name, options.handler); }
  } as unknown as ExtensionAPI;
  const options: ExperienceExtensionOptions = { sourceRepository: "D:/project", dataDirectory: "D:/isolated-data",
    loadActiveCandidates: (repository, directory) => {
      expect([repository, directory]).toEqual(["D:/project", "D:/isolated-data"]);
      return Promise.resolve(state.active);
    },
    retrieve: (objective, pool) => {
      requests.push({ objective, ids: pool.map((entry) => entry.id) });
      return Promise.resolve(selection(pool[0]));
    }, getTaskObjective: () => state.objective, isPlanning: () => state.planning, ...settings };
  if (!withRetrieval) delete options.retrieve;
  const extension = createExperienceExtension(options);
  await (typeof extension === "function" ? extension : extension.factory)(api);
  return { state, context, notifications, statuses, requests,
    command: async (args: string) => { await commands.get("experience")!(args, context); },
    event: async (name = "before_agent_start", prompt = "修复解析器") =>
      events.get(name)!({ type: name, prompt, systemPrompt: "不可绕过任务权限" }, context) };
}

describe("experience automatic retrieval extension", () => {
  it("uses the actual prompt and injects checked guidance by default without changing system instructions", async () => {
    const ui = await harness();
    const result = await ui.event() as { message: { content: string; details: unknown }; systemPrompt?: string };
    expect(result?.message.content).toContain(candidate().content);
    expect(result?.message.content).toContain("higher-priority instructions");
    expect(result?.message.details).toMatchObject({ auditId: "audit-one", selectedIds: ["candidate-one"] });
    expect(result?.systemPrompt).toBeUndefined();
    expect(ui.requests).toEqual([{ objective: "修复解析器", ids: ["candidate-one"] }]);
  });
  it("lists without retrieval and limits use to the requested active candidate", async () => {
    const ui = await harness();
    ui.state.active.push({ ...candidate(), id: "candidate-two" });
    await ui.command("list");
    expect(ui.requests).toEqual([]);
    await ui.command("use candidate-two");
    const result = await ui.event() as { message: { details: unknown } };
    expect(result?.message.details).toMatchObject({ selectedIds: ["candidate-two"] });
    expect(ui.requests[0]?.ids).toEqual(["candidate-two"]);
  });
  it.each(["empty", "failed"] as const)("never bypasses a %s result with manual use", async (status) => {
    const ui = await harness({ retrieve: () => Promise.resolve({ candidate: null, selectedIds: [], reasons: [], auditId: "audit-one", status, error: "private-secret" }) });
    await ui.command("use candidate-one");
    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.notifications.join("\n")).not.toContain("private-secret");
  });
  it("keeps off across turns, restores auto explicitly and resets the new session to auto", async () => {
    const ui = await harness();
    await ui.command("off");
    await expect(ui.event()).resolves.toBeUndefined();
    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.requests).toEqual([]);
    await ui.command("auto");
    expect(await ui.event()).toBeDefined();
    await ui.command("off");
    await ui.event("session_start");
    expect(await ui.event()).toBeDefined();
  });
  it.each(["off", "auto", "use", "session_start", "session_before_switch", "session_shutdown", "model_select", "input", "task", "session", "model", "planning"])("discards results after %s changes while retrieval is pending", async (change) => {
    const pending = deferred<TaskExperienceSelection>();
    const started = deferred<void>();
    const ui = await harness({ retrieve: () => { started.resolve(); return pending.promise; } });
    const result = ui.event();
    await started.promise;
    if (["off", "auto"].includes(change)) await ui.command(change);
    else if (change === "use") await ui.command("use candidate-one");
    else if (change === "task") ui.state.objective = "another task";
    else if (change === "session") ui.state.session = "session-two";
    else if (change === "model") ui.context.model = { ...ui.context.model!, id: "model-two" };
    else if (change === "planning") ui.state.planning = true;
    else await ui.event(change);
    pending.resolve(selection());
    await expect(result).resolves.toBeUndefined();
  });
  it.each(["revoked", "content", "metadata"])("revalidates %s after retrieval before injecting", async (change) => {
    const pending = deferred<TaskExperienceSelection>();
    const started = deferred<void>();
    const ui = await harness({ retrieve: () => { started.resolve(); return pending.promise; } });
    const result = ui.event();
    await started.promise;
    ui.state.active = change === "revoked" ? [] : change === "content" ? [candidate("不同正文")] : [{ ...candidate(), applicability: ["条件已变更"] }];
    pending.resolve(selection());
    await expect(result).resolves.toBeUndefined();
  });
  it.each(["planning", "model", "pool", "retrieve"])("does not request or inject with unavailable %s", async (missing) => {
    const ui = await harness({}, missing !== "retrieve");
    if (missing === "planning") ui.state.planning = true;
    if (missing === "model") ui.context.model = undefined;
    if (missing === "pool") ui.state.active = [];
    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.requests).toEqual([]);
  });
  it("fails closed on lookup and retrieval errors without blocking the task or echoing secrets", async () => {
    for (const settings of [
      { loadActiveCandidates: () => Promise.reject(new Error("private-secret")) },
      { retrieve: () => Promise.reject(new Error("private-secret")) }
    ]) {
      const ui = await harness(settings);
      await expect(ui.event()).resolves.toBeUndefined();
      expect(ui.notifications.join("\n")).not.toContain("private-secret");
    }
  });
  it("rejects corrupt and unavailable candidates and invalid commands", async () => {
    const ui = await harness();
    await ui.command("use missing");
    await expect(ui.event()).resolves.toBeUndefined();
    await ui.command("auto extra");
    expect(ui.notifications.at(-1)).toContain("用法");
    await ui.command("auto");
    ui.state.active = [{ ...candidate(), content: "篡改正文" }];
    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.requests).toEqual([]);
  });
  it("does not accept a stale use request that finishes after off", async () => {
    const pending = deferred<ExperienceCandidate[]>();
    const ui = await harness({ loadActiveCandidates: () => pending.promise });
    const use = ui.command("use candidate-one");
    await ui.command("off");
    pending.resolve([candidate()]);
    await use;
    await expect(ui.event()).resolves.toBeUndefined();
  });
  it.each(["list", "turn"])("clears revoked manual selection during %s and never silently restores it", async (step) => {
    const ui = await harness();
    await ui.command("use candidate-one");
    ui.state.active = [];
    if (step === "list") await ui.command("list");
    else await ui.event();
    expect(ui.statuses.get("experience") ?? "").not.toContain("待筛选");
    ui.state.active = [candidate()];
    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.requests).toEqual([]);
  });
});
