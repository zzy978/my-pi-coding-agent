import { homedir } from "node:os";
import { join } from "node:path";

export function getDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_TUI_AGENT_DATA_DIR) return env.PI_TUI_AGENT_DATA_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "pi-tui-coding-agent");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "pi-tui-coding-agent");
  }
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-tui-coding-agent");
}
