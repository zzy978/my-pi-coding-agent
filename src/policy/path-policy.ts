import { isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";

const ALWAYS_PROTECTED = [
  ".git", ".git/**", "**/.git", "**/.git/**",
  ".env", ".env.*", "**/.env", "**/.env.*",
  "node_modules", "node_modules/**", "**/node_modules", "**/node_modules/**"
];
const SENSITIVE_READ_PATHS = [
  ".git", ".git/**", "**/.git", "**/.git/**",
  ".env", ".env.*", "**/.env", "**/.env.*"
];
const MATCH_OPTIONS = { dot: true, nocase: process.platform === "win32" } as const;

export function normalizeRelativePath(filePath: string): string {
  return filePath.split(sep).join("/").replace(/^\.\//, "");
}

export function relativePathWithin(workspace: string, filePath: string): string | null {
  const absoluteWorkspace = resolve(workspace);
  const absolutePath = resolve(absoluteWorkspace, filePath);
  const candidate = relative(absoluteWorkspace, absolutePath);
  if (candidate === "") return "";
  if (candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) return null;
  return normalizeRelativePath(candidate);
}

export function isProtectedPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return ALWAYS_PROTECTED.some((pattern) => minimatch(normalized, pattern, MATCH_OPTIONS));
}

export function isSensitiveReadPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return SENSITIVE_READ_PATHS.some((pattern) => minimatch(normalized, pattern, MATCH_OPTIONS));
}

export function isAllowedChangedPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || isProtectedPath(normalized)) return false;
  return true;
}

export function assertReadablePath(workspace: string, filePath: string): string {
  const absolutePath = resolve(workspace, filePath);
  if (isSensitiveReadPath(absolutePath)) throw new Error(`Path is protected from reads: ${filePath}`);
  return absolutePath;
}

export function assertWritablePath(workspace: string, filePath: string): string {
  const absolutePath = resolve(workspace, filePath);
  if (!filePath || isProtectedPath(absolutePath)) {
    throw new Error(`Path is not allowed: ${filePath}`);
  }
  return absolutePath;
}
