import { describe, expect, it, vi, beforeEach } from "vitest";
import { createApprovalGatedShellOperations } from "../src/policy/safe-tools.js";
import { startTaskContainer, stopTaskContainer, containerShell } from "../src/benchmark/swe-container.js";
import { docker } from "../src/benchmark/swe-process.js";

vi.mock("../src/benchmark/swe-process.js", () => ({ docker: vi.fn(() => Promise.resolve({ code: 0, stdout: "", stderr: "" })) }));
beforeEach(() => { vi.mocked(docker).mockReset(); vi.mocked(docker).mockResolvedValue({ code: 0, stdout: "", stderr: "" }); });
describe("SWE 容器边界", () => {
  it("不挂载宿主、不联网，开始前恢复源提交并移除未来历史", async () => {
    const name = await startTaskContainer({ instance_id: "django__django-123", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "fix" }, "sha256:abc");
    const args = vi.mocked(docker).mock.calls[0]![0];
    expect(args).toContain("none");
    expect(args).not.toContain("--mount");
    expect(args).not.toContain("-v");
    expect(vi.mocked(docker).mock.calls[1]![0].at(-1)).toContain(`git reset --hard ${"a".repeat(40)}`);
    expect(vi.mocked(docker).mock.calls[1]![0].at(-1)).toContain("rm -rf .git");
    await stopTaskContainer(name);
    await expect(stopTaskContainer("unrelated-container")).rejects.toThrow();
  });
  it("危险命令在容器调用前拒绝；普通命令被限制为120秒且不传凭据环境", async () => {
    const operations = createApprovalGatedShellOperations(containerShell("picode-swe-test"), () => Promise.resolve(false));
    await expect(operations.exec("git push origin main", "/testbed", { onData: () => undefined })).rejects.toThrow();
    expect(docker).not.toHaveBeenCalled();
    await operations.exec("python --version", "/host", { timeout: 9999, env: { SECRET: "never-forward" }, onData: () => undefined });
    const args = vi.mocked(docker).mock.calls[0]![0];
    expect(args.slice(-2)).toEqual(["120", "python --version"]);
    expect(args.join(" ")).not.toContain("never-forward");
  });
  it("setup失败仍清理本次创建的容器", async () => {
    vi.mocked(docker).mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }).mockRejectedValueOnce(new Error("bad baseline"));
    await expect(startTaskContainer({ instance_id: "django__django-123", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "fix" }, "image")).rejects.toThrow("bad baseline");
    expect(vi.mocked(docker).mock.calls[2]![0].slice(0, 2)).toEqual(["rm", "-f"]);
  });
});
