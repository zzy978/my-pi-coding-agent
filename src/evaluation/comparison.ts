import { redactSensitiveText } from "./redaction.js";
import { sha256Text } from "./schema.js";
import type { RunComparison, RunManifest, RunResult } from "./schema.js";
import { formatTaskPrompt } from "../task/task-spec.js";

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function setupConfiguration(manifest: RunManifest): { source: string; commands: unknown[] } {
  return manifest.setup
    ? { source: manifest.setup.source, commands: manifest.setup.commands }
    : { source: "disabled", commands: [] };
}

function configurationDifferences(original: RunManifest, replay: RunManifest): string[] {
  const differences: string[] = [];
  if (!equalJson(original.agent.model, replay.agent.model)) differences.push("model");
  if (!equalJson(original.agent.modelConfig ?? null, replay.agent.modelConfig ?? null)) differences.push("modelConfig");
  if (original.agent.thinkingLevel !== replay.agent.thinkingLevel) differences.push("thinkingLevel");
  if (original.agent.sessionMode !== replay.agent.sessionMode) differences.push("sessionMode");
  if (original.agent.appVersion !== replay.agent.appVersion) differences.push("appVersion");
  if (original.agent.promptPolicyVersion !== replay.agent.promptPolicyVersion) differences.push("promptPolicyVersion");
  if (!equalJson(setupConfiguration(original), setupConfiguration(replay))) differences.push("setup");
  if (original.policy.allowShell !== replay.policy.allowShell) differences.push("allowShell");
  if (!equalJson(original.policy.allowedPaths, replay.policy.allowedPaths)) differences.push("allowedPaths");
  if (!equalJson(original.policy.tools, replay.policy.tools)) differences.push("tools");
  if (!equalJson(original.contextFiles, replay.contextFiles)) differences.push("contextFiles");
  if (original.verifier.sha256 !== replay.verifier.sha256) differences.push("verifier");
  if (!equalJson(original.experiment, replay.experiment)) differences.push("experiment");
  if (!equalJson(original.replayExperience, replay.replayExperience)) differences.push("replayExperience");
  return differences;
}

function effectivePromptHash(manifest: RunManifest): string {
  return manifest.experiment?.effectivePromptSha256 ?? manifest.replayExperience?.effectivePromptSha256 ??
    sha256Text(formatTaskPrompt(manifest.task.content, manifest.task.content.objective));
}

function fileComparison(original: string[], replay: string[]): RunComparison["changedFiles"] {
  const originalSet = new Set(original);
  const replaySet = new Set(replay);
  return {
    original,
    replay,
    common: original.filter((file) => replaySet.has(file)),
    onlyOriginal: original.filter((file) => !replaySet.has(file)),
    onlyReplay: replay.filter((file) => !originalSet.has(file))
  };
}

export function compareRuns(
  originalManifest: RunManifest,
  originalResult: RunResult,
  replayManifest: RunManifest,
  replayResult: RunResult,
  createdAt = new Date().toISOString()
): RunComparison {
  const baselineSame = originalManifest.baselineCommit === replayManifest.baselineCommit;
  const taskSame = originalManifest.task.sha256 === replayManifest.task.sha256;
  const differences = configurationDifferences(originalManifest, replayManifest);
  const samePrompt = effectivePromptHash(originalManifest) === effectivePromptHash(replayManifest);
  const criticalDifferences = differences.filter((difference) => difference !== "appVersion" && difference !== "sessionMode" &&
    !(difference === "replayExperience" && samePrompt));
  const comparable = baselineSame && taskSame && criticalDifferences.length === 0;
  const selection = !originalManifest.replayExperience && !originalManifest.experiment ? replayManifest.replayExperience : undefined;
  let experienceObservation: RunComparison["experienceObservation"];
  if (selection) {
    const selected = selection.status === "selected" && Boolean(selection.candidate);
    const eligible = selected && originalManifest.kind === "run" && baselineSame && taskSame &&
      differences.every((difference) => difference === "replayExperience") &&
      Boolean(originalResult.verification?.configured && replayResult.verification?.configured);
    const outcome = !selected ? "not_evaluated" : !eligible ? "invalid_isolation" :
      originalResult.status === "execution_failed" || replayResult.status === "execution_failed" ? "inconclusive" :
        originalResult.status !== "verification_passed" && replayResult.status === "verification_passed" ? "observed_improvement" :
          originalResult.status === "verification_passed" && replayResult.status !== "verification_passed" ? "observed_regression" :
            "no_observed_gain";
    experienceObservation = { eligible: Boolean(eligible), outcome, selectedIds: [...selection.selectedIds],
      auditId: selection.auditId,
      reason: !selected ? "No experience was injected; selection status is " + selection.status :
        !eligible ? "Baseline, task, verifier, or another execution condition differs" :
          "One replay gives an observation, not a causal or statistically reliable effectiveness estimate" };
  }
  return {
    schemaVersion: 1,
    createdAt,
    originalRunId: originalManifest.runId,
    replayRunId: replayManifest.runId,
    status: comparable ? replayResult.status : "not_comparable",
    baseline: {
      original: originalManifest.baselineCommit,
      replay: replayManifest.baselineCommit,
      same: baselineSame
    },
    task: {
      originalSha256: originalManifest.task.sha256,
      replaySha256: replayManifest.task.sha256,
      same: taskSame
    },
    configurationDifferences: differences,
    verification: {
      original: originalResult.status,
      replay: replayResult.status,
      originalPassed: originalResult.status === "verification_passed",
      replayPassed: replayResult.status === "verification_passed"
    },
    changedFiles: fileComparison(
      originalResult.verification?.changedFiles ?? [],
      replayResult.verification?.changedFiles ?? []
    ),
    diffSummary: { original: originalResult.diffSummary, replay: replayResult.diffSummary },
    durationMs: { original: originalResult.durationMs, replay: replayResult.durationMs },
    toolCallCount: { original: originalResult.toolCallCount, replay: replayResult.toolCallCount },
    errors: {
      original: {
        count: originalResult.errorCount,
        retries: originalResult.retryCount,
        summaries: originalResult.errors.map((error) => redactSensitiveText(error))
      },
      replay: {
        count: replayResult.errorCount,
        retries: replayResult.retryCount,
        summaries: replayResult.errors.map((error) => redactSensitiveText(error))
      }
    },
    ...(experienceObservation ? { experienceObservation } : {})
  };
}

function bullets(values: string[]): string {
  return values.length ? values.map((value) => `- ${inlineCode(value)}`).join("\n") : "- None";
}

function inlineCode(value: string): string {
  const safe = redactSensitiveText(value).replace(/[\r\n]+/g, " ");
  const longestFence = Math.max(0, ...Array.from(safe.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(1, longestFence + 1));
  return `${fence}${safe}${fence}`;
}

function codeBlock(value: string): string {
  const longestFence = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}text\n${redactSensitiveText(value) || "(empty)"}\n${fence}`;
}

export function comparisonMarkdown(comparison: RunComparison): string {
  return `# Coding Agent Replay Comparison

- Original run: ${comparison.originalRunId}
- Replay run: ${comparison.replayRunId}
- Classification: ${comparison.status}
- Same baseline: ${comparison.baseline.same ? "yes" : "no"}
- Same TaskSpec: ${comparison.task.same ? "yes" : "no"}
- Original verification: ${comparison.verification.original}
- Replay verification: ${comparison.verification.replay}
${comparison.experienceObservation ? `- Experience selection: ${comparison.experienceObservation.outcome}
- Selected candidate IDs: ${comparison.experienceObservation.selectedIds.length ? comparison.experienceObservation.selectedIds.join(", ") : "none"}
- Selection audit: ${comparison.experienceObservation.auditId}
- Interpretation: ${comparison.experienceObservation.reason}
` : ""}

## Configuration differences

${bullets(comparison.configurationDifferences)}

## Changed files

### Common

${bullets(comparison.changedFiles.common)}

### Original only

${bullets(comparison.changedFiles.onlyOriginal)}

### Replay only

${bullets(comparison.changedFiles.onlyReplay)}

## Metrics

| Metric | Original | Replay |
| --- | ---: | ---: |
| Duration (ms) | ${comparison.durationMs.original} | ${comparison.durationMs.replay} |
| Tool calls | ${comparison.toolCallCount.original} | ${comparison.toolCallCount.replay} |
| Errors | ${comparison.errors.original.count} | ${comparison.errors.replay.count} |
| Retries | ${comparison.errors.original.retries} | ${comparison.errors.replay.retries} |

## Diff summaries

### Original

${codeBlock(comparison.diffSummary.original)}

### Replay

${codeBlock(comparison.diffSummary.replay)}

## Error summaries

### Original

${bullets(comparison.errors.original.summaries)}

### Replay

${bullets(comparison.errors.replay.summaries)}
`;
}
