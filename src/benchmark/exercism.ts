import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTaskSpec } from "../task/task-spec.js";
import { verifierSource } from "./exercism-verifier.js";

export const EXERCISM_REVISION = "a01edc6f5b1de1b442c7a2295f841eee2e692ae4";
export const HARD_EXERCISES = [
  { slug: "forth", difficulty: 8, split: "learning" },
  { slug: "circular-buffer", difficulty: 8, split: "learning" },
  { slug: "word-search", difficulty: 8, split: "learning" },
  { slug: "change", difficulty: 8, split: "learning" },
  { slug: "simple-linked-list", difficulty: 8, split: "holdout" },
  { slug: "bowling", difficulty: 8, split: "holdout" },
  { slug: "react", difficulty: 8, split: "holdout" },
  { slug: "zipper", difficulty: 8, split: "holdout" },
  { slug: "crypto-square", difficulty: 9, split: "holdout" }
] as const;

export interface Exercise {
  slug: string;
  difficulty: number;
  split: "learning" | "holdout";
  instructions: string;
  solution: string;
  tests: string;
  reference: string;
  metadata: string;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function normalizeReference(source: string, slug?: string): string {
  const esm = source.replace(/^module\.exports = ([A-Za-z_$][\w$]*);$/gmu, "export default $1;");
  if (slug !== "crypto-square") return esm;
  // The pinned upstream proof regroups transposed text using columns instead of rows.
  // Repair QA only; the official exercise and all assertions remain unchanged.
  const getter = /get ciphertext\(\) \{[\s\S]*?\n {2}\}\n\n {2}get size/u;
  if (!getter.test(esm)) throw new Error("Unknown crypto-square reference layout");
  return esm.replace(getter, `get ciphertext() {
    if (this.size === 0) return '';
    const rows = Math.ceil(this.plaintext.length / this.size);
    return this.ciphertextSegments().map(item => item.padEnd(rows, ' ')).join(' ');
  }

  get size`);
}

/** Only adapt the pinned track's known syntax; unknown suite shapes fail closed. */
export function adaptTests(source: string): { text: string; count: number } {
  const enabled = source.replace(/\btest\.skip\s*\(/gu, "test(");
  if (/\b(?:test|it|describe)\s*\.|\b(?:xit|xdescribe|fit|fdescribe)\s*\(|\bit\s*\(/u.test(enabled)) {
    throw new Error("Unsupported skip/focus/parameterized test syntax");
  }
  const count = [...enabled.matchAll(/\b(?:test|xtest)\s*\(/gu)].length;
  if (!count || !source.includes("from '@jest/globals'")) throw new Error("No supported Jest cases found");
  const text = enabled
    .replace(/import\s*\{([^}]+)\}\s*from '@jest\/globals';/u, (_match, names: string) =>
      `import {${names.replace(/\bxtest\b/gu, "test as xtest")}} from '@jest/globals';`)
    .replace(/from '([.][/][a-z-]+)';/gu, "from '$1.js';");
  return { text, count };
}

export async function writeBenchmark(destination: string, exercises: Exercise[], license: string): Promise<void> {
  if (!exercises.length || new Set(exercises.map((item) => item.slug)).size !== exercises.length) throw new Error("Empty or duplicate exercises");
  for (const exercise of exercises) {
    if (!/^[a-z]+(?:-[a-z]+)*$/u.test(exercise.slug) || !Number.isInteger(exercise.difficulty) || exercise.difficulty < 8 || exercise.difficulty > 10) {
      throw new Error("Only safe hard exercise names are accepted");
    }
    adaptTests(exercise.tests);
  }
  // Exclusive creation protects existing repositories and incomplete earlier attempts.
  await mkdir(destination);
  const immutable: Record<string, string> = {};
  const put = async (path: string, text: string, frozen = true): Promise<void> => {
    await writeFile(join(destination, path), text, "utf8");
    if (frozen) immutable[path] = hashText(text);
  };
  await mkdir(join(destination, "tasks"));
  await mkdir(join(destination, "exercises"));
  await put("package.json", JSON.stringify({ name: "exercism-js-hard-benchmark", version: "1.0.0", private: true, type: "module", engines: { node: ">=22.19.0" }, devDependencies: { jest: "29.7.0" } }, null, 2) + "\n");
  await put("jest.config.cjs", "module.exports = { testEnvironment: 'node', transform: {}, testMatch: ['**/exercises/**/*.spec.js'], cache: false };\n");
  await put(".gitignore", "node_modules/\n");
  // Preserve hashed upstream bytes across Windows checkouts and managed worktrees.
  await put(".gitattributes", "* -text\n");
  await put("LICENSE", license);
  await put("verify.cjs", verifierSource);
  const entries = [];
  for (const exercise of exercises) {
    const { slug } = exercise;
    const directory = `exercises/${slug}`;
    await mkdir(join(destination, directory));
    const adapted = adaptTests(exercise.tests);
    await put(`${directory}/${slug}.js`, exercise.solution, false);
    await put(`${directory}/${slug}.spec.js`, adapted.text);
    await put(`${directory}/README.md`, exercise.instructions);
    const task = parseTaskSpec({
      id: `exercism-js-hard-${slug}`,
      objective: `完成 Exercism JavaScript 的 ${slug} 题。阅读 ${directory}/README.md 和测试，实现 ${directory}/${slug}.js。遵守题意与 API，只修改该实现文件，并运行 node verify.cjs ${slug} 验证。`,
      allowedPaths: [`${directory}/${slug}.js`],
      verify: [{ command: `node verify.cjs ${slug}`, timeoutMs: 120_000 }],
      doneWhen: ["全部测试执行并通过，无跳过测试", "仅修改本题实现文件，题意、测试及验证器保持原样"]
    });
    await put(`tasks/${slug}.json`, JSON.stringify(task, null, 2) + "\n");
    entries.push({ slug, difficulty: exercise.difficulty, split: exercise.split, tests: adapted.count,
      source: `https://github.com/exercism/javascript/tree/${EXERCISM_REVISION}/${directory.replace("exercises/", "exercises/practice/")}`,
      originalHashes: { solution: hashText(exercise.solution), tests: hashText(exercise.tests), instructions: hashText(exercise.instructions), metadata: hashText(exercise.metadata) },
      // Author attribution remains available without copying .meta reference files.
      metadata: JSON.parse(exercise.metadata) as unknown });
  }
  await put("README.md", `# Exercism JavaScript 困难题库\n\n上游版本：${EXERCISM_REVISION}。全部题目均为官方困难档（8–10）。\n\n首次使用运行 npm ci --ignore-scripts。每题通过 node verify.cjs 题目名 执行全部测试。只修改该题实现文件。\n\n| 题目 | 难度 | 分组 | 测试数 |\n| --- | --- | --- | --- |\n${entries.map((item) => `| ${item.slug} | ${item.difficulty} | ${item.split === "learning" ? "经验提炼" : "留出评估"} | ${item.tests} |`).join("\n")}\n\n先在经验提炼题采集真实失败并冻结候选，再评估留出题。不得使用留出题结果调整当前候选后仍声称它是留出评估。题库测试公开可读；这不是隐藏测试评测，也不是模型未见题目的证明。\n\n测试使用官方 Jest 断言，启用 xtest 并补全 ESM 导入扩展名。参考实现不包含在本仓库或其历史中。来源、作者与测试校验信息见 benchmark.json。\n`);
  await put("benchmark.json", JSON.stringify({ schemaVersion: 1, upstream: "exercism/javascript", revision: EXERCISM_REVISION, exercises: entries, immutable }, null, 2) + "\n", false);
}
