import type { RunBundle } from "../evaluation/store.js";
import type { CollectedEvidence } from "./evidence.js";
import type { FailureObservation } from "./schema.js";

export function classifyFailure(bundle: RunBundle, collected: CollectedEvidence): FailureObservation {
  const refs = (prefix: string): string[] => {
    const matching = collected.evidence.filter((item) => item.ref.startsWith(prefix)).map((item) => item.ref);
    return matching.length ? matching : ["manifest.json#/verifier"];
  };
  if (!bundle.result) return { eligibility: "inconclusive", category: "unknown", stage: "unknown", summary: "Run has no completed result; no failure cause can be established.", evidenceRefs: refs("manifest.json#/verifier") };
  if (bundle.result.status === "verification_passed") return { eligibility: "ignored", category: "none", stage: "verification", summary: "The configured verifier passed. Incidental tool errors are not a failed outcome.", evidenceRefs: refs("result.json#/status") };
  if (collected.trace.some((entry) => entry.type === "setup_end" && entry.data?.success === false)) return { eligibility: "inconclusive", category: "setup_failed", stage: "setup", summary: "Workspace setup failed before usable coding evaluation; repair the environment before learning a coding strategy.", evidenceRefs: refs("trace.jsonl#") };
  if (bundle.manifest.verifier.commands.length === 0 || bundle.result.verification?.configured === false) return { eligibility: "inconclusive", category: "no_verifier", stage: "verification", summary: "No verifier was configured. Lack of verified success is not evidence of a coding failure.", evidenceRefs: refs("manifest.json#/verifier") };
  const verification = bundle.result.verification;
  const commandRefs = (status: "failed" | "timed_out"): string[] => {
    const matching = verification?.commands.flatMap((command, index) => command.status === status ? [`result.json#/verification/commands/${index}`] : []) ?? [];
    return matching.filter((ref) => collected.evidence.some((item) => item.ref === ref));
  };
  if (verification?.disallowedChangedFiles.length) return { eligibility: "eligible", category: "scope_violation", stage: "verification", summary: "Recorded changes include files outside allowedPaths.", evidenceRefs: refs("result.json#/verification") };
  if (verification?.commands.some((command) => command.status === "timed_out")) return { eligibility: "eligible", category: "verifier_timeout", stage: "verification", summary: "A configured verifier timed out; this alone does not identify a code defect.", evidenceRefs: commandRefs("timed_out") };
  if (verification?.commands.some((command) => command.status === "failed")) return { eligibility: "eligible", category: "verifier_failed", stage: "verification", summary: "A configured verifier failed. The diagnostic evidence may support a hypothesis, not a proven root cause.", evidenceRefs: commandRefs("failed") };
  if (bundle.result.status === "execution_failed") return { eligibility: "eligible", category: "execution_failed", stage: "execution", summary: "Agent execution failed before successful verification; inspect recorded errors before attributing a cause.", evidenceRefs: refs("result.json#/") };
  if (collected.trace.some((entry) => entry.type === "tool_end" && entry.data?.isError === true)) return { eligibility: "eligible", category: "tool_failed", stage: "execution", summary: "The failed run contains tool errors, without a conclusive verifier failure category.", evidenceRefs: refs("trace.jsonl#") };
  return { eligibility: "inconclusive", category: "unknown", stage: "unknown", summary: "Available artifacts do not establish a supported failure pattern.", evidenceRefs: refs("result.json#/status") };
}
