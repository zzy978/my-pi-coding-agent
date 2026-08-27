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
      "--verify", "npm test", "--verify", "npm run check", "--in-place"
    ], cwd);

    expect(options.workspace).toBe(resolve(cwd, "repo"));
    expect(options.task).toBe("fix it");
    expect(options.allowedPaths).toEqual(["src/**", "test/**"]);
    expect(options.verifyCommands).toEqual(["npm test", "npm run check"]);
    expect(options.inPlace).toBe(true);
  });

  it.each([
    [["--task"], "--task requires a value"],
    [["--task", "one", "--task-file", "task.yaml"], "Use either"],
    [["--continue", "--no-session"], "cannot be combined"],
    [["--unknown"], "Unknown option"]
  ] as const)("rejects invalid arguments %j", (args, message) => {
    expect(() => parseCliArgs([...args])).toThrowError(CliUsageError);
    expect(() => parseCliArgs([...args])).toThrow(message);
  });
});

