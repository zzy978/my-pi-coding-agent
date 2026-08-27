import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommand } from "../src/policy/command-policy.js";
import {
  assertReadablePath,
  assertWritablePath,
  isAllowedChangedPath,
  isProtectedPath,
  isSensitiveReadPath,
  relativePathWithin
} from "../src/policy/path-policy.js";

describe("path policy", () => {
  const workspace = resolve("workspace-fixture");

  it("keeps paths inside the workspace", () => {
    expect(relativePathWithin(workspace, "src/index.ts")).toBe("src/index.ts");
    expect(relativePathWithin(workspace, "../secret.txt")).toBeNull();
    expect(() => assertReadablePath(workspace, "../secret.txt")).toThrow("outside");
  });

  it("enforces allowed globs and permanently protected paths", () => {
    expect(isAllowedChangedPath("src/index.ts", ["src/**"])).toBe(true);
    expect(isAllowedChangedPath("README.md", ["src/**"])).toBe(false);
    expect(isProtectedPath(".git/config")).toBe(true);
    expect(isProtectedPath(".env.local")).toBe(true);
    expect(isSensitiveReadPath(".env.local")).toBe(true);
    expect(() => assertReadablePath(workspace, ".env.local")).toThrow("protected from reads");
    expect(isAllowedChangedPath("node_modules/pkg/index.js", ["**/*"])).toBe(false);
    expect(() => assertWritablePath(workspace, ".env", ["**/*"])).toThrow("not allowed");
  });
});

describe("command policy", () => {
  it.each([
    "git reset --hard HEAD",
    "git clean -fd",
    "git commit -am done",
    "git checkout README.md",
    "Remove-Item . -Recurse -Force",
    "rm -rf ./build",
    "sudo npm test",
    "cd C:\\Windows"
  ])("blocks %s", (command) => {
    expect(checkCommand(command).allowed).toBe(false);
  });

  it.each(["npm test", "git diff --stat", "Get-Content src/index.ts", "cd src; npm test"])("allows %s", (command) => {
    expect(checkCommand(command)).toEqual({ allowed: true });
  });
});
