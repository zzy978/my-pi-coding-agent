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

  it("retains relative-path reporting without restricting access", () => {
    expect(relativePathWithin(workspace, "src/index.ts")).toBe("src/index.ts");
    expect(relativePathWithin(workspace, "../secret.txt")).toBeNull();
    expect(assertReadablePath(workspace, "../secret.txt")).toBe(resolve(workspace, "../secret.txt"));
    expect(assertWritablePath(workspace, "../other/new.txt")).toBe(resolve(workspace, "../other/new.txt"));
  });

  it("preserves protected paths without a whitelist", () => {
    expect(isAllowedChangedPath("src/index.ts")).toBe(true);
    expect(isAllowedChangedPath("README.md")).toBe(true);
    expect(isProtectedPath(".git/config")).toBe(true);
    expect(isProtectedPath("packages/app/.git/config")).toBe(true);
    expect(isProtectedPath(".env.local")).toBe(true);
    expect(isProtectedPath("apps/api/.env.production")).toBe(true);
    expect(isSensitiveReadPath(".env.local")).toBe(true);
    expect(isSensitiveReadPath("apps/api/.env.production")).toBe(true);
    expect(() => assertReadablePath(workspace, ".env.local")).toThrow("protected from reads");
    expect(isAllowedChangedPath("node_modules/pkg/index.js")).toBe(false);
    expect(isAllowedChangedPath("packages/app/node_modules/pkg/index.js")).toBe(false);
    if (process.platform === "win32") {
      expect(isProtectedPath(".Git/config")).toBe(true);
      expect(isSensitiveReadPath(".ENV")).toBe(true);
      expect(isAllowedChangedPath("Node_Modules/pkg/index.js")).toBe(false);
    }
    expect(() => assertWritablePath(workspace, ".env")).toThrow("not allowed");
  });
});

describe("command policy", () => {
  it.each([
    "git commit -am done",
    "sudo npm test",
    "format C:",
    "format",
    "echo ok\nformat D:",
    "cmd /c \"format D: /q\"",
    "powershell -Command \"& 'C:/Windows/System32/format.com' D:\"",
    "bash -lc 'format D:'",
    "docker exec box bash -lc 'format D:'",
    "Start-Process -FilePath format.com -ArgumentList 'D:'",
    "FORMAT.COM D: /Q",
    "cmd /c format C:",
    "& 'C:\\Windows\\System32\\format.com' D:",
    ".\\format.exe D:",
    "echo ready; format C:",
    "Format-Volume -DriveLetter D",
    "cmd /c format.com>C:/format.log D:",
    "cmd /c format<C:/answers.txt D:",
    "cmd /c format.com/?",
    "cmd /c format%SPACE%C:",
    "node -e \"require('child_process').execSync('format C:')\""
  ])("blocks %s", (command) => {
    expect(checkCommand(command).allowed).toBe(false);
  });

  it.each([
    "git reset --hard HEAD",
    "git clean -fd",
    "git rm obsolete.txt",
    "git checkout README.md",
    "Remove-Item ./build -Recurse -Force",
    "rm -rf ./build",
    "rm.exe -rf ./build",
    "npx rimraf build",
    "del output.txt",
    "cmd /c del output.txt",
    "find . -name '*.tmp' -delete",
    "npm run clean",
    "node -e \"fs.rmSync('build', { recursive: true })\"",
    "powershell -Command \"[System.IO.File]::Delete('output.txt')\""
  ])("requires approval for %s", (command) => {
    expect(checkCommand(command)).toMatchObject({ allowed: true, requiresApproval: true });
  });

  it.each(["cd ../other", "cd C:/Windows", "cd /tmp", "npm test", "git diff --stat", "Get-Content src/index.ts", "cd src; npm test"])("allows %s", (command) => {
    expect(checkCommand(command)).toEqual({ allowed: true });
  });

  it.each([
    "node -e \"const prettier = require('./'); console.log(prettier.format('const x=1', {parser:'babel'}))\"",
    "Get-Content src/cli/format.js",
    "Get-Content tests/format/typescript/enum/jsfmt.spec.js",
    "rg format src",
    "node -e \"const format = require('./').format; console.log(format('x'))\"",
    "powershell -Command \"Get-Content tests/format/a.js\"",
    "docker exec box bash -lc 'cat tests/format/a.js'",
    "Get-Content C:/Windows/System32/format.com",
    "echo format C:",
    "Get-Process | Format-Table"
  ])("does not mistake formatter code or output formatting for disk formatting: %s", (command) => {
    expect(checkCommand(command)).toEqual({ allowed: true });
  });
});
