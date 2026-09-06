import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { sha256Json, sha256Text } from "../evaluation/schema.js";
import { loadRunBundle } from "../evaluation/store.js";
import { loadExperiment } from "../experiment/store.js";
import { getDataDirectories } from "../runtime/data-dir.js";
import { resolveGitRoot } from "../workspace/git.js";
import { assertArtifactId, parseCandidateSnapshot, type ExperienceCandidate } from "./candidate.js";
import { loadCandidate } from "./store.js";

export interface PromotionEvent {
  schemaVersion: 1;
  id: string;
  sequence: number;
  previousEventId: string | null;
  action: "promote" | "revoke";
  createdAt: string;
  sourceRepository: string;
  candidateId: string;
  contentSha256: string;
  snapshotSha256: string;
  evidence: Array<{ id: string; sha256: string }>;
  confirmation: "explicit-human-approval";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function canonicalRepository(path: string): Promise<string> {
  const canonical = await realpath(await resolveGitRoot(path));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function regularDirectory(path: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(path, { recursive: true });
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("晋升目录必须是普通目录，不能使用符号链接");
    return true;
  } catch (error) {
    if (!create && isMissing(error)) return false;
    throw error;
  }
}

async function journalDirectory(repository: string, dataDirectory: string, create: boolean): Promise<string | undefined> {
  if (!await regularDirectory(dataDirectory, create)) return undefined;
  const root = getDataDirectories(dataDirectory).promotions;
  if (!await regularDirectory(root, create)) return undefined;
  const directory = join(root, sha256Text(repository));
  if (!await regularDirectory(directory, create)) return undefined;
  if (!await regularDirectory(join(directory, "events"), create)) return undefined;
  return directory;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("晋升记录格式无效");
  return value as Record<string, unknown>;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("晋升记录哈希无效");
  return value;
}

function parseEvent(value: unknown, repository: string): PromotionEvent {
  const item = record(value);
  if (item.schemaVersion !== 1 || item.sourceRepository !== repository || item.confirmation !== "explicit-human-approval" ||
    (item.action !== "promote" && item.action !== "revoke") ||
    typeof item.sequence !== "number" || !Number.isSafeInteger(item.sequence) || item.sequence < 1 ||
    typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) || !Array.isArray(item.evidence) || item.evidence.length > 20) {
    throw new Error("晋升记录版本、仓库或字段无效");
  }
  const evidence = item.evidence.map((value: unknown) => {
    const entry = record(value);
    return { id: assertArtifactId(entry.id), sha256: hash(entry.sha256) };
  });
  if (new Set(evidence.map((entry) => entry.id)).size !== evidence.length) throw new Error("晋升证据 ID 重复");
  if (item.action === "promote" && evidence.length < 2) throw new Error("晋升缺少跨任务证据");
  return {
    schemaVersion: 1, id: assertArtifactId(item.id), sequence: item.sequence,
    previousEventId: item.previousEventId === null ? null : assertArtifactId(item.previousEventId),
    action: item.action, createdAt: item.createdAt, sourceRepository: repository,
    candidateId: assertArtifactId(item.candidateId), contentSha256: hash(item.contentSha256),
    snapshotSha256: hash(item.snapshotSha256), evidence, confirmation: "explicit-human-approval"
  };
}

async function readEvents(directory: string, repository: string): Promise<PromotionEvent[]> {
  const entries = (await readdir(join(directory, "events"))).filter((entry) => entry.endsWith(".json")).sort();
  if (entries.length > 10_000) throw new Error("晋升历史超过读取上限");
  const events: PromotionEvent[] = [];
  for (const filename of entries) {
    const path = join(directory, "events", filename);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > 65_536) {
      throw new Error("晋升记录不是安全的普通文件或超过大小上限");
    }
    const envelope = record(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (hash(envelope.sha256) !== sha256Json(envelope.event)) throw new Error("晋升记录哈希不匹配");
    const event = parseEvent(envelope.event, repository);
    if (event.sequence !== events.length + 1 || event.previousEventId !== (events.at(-1)?.id ?? null) ||
      filename !== `${String(event.sequence).padStart(8, "0")}-${event.id}.json`) {
      throw new Error("晋升历史链不完整或顺序错误");
    }
    events.push(event);
  }
  const head = await readHead(directory);
  if (!head) {
    if (events.length) throw new Error("晋升历史缺少 head，无法确认完整性");
  } else if (head.sourceRepository !== repository || head.sequence !== events.length || head.eventId !== events.at(-1)?.id ||
    head.historySha256 !== sha256Json(events)) throw new Error("晋升历史 head 或哈希不匹配，拒绝恢复旧状态");
  return events;
}

async function readHead(directory: string): Promise<Record<string, unknown> | undefined> {
  const path = join(directory, "head.json");
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > 65_536) throw new Error("晋升历史 head 文件无效");
  const head = record(JSON.parse(await readFile(path, "utf8")) as unknown);
  if (head.schemaVersion !== 1 || typeof head.sourceRepository !== "string" || !isAbsolute(head.sourceRepository)) throw new Error("晋升历史 head 格式无效");
  return head;
}

async function updateHead(directory: string, repository: string, events: PromotionEvent[]): Promise<void> {
  const path = join(directory, "head.json");
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, sourceRepository: repository, sequence: events.length,
      eventId: events.at(-1)?.id, historySha256: sha256Json(events) }), { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  }
}

export async function listPromotions(sourceRepository: string, dataDirectory: string): Promise<PromotionEvent[]> {
  const repository = await canonicalRepository(sourceRepository);
  const directory = await journalDirectory(repository, dataDirectory, false);
  return directory ? readEvents(directory, repository) : [];
}

async function checkEvidence(candidate: ExperienceCandidate, evidenceIds: string[], repository: string, dataDirectory: string) {
  if (evidenceIds.length < 2 || evidenceIds.length > 20 || new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error("晋升需要 2–20 项无重复的实验，覆盖至少两个不同任务");
  }
  const source = await loadRunBundle(candidate.sourceRunId, dataDirectory);
  const taskIdentity = (objective: string) => sha256Text(objective.trim().replace(/\s+/g, " ").toLowerCase());
  const sourceTask = taskIdentity(source.manifest.task.content.objective);
  const tasks = new Set<string>();
  let improved = false;
  const evidence: PromotionEvent["evidence"] = [];
  for (const id of evidenceIds) {
    assertArtifactId(id);
    // The experiment loader verifies source/trial hashes and recomputes the verdict.
    const experiment = await loadExperiment(id, dataDirectory);
    if (sha256Json(parseCandidateSnapshot(experiment.candidate)) !== sha256Json(parseCandidateSnapshot(candidate))) {
      throw new Error("实验证据不属于当前冻结候选");
    }
    if (experiment.pairsRequested < 3 || experiment.pairsCompleted !== experiment.pairsRequested || !experiment.completedAt) {
      throw new Error("每项晋升实验必须至少包含 3 对完整运行");
    }
    if (experiment.scopeViolations > 0) throw new Error("含越界变更的实验不能用于晋升");
    if (experiment.errors.length || experiment.isolationDifferences.length ||
      !["observed_improvement", "no_observed_gain"].includes(experiment.outcome)) {
      throw new Error("实验证据存在退化、隔离失败或不确定结果，不能晋升");
    }
    const run = await loadRunBundle(experiment.sourceRunId, dataDirectory);
    if (await canonicalRepository(experiment.sourceRepository) !== repository ||
      await canonicalRepository(run.manifest.sourceRepository) !== repository) throw new Error("晋升证据必须来自同一仓库");
    tasks.add(taskIdentity(run.manifest.task.content.objective));
    improved ||= experiment.outcome === "observed_improvement";
    evidence.push({ id, sha256: sha256Json(experiment) });
  }
  if (tasks.size < 2 || ![...tasks].some((task) => task !== sourceTask)) {
    throw new Error("晋升需要至少两个不同任务，且包含不是经验来源任务的留出任务");
  }
  if (!improved) throw new Error("晋升证据中至少一项实验需要观察到改善");
  return evidence;
}

async function appendEvent(
  repository: string, dataDirectory: string,
  create: (history: PromotionEvent[]) => Promise<Omit<PromotionEvent, "id" | "sequence" | "previousEventId" | "createdAt">>
): Promise<PromotionEvent> {
  const directory = await journalDirectory(repository, dataDirectory, true);
  if (!directory) throw new Error("无法创建晋升目录");
  const lockPath = join(directory, ".lock");
  const lock = await open(lockPath, "wx").catch(() => { throw new Error("晋升记录被其他进程锁定；若进程已退出，请检查残留 .lock 文件"); });
  try {
    const history = await readEvents(directory, repository);
    const fields = await create(history);
    const event: PromotionEvent = { ...fields, id: randomUUID(), sequence: history.length + 1,
      previousEventId: history.at(-1)?.id ?? null, createdAt: new Date().toISOString() };
    const filename = `${String(event.sequence).padStart(8, "0")}-${event.id}.json`;
    const temporary = join(directory, "events", `${filename}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ event, sha256: sha256Json(event) }, null, 2), { encoding: "utf8", flag: "wx" });
      await rename(temporary, join(directory, "events", filename));
      // Publish the complete journal head last; any interrupted append fails closed.
      await updateHead(directory, repository, [...history, event]);
    } finally {
      await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
    }
    return event;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function promoteCandidate(options: {
  candidateId: string; evidenceIds: string[]; approved: boolean; dataDirectory: string;
}): Promise<PromotionEvent> {
  if (!options.approved) throw new Error("晋升需要明确人工确认（--approve）");
  const candidate = await loadCandidate(assertArtifactId(options.candidateId), options.dataDirectory);
  const snapshot = parseCandidateSnapshot(candidate);
  const source = await loadRunBundle(candidate.sourceRunId, options.dataDirectory);
  const repository = await canonicalRepository(source.manifest.sourceRepository);
  return appendEvent(repository, options.dataDirectory, async () => ({
    schemaVersion: 1, action: "promote", sourceRepository: repository, candidateId: candidate.id,
    contentSha256: snapshot.contentSha256, snapshotSha256: sha256Json(snapshot),
    evidence: await checkEvidence(candidate, options.evidenceIds, repository, options.dataDirectory),
    confirmation: "explicit-human-approval"
  }));
}

export async function revokeCandidate(options: {
  candidateId: string; approved: boolean; dataDirectory: string;
}): Promise<PromotionEvent> {
  if (!options.approved) throw new Error("撤销需要明确人工确认（--approve）");
  const candidateId = assertArtifactId(options.candidateId);
  // Revocation must work even after the candidate, source run, or repository is removed.
  const root = getDataDirectories(options.dataDirectory).promotions;
  if (!await regularDirectory(options.dataDirectory, false) || !await regularDirectory(root, false)) throw new Error("候选未处于晋升状态");
  const matches: PromotionEvent[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const directory = join(root, entry.name);
    await regularDirectory(directory, false);
    await regularDirectory(join(directory, "events"), false);
    const head = await readHead(directory);
    if (!head && !(await readdir(join(directory, "events"))).some((name) => name.endsWith(".json"))) continue;
    if (!head || typeof head.sourceRepository !== "string" || sha256Text(head.sourceRepository) !== entry.name) {
      throw new Error("晋升历史仓库 head 无效");
    }
    const history = await readEvents(directory, head.sourceRepository);
    const event = history.findLast((item) => item.candidateId === candidateId);
    if (event?.action === "promote") matches.push(event);
  }
  const match = matches[0];
  if (!match || matches.length !== 1) throw new Error("候选未处于唯一、有效的晋升状态");
  const repository = match.sourceRepository;
  return appendEvent(repository, options.dataDirectory, (history) => {
    const previous = history.findLast((event) => event.candidateId === candidateId);
    if (!previous || previous.action !== "promote") throw new Error("候选未处于晋升状态");
    return Promise.resolve({ schemaVersion: 1, action: "revoke", sourceRepository: repository,
      candidateId, contentSha256: previous.contentSha256, snapshotSha256: previous.snapshotSha256,
      evidence: previous.evidence, confirmation: "explicit-human-approval" });
  });
}

export async function listActiveCandidates(sourceRepository: string, dataDirectory: string): Promise<ExperienceCandidate[]> {
  const repository = await canonicalRepository(sourceRepository);
  const directory = await journalDirectory(repository, dataDirectory, false);
  if (!directory) return [];
  const latest = new Map<string, PromotionEvent>();
  for (const event of await readEvents(directory, repository)) latest.set(event.candidateId, event);
  const active: ExperienceCandidate[] = [];
  for (const event of latest.values()) {
    if (event.action === "revoke") continue;
    const candidate = await loadCandidate(event.candidateId, dataDirectory);
    const snapshot = parseCandidateSnapshot(candidate);
    if (snapshot.contentSha256 !== event.contentSha256 || sha256Json(snapshot) !== event.snapshotSha256) throw new Error("已晋升候选哈希发生变化");
    const source = await loadRunBundle(candidate.sourceRunId, dataDirectory);
    if (await canonicalRepository(source.manifest.sourceRepository) !== repository) throw new Error("已晋升候选仓库不匹配");
    const evidence = await checkEvidence(candidate, event.evidence.map((entry) => entry.id), repository, dataDirectory);
    if (sha256Json(evidence) !== sha256Json(event.evidence)) throw new Error("晋升实验证据已变化，需要重新审核");
    active.push(candidate);
  }
  return active;
}
