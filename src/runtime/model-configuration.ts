import { createHash } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelConfig, ModelLimits, RecordedModelConfig } from "../model-config.js";

export async function configureModelRuntime(runtime: ModelRuntime, config: ModelConfig, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (config.provider && config.baseUrl) runtime.registerProvider(config.provider, { baseUrl: config.baseUrl });
  if (config.provider && config.apiKey) await runtime.setRuntimeApiKey(config.provider, config.apiKey, signal ? { signal } : {});
}

export function configuredModel(runtime: ModelRuntime, config: ModelConfig): ReturnType<ModelRuntime["getModel"]> {
  const { provider, modelId } = config;
  if (!provider) return undefined;
  const model = runtime.getAvailableSnapshot().find((item) => item.provider === provider && (!modelId || item.id === modelId));
  if (!model) throw new Error("配置的模型不可用；请检查 provider、model ID 和认证。");
  return model;
}

/** The wrapper also covers SDK compaction calls through completeSimple. */
export function applyModelLimits(runtime: Pick<ModelRuntime, "streamSimple">, limits: ModelLimits): void {
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => stream({ ...model, maxTokens: Math.min(model.maxTokens, limits.maxOutputTokens) }, context, {
    ...options, timeoutMs: limits.requestTimeoutMs,
    signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(limits.requestTimeoutMs)]),
    maxTokens: Math.min(options?.maxTokens ?? limits.maxOutputTokens, limits.maxOutputTokens, model.maxTokens)
  });
}

export function recordModelConfig(model: { baseUrl: string; maxTokens: number }, limits: ModelLimits): RecordedModelConfig {
  return { requestTimeoutMs: limits.requestTimeoutMs, maxOutputTokens: Math.min(limits.maxOutputTokens, model.maxTokens),
    taskTimeoutMs: limits.taskTimeoutMs, baseUrlSha256: createHash("sha256").update(model.baseUrl).digest("hex") };
}
