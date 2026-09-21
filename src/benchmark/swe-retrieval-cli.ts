import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readModelConfig } from "../model-config.js";
import { sha256Text } from "../evaluation/schema.js";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { completeExperienceStage } from "../experience/synthesizer.js";
import { stripUnsafeControls } from "../experience/candidate.js";
import { readRetrievalStatus, reportRetrievalWorkflow, runRetrievalWorkflow } from "./swe-retrieval.js";

export const retrievalHelp = `经验检索 V2 离线诊断
用法：npm run benchmark:swe-retrieval -- run|status|report [source-root] [output-root]
默认来源：.picoding/benchmarks/swe-holdout-v1
默认输出：.picoding/benchmarks/swe-retrieval-v2
run：生成独立检索描述、筛选与独立配对评审；会调用已配置模型，逐次保存用量。
status：只读查看状态，不调用模型、不创建目录。
report：从检查点和人工标签重新生成报告，不调用模型。
输出须位于来源目录之外。中断/失败请求不自动重试；协议漂移必须使用新输出目录。
不会运行 Docker 修复、官方评分、晋升或日常 TUI 自动注入。`;

export async function runRetrievalCli(args: string[], log: (text: string) => void = console.log): Promise<void> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { log(retrievalHelp); return; }
  const mode = args[0] ?? "status";
  if (!["run", "status", "report"].includes(mode) || args.length > 3 || args.slice(1).some((value) => value.startsWith("--"))) throw new Error(retrievalHelp);
  const sourceRoot = resolve(args[1] ?? ".picoding/benchmarks/swe-holdout-v1");
  const outputRoot = resolve(args[2] ?? ".picoding/benchmarks/swe-retrieval-v2");
  if (mode === "status") { log(JSON.stringify(await readRetrievalStatus(outputRoot), null, 2)); return; }
  if (mode === "report") { log(JSON.stringify(await reportRetrievalWorkflow(sourceRoot, outputRoot), null, 2)); return; }
  const config = readModelConfig();
  if (!config.provider || !config.modelId) throw new Error("请先配置 PICODE_MODEL_PROVIDER 和 PICODE_MODEL_ID；不会自动替换模型。");
  const model = { provider: config.provider, id: config.modelId };
  const result = await runRetrievalWorkflow({ sourceRoot, outputRoot,
    model: { ...model, reasoning: "low", baseUrlSha256: sha256Text(config.baseUrl ?? "provider-default"), timeoutMs: config.synthesisTimeoutMs, maxOutputTokens: config.synthesisMaxOutputTokens },
    onProgress: log,
    complete: async (request) => completeExperienceStage({ model, modelConfig: config, reasoning: "low",
      dataDirectory: join(outputRoot, "model-data") }, request.material, request.systemPrompt),
  });
  log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRetrievalCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(stripUnsafeControls(redactSensitiveText(error instanceof Error ? error.message : String(error)))); process.exitCode = 1;
  });
}
