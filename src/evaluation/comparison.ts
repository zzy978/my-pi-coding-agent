import { redactSensitiveText } from "./redaction.js";
import type { RunComparison, RunManifest, RunResult } from "./schema.js";

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function configurationDifferences(original: RunManifest, replay: RunManifest): string[] {
  const differences: string[] = [];
  if (!equalJson(original.agent.model, replay.agent.model)) differences.push("model");
  if (original.agent.thinkingLevel !== replay.agent.thinkingLevel) differences.push("thinkingLevel");
  if (original.agent.sessionMode !== replay.agent.sessionMode) differences.push("sessionMode");
  if (original.agent.appVersion !== replay.agent.appVersion) differences.push("appVersion");
  if (original.policy.allowShell !== replay.policy.allowShell) differences.push("allowShell");
  if (!equalJson(original.policy.allowedPaths, replay.policy.allowedPaths)) differences.push("allowedPaths");
  if (!equalJson(original.policy.tools, replay.policy.tools)) differences.push("tools");
  if (!equalJson(original.contextFiles, replay.contextFiles)) differences.push("contextFiles");
  if (original.verifier.sha256 !== replay.verifier.sha256) differences.push("verifier");
  return differences;
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
  const criticalDifferences = differences.filter((difference) => difference !== "appVersion" && difference !== "sessionMode");
  const comparable = baselineSame && taskSame && criticalDifferences.length === 0;
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
    }
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
