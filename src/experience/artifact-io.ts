import { lstat, readFile } from "node:fs/promises";

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function assertRegularDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Experience artifact path must be a regular directory, not a link");
}

export async function readArtifactText(path: string, limit: number): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink > 1) throw new Error("Experience artifact must be a regular file, not a link");
  if (metadata.size > limit) throw new Error("Experience artifact exceeds size limit");
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > limit) throw new Error("Experience artifact exceeds size limit");
  return content;
}
