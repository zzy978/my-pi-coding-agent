import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { currentBranch, resolveCommit, resolveGitRoot, WorkspaceError, type WorkspaceInfo } from "./git.js";

/** 交互工作区只要求目录存在，Git 信息是可选能力，不创建或修改仓库。 */
export async function prepareCurrentWorkspace(sourcePath: string): Promise<WorkspaceInfo> {
  const workspace = resolve(sourcePath);
  if (!(await stat(workspace)).isDirectory()) throw new WorkspaceError(`Workspace is not a directory: ${workspace}`);
  let sourceRoot: string;
  try {
    sourceRoot = await resolveGitRoot(workspace);
  } catch {
    return { sourceRoot: workspace, workspace, branch: "Git 不可用", managedWorktree: false, baselineCommit: "", gitUnavailable: true };
  }
  const branch = await currentBranch(sourceRoot);
  // 尚无提交时不伪造基线；固定提交仍由受控运行的 prepareWorkspace 强制要求。
  const baselineCommit = await resolveCommit(sourceRoot).catch(() => "");
  return { sourceRoot, workspace, branch, managedWorktree: false, baselineCommit };
}
