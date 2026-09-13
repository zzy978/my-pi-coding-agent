import { stat } from "node:fs/promises";
import type { ResourceLoader, InlineExtension } from "@earendil-works/pi-coding-agent";
import { readDiagnosticContext } from "./diagnostics-context.js";
import { APP_VERSION } from "./config.js";
import { readModelConfigWithSources, type ModelConfigSnapshot, type ConfigSource } from "./model-config.js";
import { sha256Text } from "./evaluation/schema.js";
import { redactSensitiveText } from "./evaluation/redaction.js";
import { createSafeToolDefinitions } from "./policy/safe-tools.js";
import { getDataDirectories } from "./runtime/data-dir.js";

function visible(value: string): string {
  return Array.from(redactSensitiveText(value), (character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
      ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }).join("");
}

export interface DiagnosticsReport {
  schemaVersion: 1;
  appVersion: string;
  mode: "preflight" | "session";
  workspace: string;
  configuration: Array<{ field: string; value: string | number; source: ConfigSource }>;
  model: { status: "unresolved" | "selected"; provider?: string; id?: string; maxOutputTokens?: number; baseUrlSha256?: string };
  contextFiles: Array<{ path: string; sha256: string }>;
  prompts: Array<{ path: string; sha256: string }>;
  extensions: { status: "not-loaded" | "loaded"; paths: string[]; errorCount: number };
  tools: string[];
  notes: string[];
}

interface DiagnosticsInput {
  workspace: string;
  configuration: ModelConfigSnapshot;
  contextFiles: Array<{ path: string; content: string }>;
  tools: string[];
  loader?: ResourceLoader;
  model?: { provider: string; id: string; maxTokens: number; baseUrl: string };
}

/** 仅投影允许公开的字段；不序列化配置对象、认证对象或提示正文。 */
export function buildDiagnostics(input: DiagnosticsInput): DiagnosticsReport {
  const { config, sources } = input.configuration;
  const fields = {
    provider: config.provider ?? "未指定（由会话选择）",
    modelId: config.modelId ?? "未指定（由会话选择）",
    apiKey: config.apiKey ? "已配置" : "未配置（Pi 认证另行解析）",
    baseUrl: config.baseUrl ? `sha256:${sha256Text(config.baseUrl)}` : "未覆盖（由模型提供）",
    requestTimeoutMs: config.requestTimeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    taskTimeoutMs: config.taskTimeoutMs,
    synthesisTimeoutMs: config.synthesisTimeoutMs,
    synthesisMaxOutputTokens: config.synthesisMaxOutputTokens
  };
  const loader = input.loader;
  const prompts: DiagnosticsReport["prompts"] = [];
  const system = loader?.getSystemPrompt();
  if (system !== undefined) prompts.push({ path: visible(loader?.getSystemPromptSource()?.path ?? "runtime:system"), sha256: sha256Text(system) });
  const append = loader?.getAppendSystemPrompt() ?? [];
  const appendSources = loader?.getAppendSystemPromptSources() ?? [];
  for (const [index, content] of append.entries()) {
    prompts.push({ path: visible(appendSources.length === append.length ? appendSources[index]?.path ?? `runtime:append:${index}` : `runtime:append:${index}`), sha256: sha256Text(content) });
  }
  return {
    schemaVersion: 1, appVersion: APP_VERSION, mode: loader ? "session" : "preflight", workspace: visible(input.workspace),
    configuration: Object.entries(fields).map(([field, value]) => {
      const source = sources[field as keyof typeof sources] ?? { kind: "programmatic" as const };
      return { field, value: typeof value === "string" ? visible(value) : value,
        source: { ...source, ...(source.path === undefined ? {} : { path: visible(source.path) }) } };
    }),
    model: input.model ? { status: "selected", provider: visible(input.model.provider), id: visible(input.model.id),
      maxOutputTokens: Math.min(input.model.maxTokens, config.maxOutputTokens), baseUrlSha256: sha256Text(input.model.baseUrl) }
      : { status: "unresolved" },
    contextFiles: input.contextFiles.map((file) => ({ path: visible(file.path), sha256: sha256Text(file.content) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    prompts,
    extensions: loader ? { status: "loaded", paths: loader.getExtensions().extensions.map((item) => visible(item.path)).sort(),
      errorCount: loader.getExtensions().errors.length } : { status: "not-loaded", paths: [], errorCount: 0 },
    tools: input.tools.map(visible).sort(),
    notes: loader ? ["当前会话快照；配置来源保留启动时状态。", "单次输出上限取配置与模型能力较小值；调用者仍可进一步降低。",
      "提示哈希仅覆盖资源加载器中的 system/append 片段，不代表完整请求；不输出正文或认证值。"]
      : ["启动前快照：未创建会话，实际模型及 Pi 认证尚未解析。", "上下文列表来自当前磁盘；工具为宿主内置工具，不包含扩展新增工具。",
        "未加载扩展、Skills 或提示模板；在已启动会话中用 /diagnostics 查看实际加载状态。" ]
  };
}

export async function collectDiagnostics(options: {
  workspace: string; shellEnabled?: boolean; agentDirectory?: string; configuration?: ModelConfigSnapshot;
}): Promise<DiagnosticsReport> {
  const configuration = options.configuration ?? readModelConfigWithSources();
  try {
    if (!(await stat(options.workspace)).isDirectory()) throw new Error();
  } catch { throw new Error("诊断工作目录不可访问或不是目录。"); }
  const context = await readDiagnosticContext(options.workspace, options.agentDirectory ?? getDataDirectories().agent);
  const report = buildDiagnostics({ workspace: options.workspace, configuration,
    contextFiles: context.files,
    tools: createSafeToolDefinitions(options.workspace, options.shellEnabled ?? true).map((tool) => tool.name) });
  if (context.warnings) report.notes.push("上下文读取器产生警告，列表可能不完整；原始错误已隐藏以保护路径和凭据。");
  return report;
}

export function formatDiagnostics(report: DiagnosticsReport): string {
  const sourceLabel = (source: ConfigSource): string => {
    const label = { environment: "系统环境变量", file: "配置文件", default: "默认值/未指定", programmatic: "程序传入" }[source.kind];
    return `${label}${source.path ? ` ${source.path}` : ""}${source.overriddenByEmptyEnvironment ? "（空环境变量屏蔽文件值）" : ""}`;
  };
  return [
    `诊断：${report.mode === "session" ? "当前会话" : "启动前快照"}（${report.appVersion}）`,
    `目录：${report.workspace}`,
    ...report.configuration.map((item) => `${item.field}: ${item.value} ← ${sourceLabel(item.source)}`),
    `实际模型：${report.model.status === "selected" ? `${report.model.provider}/${report.model.id}；输出上限 ${report.model.maxOutputTokens}` : "尚未解析"}`,
    `上下文文件：${report.contextFiles.length}`,
    ...report.contextFiles.map((item) => `  ${item.path}  sha256:${item.sha256}`),
    `提示片段：${report.mode === "session" ? report.prompts.length : "尚未加载"}`,
    ...report.prompts.map((item) => `  ${item.path}  sha256:${item.sha256}`),
    `扩展：${report.extensions.status === "loaded" ? `${report.extensions.paths.length} 已加载；${report.extensions.errorCount} 加载错误` : "尚未加载"}`,
    ...report.extensions.paths.map((path) => `  ${path}`),
    `工具：${report.tools.join(", ")}`,
    ...report.notes
  ].join("\n");
}

export function createDiagnosticsExtension(configuration: ModelConfigSnapshot, getLoader: () => ResourceLoader | undefined): InlineExtension {
  return { name: "pi-tui-diagnostics", factory: (pi) => {
    pi.registerCommand("diagnostics", {
      description: "查看当前配置来源、模型、上下文哈希、扩展和工具",
      handler: (args, ctx) => {
        if (args.trim() && args.trim() !== "--json") { ctx.ui.notify("用法：/diagnostics [--json]", "error"); return Promise.resolve(); }
        const loader = getLoader();
        if (!loader) { ctx.ui.notify("会话资源尚未就绪。", "error"); return Promise.resolve(); }
        const report = buildDiagnostics({ workspace: ctx.cwd, configuration, loader,
          contextFiles: loader.getAgentsFiles().agentsFiles, tools: pi.getActiveTools(), ...(ctx.model ? { model: ctx.model } : {}) });
        ctx.ui.notify(args.trim() === "--json" ? JSON.stringify(report, null, 2) : formatDiagnostics(report), "info");
        return Promise.resolve();
      }
    });
  } };
}
