import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readModelConfig } from "../src/model-config.js";
import { isProtectedPath, isSensitiveReadPath } from "../src/policy/path-policy.js";
import { assertRecordableCommands } from "../src/evaluation/redaction.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("model environment configuration", () => {
  it("reads a fixed file without exporting secrets, with environment taking priority", async () => {
    const root = await mkdtemp(join(tmpdir(), "picode-env-"));
    directories.push(root);
    const path = join(root, ".env");
    await writeFile(path, 'PICODE_MODEL_PROVIDER=openai\nPICODE_MODEL_ID=example\nPICODE_MODEL_API_KEY="test-only-secret"\nPICODE_MODEL_REQUEST_TIMEOUT_MS=8000\nPICODE_MODEL_MAX_OUTPUT_TOKENS=512\n');
    const env = { PICODE_MODEL_REQUEST_TIMEOUT_MS: "9000" };
    const config = readModelConfig({ path, env });
    expect(config.apiKey).toBe("test-only-secret");
    expect(config.requestTimeoutMs).toBe(9000);
    expect(config.maxOutputTokens).toBe(512);
    expect(env).toEqual({ PICODE_MODEL_REQUEST_TIMEOUT_MS: "9000" });
    expect(await readFile(path, "utf8")).toContain("test-only-secret");
  });

  it.each(["0", "-1", "1.5", "NaN", "2147483648", "secret-invalid"]) ("rejects invalid request limits without echoing values: %s", (value) => {
    expect(() => readModelConfig({ path: null, env: { PICODE_MODEL_REQUEST_TIMEOUT_MS: value } })).toThrow("PICODE_MODEL_REQUEST_TIMEOUT_MS");
    try { readModelConfig({ path: null, env: { PICODE_MODEL_REQUEST_TIMEOUT_MS: value } }); }
    catch (error) { expect(String(error)).not.toContain(value === "0" ? "value=0" : `value=${value}`); }
  });

  it("requires a provider for credentials and rejects credential-bearing URLs", () => {
    expect(() => readModelConfig({ path: null, env: { PICODE_MODEL_API_KEY: "test-only-secret" } })).toThrow("PICODE_MODEL_PROVIDER");
    for (const url of ["file:///tmp/model", "https://user:password@example.com", "https://example.com?api_key=secret"]) {
      expect(() => readModelConfig({ path: null, env: { PICODE_MODEL_PROVIDER: "openai", PICODE_MODEL_BASE_URL: url } })).toThrow("PICODE_MODEL_BASE_URL");
    }
  });

  it("rejects configured credentials embedded in setup commands before recording", () => {
    readModelConfig({ path: null, env: { PICODE_MODEL_PROVIDER: "openai", PICODE_MODEL_API_KEY: "opaque-credential-for-test" } });
    expect(() => assertRecordableCommands([{ command: 'node setup.js "opaque-credential-for-test"' }], "Setup")).toThrow("credential");
    expect(() => assertRecordableCommands([{ command: "node setup.js" }], "Setup")).not.toThrow();
  });

  it("allows only the exact public template while keeping protected ancestors", () => {
    expect(isProtectedPath("docs/.env.example")).toBe(false);
    expect(isSensitiveReadPath("docs/.env.example")).toBe(false);
    for (const path of [".env", ".env.local", ".env.example.local", ".git/.env.example", ".env.private/.env.example", "node_modules/.env.example"]) {
      expect(isProtectedPath(path)).toBe(true);
    }
  });
});
