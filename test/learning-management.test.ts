import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";
import { run } from "../src/main.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 3 })));
});

describe("headless learning management", () => {
  it("routes read-only lists before TUI startup and creates no worktree or model credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-learning-cli-"));
    roots.push(root);
    vi.stubEnv("PI_TUI_AGENT_DATA_DIR", root);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const flag of ["--list-experiences", "--list-experiments"]) {
      expect(await run(parseCliArgs([flag, "--json"]))).toBe(0);
      expect(output).toHaveBeenLastCalledWith("[]");
    }
    expect(await readdir(join(root, "worktree"))).toEqual([]);
    expect(await readdir(join(root, "agent"))).toEqual([]);
    expect(await readdir(join(root, "runs"))).toEqual([]);
  });

  it("does not silently start a TUI when a requested experience does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-learning-show-"));
    roots.push(root);
    vi.stubEnv("PI_TUI_AGENT_DATA_DIR", root);
    await expect(run(parseCliArgs(["--show-experience", "missing", "--json"]))).rejects.toThrow();
    expect(await readdir(join(root, "worktree"))).toEqual([]);
  });
});
