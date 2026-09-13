import { Worker } from "node:worker_threads";

interface ContextSnapshot {
  files: Array<{ path: string; content: string }>;
  warnings: boolean;
}

/** Pi 的读取器直接写 stderr；隔离其输出，避免全局替换 console 的并发风险。 */
export function readDiagnosticContext(cwd: string, agentDir: string): Promise<ContextSnapshot> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { loadProjectContextFiles } = await import(workerData.sdkUrl);
        const files = loadProjectContextFiles({ cwd: workerData.cwd, agentDir: workerData.agentDir });
        parentPort.postMessage(files);
      })().catch(() => { process.exitCode = 1; });
    `, { eval: true, workerData: { cwd, agentDir, sdkUrl: import.meta.resolve("@earendil-works/pi-coding-agent") }, stdout: true, stderr: true });
    let files: ContextSnapshot["files"] | undefined;
    let warnings = false;
    worker.stdout.on("data", () => { warnings = true; });
    worker.stderr.on("data", () => { warnings = true; });
    worker.on("message", (value: ContextSnapshot["files"]) => { files = value; });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("上下文诊断读取超时。"));
    }, 30_000);
    worker.on("error", () => {
      clearTimeout(timer);
      reject(new Error("上下文诊断读取失败。"));
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !files) reject(new Error("上下文诊断读取失败。"));
      else resolve({ files, warnings });
    });
  });
}
