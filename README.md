# Pi TUI Coding Agent

一个建立在 [Pi coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 之上的终端编程代理。它保留 Pi 的模型、会话和工具事件能力，增加了任务边界、Git worktree、可重复验证和运行报告。

## 能做什么

- 在终端里流式显示模型回复、推理状态和并行工具调用。
- 从自然语言或 YAML/JSON `TaskSpec` 接收任务。
- 默认从干净的源仓库创建独立 Git worktree 和 `agent/*` 分支。
- 用 `allowedPaths` 限制写入范围，并保护 `.git`、`.env*` 和 `node_modules`。
- 在每轮模型执行后运行确定性的验证命令。
- 把任务、变更文件、验证输出和模型/会话信息写入 JSON 与 Markdown 报告。
- 继续 Pi 会话，或使用不落盘的临时会话。

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

默认要求源仓库没有未提交变更，然后创建托管 worktree。只有在明确接受直接修改当前检出目录时才使用 `--in-place`。

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

## TUI 命令

| 命令 | 作用 |
| --- | --- |
| `/task <目标>` | 修改当前任务目标 |
| `/allow <glob>` | 增加允许变更的路径 |
| `/verify-add <命令>` | 增加验证命令 |
| `/run` | 执行当前任务目标 |
| `/verify` | 仅运行验证器 |
| `/diff` | 查看变更文件和 diff 统计 |
| `/status` | 查看任务、模型、会话与用量 |
| `/abort` 或 `Esc` | 中止当前模型轮次 |
| `/clear` | 清空当前屏幕中的对话记录 |
| `/quit` | 安全退出 |

`Ctrl+C` 在运行中会中止当前轮次；空闲时会退出。

## 数据位置

会话由 Pi 管理。本项目生成的 worktree 和报告默认保存在：

- Windows：`%LOCALAPPDATA%\pi-tui-coding-agent`
- macOS：`~/Library/Application Support/pi-tui-coding-agent`
- Linux：`$XDG_DATA_HOME/pi-tui-coding-agent`，未设置时为 `~/.local/share/pi-tui-coding-agent`

可用 `PI_TUI_AGENT_DATA_DIR` 改写该目录。

## 安全边界

托管 worktree、路径白名单和命令拦截属于降低误操作风险的护栏，不是强隔离沙箱。Shell 进程仍以当前用户权限运行，无法可靠抵御恶意提示、恶意仓库内容或蓄意绕过。

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
- `src/workspace/git.ts`：Git worktree 生命周期。
- `src/verifier/verifier.ts`：确定性验证。
- `src/report/report.ts`：运行证据报告。

## License

MIT
