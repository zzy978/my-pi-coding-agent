import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDataDirectories,
  getDataDirectories,
  getDataDirectory
} from "../src/runtime/data-dir.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 3
  })));
});

describe("runtime data directory", () => {
  it("defaults to the repository-local .picoding directory", () => {
    const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    expect(getDataDirectory({})).toBe(join(repositoryRoot, ".picoding"));
  });

  it("keeps the explicit environment override", () => {
    expect(getDataDirectory({ PI_TUI_AGENT_DATA_DIR: "D:\\isolated-pi-data" }))
      .toBe("D:\\isolated-pi-data");
  });

  it("creates one directory for every runtime artifact category", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-data-layout-"));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, ".picoding");
    const directories = await ensureDataDirectories(dataDirectory);

    expect(directories).toEqual({
      root: dataDirectory,
      runs: join(dataDirectory, "runs"),
      worktree: join(dataDirectory, "worktree"),
      sessions: join(dataDirectory, "sessions"),
      reports: join(dataDirectory, "reports"),
      temp: join(dataDirectory, "temp"),
      agent: join(dataDirectory, "agent")
    });
    const paths = getDataDirectories(dataDirectory);
    await expect(Promise.all([
      paths.root,
      paths.runs,
      paths.worktree,
      paths.sessions,
      paths.reports,
      paths.temp,
      paths.agent
    ].map((path) => stat(path))))
      .resolves.toHaveLength(7);
  });
});
