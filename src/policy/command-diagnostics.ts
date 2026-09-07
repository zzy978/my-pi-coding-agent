import { redactCommandPreview } from "../evaluation/redaction.js";
import type { CommandPolicyResult } from "./command-policy.js";

export function commandPolicyDiagnostic(command: string, policy: CommandPolicyResult, approvalDenied = false): string {
  const decision = approvalDenied
    ? "Deletion command denied: explicit human approval was not granted"
    : "Command blocked";
  return `${decision} [${policy.ruleId ?? "unknown-policy"}]: ${policy.reason ?? "policy violation"}\nCommand (redacted): ${redactCommandPreview(command)}`;
}

export function policyFailureSummary(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return undefined;
  for (const block of result.content as unknown[]) {
    if (!block || typeof block !== "object" || !("text" in block) || typeof block.text !== "string") continue;
    if (/^(?:Command blocked|Deletion command denied)/.test(block.text)) return redactCommandPreview(block.text);
  }
  return undefined;
}
