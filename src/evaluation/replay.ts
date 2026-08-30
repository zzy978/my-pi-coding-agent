import type { PiRuntimeOptions } from "../runtime/pi-runtime.js";
import type { TaskSpec } from "../task/task-spec.js";
import type { RunManifest } from "./schema.js";

export interface ReplayPlan {
  sourceRepository: string;
  baselineCommit: string;
  task: TaskSpec;
  allowShell: boolean;
  noSession: boolean;
  requestedModel: { provider: string; id: string };
  thinkingLevel: NonNullable<PiRuntimeOptions["thinkingLevel"]>;
}

export function createReplayPlan(manifest: RunManifest, unsafeShellAuthorized: boolean): ReplayPlan {
  if (!manifest.replayable) throw new Error(`Run ${manifest.runId} was not recorded from a managed worktree`);
  if (manifest.policy.allowShell && !unsafeShellAuthorized) {
    throw new Error("This run used unsafe shell access. Replay requires explicit --unsafe-shell authorization.");
  }
  if (!manifest.policy.allowShell && unsafeShellAuthorized) {
    throw new Error("Replay cannot enable --unsafe-shell when the original run kept shell disabled.");
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
    thinkingLevel: manifest.agent.thinkingLevel as NonNullable<PiRuntimeOptions["thinkingLevel"]>
  };
}
