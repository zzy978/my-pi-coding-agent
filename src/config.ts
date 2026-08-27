export const APP_NAME = "pi-agent-tui";
export const APP_VERSION = "0.1.0";
export const MIN_NODE_VERSION = { major: 22, minor: 19, patch: 0 } as const;

export function isSupportedNodeVersion(version = process.versions.node): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  const minimum = MIN_NODE_VERSION;
  if (major !== minimum.major) return major > minimum.major;
  if (minor !== minimum.minor) return minor > minimum.minor;
  return patch >= minimum.patch;
}

export function minimumNodeVersionText(): string {
  const { major, minor, patch } = MIN_NODE_VERSION;
  return `${major}.${minor}.${patch}`;
}
