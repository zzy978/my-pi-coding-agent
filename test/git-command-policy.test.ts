import { describe, expect, it } from "vitest";
import { checkCommand } from "../src/policy/command-policy.js";

describe("Git 标签查询与写入边界", () => {
  it.each([
    "git tag", "git tag -l", "git tag --list 'v*'", "git tag | tail -5",
    "git -C /testbed tag --list", 'git -C "repo with spaces" tag -l "v*"',
    "git.exe tag --list", '"C:\\Program Files\\Git\\cmd\\git.exe" tag --list',
    "& 'C:\\Program Files\\Git\\cmd\\git.exe' tag --list",
    "git --no-pager tag --list", "cd /testbed && git log --all --oneline | head -20 && git tag | tail -5",
    "cd /testbed && git branch -a && git tag | tail && git log --all --oneline | head && git reflog | head && ls .git/refs/remotes 2>/dev/null; git remote -v"
  ])("允许确定的标签查询：%s", (command) => {
    expect(checkCommand(command)).toEqual({ allowed: true });
  });

  it.each([
    "git tag v1.0", "git tag -d v1.0", "git tag --delete v1.0", "git tag -f v1.0",
    "git tag -a v1.0 -m release", "git tag -s v1.0", "git tag --list --delete v1.0",
    "git tag -ld v1.0", "git tag --unknown", "git tag $ARGS", "git tag --list $(git tag -d v1.0)",
    "git.exe tag -d v1.0", "git -C /testbed tag -f v1.0", "git -C /testbed tag v1.0",
    'git -c alias.x=push tag --list', "git tag --list && git tag v1.0",
    "git tag --list; git push", "git tag | git commit -am done",
    "bash -lc 'git tag -d v1.0'", "git 'tag' -d v1.0", "git tag --list > .git/refs/tags/out",
    "git tag --list \\; git 'tag' v1.0",
    "git tag --list; git -C repo push", "git tag --list; git.exe push",
    "git tag --list; git --no-pager -C repo commit -am done",
    "git tag --list; & 'C:\\Program Files\\Git\\cmd\\git.exe' rebase HEAD~1",
    "git tag --list; git -c advice.detachedHead=false checkout source.py",
    String.raw`git tag --list; Write-Output "\"; git 'push'; #"`,
    'git tag --list; echo "$(git \'push\')"'
  ])("拒绝写入或不能确认安全的组合，并允许代理改用合法操作：%s", (command) => {
    expect(checkCommand(command)).toMatchObject({ allowed: false, onDeny: "continue", ruleId: "git-history" });
  });

  it.each(["git tag --list && sudo whoami", "git tag v1.0; sudo whoami", "git push && format D:"])("高风险规则优先：%s", (command) => {
    expect(checkCommand(command)).toMatchObject({ allowed: false, onDeny: "stop" });
  });

  it.each([
    "git tag --list && rm -rf build", "git -C repo tag --list && git -C repo checkout source.py",
    "git tag --list; git.exe restore source.py", "git tag --list; git -C repo reset --hard",
    "git tag --list; git -C repo clean -fd", "git tag --list; git.exe clean --force",
    "git tag --list; git.exe rm source.py", "git tag --list; git -C repo switch main"
  ])("查询不能屏蔽其他命令的审批：%s", (command) => {
    expect(checkCommand(command)).toMatchObject({ allowed: true, requiresApproval: true });
  });
});
