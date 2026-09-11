import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export interface ModelLimits {
  requestTimeoutMs: number;
  maxOutputTokens: number;
  taskTimeoutMs: number;
}

export interface ModelConfig extends ModelLimits {
  provider?: string;
  modelId?: string;
  apiKey?: string;
  baseUrl?: string;
  synthesisTimeoutMs: number;
  synthesisMaxOutputTokens: number;
}

export interface RecordedModelConfig extends ModelLimits {
  baseUrlSha256: string;
}

const defaultEnvPath = fileURLToPath(new URL("../.env", import.meta.url));
const runtimeSecrets = new Set<string>();

/** Keep file credentials out of process.env and child-process environments. */
export function modelSecrets(): readonly string[] {
  return [...runtimeSecrets];
}

export function readModelConfig(options: { path?: string | null; env?: NodeJS.ProcessEnv } = {}): ModelConfig {
  const env = options.env ?? process.env;
  const path = options.path === undefined ? env.PICODE_ENV_FILE || defaultEnvPath : options.path;
  let file: NodeJS.ProcessEnv = {};
  if (path !== null) {
    try { file = parseEnv(readFileSync(path, "utf8")); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT" && options.path === undefined && !env.PICODE_ENV_FILE)) {
        throw new Error("无法读取模型配置文件；请检查 PICODE_ENV_FILE 和文件权限。");
      }
    }
  }
  const value = (name: string): string | undefined => (env[name] ?? file[name])?.trim() || undefined;
  const number = (name: string, fallback: number, allowZero = false): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > 2_147_483_647) {
      throw new Error(`${name} 必须为${allowZero ? "非负" : "正"}整数，且不超过 2147483647。`);
    }
    return parsed;
  };
  const provider = value("PICODE_MODEL_PROVIDER");
  const modelId = value("PICODE_MODEL_ID");
  const apiKey = value("PICODE_MODEL_API_KEY");
  const baseUrl = value("PICODE_MODEL_BASE_URL");
  if (apiKey) runtimeSecrets.add(apiKey);
  if (!provider && (modelId || apiKey || baseUrl)) throw new Error("设置模型、密钥或服务地址时必须设置 PICODE_MODEL_PROVIDER。");
  if (provider && !/^[a-zA-Z0-9._-]+$/.test(provider)) throw new Error("PICODE_MODEL_PROVIDER 格式不正确。");
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { throw new Error("PICODE_MODEL_BASE_URL 必须为 HTTP(S) 地址，不得包含用户名、密码、查询参数或片段。"); }
  }
  return {
    ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}),
    ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}),
    requestTimeoutMs: number("PICODE_MODEL_REQUEST_TIMEOUT_MS", 120_000),
    maxOutputTokens: number("PICODE_MODEL_MAX_OUTPUT_TOKENS", 16_384),
    taskTimeoutMs: number("PICODE_MODEL_TASK_TIMEOUT_MS", 0, true),
    synthesisTimeoutMs: number("PICODE_SYNTHESIS_TIMEOUT_MS", 120_000),
    synthesisMaxOutputTokens: number("PICODE_SYNTHESIS_MAX_OUTPUT_TOKENS", 16_000)
  };
}

export function parseRecordedModelConfig(value: unknown): RecordedModelConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid recorded model configuration");
  const record = value as Record<string, unknown>;
  for (const key of ["requestTimeoutMs", "maxOutputTokens", "taskTimeoutMs"] as const) {
    const number = record[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < (key === "taskTimeoutMs" ? 0 : 1) || number > 2_147_483_647) {
      throw new Error(`Invalid recorded model configuration: ${key}`);
    }
  }
  if (typeof record.baseUrlSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.baseUrlSha256)) throw new Error("Invalid recorded model endpoint fingerprint");
  return { requestTimeoutMs: record.requestTimeoutMs as number, maxOutputTokens: record.maxOutputTokens as number,
    taskTimeoutMs: record.taskTimeoutMs as number, baseUrlSha256: record.baseUrlSha256 };
}
