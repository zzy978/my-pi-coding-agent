import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DataDirectories {
  root: string;
  runs: string;
  experiences: string;
  experiments: string;
  promotions: string;
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
    experiences: join(dataDirectory, "experiences"),
    experiments: join(dataDirectory, "experiments"),
    promotions: join(dataDirectory, "promotions"),
    worktree: join(dataDirectory, "worktree"),
    sessions: join(dataDirectory, "sessions"),
    reports: join(dataDirectory, "reports"),
    temp: join(dataDirectory, "temp"),
    agent: join(dataDirectory, "agent")
  };
}

export async function ensureDataDirectories(dataDirectory = getDataDirectory()): Promise<DataDirectories> {
  const directories = getDataDirectories(dataDirectory);
  const ensureRegular = async (directory: string): Promise<void> => {
    await mkdir(directory, { recursive: true });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Data path must be a regular directory, not a link: ${directory}`);
  };
  // Check the root before creating anything beneath it (Windows junctions included).
  await ensureRegular(directories.root);
  const paths = [
    directories.runs,
    directories.experiences,
    directories.experiments,
    directories.promotions,
    directories.worktree,
    directories.sessions,
    directories.reports,
    directories.temp,
    directories.agent
  ];
  await Promise.all(paths.map(ensureRegular));
  return directories;
}
