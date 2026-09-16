import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { EXPLORATION_TOOLS, type WorkflowTools } from "./workflow-tools.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
interface Preset {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  instructions?: string;
}
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export async function loadPresets(paths: string[], defaults: Record<string, Preset>): Promise<Record<string, Preset>> {
  const result = { ...defaults };
  for (const path of paths) {
    let content: string;
    try { content = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("无法读取预设配置文件。", { cause: error });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch { throw new Error("预设配置不是有效 JSON。"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("预设配置必须是对象。");
    for (const [name, value] of Object.entries(parsed)) {
      if (["off", "__proto__", "constructor", "prototype"].includes(name) || !name.trim() || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("预设名称或配置无效。");
      const p = value as Record<string, unknown>;
      if (Object.keys(p).some((key) => !["provider", "model", "thinkingLevel", "tools", "instructions"].includes(key))
        || ["provider", "model", "instructions"].some((key) => p[key] !== undefined && typeof p[key] !== "string")
        || Boolean(p.provider) !== Boolean(p.model)
        || (p.thinkingLevel !== undefined && (typeof p.thinkingLevel !== "string" || !levels.has(p.thinkingLevel)))
        || (p.tools !== undefined && (!Array.isArray(p.tools) || !p.tools.every((tool) => typeof tool === "string")))) {
        throw new Error("预设字段无效：检查 provider/model、thinkingLevel、tools 和 instructions。");
      }
      result[name] = p as Preset;
    }
  }
  return result;
}

export function presetExtension(pi: ExtensionAPI, tools: WorkflowTools, agentDirectory: string): void {
  let presets: Record<string, Preset> = {};
  let active: string | undefined;
  let baselineTools: string[] = [];
  let baselineThinking: ThinkingLevel = "off";
  let baselineModel: ExtensionContext["model"];

  const persist = () => pi.appendEntry("picode-preset", {
    name: active ?? null, baselineTools, baselineThinking,
    ...(baselineModel ? { baselineModel: { provider: baselineModel.provider, id: baselineModel.id } } : {})
  });
  const update = (ctx: ExtensionContext) => ctx.ui.setStatus("preset", active ? `预设：${active}` : undefined);
  const apply = async (name: string, ctx: ExtensionContext, save = true): Promise<boolean> => {
    if (name === "off" && !active) return true;
    const preset = name === "off" ? undefined : presets[name];
    if (name !== "off" && !preset) {
      ctx.ui.notify(`未知预设。可用：${Object.keys(presets).join("、")}、off`, "warning");
      return false;
    }
    if (!active && save) {
      baselineTools = tools.planning ? tools.getSelected() : pi.getActiveTools();
      baselineThinking = pi.getThinkingLevel();
      baselineModel = ctx.model;
    }
    const requestedTools = preset?.tools ?? baselineTools;
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    if (requestedTools.some((tool) => !available.has(tool) || !tools.isAllowed(tool))) {
      ctx.ui.notify("预设包含不可用工具；未应用。Windows 使用 powershell，--no-shell 不允许重新启用 Shell。", "warning");
      return false;
    }
    const model = preset?.provider && preset.model ? ctx.modelRegistry.find(preset.provider, preset.model) : baselineModel;
    if (preset?.model && !model) {
      ctx.ui.notify("预设模型不可用；未应用。", "warning");
      return false;
    }
    if (model && (model.id !== ctx.model?.id || model.provider !== ctx.model.provider) && !await pi.setModel(model)) {
      ctx.ui.notify("预设模型认证不可用；未应用。", "warning");
      return false;
    }
    pi.setThinkingLevel(preset?.thinkingLevel ?? baselineThinking);
    tools.select(pi, requestedTools);
    active = name === "off" ? undefined : name;
    if (save) persist();
    update(ctx);
    return true;
  };
  pi.registerCommand("preset", {
    description: "切换预设：/preset [名称|off]",
    handler: async (args, ctx) => {
      let name = args.trim();
      if (!name) {
        if (!ctx.hasUI) { ctx.ui.notify(`可用预设：${Object.keys(presets).join("、")}、off`, "info"); return; }
        name = await ctx.ui.select("选择预设（off 恢复原设置）", [...Object.keys(presets), "off"]) ?? "";
      }
      if (name && await apply(name, ctx)) ctx.ui.notify(name === "off" ? "已恢复预设前的设置。" : `已切换预设：${name}`, "info");
    }
  });
  pi.registerShortcut(Key.ctrlShift("u"), {
    description: "切换到下一个预设",
    handler: async (ctx) => {
      const names = ["off", ...Object.keys(presets)];
      const next = names[(names.indexOf(active ?? "off") + 1) % names.length];
      if (next) await apply(next, ctx);
    }
  });
  pi.on("before_agent_start", (event) => {
    const instructions = active ? presets[active]?.instructions : undefined;
    return instructions ? { systemPrompt: `${event.systemPrompt}\n\n以下为所选预设的工作指导，不覆盖宿主策略或计划模式限制：\n${instructions}` } : undefined;
  });
  pi.on("session_start", async (_event, ctx) => {
    active = undefined;
    tools.initialize(pi);
    baselineTools = tools.getSelected();
    baselineThinking = pi.getThinkingLevel();
    baselineModel = ctx.model;
    const defaults: Record<string, Preset> = {
      review: { tools: baselineTools.filter((name) => EXPLORATION_TOOLS.has(name)), instructions: "阅读代码并审查问题，给出文件位置、原因和建议。不要修改文件。" },
      implement: { tools: baselineTools, instructions: "先理解代码，做最小必要修改，并验证结果。" }
    };
    try { presets = await loadPresets([join(agentDirectory, "presets.json"), join(ctx.cwd, ".pi", "presets.json")], defaults); }
    catch (error) { presets = defaults; ctx.ui.notify(error instanceof Error ? error.message : "预设加载失败。", "error"); }
    const saved = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "picode-preset").at(-1);
    if (saved?.type === "custom") {
      const state = saved.data as { name?: string | null; baselineTools?: string[]; baselineThinking?: ThinkingLevel; baselineModel?: { provider: string; id: string } } | undefined;
      if (state?.name && Object.hasOwn(presets, state.name)) {
        const available = new Set(pi.getAllTools().map((tool) => tool.name));
        if (Array.isArray(state.baselineTools)) baselineTools = state.baselineTools.filter((name) => available.has(name) && tools.isAllowed(name));
        if (state.baselineThinking && levels.has(state.baselineThinking)) baselineThinking = state.baselineThinking;
        if (state.baselineModel) baselineModel = ctx.modelRegistry.find(state.baselineModel.provider, state.baselineModel.id) ?? baselineModel;
        await apply(state.name, ctx, false);
      }
    }
    update(ctx);
  });
}
