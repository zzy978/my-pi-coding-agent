# Pi TUI Coding Agent

一个建立在 [Pi coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 之上的终端编程代理。它保留 Pi 的模型、会话和工具事件能力，增加了任务边界、可重复验证和运行报告。

## 能做什么

- 在终端里流式显示模型回复、推理状态和并行工具调用。
- 从自然语言或 YAML/JSON `TaskSpec` 接收任务。
- 直接在当前 Git 检出目录中执行交互任务，不额外创建 worktree 或分支。
- 对 `write`/`edit` 文件工具强制执行 `allowedPaths`，并在验证后审计全部 Git 变更；`.git`、`.env*` 和 `node_modules` 始终禁止写入。
- 在每轮模型执行后运行确定性的验证命令。
- 把任务、变更文件、验证输出和模型/会话信息写入 JSON 与 Markdown 报告。
- 在 TUI 内新建持久会话、切换同一源仓库的已记录历史会话，或使用不落盘的临时会话。

## 环境要求

- Node.js 22.19.0 或更高版本，推荐 Node.js 24 LTS。
- Git。
- 至少一个已在 Pi 中配置的模型。

先安装并登录 Pi：

```bash
npx @earendil-works/pi-coding-agent
```

在 Pi 中执行 `/login`，完成模型提供商认证。

## 安装与运行

```bash
npm install
npm run build
npm link
pi-agent-tui --doctor /path/to/repository
pi-agent-tui /path/to/repository
```

直接开发运行：

```bash
npm run dev -- /path/to/repository
```

Windows PowerShell 示例：

```powershell
npm run dev -- D:\projects\my-repo --task "修复解析器并补充回归测试" --verify "npm test"
```

交互式 TUI 直接在指定仓库的当前检出目录中工作，允许保留已有的未提交变更，不会创建 `agent/*` 分支或额外 worktree。持久会话按仓库根目录归组，因此 `--continue` 和 TUI 内的 `/sessions` 会在同一个当前检出目录中恢复对话上下文。

会话恢复只恢复模型的对话上下文，并继续在当前检出目录中工作；它不会自动切换到会话曾使用的旧分支，也不会还原当时尚未提交的文件状态。

交互式 TUI 不会自动重复安装依赖。确有需要时，可使用可重复的 `--setup "<命令>"` 在启动 Agent 前显式执行初始化，或用 `--no-setup` 禁止 setup。显式 setup 直接在当前检出目录执行，因此只应运行你理解并信任的命令。

显式 `--setup "npm ci"` 会访问包源并执行仓库定义的 lifecycle scripts，只适用于你信任的仓库；不受信任的仓库应避免执行 setup，并放入限制网络和凭据的容器或虚拟机。

通用 Shell 默认关闭，因为它能以当前用户权限绕过文件路径策略。只有对仓库和任务输入都充分信任时才显式添加 `--unsafe-shell`。即使启用，`allowedPaths` 也不会成为 Shell 的强制边界；最终 Git 审计只能发现仓库内副作用，无法撤销它们或发现仓库外写入。

Agent 的自然语言回复跟随当前用户 message 的主要语言：中文提问默认中文回复，英文提问默认英文回复；message 中明确指定的输出语言优先。代码、命令、路径和标识符不会被当作语言判断依据。

## 任务规范

可以直接指定任务：

```bash
pi-agent-tui . --task "实现健康检查命令" --allow "src/**" --allow "test/**" --verify "npm test"
```

复杂任务推荐使用文件：

```bash
pi-agent-tui . --task-file examples/task.yaml
```

```yaml
id: add-health-command
objective: Add a health-check command and document how to use it.
allowedPaths:
  - src/**
  - test/**
verify:
  - command: npm test
    timeoutMs: 120000
doneWhen:
  - Tests cover passing and failing behavior
  - All configured verification commands pass
```

没有配置验证命令时，运行结果会被标记为“不完整”，不会被当作成功。

## 可复现评测与回放

受控运行是一次性的 `prompt → verifier → evidence` 流程。它始终从干净源仓库创建新的受管 worktree，不进入交互式 TUI：

```bash
pi-agent-tui /path/to/repository --record --task-file examples/task.yaml --no-session
pi-agent-tui --list-runs
pi-agent-tui --show-run <runId>
pi-agent-tui --replay <runId>
```

`--replay` 从原 manifest 固定的 Git commit 创建另一个全新 worktree，并恢复 TaskSpec、verifier、模型、thinking level 和工具策略。若原运行使用了 `--unsafe-shell`，回放必须再次显式授权；未使用 Shell 的运行不能在回放时升级权限。

每次运行在数据目录的 `runs/<runId>/` 下生成：

```text
manifest.json       固定基线、任务、模型、策略和上下文哈希
trace.jsonl         脱敏后的可观察事件与执行摘要
verification.json  verifier 和路径审计证据
result.json         状态、改动、耗时、Token 与成本
report.json/.md     机器和人工可读的运行报告
comparison.json/.md（回放）原始运行与回放的对比报告
```

`verification_passed` 表示新运行独立通过 verifier 和路径审计，不表示模型文本或工具顺序逐字一致。可用 `--list-runs --json` 或 `--show-run <runId> --json` 获取机器可读输出。

## TUI 命令

| 命令 | 作用 |
| --- | --- |
| `/task <目标>` | 修改当前任务目标 |
| `/allow <glob>` | 增加允许变更的路径 |
| `/verify-add <命令>` | 增加验证命令 |
| `/run` | 执行当前任务目标 |
| `/new` | 新建持久会话（New session） |
| `/temp` | 新建不落盘的临时会话（Temporary session） |
| `/sessions` | 打开选择器并切换会话（Switch session） |
| `/sessions <session-id>` | 按完整 ID 或唯一 ID 前缀切换会话 |
| `/verify` | 仅运行验证器 |
| `/diff` | 查看变更文件和 diff 统计 |
| `/status` | 查看任务、模型、会话与用量 |
| `/abort` 或 `Esc` | 中止当前模型轮次 |
| `/clear` | 清空当前屏幕中的对话记录 |
| `/quit` | 安全退出 |

`Ctrl+C` 在运行中会中止当前轮次；空闲时会退出。

## 数据位置

会话内容仍使用 Pi 的 JSONL 格式；本项目按源仓库路径建立稳定的会话目录，并原子记录 session ID，使尚未产生首条模型回复的空会话也可被发现。已物化会话的内容和 ID 仍以 JSONL 为事实源；同一持久会话同时被另一个进程占用时会拒绝打开，避免并发追加损坏上下文。会话、受控运行使用的临时 worktree 和报告默认保存在：

- Windows：`%LOCALAPPDATA%\pi-tui-coding-agent`
- macOS：`~/Library/Application Support/pi-tui-coding-agent`
- Linux：`$XDG_DATA_HOME/pi-tui-coding-agent`，未设置时为 `~/.local/share/pi-tui-coding-agent`

可用 `PI_TUI_AGENT_DATA_DIR` 改写该目录。

## 安全边界

路径白名单、命令拦截和 Git 变更审计属于降低误操作风险的护栏，不是自动回滚机制或强隔离沙箱。Git 不会自动保护未提交改动和未跟踪文件；Shell 进程仍以当前用户权限运行，无法可靠抵御恶意提示、恶意仓库内容或蓄意绕过。

处理不受信任的仓库或需要更强保证时，应在容器或虚拟机中运行，并限制网络、凭据挂载、CPU、内存、进程数和可写目录。不要把生产密钥放入代理进程环境。

## 开发与验证

```bash
npm run check
npm test
npm run lint
npm run build
```

代码入口：

- `src/runtime/pi-runtime.ts`：Pi 会话和扩展装配。
- `src/tui/app.ts`：终端界面与事件渲染。
- `src/policy/`：路径和命令护栏。
- `src/workspace/git.ts`：当前检出目录解析，以及受控记录/回放使用的 worktree 生命周期。
- `src/verifier/verifier.ts`：确定性验证。
- `src/report/report.ts`：运行证据报告。
- `src/evaluation/`：受控运行、manifest、Trace、回放与对比。

## License

MIT
