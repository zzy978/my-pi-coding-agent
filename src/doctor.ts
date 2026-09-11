import { stat } from "node:fs/promises";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { isSupportedNodeVersion, minimumNodeVersionText } from "./config.js";
import { runProcess } from "./runtime/process.js";
import { prepareCurrentWorkspace } from "./workspace/current-workspace.js";
import { getDataDirectories } from "./runtime/data-dir.js";
import { readModelConfig } from "./model-config.js";
import { configureModelRuntime, configuredModel } from "./runtime/model-configuration.js";
import { redactSensitiveText } from "./evaluation/redaction.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(
  workspace: string,
  agentDirectory = getDataDirectories().agent
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "node",
    ok: isSupportedNodeVersion(),
    detail: `${process.versions.node} (required >= ${minimumNodeVersionText()})`
  });

  try {
    if (!(await stat(workspace)).isDirectory()) throw new Error("Workspace is not a directory");
    checks.push({ name: "workspace", ok: true, detail: workspace });
  } catch {
    checks.push({ name: "workspace", ok: false, detail: `Not accessible: ${workspace}` });
    return checks;
  }

  try {
    const git = await runProcess("git", ["--version"], { cwd: workspace, timeoutMs: 10_000 });
    checks.push({ name: "git", ok: true, detail: git.exitCode === 0 ? git.stdout.trim() : "Git 不可用；普通交互可用，Git 审计与受控评测不可用。" });
  } catch {
    checks.push({ name: "git", ok: true, detail: "Git 不可用；普通交互可用，Git 审计与受控评测不可用。" });
  }

  try {
    const current = await prepareCurrentWorkspace(workspace);
    checks.push({ name: "repository", ok: true, detail: current.gitUnavailable
      ? "Git 仓库信息不可用；以当前目录启动普通交互。"
      : `${current.sourceRoot}${current.baselineCommit ? "" : "（尚无提交；普通交互可用）"}` });
  } catch (error) {
    checks.push({ name: "repository", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  try {
    const services = await createAgentSessionServices({
      cwd: workspace,
      agentDir: agentDirectory,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true
      }
    });
    const config = readModelConfig();
    await configureModelRuntime(services.modelRuntime, config);
    const selectedModel = configuredModel(services.modelRuntime, config);
    const available = services.modelRuntime.getAvailableSnapshot();
    checks.push({
      name: "model",
      ok: available.length > 0,
      detail: available.length > 0
        ? `${available.length} configured model(s); ${selectedModel ? `selected: ${selectedModel.provider}/${selectedModel.id}` : "default selection is resolved at session start"}`
        : "No configured model. Start pi-agent-tui interactively and use /login first."
    });
    for (const diagnostic of services.diagnostics) {
      checks.push({ name: `pi-${diagnostic.type}`, ok: diagnostic.type !== "error", detail: diagnostic.message });
    }
  } catch (error) {
    checks.push({ name: "pi-runtime", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  return checks.map((check) => ({ ...check, detail: redactSensitiveText(check.detail) }));
}
