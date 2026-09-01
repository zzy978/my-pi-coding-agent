import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { getDataDirectory } from "./data-dir.js";

interface WorkspaceSessionMetadata {
  version: 1;
  sourceRoot: string;
}

interface SessionRecord {
  version: 1;
  id: string;
  path: string;
  cwd: string;
  recordedAt: string;
  objective?: string;
}

interface SessionLock {
  version: 1;
  pid: number;
  token: string;
}

export interface StoredSessionInfo extends SessionInfo {
  materialized: boolean;
  objective?: string;
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function parseRecord(value: unknown): SessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<SessionRecord>;
  if (record.version !== 1 || typeof record.id !== "string" || !record.id
    || typeof record.path !== "string" || !record.path
    || typeof record.cwd !== "string" || typeof record.recordedAt !== "string"
    || (record.objective !== undefined && (typeof record.objective !== "string" || !record.objective.trim()))
    || Number.isNaN(new Date(record.recordedAt).getTime())) return undefined;
  return record as SessionRecord;
}

export class WorkspaceSessionStore {
  readonly sourceRoot: string;
  readonly sessionDirectory: string;
  private readonly workspaceDirectory: string;
  private readonly metadataPath: string;
  private readonly recordsDirectory: string;
  private readonly locksDirectory: string;
  private lastRecordTimestamp = 0;

  private constructor(sourceRoot: string, dataDirectory: string) {
    this.sourceRoot = resolve(sourceRoot);
    this.workspaceDirectory = join(dataDirectory, "sessions", sha256(canonicalPath(this.sourceRoot)));
    this.sessionDirectory = join(this.workspaceDirectory, "files");
    this.metadataPath = join(this.workspaceDirectory, "workspace.json");
    this.recordsDirectory = join(this.workspaceDirectory, "records");
    this.locksDirectory = join(this.workspaceDirectory, "locks");
  }

  static async create(sourceRoot: string, dataDirectory = getDataDirectory()): Promise<WorkspaceSessionStore> {
    const store = new WorkspaceSessionStore(sourceRoot, dataDirectory);
    await store.initialize();
    return store;
  }

  async list(): Promise<StoredSessionInfo[]> {
    const [managed, legacy, records] = await Promise.all([
      SessionManager.listAll(this.sessionDirectory),
      SessionManager.list(this.sourceRoot),
      this.readRecords()
    ]);
    const byId = new Map<string, StoredSessionInfo>();
    for (const session of [...managed, ...legacy]) {
      const candidate = { ...session, materialized: true };
      const existing = byId.get(session.id);
      if (!existing || session.modified > existing.modified) byId.set(session.id, candidate);
    }
    const recordsById = new Map<string, SessionRecord[]>();
    for (const record of records) {
      const group = recordsById.get(record.id) ?? [];
      group.push(record);
      recordsById.set(record.id, group);
    }
    for (const [id, group] of recordsById) {
      group.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
      const first = group[0];
      const latest = group.at(-1);
      if (!first || !latest) continue;
      const materialized = byId.get(id);
      if (materialized) {
        if (latest.objective) materialized.objective = latest.objective;
        continue;
      }
      if (existsSync(latest.path)) continue;
      byId.set(id, {
        id,
        path: latest.path,
        cwd: latest.cwd,
        created: new Date(first.recordedAt),
        modified: new Date(latest.recordedAt),
        messageCount: 0,
        firstMessage: "(no messages)",
        allMessagesText: "",
        materialized: false,
        ...(latest.objective ? { objective: latest.objective } : {})
      });
    }
    return [...byId.values()].sort((left, right) => right.modified.getTime() - left.modified.getTime());
  }

  async record(session: { id: string; path: string; cwd: string; objective?: string }): Promise<void> {
    const timestamp = Math.max(Date.now(), this.lastRecordTimestamp + 1);
    this.lastRecordTimestamp = timestamp;
    const record: SessionRecord = {
      version: 1,
      id: session.id,
      path: resolve(session.path),
      cwd: resolve(session.cwd),
      recordedAt: new Date(timestamp).toISOString(),
      ...(session.objective?.trim() ? { objective: session.objective.trim() } : {})
    };
    const name = `${timestamp}-${randomUUID()}.json`;
    await this.atomicCreate(join(this.recordsDirectory, name), `${JSON.stringify(record)}\n`);
  }

  acquire(sessionId: string): () => void {
    if (!sessionId.trim()) throw new Error("Cannot lock a session without an ID");
    const path = join(this.locksDirectory, `${sha256(sessionId)}.lock`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      let descriptor: number | undefined;
      let created = false;
      try {
        descriptor = openSync(path, "wx");
        created = true;
        const lock: SessionLock = { version: 1, pid: process.pid, token };
        writeFileSync(descriptor, `${JSON.stringify(lock)}\n`, "utf8");
        closeSync(descriptor);
        descriptor = undefined;
        return () => {
          try {
            const current = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionLock>;
            if (current.token === token && current.pid === process.pid) unlinkSync(path);
          } catch {
            // A missing or replaced lock no longer belongs to this runtime.
          }
        };
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        if (created) {
          try {
            unlinkSync(path);
          } catch {
            // Preserve the original lock creation error.
          }
        }
        if (!isAlreadyExists(error)) throw error;
        let existing: Partial<SessionLock> | undefined;
        try {
          existing = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionLock>;
        } catch {
          throw new Error(`Session ${sessionId} is locked by another process`);
        }
        if (typeof existing.pid !== "number" || isProcessAlive(existing.pid)) {
          throw new Error(`Session ${sessionId} is already active in another process`);
        }
        try {
          unlinkSync(path);
        } catch {
          throw new Error(`Session ${sessionId} is locked by another process`);
        }
      }
    }
    throw new Error(`Could not acquire session ${sessionId}`);
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.sessionDirectory, { recursive: true }),
      mkdir(this.recordsDirectory, { recursive: true }),
      mkdir(this.locksDirectory, { recursive: true })
    ]);
    const metadata: WorkspaceSessionMetadata = { version: 1, sourceRoot: this.sourceRoot };
    try {
      await this.atomicCreate(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    } catch (error) {
      try {
        await readFile(this.metadataPath, "utf8");
      } catch {
        throw error;
      }
    }
    const existing = JSON.parse(await readFile(this.metadataPath, "utf8")) as Partial<WorkspaceSessionMetadata>;
    if (existing.version !== 1 || typeof existing.sourceRoot !== "string"
      || canonicalPath(existing.sourceRoot) !== canonicalPath(this.sourceRoot)) {
      throw new Error(`Session workspace metadata does not match ${this.sourceRoot}`);
    }
  }

  private async atomicCreate(path: string, content: string): Promise<void> {
    const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async readRecords(): Promise<SessionRecord[]> {
    const names = await readdir(this.recordsDirectory);
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        return parseRecord(JSON.parse(await readFile(join(this.recordsDirectory, name), "utf8")));
      } catch {
        return undefined;
      }
    }));
    return records.filter((record): record is SessionRecord => record !== undefined);
  }
}
