import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DataDirectories {
  root: string;
  runs: string;
  worktree: string;
  sessions: string;
  reports: string;
  temp: string;
  agent: string;
}

const projectDirectory = fileURLToPath(new URL("../..", import.meta.url));

export function getDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_TUI_AGENT_DATA_DIR) return env.PI_TUI_AGENT_DATA_DIR;
  return join(projectDirectory, ".picoding");
}

export function getDataDirectories(dataDirectory = getDataDirectory()): DataDirectories {
  return {
    root: dataDirectory,
    runs: join(dataDirectory, "runs"),
    worktree: join(dataDirectory, "worktree"),
    sessions: join(dataDirectory, "sessions"),
    reports: join(dataDirectory, "reports"),
    temp: join(dataDirectory, "temp"),
    agent: join(dataDirectory, "agent")
  };
}

export async function ensureDataDirectories(dataDirectory = getDataDirectory()): Promise<DataDirectories> {
  const directories = getDataDirectories(dataDirectory);
  const paths = [
    directories.root,
    directories.runs,
    directories.worktree,
    directories.sessions,
    directories.reports,
    directories.temp,
    directories.agent
  ];
  await Promise.all(paths.map((directory) => mkdir(directory, { recursive: true })));
  return directories;
}
