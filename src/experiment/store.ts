import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertArtifactId } from "../experience/candidate.js";
import { sha256Json } from "../evaluation/schema.js";
import { loadRunBundle, writeJsonAtomic } from "../evaluation/store.js";
import { parseExperiment, summarizeExperiment, type ExperimentBundle } from "./schema.js";

async function assertDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Experiment directory must not be a link");
}
function directory(id: string, dataDirectory: string): string {
  return join(dataDirectory, "experiments", assertArtifactId(id));
}
async function readEnvelope(path: string): Promise<ExperimentBundle> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || stat.size > 2 * 1024 * 1024) throw new Error("Experiment artifact is not a bounded regular file without links");
  const envelope: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!envelope || typeof envelope !== "object" || !("bundle" in envelope) || !("sha256" in envelope)) throw new Error("Invalid experiment envelope");
  if (envelope.sha256 !== sha256Json(envelope.bundle)) throw new Error("Experiment content hash does not match");
  return parseExperiment(envelope.bundle);
}

export async function saveExperiment(bundle: ExperimentBundle, dataDirectory: string, initial = false): Promise<void> {
  const parsed = parseExperiment(bundle);
  await assertDirectory(dataDirectory);
  const root = join(dataDirectory, "experiments");
  await mkdir(root, { recursive: true });
  await assertDirectory(root);
  const path = directory(parsed.id, dataDirectory);
  if (initial) await mkdir(path);
  await assertDirectory(path);
  const envelope = { sha256: sha256Json(parsed), bundle: parsed };
  if (parsed.completedAt) {
    await writeFile(join(path, "experiment.json"), `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } else {
    await writeJsonAtomic(join(path, "progress.json"), envelope);
  }
}

export async function loadExperiment(id: string, dataDirectory: string): Promise<ExperimentBundle> {
  await assertDirectory(dataDirectory);
  await assertDirectory(join(dataDirectory, "experiments"));
  const path = directory(id, dataDirectory);
  await assertDirectory(path);
  let experiment: ExperimentBundle;
  try { experiment = await readEnvelope(join(path, "experiment.json")); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    experiment = await readEnvelope(join(path, "progress.json"));
  }
  if (experiment.id !== id) throw new Error("Experiment ID does not match directory");
  await assertDirectory(join(dataDirectory, "runs"));
  const source = await loadRunBundle(experiment.sourceRunId, dataDirectory);
  const runs = await Promise.all(experiment.trials.map((trial) => loadRunBundle(trial.runId, dataDirectory)));
  const verified = summarizeExperiment(experiment, source.manifest, runs);
  if (sha256Json(verified) !== sha256Json(experiment)) throw new Error("Experiment summary does not match run evidence");
  return verified;
}

export async function listExperiments(dataDirectory: string): Promise<ExperimentBundle[]> {
  const root = join(dataDirectory, "experiments");
  let entries;
  try { await assertDirectory(dataDirectory); await assertDirectory(root); entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const bundles: ExperimentBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try { bundles.push(await loadExperiment(entry.name, dataDirectory)); }
    catch { /* An invalid artifact remains inspectable explicitly by ID. */ }
  }
  return bundles.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
