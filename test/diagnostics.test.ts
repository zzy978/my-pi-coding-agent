import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";
import { readModelConfigWithSources } from "../src/model-config.js";
import { buildDiagnostics, collectDiagnostics, createDiagnosticsExtension, formatDiagnostics } from "../src/diagnostics.js";
import type { ResourceLoader, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { run } from "../src/main.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "picode-diagnostics-"));
  roots.push(root);
  return root;
}

describe("read-only diagnostics", () => {
  it("registers a read-only session command that reads the current model and tools each time", async () => {
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    let tools = ["read"];
    const pi = { registerCommand: (name: string, value: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
      expect(name).toBe("diagnostics"); command = value;
    }, getActiveTools: () => tools } as unknown as ExtensionAPI;
    const loader = {
      getSystemPrompt: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      getAgentsFiles: () => ({ agentsFiles: [{ path: "AGENTS.md", content: "loaded instructions" }] }),
      getExtensions: () => ({ extensions: [{ path: "loaded-extension.ts" }], errors: [] })
    } as unknown as ResourceLoader;
    const configuration = readModelConfigWithSources({ path: null, env: { PICODE_MODEL_MAX_OUTPUT_TOKENS: "5000" } });
    const extension = createDiagnosticsExtension(configuration, () => loader);
    if (typeof extension === "function") await extension(pi); else await extension.factory(pi);
    const notify = vi.fn();
    const ctx = { cwd: "workspace", model: { provider: "test", id: "first", baseUrl: "https://example.com", maxTokens: 1000 }, ui: { notify } } as unknown as ExtensionCommandContext;
    await command!.handler("--json", ctx);
    expect(JSON.parse(String(notify.mock.calls[0]?.[0]))).toMatchObject({ mode: "session", model: { id: "first", maxOutputTokens: 1000 }, tools: ["read"] });
    tools = ["read", "edit"];
    ctx.model = { ...ctx.model!, id: "second" };
    vi.stubEnv("PICODE_MODEL_MAX_OUTPUT_TOKENS", "1");
    await command!.handler("--json", ctx);
    const changed = JSON.parse(String(notify.mock.calls[1]?.[0])) as { model: { id: string; maxOutputTokens: number }; tools: string[] };
    expect(changed.model).toMatchObject({ id: "second", maxOutputTokens: 1000 });
    expect(changed.tools).toEqual(["edit", "read"]);
    await command!.handler("invalid", ctx);
    expect(notify.mock.calls[2]?.[1]).toBe("error");
  });
  it("uses live resources and model limits while escaping all public string fields", () => {
    const loader = {
      getSystemPrompt: () => "private prompt",
      getSystemPromptSource: () => ({ path: "system.md" }),
      getAppendSystemPrompt: () => ["private append"],
      getAppendSystemPromptSources: () => [{ path: "append.md" }],
      getExtensions: () => ({ extensions: [{ path: "extension\u001b[2J.ts" }], errors: [{ error: "hidden error body" }] })
    } as unknown as ResourceLoader;
    const configuration = readModelConfigWithSources({ path: null, env: {
      PICODE_MODEL_PROVIDER: "openai", PICODE_MODEL_API_KEY: "live-opaque-secret", PICODE_MODEL_MAX_OUTPUT_TOKENS: "9000"
    } });
    const report = buildDiagnostics({ workspace: "workspace\u202e", configuration, loader,
      contextFiles: [{ path: "live-opaque-secret.md", content: "private body" }], tools: ["tool\u001b[2J"],
      model: { provider: "openai", id: "live-model", maxTokens: 4096, baseUrl: "https://example.com/private-endpoint" } });
    expect(report.mode).toBe("session");
    expect(report.model).toMatchObject({ id: "live-model", maxOutputTokens: 4096 });
    expect(report.extensions.errorCount).toBe(1);
    expect(report.prompts).toHaveLength(2);
    for (const output of [JSON.stringify(report), formatDiagnostics(report)]) {
      for (const forbidden of ["live-opaque-secret", "private body", "private prompt", "private append", "private-endpoint", "hidden error body", "\u001b", "\u202e"]) {
        expect(output).not.toContain(forbidden);
      }
    }
  });

  it("reports explicit environment values and rejects invalid configuration and directories", async () => {
    const configuration = readModelConfigWithSources({ path: null, env: { PICODE_MODEL_MAX_OUTPUT_TOKENS: "512" } });
    expect(configuration.sources.maxOutputTokens).toEqual({ kind: "environment" });
    expect(configuration.config.maxOutputTokens).toBe(512);
    expect(() => readModelConfigWithSources({ path: null, env: { PICODE_MODEL_MAX_OUTPUT_TOKENS: "invalid" } })).toThrow();
    const root = await fixture();
    const file = join(root, "file");
    await writeFile(file, "x");
    await expect(collectDiagnostics({ workspace: file, configuration })).rejects.toThrow("目录");
    await expect(collectDiagnostics({ workspace: join(root, "missing"), configuration })).rejects.toThrow();
  });

  it("does not echo a missing path containing credentials or terminal control characters", async () => {
    const root = await fixture();
    const path = join(root, "config.env");
    await writeFile(path, "PICODE_MODEL_PROVIDER=openai\nPICODE_MODEL_API_KEY=missing-path-secret\n");
    vi.stubEnv("PICODE_ENV_FILE", path);
    try {
      await collectDiagnostics({ workspace: join(root, "missing-path-secret\u001b") });
      expect.fail("Expected inaccessible directory");
    } catch (error) {
      expect(String(error)).not.toContain("missing-path-secret");
      expect(String(error)).not.toContain("\u001b");
    }
  });
  it("shares parsing and tracks environment, file, defaults and blank overrides", async () => {
    const root = await fixture();
    const path = join(root, "config.env");
    await writeFile(path, "PICODE_MODEL_PROVIDER=openai\nPICODE_MODEL_API_KEY=opaque-diagnostic-secret\nPICODE_MODEL_REQUEST_TIMEOUT_MS=8000\n");
    const result = readModelConfigWithSources({ path, env: { PICODE_MODEL_REQUEST_TIMEOUT_MS: " " } });
    expect(result.config.requestTimeoutMs).toBe(120_000);
    expect(result.sources.requestTimeoutMs).toEqual({ kind: "default", overriddenByEmptyEnvironment: true });
    expect(result.sources.provider).toEqual({ kind: "file", path });
    expect(result.sources.maxOutputTokens).toEqual({ kind: "default" });
  });

  it("does not execute extensions, create data or reveal credentials and context bodies", async () => {
    const root = await fixture();
    const agentDirectory = join(root, "missing-agent");
    const configPath = join(root, "config.env");
    await writeFile(configPath, "PICODE_MODEL_PROVIDER=openai\nPICODE_MODEL_API_KEY=opaque-diagnostic-secret\nPICODE_MODEL_ID=test\n");
    await writeFile(join(root, "AGENTS.md"), "private context body");
    await mkdir(join(root, ".pi", "extensions"), { recursive: true });
    await writeFile(join(root, ".pi", "extensions", "fail.ts"), 'throw new Error("MUST NOT EXECUTE");');
    const before = await readdir(root);
    const report = await collectDiagnostics({ workspace: root, agentDirectory, shellEnabled: false,
      configuration: readModelConfigWithSources({ path: configPath, env: {} }) });
    expect(report.mode).toBe("preflight");
    expect(report.contextFiles.find((item) => item.path === join(root, "AGENTS.md"))?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.tools).not.toContain("powershell");
    expect(report.extensions.status).toBe("not-loaded");
    expect(report.model.status).toBe("unresolved");
    expect(JSON.stringify(report)).not.toContain("opaque-diagnostic-secret");
    expect(formatDiagnostics(report)).not.toContain("private context body");
    expect(await readdir(root)).toEqual(before);
    expect(await readFile(configPath, "utf8")).toContain("opaque-diagnostic-secret");
  });

  it("routes JSON before any data directory creation and rejects execution flags", async () => {
    const root = await fixture();
    vi.stubEnv("PI_TUI_AGENT_DATA_DIR", join(root, "missing-data"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await run(parseCliArgs([root, "--diagnostics", "--json"]))).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]?.[0])) as { mode: string };
    expect(report.mode).toBe("preflight");
    expect(await readdir(root)).toEqual([]);
    for (const flags of [["--doctor"], ["--task", "x"], ["--setup", "echo x"], ["--continue"], ["--list-runs"], ["--analyze-run", "id"]]) {
      expect(() => parseCliArgs(["--diagnostics", ...flags])).toThrow();
    }
    expect(parseCliArgs(["--diagnostics", "--json", "--no-shell"]).diagnostics).toBe(true);
  });
});
