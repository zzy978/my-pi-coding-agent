import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliArgs } from "../src/cli-args.js";
import { isSupportedNodeVersion } from "../src/config.js";

describe("Node version policy", () => {
  it.each([
    ["22.18.9", false],
    ["22.19.0", true],
    ["22.20.0", true],
    ["23.0.0", true],
    ["21.99.99", false]
  ])("evaluates %s", (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });
});

describe("parseCliArgs", () => {
  it("parses repeatable task controls and resolves paths", () => {
    const cwd = resolve("fixture-root");
    const options = parseCliArgs([
      "repo", "--task", "fix it", "--allow", "src/**", "--allow", "test/**",
      "--verify", "npm test", "--verify", "npm run check",
      "--setup", "npm ci", "--setup", "npm run prepare", "--in-place", "--unsafe-shell"
    ], cwd);

    expect(options.workspace).toBe(resolve(cwd, "repo"));
    expect(options.task).toBe("fix it");
    expect(options.allowedPaths).toEqual(["src/**", "test/**"]);
    expect(options.verifyCommands).toEqual(["npm test", "npm run check"]);
    expect(options.setupCommands).toEqual(["npm ci", "npm run prepare"]);
    expect(options.noSetup).toBe(false);
    expect(options).not.toHaveProperty("inPlace");
    expect(options.unsafeShell).toBe(true);
  });

  it("parses controlled-run management modes without changing the default workspace", () => {
    const cwd = resolve("fixture-root");
    expect(parseCliArgs(["repo", "--record", "--task", "fix it"], cwd)).toMatchObject({
      workspace: resolve(cwd, "repo"),
      record: true
    });
    expect(parseCliArgs(["--list-runs", "--json"], cwd)).toMatchObject({ listRuns: true, json: true });
    expect(parseCliArgs(["--show-run", "run-123"], cwd)).toMatchObject({ showRunId: "run-123" });
    expect(parseCliArgs(["--replay", "run-123", "--unsafe-shell"], cwd)).toMatchObject({
      replayRunId: "run-123",
      unsafeShell: true
    });
  });

  it("continues workspace sessions without exposing a worktree mode", () => {
    expect(parseCliArgs(["repo", "--continue"], resolve("fixture-root"))).toMatchObject({
      continueSession: true
    });
    expect(parseCliArgs(["repo", "--continue"], resolve("fixture-root"))).not.toHaveProperty("inPlace");
  });

  it.each([
    [["--task"], "--task requires a value"],
    [["--task", "one", "--task-file", "task.yaml"], "Use either"],
    [["--continue", "--no-session", "--in-place"], "cannot be combined"],
    [["--unknown"], "Unknown option"],
    [["--record"], "requires --task"],
    [["--setup", "npm ci", "--no-setup"], "cannot be combined"],
    [["repo", "--record", "--task", "x", "--in-place"], "fresh managed worktree"],
    [["repo", "--replay", "run-123"], "restores workspace"],
    [["--replay", "run-123", "--task", "x"], "restores workspace"],
    [["--replay", "run-123", "--no-setup"], "restores workspace"],
    [["--list-runs", "--show-run", "run-123"], "Use only one"],
    [["--json"], "requires --list-runs"]
  ] as const)("rejects invalid arguments %j", (args, message) => {
    expect(() => parseCliArgs([...args])).toThrowError(CliUsageError);
    expect(() => parseCliArgs([...args])).toThrow(message);
  });
});
