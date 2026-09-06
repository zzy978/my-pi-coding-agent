import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ExperienceCandidate } from "../src/experience/candidate.js";
import { createExperienceExtension } from "../src/runtime/experience-extension.js";

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown>;
type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

function candidate(content = "先验证失败是否可稳定重现，再修改最小相关代码。"): ExperienceCandidate {
  return {
    id: "candidate-one",
    kind: "strategy",
    content,
    contentSha256: createHash("sha256").update(content).digest("hex"),
    rendererVersion: 1,
    sourceRunId: "source-run",
    sourceExperienceId: "experience-one",
    createdAt: "2026-09-05T00:00:00.000Z",
    title: "最小回归修复",
    applicability: ["可复现的测试失败"],
    contraindications: ["未配置验证器"]
  };
}

async function harness(load: () => Promise<ExperienceCandidate[]>) {
  const events = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const notifications: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const context = {
    hasUI: true,
    ui: {
      notify: (message: string) => { notifications.push(message); },
      setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); }
    }
  } as unknown as ExtensionCommandContext;
  const api = {
    on: (name: string, handler: unknown) => {
      const registered = handler as (event: unknown, ctx: ExtensionContext) => unknown;
      events.set(name, (event, ctx) => Promise.resolve(registered(event, ctx)));
    },
    registerCommand: (name: string, options: { handler: CommandHandler }) => {
      commands.set(name, options.handler);
    }
  } as unknown as ExtensionAPI;
  const extension = createExperienceExtension({
    sourceRepository: "D:/project",
    dataDirectory: "D:/isolated-data",
    loadActiveCandidates: (sourceRepository, dataDirectory) => {
      if (sourceRepository !== "D:/project" || dataDirectory !== "D:/isolated-data") {
        throw new Error("Candidate lookup escaped its configured repository or data directory");
      }
      return load();
    }
  });
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory(api);
  return {
    notifications,
    statuses,
    command: async (args: string) => {
      const handler = commands.get("experience");
      if (!handler) throw new Error("Missing /experience command");
      await handler(args, context);
    },
    event: async (name = "before_agent_start") => {
      const handler = events.get(name);
      if (!handler) throw new Error(`Missing ${name} handler`);
      return handler({ type: name, prompt: "修复解析器", systemPrompt: "不可绕过任务权限" }, context);
    }
  };
}

describe("experience extension", () => {
  it("keeps ordinary turns unchanged and listing does not implicitly select a candidate", async () => {
    const ui = await harness(() => Promise.resolve([candidate()]));

    await expect(ui.event()).resolves.toBeUndefined();
    await ui.command("list");
    await expect(ui.event()).resolves.toBeUndefined();

    expect(ui.notifications.join("\n")).toContain("candidate-one");
    expect(ui.notifications.join("\n")).toContain("最小回归修复");
  });

  it("injects only the explicitly selected frozen candidate as user-level guidance", async () => {
    const ui = await harness(() => Promise.resolve([candidate()]));
    await ui.command("use candidate-one");

    const result = await ui.event() as {
      message?: { customType: string; content: string; display: boolean; details?: unknown };
      systemPrompt?: string;
    };

    expect(result.systemPrompt).toBeUndefined();
    expect(result.message?.customType).toBe("host-experience");
    expect(result.message?.content).toContain("先验证失败是否可稳定重现，再修改最小相关代码。");
    expect(result.message?.content).toContain("higher-priority instructions and task boundaries take precedence");
    expect(result.message?.display).toBe(true);
    expect(result.message?.details).toMatchObject({ candidateId: "candidate-one", sourceRunId: "source-run" });
    expect(ui.notifications.join("\n")).toContain("可复现的测试失败");
    expect(ui.notifications.join("\n")).toContain("未配置验证器");
  });

  it("rechecks promotion on each turn and permanently clears a revoked selection", async () => {
    let active = [candidate()];
    const ui = await harness(() => Promise.resolve(active));
    await ui.command("use candidate-one");
    expect(await ui.event()).toBeDefined();

    active = [];
    await expect(ui.event()).resolves.toBeUndefined();
    active = [candidate()];
    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.notifications.join("\n")).toContain("已停用");
  });

  it("does not silently replace a selected candidate when its content hash changes", async () => {
    let active = [candidate()];
    const ui = await harness(() => Promise.resolve(active));
    await ui.command("use candidate-one");
    active = [candidate("先收集调用链证据。")];

    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.notifications.join("\n")).toContain("已停用");
  });

  it("clears stale UI status when listing after a candidate was revoked", async () => {
    let active = [candidate()];
    const ui = await harness(() => Promise.resolve(active));
    await ui.command("use candidate-one");
    active = [];

    await ui.command("list");

    expect(ui.statuses.get("experience")).toBeUndefined();
    expect(ui.notifications.at(-1)).toContain("当前未启用");
    await expect(ui.event()).resolves.toBeUndefined();
  });

  it.each(["off", "session_start"])("clears selection on %s", async (action) => {
    const ui = await harness(() => Promise.resolve([candidate()]));
    await ui.command("use candidate-one");

    if (action === "off") await ui.command(action);
    else await ui.event(action);

    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.statuses.get("experience")).toBeUndefined();
  });

  it("fails closed on registry errors without echoing unsafe error details", async () => {
    let failure = false;
    const ui = await harness(() => {
      if (failure) return Promise.reject(new Error("private-secret-auth-content"));
      return Promise.resolve([candidate()]);
    });
    await ui.command("use candidate-one");
    failure = true;

    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.notifications.join("\n")).toContain("已停用");
    expect(ui.notifications.join("\n")).not.toContain("private-secret-auth-content");
    failure = false;
    await expect(ui.event()).resolves.toBeUndefined();
  });

  it("rejects a corrupt candidate before it enters model context", async () => {
    const corrupt = { ...candidate(), content: "篡改过的候选" };
    const ui = await harness(() => Promise.resolve([corrupt]));

    await ui.command("use candidate-one");

    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.notifications.join("\n")).not.toContain("篡改过的候选");
  });

  it("does not choose an unavailable candidate or accept extra command arguments", async () => {
    const ui = await harness(() => Promise.resolve([candidate()]));
    await ui.command("use missing-candidate");
    await expect(ui.event()).resolves.toBeUndefined();
    await ui.command("use candidate-one extra");
    await expect(ui.event()).resolves.toBeUndefined();
    expect(ui.notifications.join("\n")).toContain("用法");
  });

  it("does not reenable a pending selection after the user switches session", async () => {
    let resolveLookup: ((value: ExperienceCandidate[]) => void) | undefined;
    const ui = await harness(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const selection = ui.command("use candidate-one");
    await ui.event("session_start");
    resolveLookup?.([candidate()]);
    await selection;

    await expect(ui.event()).resolves.toBeUndefined();
  });

  it("does not inject a pending lookup after the user turns experience off", async () => {
    let resolveLookup: ((value: ExperienceCandidate[]) => void) | undefined;
    let delayed = false;
    const ui = await harness(() => delayed
      ? new Promise((resolve) => { resolveLookup = resolve; })
      : Promise.resolve([candidate()]));
    await ui.command("use candidate-one");
    delayed = true;
    const prompt = ui.event();
    await ui.command("off");
    resolveLookup?.([candidate()]);

    await expect(prompt).resolves.toBeUndefined();
  });
});
