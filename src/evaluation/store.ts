import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getDataDirectory } from "../runtime/data-dir.js";
import {
  EvaluationArtifactError,
  parseRunManifest,
  parseRunResult,
  sha256Json,
  type RunComparison,
  type RunManifest,
  type RunResult
} from "./schema.js";

export interface RunBundle {
  directory: string;
  manifest: RunManifest;
  result?: RunResult;
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(runId)) {
    throw new EvaluationArtifactError("Run ID contains unsupported characters");
  }
}

export function runsDirectory(dataDirectory = getDataDirectory()): string {
  return join(dataDirectory, "runs");
}

export function runDirectory(runId: string, dataDirectory = getDataDirectory()): string {
  assertRunId(runId);
  return join(runsDirectory(dataDirectory), runId);
}

async function readJson(path: string, label: string): Promise<unknown> {
  let source: string;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new EvaluationArtifactError(`${label} must not be a symbolic link`);
    if (!metadata.isFile()) throw new EvaluationArtifactError(`${label} is not a regular file`);
    if (metadata.size > 2 * 1024 * 1024) throw new EvaluationArtifactError(`${label} exceeds the 2 MiB limit`);
    source = await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EvaluationArtifactError(`Cannot read ${label}: ${detail}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new EvaluationArtifactError(`Cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

export async function createRunDirectory(manifest: RunManifest, dataDirectory = getDataDirectory()): Promise<string> {
  await mkdir(runsDirectory(dataDirectory), { recursive: true });
  const directory = runDirectory(manifest.runId, dataDirectory);
  await mkdir(directory, { recursive: false });
  await writeJsonAtomic(join(directory, "manifest.json"), manifest);
  return directory;
}

export async function loadRunManifest(runId: string, dataDirectory = getDataDirectory()): Promise<RunManifest> {
  const directory = runDirectory(runId, dataDirectory);
  try {
    const directoryMetadata = await lstat(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new EvaluationArtifactError(`Run directory is not a regular directory: ${runId}`);
    }
  } catch (error) {
    if (error instanceof EvaluationArtifactError) throw error;
    throw new EvaluationArtifactError(`Cannot read run directory ${runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const path = join(directory, "manifest.json");
  const manifest = parseRunManifest(await readJson(path, `manifest for run ${runId}`));
  if (manifest.runId !== runId) throw new EvaluationArtifactError(`Manifest runId does not match directory ${runId}`);
  return manifest;
}

export async function loadRunBundle(runId: string, dataDirectory = getDataDirectory()): Promise<RunBundle> {
  const directory = runDirectory(runId, dataDirectory);
  const manifest = await loadRunManifest(runId, dataDirectory);
  let result: RunResult | undefined;
  let hasResult = false;
  try {
    await lstat(join(directory, "result.json"));
    hasResult = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (hasResult) {
    result = parseRunResult(await readJson(join(directory, "result.json"), `result for run ${runId}`));
  }
  if (result) {
    if (result.runId !== runId) throw new EvaluationArtifactError(`Result runId does not match directory ${runId}`);
    if (result.manifestSha256 !== sha256Json(manifest)) {
      throw new EvaluationArtifactError(`Result manifest hash does not match run ${runId}`);
    }
    if (result.workspace.baselineCommit !== manifest.baselineCommit) {
      throw new EvaluationArtifactError(`Result baseline commit does not match run ${runId}`);
    }
    if (result.workspace.managedWorktree !== manifest.replayable) {
      throw new EvaluationArtifactError(`Result worktree mode does not match run ${runId}`);
    }
    if (result.verification && result.verification.commands.length !== manifest.verifier.commands.length) {
      throw new EvaluationArtifactError(`Result verifier evidence count does not match run ${runId}`);
    }
  }
  return { directory, manifest, ...(result ? { result } : {}) };
}

export async function listRunBundles(dataDirectory = getDataDirectory()): Promise<RunBundle[]> {
  let entries;
  try {
    entries = await readdir(runsDirectory(dataDirectory), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const bundles: RunBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      bundles.push(await loadRunBundle(entry.name, dataDirectory));
    } catch {
      // Corrupt runs remain inspectable by ID but do not break the complete listing.
    }
  }
  return bundles.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt));
}

export async function writeRunResult(result: RunResult, directory: string): Promise<string> {
  const path = join(directory, "result.json");
  await writeJsonAtomic(path, result);
  return path;
}

export async function writeComparisonArtifacts(
  comparison: RunComparison,
  markdown: string,
  directory: string
): Promise<{ jsonPath: string; markdownPath: string }> {
  const jsonPath = join(directory, "comparison.json");
  const markdownPath = join(directory, "comparison.md");
  await Promise.all([
    writeJsonAtomic(jsonPath, comparison),
    writeFile(markdownPath, markdown, "utf8")
  ]);
  return { jsonPath, markdownPath };
}
