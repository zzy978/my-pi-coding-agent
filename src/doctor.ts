import { access } from "node:fs/promises";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { isSupportedNodeVersion, minimumNodeVersionText } from "./config.js";
import { runProcess } from "./runtime/process.js";
import { resolveGitRoot } from "./workspace/git.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(workspace: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "node",
    ok: isSupportedNodeVersion(),
    detail: `${process.versions.node} (required >= ${minimumNodeVersionText()})`
  });

  try {
    await access(workspace);
    checks.push({ name: "workspace", ok: true, detail: workspace });
  } catch {
    checks.push({ name: "workspace", ok: false, detail: `Not accessible: ${workspace}` });
    return checks;
  }

  try {
    const git = await runProcess("git", ["--version"], { cwd: workspace, timeoutMs: 10_000 });
    checks.push({ name: "git", ok: git.exitCode === 0, detail: (git.stdout || git.stderr).trim() });
  } catch (error) {
    checks.push({ name: "git", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  try {
    const root = await resolveGitRoot(workspace);
    checks.push({ name: "repository", ok: true, detail: root });
  } catch (error) {
    checks.push({ name: "repository", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  try {
    const services = await createAgentSessionServices({
      cwd: workspace,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true
      }
    });
    const available = services.modelRuntime.getAvailableSnapshot();
    checks.push({
      name: "model",
      ok: available.length > 0,
      detail: available.length > 0
        ? `${available.length} configured model(s); default selection is resolved at session start`
        : "No configured model. Run pi and use /login first."
    });
    for (const diagnostic of services.diagnostics) {
      checks.push({ name: `pi-${diagnostic.type}`, ok: diagnostic.type !== "error", detail: diagnostic.message });
    }
  } catch (error) {
    checks.push({ name: "pi-runtime", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  return checks;
}
