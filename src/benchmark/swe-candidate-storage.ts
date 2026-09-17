import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FileSeal = Record<string, string>;
export async function assertRuntimeEntry(root: string, moduleUrl: string, cwd: string): Promise<void> {
  const normalize = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  if (normalize(await realpath(fileURLToPath(moduleUrl))) !== normalize(await realpath(join(root, "runtime", "src", "benchmark", "swe-candidate-batch.ts"))) ||
    normalize(await realpath(cwd)) !== normalize(await realpath(join(root, "runtime")))) throw new Error("Must load and run the frozen runtime entry");
}
const safe = (file: string): void => {
  if (isAbsolute(file) || file.includes("\\") || file.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe artifact path");
};

export async function fileHash(root: string, file: string): Promise<string> {
  safe(file);
  let current = root;
  for (const part of file.split("/")) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic artifact path");
  }
  const stat = await lstat(current);
  if (!stat.isFile() || stat.nlink > 1) throw new Error("Artifact must be a regular file without hard links");
  return createHash("sha256").update(await readFile(current)).digest("hex");
}

export async function sealFiles(root: string, files: string[]): Promise<FileSeal> {
  if (new Set(files).size !== files.length) throw new Error("Duplicate artifact file");
  const result: FileSeal = {};
  for (const file of [...files].sort()) result[file] = await fileHash(root, file);
  return result;
}

export async function verifyFiles(root: string, seal: FileSeal): Promise<string[]> {
  const issues: string[] = [];
  for (const [file, hash] of Object.entries(seal)) {
    try { if (!/^[a-f0-9]{64}$/.test(hash) || await fileHash(root, file) !== hash) issues.push(`文件哈希不匹配：${file}`); }
    catch { issues.push(`文件不可读取：${file}`); }
  }
  return issues;
}

export async function treeFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic source path: ${file}`);
    if (entry.isDirectory()) files.push(...await treeFiles(root, file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
