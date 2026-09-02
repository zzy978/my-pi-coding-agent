# Pi TUI Coding Agent

一个建立在 [Pi coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 之上的终端编程代理。交互模式直接复用 Pi 的完整 TUI、模型、会话、资源和工具能力，同时增加任务边界、可重复验证、运行报告与评测回放。

## 能做什么

- 使用 Pi 官方完整交互界面，包括模型与登录管理、会话树、分叉、压缩、导入导出、分享、设置、主题和快捷键。
- 自动发现 Pi Extensions、Skills、Prompt Templates、Themes 和项目上下文文件，并支持 `/reload`。
- 从自然语言或 YAML/JSON `TaskSpec` 接收任务。
- 直接在当前 Git 检出目录中执行交互任务，不额外创建 worktree 或分支。
- 对 `write`/`edit` 文件工具强制执行 `allowedPaths`，并在验证后审计全部 Git 变更；`.git`、`.env*` 和 `node_modules` 始终禁止写入。
- 在每轮模型执行后运行确定性的验证命令。
- 把任务、变更文件、验证输出和模型/会话信息写入 JSON 与 Markdown 报告。
- 在 TUI 内新建持久会话、切换同一源仓库的已记录历史会话，或使用不落盘的临时会话。
- 提供 `read`、`grep`、`find`、`ls`、`edit`、`write` 和 Shell 全套编码工具；识别到删除或丢弃工作区内容的 Shell 命令时，在进程启动前要求人工单次审批，也可用 `--no-shell` 完全关闭 Shell。

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

Shell 默认启用；如当前仓库或任务不受信任，请添加 `--no-shell` 完全关闭。交互式 TUI 会在执行已识别的删除命令（例如 `rm`、`Remove-Item`、`git clean`）前显示命令并要求单次审批，默认选项为拒绝；没有交互界面的 record/replay 会直接拒绝这类命令。提权、系统级操作和 Git 历史写入仍会被永久拦截。

审批是命令策略闸门，不是操作系统沙箱。任意解释器、项目脚本或自定义程序都可能隐藏删除副作用，因此 `allowedPaths` 仍不是 Shell 的强制边界；最终 Git 审计只能发现仓库内副作用，无法撤销它们或发现仓库外写入。对不受信任的仓库或任务，应在限制文件系统、网络和凭据的容器或虚拟机中运行。

Agent 的自然语言回复跟随当前用户消息的主要语言：中文提问默认中文回复，英文提问默认英文回复；消息中明确指定的输出语言优先。代码、命令、路径和标识符不会被当作语言判断依据。

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

`--replay` 从原 manifest 固定的 Git commit 创建另一个全新 worktree，并恢复 TaskSpec、verifier、模型、thinking level 和工具策略。回放沿用原运行是否启用 Shell 的记录，不会因为当前默认值而升级或降低工具权限；显式且冲突的 `--no-shell`/兼容参数 `--unsafe-shell` 会被拒绝。为了保持可比性，受控 record/replay 不加载当前机器上可能随时间变化的 Extension、Skill、Prompt Template 和 Theme；完整资源发现只用于交互模式。

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

交互模式支持 Pi 自带的完整命令集，包括 `/login`、`/logout`、`/model`、`/settings`、`/resume`、`/new`、`/name`、`/session`、`/tree`、`/fork`、`/clone`、`/compact`、`/copy`、`/export`、`/import`、`/share`、`/reload`、`/hotkeys` 和 `/quit`。此外，本项目注册以下宿主命令：

| 命令 | 作用 |
| --- | --- |
| `/task <目标>` | 修改当前任务目标 |
| `/allow <glob>` | 增加允许变更的路径 |
| `/verify-add <命令>` | 增加验证命令 |
| `/run` | 执行当前任务目标 |
| `/temp` | 新建关闭后自动删除的临时会话 |
| `/sessions` | 打开选择器并切换会话（Switch session） |
| `/sessions <session-id>` | 按完整 ID 或唯一 ID 前缀切换会话 |
| `/verify` | 仅运行验证器 |
| `/diff` | 查看变更文件和 diff 统计 |
| `/status` | 查看宿主任务、工作区、模型与会话；用量使用 Pi 的 `/session` 查看 |

Pi 自带的 `Esc`、`Ctrl+C`、队列、模型切换和完整快捷键行为保持不变；使用 `/hotkeys` 查看当前配置。

## 数据位置

会话内容仍使用 Pi 的 JSONL 格式；本项目按源仓库路径建立稳定的会话目录，并原子记录 session ID，使尚未产生首条模型回复的空会话也可被发现。已物化会话的内容和 ID 仍以 JSONL 为事实源；同一持久会话同时被另一个进程占用时会拒绝打开，避免并发追加损坏上下文。会话、受控运行使用的临时 worktree 和报告默认保存在：

- Windows：`%LOCALAPPDATA%\pi-tui-coding-agent`
- macOS：`~/Library/Application Support/pi-tui-coding-agent`
- Linux：`$XDG_DATA_HOME/pi-tui-coding-agent`，未设置时为 `~/.local/share/pi-tui-coding-agent`

可用 `PI_TUI_AGENT_DATA_DIR` 改写该目录。

## 安全边界

路径白名单、命令拦截和 Git 变更审计属于降低误操作风险的护栏，不是自动回滚机制或强隔离沙箱。Git 不会自动保护未提交改动和未跟踪文件；Shell 进程仍以当前用户权限运行，无法可靠抵御恶意提示、恶意仓库内容或蓄意绕过。交互模式加载的 Pi Extension 是可执行 JavaScript/TypeScript，可以直接使用当前进程权限而不经过工具策略；只应加载你信任的全局或项目 Extension。

处理不受信任的仓库或需要更强保证时，应在容器或虚拟机中运行，并限制网络、凭据挂载、CPU、内存、进程数和可写目录。不要把生产密钥放入代理进程环境。

## 开发与验证

```bash
npm run check
npm test
npm run lint
npm run build
```

代码入口：

- `src/runtime/pi-interactive.ts`：Pi 完整交互运行时与官方 TUI 装配。
- `src/runtime/interactive-host-extension.ts`：TaskSpec、验证、报告和项目会话命令。
- `src/runtime/pi-runtime.ts`：record/replay 使用的受控无界面运行时。
- `src/policy/`：路径和命令护栏。
- `src/workspace/git.ts`：当前检出目录解析，以及受控记录/回放使用的 worktree 生命周期。
- `src/verifier/verifier.ts`：确定性验证。
- `src/report/report.ts`：运行证据报告。
- `src/evaluation/`：受控运行、manifest、Trace、回放与对比。

## License

MIT
