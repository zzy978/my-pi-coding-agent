import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { EXPLORATION_TOOLS, type WorkflowTools } from "../workflow-tools.js";
import { extractTodoItems, markCompletedSteps, type TodoItem } from "./utils.js";

export function planMode(pi: ExtensionAPI, tools: WorkflowTools): void {
  let todos: TodoItem[] = [];
  let executing = false;
  const persist = () => pi.appendEntry("picode-plan", { enabled: tools.planning, todos, executing });
  const update = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("plan-mode", tools.planning ? "计划模式（只读）" : executing ? "正在执行计划" : undefined);
    ctx.ui.setWidget("plan-todos", todos.length ? todos.map((item) => `${item.completed ? "☑" : "☐"} ${item.step}. ${item.text}`) : undefined);
  };
  const toggle = (ctx: ExtensionContext, enabled = !tools.planning) => {
    if (enabled && !tools.planning) {
      tools.select(pi, pi.getActiveTools());
      todos = [];
    }
    tools.planning = enabled;
    executing = false;
    tools.apply(pi);
    persist();
    update(ctx);
    ctx.ui.notify(enabled ? "已进入计划模式：可读取、搜索和提问。" : "已退出计划模式，恢复所选工具。", "info");
  };
  const execute = (ctx: ExtensionContext) => {
    if (!tools.planning || !todos.length) {
      ctx.ui.notify("请先在 /plan 模式中生成编号计划。", "warning");
      return;
    }
    tools.planning = false;
    executing = true;
    tools.apply(pi);
    persist();
    update(ctx);
    pi.sendUserMessage(`执行以下已确认计划。每完成一步附上 [DONE:n] 标记；完成标记不代表测试通过。\n${todos.map((item) => `${item.step}. ${item.text}`).join("\n")}`, { deliverAs: "followUp" });
  };
  pi.registerCommand("plan", {
    description: "计划模式：/plan [on|off|execute]",
    handler: (args, ctx) => {
      const action = args.trim();
      if (action === "execute") execute(ctx);
      else if (["", "on", "off"].includes(action)) toggle(ctx, action ? action === "on" : !tools.planning);
      else ctx.ui.notify("用法：/plan [on|off|execute]", "warning");
      return Promise.resolve();
    }
  });
  pi.registerCommand("todos", {
    description: "查看计划进度",
    handler: (_args, ctx) => {
      ctx.ui.notify(todos.length ? todos.map((item) => `${item.completed ? "✓" : "○"} ${item.step}. ${item.text}`).join("\n") : "暂无计划。请先使用 /plan。", "info");
      return Promise.resolve();
    }
  });
  pi.registerShortcut(Key.ctrlAlt("p"), { description: "切换计划模式", handler: (ctx) => { toggle(ctx); return Promise.resolve(); } });
  pi.on("tool_call", (event) => {
    if (tools.planning && !EXPLORATION_TOOLS.has(event.toolName)) return { block: true, reason: "计划模式禁止执行此工具；请先使用 /plan off 或 /plan execute。" };
    return undefined;
  });
  pi.on("user_bash", () => tools.planning ? { result: { output: "计划模式禁止 Shell；请先使用 /plan off。", exitCode: 1, cancelled: false, truncated: false } } : undefined);
  pi.on("before_agent_start", (event) => {
    // Reassert the intersection even if another extension changed the visible tool list.
    if (tools.planning) {
      tools.apply(pi);
      return { systemPrompt: `${event.systemPrompt}\n\n当前为计划模式：只读取、搜索和提问，不修改文件、不执行 Shell。使用 question 或 questionnaire 澄清必要信息。在“计划：”标题下输出编号步骤。等待用户选择执行。` };
    }
    if (executing) return { systemPrompt: `${event.systemPrompt}\n\n按计划执行，完成一步后输出 [DONE:n]。剩余步骤：\n${todos.filter((item) => !item.completed).map((item) => `${item.step}. ${item.text}`).join("\n")}` };
    return undefined;
  });
  pi.on("agent_end", async (event, ctx) => {
    const last = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (!last || last.role !== "assistant") return;
    const text = last.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (tools.planning) {
      // A new answer with no plan must not leave an old plan ready for execution.
      todos = extractTodoItems(text);
      persist();
      update(ctx);
      if (todos.length && ctx.hasUI) {
        const choice = await ctx.ui.select("计划已生成，下一步？", ["留在计划模式", "执行计划", "修改计划"]);
        if (choice === "执行计划") execute(ctx);
        else if (choice === "修改计划") ctx.ui.setEditorText("请调整计划：");
      }
    }
  });
  pi.on("turn_end", (event, ctx) => {
    if (!executing || event.message.role !== "assistant") return;
    markCompletedSteps(event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), todos);
    if (todos.length && todos.every((item) => item.completed)) {
      executing = false;
      ctx.ui.notify("计划步骤已完成，验证结果以宿主报告为准。", "info");
    }
    persist();
    update(ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    tools.planning = false;
    todos = [];
    executing = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "picode-plan") continue;
      const state = entry.data as { enabled?: boolean; todos?: TodoItem[]; executing?: boolean } | undefined;
      tools.planning = state?.enabled === true;
      executing = state?.executing === true;
      todos = Array.isArray(state?.todos) ? state.todos.filter((item) => typeof item?.text === "string" && Number.isInteger(item.step) && typeof item.completed === "boolean") : [];
    }
    tools.apply(pi);
    update(ctx);
  });
}
