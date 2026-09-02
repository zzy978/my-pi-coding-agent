import type { PiRuntimeOptions } from "../runtime/pi-runtime.js";
import type { TaskSpec } from "../task/task-spec.js";
import type { RunManifest } from "./schema.js";
import type { SetupPreference } from "../workspace/setup.js";

export interface ReplayPlan {
  sourceRepository: string;
  baselineCommit: string;
  task: TaskSpec;
  allowShell: boolean;
  noSession: boolean;
  requestedModel: { provider: string; id: string };
  thinkingLevel: NonNullable<PiRuntimeOptions["thinkingLevel"]>;
  tools: string[];
  setupPreference: SetupPreference;
}

export function createReplayPlan(manifest: RunManifest, shellOverride?: boolean): ReplayPlan {
  if (!manifest.replayable) throw new Error(`Run ${manifest.runId} was not recorded from a managed worktree`);
  if (shellOverride !== undefined && manifest.policy.allowShell !== shellOverride) {
    throw new Error(`Replay cannot ${shellOverride ? "enable" : "disable"} Shell when the recorded run used the opposite policy.`);
  }
  return {
    sourceRepository: manifest.sourceRepository,
    baselineCommit: manifest.baselineCommit,
    task: {
      ...manifest.task.content,
      allowedPaths: [...manifest.task.content.allowedPaths],
      verify: manifest.task.content.verify.map((item) => ({ ...item })),
      doneWhen: [...manifest.task.content.doneWhen]
    },
    allowShell: manifest.policy.allowShell,
    noSession: manifest.agent.sessionMode === "ephemeral",
    requestedModel: { ...manifest.agent.model },
    thinkingLevel: manifest.agent.thinkingLevel as NonNullable<PiRuntimeOptions["thinkingLevel"]>,
    tools: [...manifest.policy.tools],
    setupPreference: manifest.setup
      ? {
          mode: "resolved",
          plan: {
            source: manifest.setup.source,
            commands: manifest.setup.commands.map((item) => ({ ...item }))
          }
        }
      : { mode: "disabled" }
  };
}
