import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRuntimeEntry, sealFiles, verifyFiles } from "../src/benchmark/swe-candidate-storage.js";

describe("SWE 文件证据绑定", () => {
  it("保留文件字节哈希并拒绝内容变化及丢失", async () => {
    const root = await mkdtemp(join(tmpdir(), "picode-evidence-"));
    await writeFile(join(root, "model.patch"), "original\r\n");
    const seal = await sealFiles(root, ["model.patch"]);
    expect(await verifyFiles(root, seal)).toEqual([]);
    await writeFile(join(root, "model.patch"), "changed\n");
    expect(await verifyFiles(root, seal)).toEqual(["文件哈希不匹配：model.patch"]);
    expect(await readFile(join(root, "model.patch"), "utf8")).toBe("changed\n");
    expect(await verifyFiles(root, { "missing.json": "a".repeat(64) })).toEqual(["文件不可读取：missing.json"]);
  });
  it("拒绝相对路径逃逸和重复条目", async () => {
    const root = await mkdtemp(join(tmpdir(), "picode-evidence-"));
    await expect(sealFiles(root, ["../secret"])).rejects.toThrow("Unsafe");
    await expect(sealFiles(root, ["a", "a"])).rejects.toThrow("Duplicate");
  });
  it("正确cwd不能掩盖加载了快照外源码", async () => {
    const root = await mkdtemp(join(tmpdir(), "picode-entry-"));
    const runtime = join(root, "runtime"); const folder = join(runtime, "src", "benchmark"); await mkdir(folder, { recursive: true });
    const entry = join(folder, "swe-candidate-batch.ts"); await writeFile(entry, "frozen");
    const outside = join(root, "outside.ts"); await writeFile(outside, "changed");
    await expect(assertRuntimeEntry(root, pathToFileURL(outside).href, runtime)).rejects.toThrow("frozen");
    await expect(assertRuntimeEntry(root, pathToFileURL(entry).href, root)).rejects.toThrow("frozen");
    await expect(assertRuntimeEntry(root, pathToFileURL(entry).href, runtime)).resolves.toBeUndefined();
  });
});
