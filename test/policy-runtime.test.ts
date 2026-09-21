import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ControlledPiRuntime } from "../src/runtime/controlled-pi-runtime.js";
import { readModelConfig } from "../src/model-config.js";
import { parseTaskSpec } from "../src/task/task-spec.js";

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("策略拒绝后的真实 Pi 循环（仅本机模拟 HTTP）", () => {
  it.each([
    { command: "git tag v1.0", continues: true },
    { command: "git checkout source.py", continues: true },
    { command: "python repro.py", continues: true },
    { command: "sudo whoami", continues: false }
  ])("$command 的执行和继续边界", async ({ command, continues }) => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const executed: string[] = [];
    const events: AgentSessionEvent[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body) as typeof requests[number]);
        const index = requests.length;
        const delta = index <= 2 ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${index}`, type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command: index === 1 ? command : "git tag --list" }) } }] }
          : { role: "assistant", content: "继续执行完成" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: `mock-${index}`, choices: [{ index: 0, delta, finish_reason: index <= 2 ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local HTTP address");
    const root = await mkdtemp(join(tmpdir(), "picode-policy-loop-"));
    let runtime: ControlledPiRuntime | undefined;
    try {
      const config = readModelConfig({ path: null, env: { PICODE_MODEL_PROVIDER: "deepseek", PICODE_MODEL_ID: "deepseek-v4-flash",
        PICODE_MODEL_API_KEY: "fake-policy-key", PICODE_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, PICODE_MODEL_REQUEST_TIMEOUT_MS: "5000" } });
      runtime = await ControlledPiRuntime.create({ workspace: root, getTask: () => parseTaskSpec({ id: "policy-loop", objective: "测试策略反馈" }),
        noSession: true, allowShell: true, modelConfig: config, agentDirectory: join(root, "agent"), remoteShell: {
          exec: (value, _cwd, options) => {
            executed.push(value);
            if (value === "python repro.py") return Promise.reject(new Error("RecursionError"));
            options.onData(Buffer.from("v1.0\n"));
            return Promise.resolve({ exitCode: 0 });
          }
        } });
      runtime.session.subscribe((event) => events.push(event));
      await runtime.session.prompt("测试策略反馈");
      expect(requests).toHaveLength(continues ? 3 : 1);
      expect(executed).toEqual(continues ? [...(command === "python repro.py" ? [command] : []), "git tag --list"] : []);
      expect(events.some((event) => event.type === "agent_settled")).toBe(true);
      if (continues) {
        const feedback = requests[1]?.messages.filter((message) => message.role === "tool");
        expect(JSON.stringify(feedback)).toMatch(command === "python repro.py" ? /RecursionError/ : /denied|blocked/);
      }
    } finally {
      runtime?.dispose();
      await close(server);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
