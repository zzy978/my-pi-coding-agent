import type { RunBundle } from "../evaluation/store.js";
import type { CollectedEvidence } from "./evidence.js";
import type { FailureObservation } from "./schema.js";

export interface ReviewSelection { minSuccessToolCalls?: number; force?: boolean }

export function classifyRun(bundle: RunBundle, collected: CollectedEvidence, options: ReviewSelection = {}): FailureObservation {
  const minimum = options.minSuccessToolCalls ?? 6;
  if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > 10_000) throw new Error("minSuccessToolCalls must be between 0 and 10000");
  const refs = (prefix: string): string[] => {
    const matching = collected.evidence.filter((item) => item.ref.startsWith(prefix)).map((item) => item.ref);
    return matching.length ? matching : ["manifest.json#/verifier"];
  };
  if (!bundle.result) return { eligibility: "inconclusive", category: "unknown", stage: "unknown", summary: "Run has no completed result; no failure cause can be established.", evidenceRefs: refs("manifest.json#/verifier") };
  if (collected.trace.some((entry) => entry.type === "setup_end" && entry.data?.success === false)) return { eligibility: "inconclusive", category: "setup_failed", stage: "setup", summary: "Workspace setup failed before usable coding evaluation; repair the environment before learning a coding strategy.", evidenceRefs: refs("trace.jsonl#") };
  if (bundle.manifest.verifier.commands.length === 0 || bundle.result.verification?.configured === false) return { eligibility: "inconclusive", category: "no_verifier", stage: "verification", summary: "No verifier was configured. Lack of verified success is not evidence of a coding failure.", evidenceRefs: refs("manifest.json#/verifier") };
  const verification = bundle.result.verification;
  if (bundle.result.status === "verification_passed") {
    if (!verification?.success || verification.changeAuditUnavailable || !verification.commands.length ||
      verification.commands.some((command) => command.status !== "passed") || verification.disallowedChangedFiles.length) {
      return { eligibility: "inconclusive", category: "unknown", stage: "verification", summary: "成功状态缺少一致、完整的验证证据。", evidenceRefs: refs("result.json#/verification") };
    }
    // Eligibility must use evidence actually sent to the model, not omitted trace events.
    const recorded = new Set(collected.evidence.filter((item) => item.ref.startsWith("trace.jsonl#")).map((item) => item.excerpt));
    const events = collected.trace.filter((entry) => recorded.has(JSON.stringify({ sequence: entry.sequence, type: entry.type, ...entry.data })));
    const starts = new Map(events.filter((entry) => entry.type === "tool_start").map((entry) => [entry.data?.toolCallId, entry]));
    const actions = events.filter((entry) => {
      const id = entry.data?.toolCallId;
      const start = starts.get(id);
      return entry.type === "tool_end" && typeof id === "string" && start && start.sequence < entry.sequence &&
        start.data?.toolName === entry.data?.toolName && typeof entry.data?.resultSummary === "string" && entry.data.resultSummary.trim();
    });
    const recovery = actions.some((entry) => entry.data?.isError === true && actions.some((later) => later.sequence > entry.sequence && later.data?.isError === false));
    if (!options.force && bundle.result.toolCallCount < minimum && !recovery) {
      return { eligibility: "ignored", category: "none", stage: "verification", summary: `成功运行的工具调用少于 ${minimum} 次，且没有可核查的失败恢复过程，跳过模型复盘。`, evidenceRefs: refs("result.json#/status") };
    }
    if (!actions.some((entry) => entry.data?.isError === false)) {
      return { eligibility: "inconclusive", category: "unknown", stage: "execution", summary: "成功运行缺少关联的工具动作和结果摘要，不能仅凭调用数推断有效策略。", evidenceRefs: refs("result.json#/status") };
    }
    return { eligibility: "eligible", category: recovery ? "recovered_success" : "verified_success", stage: "verification",
      summary: recovery ? "观察到工具失败后的成功动作，最终通过验证；恢复机制仍需检验。" : "运行通过验证并保留动作证据，可提出有适用边界的成功经验假设。",
      evidenceRefs: [...refs("result.json#/status"), ...refs("trace.jsonl#")].slice(0, 80) };
  }
  const commandRefs = (status: "failed" | "timed_out"): string[] => {
    const matching = verification?.commands.flatMap((command, index) => command.status === status ? [`result.json#/verification/commands/${index}`] : []) ?? [];
    return matching.filter((ref) => collected.evidence.some((item) => item.ref === ref));
  };
  if (verification?.disallowedChangedFiles.length) return { eligibility: "eligible", category: "scope_violation", stage: "verification", summary: "Recorded changes violate the source run's path policy; consult its policy version.", evidenceRefs: refs("result.json#/verification") };
  if (verification?.commands.some((command) => command.status === "timed_out")) return { eligibility: "eligible", category: "verifier_timeout", stage: "verification", summary: "A configured verifier timed out; this alone does not identify a code defect.", evidenceRefs: commandRefs("timed_out") };
  if (verification?.commands.some((command) => command.status === "failed")) return { eligibility: "eligible", category: "verifier_failed", stage: "verification", summary: "A configured verifier failed. The diagnostic evidence may support a hypothesis, not a proven root cause.", evidenceRefs: commandRefs("failed") };
  if (bundle.result.status === "execution_failed") return { eligibility: "eligible", category: "execution_failed", stage: "execution", summary: "Agent execution failed before successful verification; inspect recorded errors before attributing a cause.", evidenceRefs: refs("result.json#/") };
  if (collected.trace.some((entry) => entry.type === "tool_end" && entry.data?.isError === true)) return { eligibility: "eligible", category: "tool_failed", stage: "execution", summary: "The failed run contains tool errors, without a conclusive verifier failure category.", evidenceRefs: refs("trace.jsonl#") };
  return { eligibility: "inconclusive", category: "unknown", stage: "unknown", summary: "Available artifacts do not establish a supported failure pattern.", evidenceRefs: refs("result.json#/status") };
}

export const classifyFailure = classifyRun;
