import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { docker } from "./swe-process.js";
import type { SweTask } from "./swe-mini.js";

export const EVALUATOR_IMAGE = "picode-swe-evaluator:4.1.0";
export async function bridge(root: string, args: string[]): Promise<void> {
  await docker(["run", "--rm", "--entrypoint", "python", "--mount", `type=bind,source=${resolve("benchmarks/swe-mini")},target=/bridge,readonly`,
    "--mount", `type=bind,source=${root},target=/data`, "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
    EVALUATOR_IMAGE, "/bridge/bridge.py", ...args], { timeoutMs: 900_000 });
}

export interface Score { completed: boolean; resolved: boolean; emptyPatch?: boolean }
export async function scorePatch(root: string, id: string, patch: string, scoreId: string): Promise<Score> {
  const path = join(root, `${scoreId}.patch`);
  await writeFile(path, patch);
  await bridge(root, ["evaluate", id, `/data/${scoreId}.patch`, scoreId]);
  const score = JSON.parse(await readFile(join(root, `${scoreId}.score.json`), "utf8")) as Score;
  if (typeof score.completed !== "boolean" || (score.completed && typeof score.resolved !== "boolean")) throw new Error("Invalid official score");
  return score;
}

export async function startTaskContainer(task: SweTask, imageId: string): Promise<string> {
  const name = `picode-swe-${randomUUID()}`;
  await docker(["run", "-d", "--name", name, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "512", "--memory", "4g", "--cpus", "2", "--entrypoint", "bash", imageId, "-c", "sleep infinity"]);
  try {
    // Trusted setup: remove future Git history; model tools never receive this operation.
    await docker(["exec", "-w", "/testbed", name, "bash", "-c",
      `git reset --hard ${task.base_commit} && git clean -fd && rm -rf .git && git init -q && git config user.email benchmark@localhost && git config user.name benchmark && git add -A && git commit -qm baseline`]);
    return name;
  } catch (error) { await stopTaskContainer(name); throw error; }
}

export async function stopTaskContainer(name: string): Promise<void> {
  if (!/^picode-swe-[a-f0-9-]+$/.test(name)) throw new Error("Refusing to remove unrelated container");
  await docker(["rm", "-f", name]);
}

export function containerShell(name: string): BashOperations {
  return { exec: async (command, _cwd, options) => {
    const seconds = Math.min(Math.max(options.timeout ?? 120, 1), 120);
    const result = await docker(["exec", "-w", "/testbed", name, "bash", "-c",
      'source /opt/miniconda3/bin/activate testbed && exec timeout -k 5 "$1" bash --noprofile --norc -c "$2"', "picode", String(seconds), command],
    { acceptFailure: true, timeoutMs: (seconds + 15) * 1000, ...(options.signal ? { signal: options.signal } : {}), onData: options.onData });
    return { exitCode: result.code };
  } };
}

export async function collectContainerPatch(name: string): Promise<{ patch: string; files: string[] }> {
  await docker(["exec", "-w", "/testbed", name, "git", "add", "-N", "."]);
  const patch = (await docker(["exec", "-w", "/testbed", name, "git", "diff", "--binary", "HEAD"])).stdout;
  const files = (await docker(["exec", "-w", "/testbed", name, "git", "diff", "--name-only", "HEAD"])).stdout.trim().split("\n").filter(Boolean);
  return { patch, files };
}

export async function prepareImages(root: string, tasks: Array<SweTask & { image: string }>): Promise<Record<string, string>> {
  await mkdir(root, { recursive: true });
  let images: Record<string, string> = {};
  try { images = JSON.parse(await readFile(join(root, "images.json"), "utf8")) as Record<string, string>; }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  for (const task of tasks) {
    if (!images[task.instance_id]) {
      console.log(`IMAGE ${task.instance_id}`);
      const source = `ghcr.io/epoch-research/swe-bench.eval.x86_64.${task.instance_id}:latest`;
      await docker(["pull", source], { timeoutMs: 1_800_000 });
      // The official scorer expects its own image key; both arms use the identical pinned image.
      await docker(["tag", source, task.image]);
      images[task.instance_id] = (await docker(["image", "inspect", "--format", "{{.Id}}", task.image])).stdout.trim();
      await writeFile(join(root, "images.json"), JSON.stringify(images, null, 2));
    } else if ((await docker(["image", "inspect", "--format", "{{.Id}}", task.image])).stdout.trim() !== images[task.instance_id]) throw new Error("Image tag drift");
  }
  return images;
}

export async function preflightTasks(root: string, tasks: SweTask[]): Promise<void> {
  const path = join(root, "preflight.json");
  let ready: string[] = [];
  try { ready = JSON.parse(await readFile(path, "utf8")) as string[]; }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const harmless = "diff --git a/.picode-preflight b/.picode-preflight\nnew file mode 100644\nindex 0000000..f2ba8f8\n--- /dev/null\n+++ b/.picode-preflight\n@@ -0,0 +1 @@\n+baseline\n";
  for (const task of tasks) {
    if (ready.includes(task.instance_id)) continue;
    console.log(`PREFLIGHT ${task.instance_id}`);
    const id = `qa-${randomUUID()}`;
    const red = await scorePatch(root, task.instance_id, harmless, `${id}-red`);
    await bridge(root, ["evaluate", task.instance_id, "gold", `${id}-gold`]);
    const gold = JSON.parse(await readFile(join(root, `${id}-gold.score.json`), "utf8")) as Score;
    if (!red.completed || red.resolved || !gold.completed || !gold.resolved) throw new Error(`Preflight failed: ${task.instance_id}; no model task started`);
    ready.push(task.instance_id);
    await writeFile(path, JSON.stringify(ready, null, 2));
  }
}
