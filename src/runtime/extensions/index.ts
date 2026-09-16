import type { AgentSessionRuntime, InlineExtension } from "@earendil-works/pi-coding-agent";
import question from "./question.js";
import questionnaire from "./questionnaire.js";
import handoff from "./handoff.js";
import { presetExtension } from "./preset.js";
import { planMode } from "./plan-mode/index.js";
import { WorkflowTools } from "./workflow-tools.js";

export function createWorkflowExtensions(agentDirectory: string, getRuntimeHost: () => AgentSessionRuntime, allowShell: boolean, createSession: AgentSessionRuntime["newSession"]): {
  extension: InlineExtension;
  isPlanning: () => boolean;
} {
  const tools = new WorkflowTools(allowShell);
  return {
    isPlanning: () => tools.planning,
    extension: {
      name: "picode-workflow",
      factory: (pi) => {
        question(pi);
        questionnaire(pi);
        // Restore the requested preset first, then intersect with plan restrictions.
        presetExtension(pi, tools, agentDirectory);
        planMode(pi, tools);
        handoff(pi, getRuntimeHost, createSession);
      }
    }
  };
}
