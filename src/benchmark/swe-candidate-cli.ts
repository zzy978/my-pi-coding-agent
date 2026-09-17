import { readFile } from "node:fs/promises";
import { redactSensitiveText } from "../evaluation/redaction.js";
import { auditCandidateBatch, prepareCandidateAudit, runCandidateBatch, type AuditRequest } from "./swe-candidate-batch.js";

async function main(): Promise<void> {
  const [mode, input, ...extra] = process.argv.slice(2);
  if (!input || extra.length || !["prepare", "run", "audit"].includes(mode ?? "")) {
    throw new Error("用法：tsx src/benchmark/swe-candidate-cli.ts prepare <request.json> | run <批次目录> | audit <批次目录>");
  }
  if (mode === "prepare") console.log(await prepareCandidateAudit(JSON.parse(await readFile(input, "utf8")) as AuditRequest));
  else if (mode === "run") await runCandidateBatch(input);
  else console.log(JSON.stringify(await auditCandidateBatch(input), null, 2));
}
main().catch((error: unknown) => { console.error(redactSensitiveText(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
