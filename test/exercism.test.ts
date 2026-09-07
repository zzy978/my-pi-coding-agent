import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptTests, normalizeReference, writeBenchmark, type Exercise } from "../src/benchmark/exercism.js";
import { loadTaskSpec } from "../src/task/task-spec.js";
import { runProcess } from "../src/runtime/process.js";
import { initializeBenchmarkRepository } from "../src/benchmark/exercism-prepare.js";
import { initializeGitRepository } from "./helpers/git-repository.js";

const spec = "import { describe, expect, test, xtest } from '@jest/globals';\nimport { value } from './forth';\ndescribe('value', () => { test('first', () => expect(value()).toBe(1)); xtest('second', () => expect(value()).toBe(2)); });\n";
const exercise: Exercise = { slug: "forth", difficulty: 8, split: "learning", instructions: "实现 Forth。", solution: "export const value = () => 0;", tests: spec, reference: "SECRET_REFERENCE", metadata: "{}" };

describe("Exercism benchmark", () => {
  it("loads legacy CommonJS reference exports as ESM without changing behavior", async () => {
    const source = normalizeReference("const Answer = () => 42;\nmodule.exports = Answer;\n");
    const loaded = await import(`data:text/javascript,${encodeURIComponent(source)}`) as { default: () => number };
    expect(loaded.default()).toBe(42);
  });
  it("repairs only the QA crypto-square reference grouping while keeping unequal row/column lengths", async () => {
    const source = `export class Crypto {
  get plaintext() { return 'abcdef'; }
  ciphertextSegments() { return ['ad', 'be', 'cf']; }
  get ciphertext() {
    return 'adb ecf';
  }

  get size() { return 3; }
}`;
    const loaded = await import(`data:text/javascript,${encodeURIComponent(normalizeReference(source, "crypto-square"))}`) as { Crypto: new () => { ciphertext: string } };
    expect(new loaded.Crypto().ciphertext).toBe("ad be cf");
  });
  it("isolates Git initialization from caller Git routing variables and refuses existing repositories", async () => {
    const parent = await mkdtemp(join(tmpdir(), "exercism-git-test-"));
    const unrelated = join(parent, "unrelated");
    const destination = join(parent, "benchmark");
    try {
      await initializeGitRepository(unrelated);
      const before = await runProcess("git", ["rev-parse", "HEAD"], { cwd: unrelated });
      await writeBenchmark(destination, [exercise], "MIT");
      await initializeBenchmarkRepository(destination, { ...process.env, GIT_DIR: join(unrelated, ".git"), GIT_WORK_TREE: unrelated, GIT_INDEX_FILE: join(unrelated, ".git/index") });
      expect((await runProcess("git", ["rev-parse", "HEAD"], { cwd: unrelated })).stdout).toBe(before.stdout);
      expect((await runProcess("git", ["ls-files", "tasks/forth.json"], { cwd: destination })).stdout.trim()).toBe("tasks/forth.json");
      await expect(initializeBenchmarkRepository(unrelated)).rejects.toThrow();
    } finally { await rm(parent, { recursive: true, force: true }); }
  }, 30_000);
  it("activates skipped tests and counts every case without rewriting assertions", () => {
    const result = adaptTests(spec);
    expect(result.count).toBe(2);
    expect(result.text).toContain("test as xtest");
    expect(result.text).toContain("expect(value()).toBe(2)");
    expect(result.text).toContain("'./forth.js'");
  });

  it("activates explicit test.skip cases such as the long crypto-square example", () => {
    const result = adaptTests(spec.replace("xtest('second'", "test.skip('second'"));
    expect(result.count).toBe(2);
    expect(result.text).not.toContain("test.skip(");
  });

  it.each(["test.only('x', () => {});", "describe.skip('x', () => {});", "test.todo('x');", "it('x', () => {});", ""])("rejects unsupported or partial suites: %s", (source) => {
    expect(() => adaptTests(source)).toThrow();
  });

  it("writes restricted tasks, retains provenance and excludes reference answers", async () => {
    const parent = await mkdtemp(join(tmpdir(), "exercism-test-"));
    const destination = join(parent, "benchmark");
    try {
      await writeBenchmark(destination, [exercise], "MIT fixture");
      const task = await loadTaskSpec(join(destination, "tasks", "forth.json"));
      expect(task.allowedPaths).toEqual(["exercises/forth/forth.js"]);
      expect(task.verify[0]?.command).toBe("node verify.cjs forth");
      expect(await readFile(join(destination, "exercises/forth/forth.js"), "utf8")).toBe(exercise.solution);
      expect((await readdir(join(destination, "exercises/forth"))).sort()).toEqual(["README.md", "forth.js", "forth.spec.js"]);
      expect(await readFile(join(destination, "benchmark.json"), "utf8")).not.toContain("SECRET_REFERENCE");
      await writeFile(join(destination, "keep.txt"), "user content");
      await expect(writeBenchmark(destination, [exercise], "MIT")).rejects.toThrow();
      expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("user content");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("refuses easy tasks and unsafe slugs before creating output", async () => {
    const parent = await mkdtemp(join(tmpdir(), "exercism-test-"));
    try {
      await expect(writeBenchmark(join(parent, "easy"), [{ ...exercise, difficulty: 3 }], "MIT")).rejects.toThrow();
      await expect(writeBenchmark(join(parent, "unsafe"), [{ ...exercise, slug: "../escape" }], "MIT")).rejects.toThrow();
      expect(await readdir(parent)).toEqual([]);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it("executes its verifier and rejects partial reports, false success and changed tests", async () => {
    const parent = await mkdtemp(join(tmpdir(), "exercism-verifier-test-"));
    const destination = join(parent, "benchmark with spaces");
    try {
      await writeBenchmark(destination, [exercise], "MIT fixture");
      const runnerDirectory = join(destination, "node_modules/jest/bin");
      await mkdir(runnerDirectory, { recursive: true });
      // Replace only the external Jest process. Exercise the actual generated verifier.
      const runner = join(runnerDirectory, "jest.js");
      const valid = { numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numRuntimeErrorTestSuites: 0, success: true };
      const run = () => runProcess(process.execPath, ["verify.cjs", "forth"], { cwd: destination });
      for (const [patch, expected] of [
        [{}, 0], [{ numPendingTests: 1 }, 1], [{ numTodoTests: 1 }, 1],
        [{ numTotalTests: 0, numPassedTests: 0 }, 1], [{ numPassedTests: 1, numFailedTests: 1 }, 1],
        [{ numRuntimeErrorTestSuites: 1 }, 1], [{ success: false }, 1]
      ] as const) {
        await writeFile(runner, `require('node:fs').writeFileSync(process.argv.at(-1), ${JSON.stringify(JSON.stringify({ ...valid, ...patch }))});`);
        expect((await run()).exitCode).toBe(expected);
      }
      await writeFile(join(destination, "exercises/forth/forth.spec.js"), "// weakened tests");
      const tampered = await run();
      expect(tampered.exitCode).toBe(1);
      expect(tampered.stderr).toContain("Immutable benchmark file changed");
      expect((await runProcess(process.execPath, ["verify.cjs", "../outside"], { cwd: destination })).exitCode).toBe(1);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
});
