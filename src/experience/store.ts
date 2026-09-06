import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Json } from "../evaluation/schema.js";
import { assertArtifactId, type ExperienceCandidate } from "./candidate.js";
import { assertRegularDirectory, isMissing, readArtifactText } from "./artifact-io.js";
import { parseExperienceBundle, type ExperienceBundle } from "./schema.js";

export async function saveExperience(bundle: ExperienceBundle, dataDirectory: string): Promise<void> {
  const parsed = parseExperienceBundle(bundle);
  await mkdir(dataDirectory, { recursive: true });
  await assertRegularDirectory(dataDirectory);
  const root = join(dataDirectory, "experiences");
  await mkdir(root, { recursive: true });
  await assertRegularDirectory(root);
  const directory = join(root, parsed.id);
  // Exclusive directory/file creation makes an existing experience immutable.
  await mkdir(directory, { recursive: false });
  await writeFile(join(directory, "experience.json"), JSON.stringify({ bundle: parsed, sha256: sha256Json(parsed) }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}

export async function loadExperience(experienceId: string, dataDirectory: string): Promise<ExperienceBundle> {
  assertArtifactId(experienceId);
  await assertRegularDirectory(dataDirectory);
  await assertRegularDirectory(join(dataDirectory, "experiences"));
  const directory = join(dataDirectory, "experiences", experienceId);
  await assertRegularDirectory(directory);
  const source = await readArtifactText(join(directory, "experience.json"), 2 * 1024 * 1024);
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Cannot parse experience JSON"); }
  if (!value || typeof value !== "object" || !("bundle" in value) || !("sha256" in value) || value.sha256 !== sha256Json(value.bundle)) throw new Error("Experience bundle hash mismatch");
  const bundle = parseExperienceBundle(value.bundle);
  if (bundle.id !== experienceId) throw new Error("Experience ID does not match its directory");
  return bundle;
}

export async function listExperiences(dataDirectory: string): Promise<ExperienceBundle[]> {
  const root = join(dataDirectory, "experiences");
  try { await assertRegularDirectory(dataDirectory); await assertRegularDirectory(root); } catch (error) { if (isMissing(error)) return []; throw error; }
  const entries = await readdir(root, { withFileTypes: true });
  const bundles: ExperienceBundle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try { bundles.push(await loadExperience(entry.name, dataDirectory)); } catch { /* Invalid entries remain inspectable by ID. */ }
  }
  return bundles.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function loadCandidate(candidateId: string, dataDirectory: string): Promise<ExperienceCandidate> {
  assertArtifactId(candidateId);
  const matches = (await listExperiences(dataDirectory)).flatMap((bundle) => bundle.candidates.filter((candidate) => candidate.id === candidateId));
  if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous candidate ID" : `Candidate not found: ${candidateId}`);
  return matches[0]!;
}
