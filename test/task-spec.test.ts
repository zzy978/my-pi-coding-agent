import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatTaskPrompt, loadTaskSpec, parseTaskSpec, TaskSpecError } from "../src/task/task-spec.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("TaskSpec", () => {
  it("normalizes aliases, removes duplicates, and applies verifier defaults", () => {
    const task = parseTaskSpec({
      id: "task-1",
      objective: "  implement a command  ",
      allowed_paths: ["src/**", "src/**"],
      verify: ["npm test", { command: "npm run check", timeoutMs: 5_000 }],
      done_when: ["tests pass"]
    });

    expect(task.objective).toBe("implement a command");
    expect(task.allowedPaths).toEqual(["src/**"]);
    expect(task.verify).toEqual([
      { command: "npm test", timeoutMs: 120_000 },
      { command: "npm run check", timeoutMs: 5_000 }
    ]);
    expect(formatTaskPrompt(task)).toContain("Verification commands: npm test; npm run check");
  });

  it("loads YAML and rejects unsafe verifier timeouts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-agent-task-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "task.yaml");
    await writeFile(file, "objective: Test YAML\nallowedPaths: [src/**]\nverify: [npm test]\n", "utf8");
    await expect(loadTaskSpec(file)).resolves.toMatchObject({ objective: "Test YAML", allowedPaths: ["src/**"] });
    expect(() => parseTaskSpec({ objective: "bad timeout", verify: [{ command: "x", timeoutMs: 10 }] }))
      .toThrowError(TaskSpecError);
  });
});

