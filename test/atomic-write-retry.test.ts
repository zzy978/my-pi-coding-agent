import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type * as FileSystemPromises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rename: vi.fn(), delay: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<object>(), rename: mocks.rename }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
import { writeJsonAtomic } from "../src/evaluation/store.js";

beforeEach(() => { mocks.rename.mockReset(); mocks.delay.mockReset(); mocks.delay.mockResolvedValue(undefined); });
describe("原子 JSON 替换遇临时占用", () => {
  it("重试临时 EPERM，保留旧文件直到原子替换成功", async () => {
    const root = await mkdtemp(join(tmpdir(), "atomic-retry-")), path = join(root, "state.json");
    const actual = await vi.importActual<typeof FileSystemPromises>("node:fs/promises");
    try {
      await writeFile(path, '{"old":true}');
      mocks.rename.mockImplementationOnce(async () => { expect(await readFile(path, "utf8")).toBe('{"old":true}'); throw Object.assign(new Error("busy"), { code: "EPERM" }); });
      mocks.rename.mockImplementation(actual.rename);
      await writeJsonAtomic(path, { next: true });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ next: true });
      expect(mocks.rename).toHaveBeenCalledTimes(2); expect(mocks.delay).toHaveBeenCalledTimes(1);
      expect(await readdir(root)).toEqual(["state.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["EPERM", "ENOSPC"])("%s 最终失败保留旧文件并清理临时文件，重试次数有界", async (code) => {
    const root = await mkdtemp(join(tmpdir(), "atomic-stop-")), path = join(root, "state.json");
    try {
      await writeFile(path, '{"old":true}');
      mocks.rename.mockRejectedValue(Object.assign(new Error("blocked"), { code }));
      await expect(writeJsonAtomic(path, { next: true })).rejects.toThrow("blocked");
      expect(await readFile(path, "utf8")).toBe('{"old":true}');
      expect(mocks.rename.mock.calls.length).toBe(code === "EPERM" ? 9 : 1);
      expect(await readdir(root)).toEqual(["state.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
