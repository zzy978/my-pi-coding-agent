import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRetrievalCli } from "../src/benchmark/swe-retrieval-cli.js";

describe("经验检索 CLI", () => {
  it("帮助与只读状态不创建产物，也不要求模型配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrieval-cli-")), output: string[] = [];
    try {
      await runRetrievalCli(["--help"], (line) => output.push(line));
      expect(output[0]).toContain("不会运行 Docker");
      await runRetrievalCli(["status", join(root, "source"), join(root, "output")], (line) => output.push(line));
      expect(output[1]).toContain("not_started"); expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("拒绝未知模式、多余参数和误拼的选项", async () => {
    for (const args of [["execute"], ["run", "a", "b", "c"], ["run", "--approve"]]) await expect(runRetrievalCli(args)).rejects.toThrow("用法");
  });
});
