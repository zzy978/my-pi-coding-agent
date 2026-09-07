import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { runProcess, runShellCommand } from "../runtime/process.js";
import { EXERCISM_REVISION, HARD_EXERCISES, hashText, normalizeReference, writeBenchmark, type Exercise } from "./exercism.js";

export async function initializeBenchmarkRepository(destination: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await lstat(join(destination, ".git"));
    throw new Error("Refusing to initialize an existing repository");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  // Git for Windows recognizes /dev/null; Node's \\.\nul spelling is not accepted by Git.
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  const git = async (args: string[]): Promise<string> => {
    const result = await runProcess("git", ["-c", "core.hooksPath=", "-c", "core.excludesFile=", ...args], { cwd: destination, env, timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(`Git baseline failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  // Empty template prevents inherited repository hooks/config; explicit files ignore global excludes.
  const template = await mkdtemp(join(tmpdir(), "exercism-git-template-"));
  try { await git(["init", `--template=${template}`]); }
  finally { await rm(template, { recursive: true, force: true }); }
  const actual = await git(["rev-parse", "--show-toplevel"]);
  if (resolve(actual) !== resolve(destination)) throw new Error("Git root differs from benchmark destination");
  const files: string[] = [];
  const collect = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && ["node_modules", ".git"].includes(entry.name)) continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) await collect(join(directory, entry.name), name + "/");
      else if (entry.isFile()) files.push(name);
      else throw new Error(`Non-regular benchmark artifact: ${name}`);
    }
  };
  await collect(destination);
  await mkdir(join(destination, ".git", "disabled-hooks"));
  await git(["config", "core.hooksPath", join(destination, ".git", "disabled-hooks")]);
  await git(["add", "--force", "--", ...files]);
  await git(["-c", "user.name=Benchmark Preparation", "-c", "user.email=benchmark@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "test: prepare Exercism JavaScript hard benchmark"]);
  const tracked = (await git(["ls-files", "-z"])).split("\0").filter(Boolean).sort();
  if (JSON.stringify(tracked) !== JSON.stringify(files.sort()) || await git(["status", "--porcelain"])) throw new Error("Benchmark baseline file list or clean status mismatch");
}

async function download(path: string): Promise<string> {
  const response = await fetch(`https://raw.githubusercontent.com/exercism/javascript/${EXERCISM_REVISION}/${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Download failed: ${path} (${response.status})`);
  return response.text();
}

export async function downloadExercises(): Promise<{ exercises: Exercise[]; license: string }> {
  const license = await download("LICENSE");
  const config = JSON.parse(await download("config.json")) as { exercises: { practice: { slug: string; difficulty: number }[] } };
  const exercises: Exercise[] = [];
  for (const item of HARD_EXERCISES) {
    if (config.exercises.practice.find((entry) => entry.slug === item.slug)?.difficulty !== item.difficulty) throw new Error(`Upstream difficulty mismatch: ${item.slug}`);
    const base = `exercises/practice/${item.slug}`;
    const [instructions, solution, tests, reference, metadata] = await Promise.all([
      download(`${base}/.docs/instructions.md`), download(`${base}/${item.slug}.js`), download(`${base}/${item.slug}.spec.js`),
      download(`${base}/.meta/proof.ci.js`), download(`${base}/.meta/config.json`)
    ]);
    exercises.push({ ...item, instructions, solution, tests, reference, metadata });
  }
  return { exercises, license };
}

interface CaseSummary { slug: string; total: number; passed: number; failed: number; pending: number; complete: boolean }

export async function verifyExercise(directory: string, slug: string): Promise<{ exitCode: number | null; summary: CaseSummary; output: string }> {
  const result = await runProcess(process.execPath, ["verify.cjs", slug], { cwd: directory, timeoutMs: 120_000, maxOutputBytes: 512 * 1024 });
  const line = result.stdout.split(/\r?\n/u).find((item) => item.startsWith("BENCHMARK_RESULT "));
  if (result.timedOut || !line) throw new Error(`Verifier did not produce a completed result for ${slug}:\n${result.stderr}\n${result.stdout}`);
  return { exitCode: result.exitCode, summary: JSON.parse(line.slice("BENCHMARK_RESULT ".length)) as CaseSummary, output: result.stdout + result.stderr };
}

/** Reference code exists only in a disposable QA directory, never in the benchmark Git repository. */
export async function validateBenchmark(destination: string, exercises: Exercise[], onStatus: (text: string) => void): Promise<unknown[]> {
  const temporary = await mkdtemp(join(tmpdir(), "exercism-reference-qa-"));
  const results: unknown[] = [];
  try {
    await cp(destination, temporary, { recursive: true, filter: (source) => !["node_modules", ".git"].includes(basename(source)) });
    await symlink(join(destination, "node_modules"), join(temporary, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    for (const exercise of exercises) {
      const stub = await verifyExercise(destination, exercise.slug);
      if (stub.exitCode === 0 || !stub.summary.complete || stub.summary.failed < 1) throw new Error(`Skeleton did not produce genuine test failures: ${exercise.slug}\n${stub.output}`);
      await writeFile(join(temporary, "exercises", exercise.slug, `${exercise.slug}.js`), normalizeReference(exercise.reference), "utf8");
      const upstreamReference = await verifyExercise(temporary, exercise.slug);
      let reference = upstreamReference;
      if (exercise.slug === "crypto-square") {
        if (!upstreamReference.summary.complete) throw new Error(`Upstream reference could not execute: ${exercise.slug}`);
        await writeFile(join(temporary, "exercises", exercise.slug, `${exercise.slug}.js`), normalizeReference(exercise.reference, exercise.slug), "utf8");
        reference = await verifyExercise(temporary, exercise.slug);
        onStatus(`crypto-square: 官方参考 ${upstreamReference.summary.passed}/${upstreamReference.summary.total}；仅在临时 QA 中修正输出分组，不改测试`);
      }
      if (reference.exitCode !== 0 || !reference.summary.complete) throw new Error(`Reference failed: ${exercise.slug}\n${reference.output}`);
      results.push({ slug: exercise.slug, skeleton: stub.summary, upstreamReference: upstreamReference.summary, reference: reference.summary,
        referenceAdjustment: exercise.slug === "crypto-square" ? "QA-only correction: pad each transposed column to row count; upstream assertions unchanged" : exercise.slug === "word-search" ? "QA-only CommonJS default export converted to ESM" : null });
      onStatus(`${exercise.slug}: 骨架 ${stub.summary.failed} 项失败；参考实现 ${reference.summary.passed}/${reference.summary.total} 通过；无跳过`);
    }
    return results;
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function prepareExercism(destinationPath: string, onStatus: (text: string) => void = console.log): Promise<void> {
  const destination = resolve(destinationPath);
  onStatus(`下载固定版本 ${EXERCISM_REVISION} 的 9 道困难题…`);
  const { exercises, license } = await downloadExercises();
  await writeBenchmark(destination, exercises, license);
  onStatus("安装独立题库的 Jest 并锁定依赖…");
  const install = await runShellCommand("npm install --ignore-scripts --no-audit --no-fund", { cwd: destination, timeoutMs: 600_000 });
  if (install.exitCode !== 0 || install.timedOut) throw new Error(`Dependency installation failed:\n${install.stderr}\n${install.stdout}`);
  const manifestPath = join(destination, "benchmark.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { immutable: Record<string, string> };
  manifest.immutable["package-lock.json"] = hashText(await readFile(join(destination, "package-lock.json"), "utf8"));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const results = await validateBenchmark(destination, exercises, onStatus);
  await writeFile(join(destination, "validation.json"), JSON.stringify({ revision: EXERCISM_REVISION, node: process.version, validatedAt: new Date().toISOString(), modelCalls: 0, results }, null, 2) + "\n", "utf8");
  // Only a fully validated, answer-free baseline is committed. Existing paths are never reused.
  await initializeBenchmarkRepository(destination);
  onStatus(`接入完成：${destination}。参考实现已清理；没有调用模型。`);
}
