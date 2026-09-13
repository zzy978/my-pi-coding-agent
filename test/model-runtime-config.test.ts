import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readModelConfig } from "../src/model-config.js";
import { configureModelRuntime, applyModelLimits } from "../src/runtime/model-configuration.js";
import { redactSensitiveText } from "../src/evaluation/redaction.js";
import { ControlledPiRuntime } from "../src/runtime/controlled-pi-runtime.js";
import { createPiInteractiveRuntime } from "../src/runtime/pi-interactive.js";
import { createInteractiveTask } from "../src/task/task-spec.js";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("model configuration at the HTTP boundary", () => {
  it("benchmark remote shell replaces all host tools and retains command policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "picode-remote-shell-"));
    directories.push(root);
    const config = readModelConfig({ path: null, env: { PICODE_MODEL_PROVIDER: "openai", PICODE_MODEL_ID: "gpt-4o", PICODE_MODEL_API_KEY: "fake-session-key" } });
    const task = createInteractiveTask({});
    const exec = vi.fn(() => Promise.resolve({ exitCode: 0 }));
    const runtime = await ControlledPiRuntime.create({ workspace: root, getTask: () => task, noSession: true, allowShell: true,
      modelConfig: config, agentDirectory: join(root, "agent"), remoteShell: { exec } });
    try {
      expect(runtime.session.getActiveToolNames()).toEqual(["bash"]);
      expect(runtime.contextFiles).toEqual([]);
    } finally { runtime.dispose(); }
    expect(exec).not.toHaveBeenCalled();
  });
  it.each(["request", "caller"] as const)("cancels a stalled HTTP response from the %s deadline", async (cause) => {
    let received = false;
    let warmedUp = false;
    const server = createServer((request, response) => {
      request.resume();
      if (warmedUp) { received = true; return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_warmup","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const config = readModelConfig({ path: null, env: { PICODE_MODEL_PROVIDER: "openai", PICODE_MODEL_API_KEY: "fake-local-key",
      PICODE_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, PICODE_MODEL_REQUEST_TIMEOUT_MS: cause === "request" ? "1000" : "10000" } });
    const root = await mkdtemp(join(tmpdir(), "picode-model-timeout-"));
    directories.push(root);
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false });
    await configureModelRuntime(runtime, config);
    const model = runtime.getAvailableSnapshot().find((item) => item.provider === "openai" && item.id === "gpt-4o");
    if (!model) throw new Error("No test model");
    // Warm the lazy SDK import before testing a stalled response under a short deadline.
    const warmup = await runtime.completeSimple(model, { messages: [{ role: "user", content: "warmup", timestamp: Date.now() }] }, { maxRetries: 0 });
    expect(warmup.stopReason, warmup.errorMessage).toBe("stop");
    warmedUp = true;
    applyModelLimits(runtime, config);
    const started = Date.now();
    const output = await runtime.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: started }] }, {
      maxRetries: 0, ...(cause === "caller" ? { signal: AbortSignal.timeout(1000) } : {})
    });
    expect(["aborted", "error"]).toContain(output.stopReason);
    expect(received).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("shares model selection across interactive and controlled sessions, and restores recorded limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "picode-model-session-"));
    directories.push(root);
    const config = readModelConfig({ path: null, env: { PICODE_MODEL_PROVIDER: "openai", PICODE_MODEL_ID: "gpt-4o",
      PICODE_MODEL_API_KEY: "fake-session-key", PICODE_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
      PICODE_MODEL_MAX_OUTPUT_TOKENS: "200", PICODE_MODEL_REQUEST_TIMEOUT_MS: "3456" } });
    const task = createInteractiveTask({});
    const base = { workspace: root, getTask: () => task, noSession: true, allowShell: false, agentDirectory: join(root, "agent"), modelConfig: config };
    const controlled = await ControlledPiRuntime.create(base);
    const frozen = controlled.modelConfig;
    try {
      expect(controlled.session.model?.id).toBe("gpt-4o");
      expect(frozen).toMatchObject({ maxOutputTokens: 200, requestTimeoutMs: 3456 });
    } finally { controlled.dispose(); }
    if (!frozen) throw new Error("Missing recorded configuration");
    const replay = await ControlledPiRuntime.create({ ...base, modelConfig: { ...config, maxOutputTokens: 500, requestTimeoutMs: 9000 }, recordedModelConfig: frozen });
    try { expect(replay.modelConfig).toEqual(frozen); } finally { replay.dispose(); }
    await expect(ControlledPiRuntime.create({ ...base, modelConfig: { ...config, baseUrl: "http://127.0.0.1:2/v1" }, recordedModelConfig: frozen })).rejects.toThrow("不一致");
    const interactive = await createPiInteractiveRuntime({ task, allowShell: false, noSession: true, continueSession: false,
      dataDirectory: join(root, "data"), modelConfig: config,
      workspace: { workspace: root, sourceRoot: root, branch: "", baselineCommit: "", managedWorktree: false, gitUnavailable: true } });
    try {
      expect(interactive.session.model?.id).toBe("gpt-4o");
      expect(interactive.session.model?.baseUrl).toBe("http://127.0.0.1:1/v1");
    } finally { await interactive.dispose(); }
  });
  it("uses configured address, in-memory credential and output cap without persisting the key", async () => {
    let received: { path?: string; authorization?: string; body?: string } = {};
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        received = { path: request.url ?? "", authorization: request.headers.authorization ?? "", body };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const root = await mkdtemp(join(tmpdir(), "picode-model-http-"));
    directories.push(root);
    const modelsPath = join(root, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { "config-test": {
      api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", models: [
        { id: "test-model", name: "Test", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      ]
    } } }));
    const config = readModelConfig({ path: null, env: { PICODE_MODEL_PROVIDER: "config-test", PICODE_MODEL_API_KEY: "arbitrary-test-key-abc",
      PICODE_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, PICODE_MODEL_MAX_OUTPUT_TOKENS: "123" } });
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath, allowModelNetwork: false });
    await configureModelRuntime(runtime, config);
    applyModelLimits(runtime, config);
    const model = runtime.getAvailableSnapshot().find((item) => item.provider === "config-test");
    if (!model) throw new Error("Configured model unavailable");
    const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, { maxTokens: 999, maxRetries: 0 });
    expect(result.stopReason).toBe("stop");
    expect(received.path).toBe("/v1/chat/completions");
    expect(received.authorization).toBe("Bearer arbitrary-test-key-abc");
    const body = JSON.parse(received.body ?? "{}") as { max_tokens?: number; max_completion_tokens?: number };
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(123);
    const stored = await readFile(join(root, "auth.json"), "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    expect(stored).not.toContain("arbitrary-test-key-abc");
    expect(redactSensitiveText("server echoed arbitrary-test-key-abc")).not.toContain("arbitrary-test-key-abc");
  });
});
