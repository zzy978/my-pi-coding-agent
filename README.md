# Pi TUI Coding Agent

一个建立在 [Pi coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 之上的终端编程代理。交互模式直接复用 Pi 的完整 TUI、模型、会话、资源和工具能力，同时增加任务边界、可重复验证、运行报告与评测回放。

## 能做什么

- 使用 Pi 官方完整交互界面，包括模型与登录管理、会话树、分叉、压缩、导入导出、分享、设置、主题和快捷键。
- 自动发现 Pi Extensions、Skills、Prompt Templates、Themes 和项目上下文文件，并支持 `/reload`。
- 从自然语言或 YAML/JSON `TaskSpec` 接收任务。
- 直接在当前 Git 检出目录中执行交互任务，不额外创建 worktree 或分支。
- 文件工具支持绝对路径、`../` 和跨目录符号链接，不再限制在启动目录，也不执行 `allowedPaths` 白名单；`.git`、`.env*` 和 `node_modules` 仍禁止写入。
- 在每轮模型执行后运行确定性的验证命令。
- 把任务、变更文件、验证输出和模型/会话信息写入 JSON 与 Markdown 报告。
- 在 TUI 内新建持久会话、切换同一源仓库的已记录历史会话，或使用不落盘的临时会话。
- 从失败评测提炼有证据引用的经验与 prompt/skill/strategy 候选；新鲜配对实验验证后，经人工晋升在 TUI 按需启用，并可撤销。
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

审批是命令策略闸门，不是操作系统沙箱。任意解释器、项目脚本或自定义程序都可能隐藏删除副作用，文件路径白名单已取消；最终 Git 审计只能发现仓库内副作用，无法撤销它们或发现仓库外写入。对不受信任的仓库或任务，应在限制文件系统、网络和凭据的容器或虚拟机中运行。

Agent 的自然语言回复跟随当前用户消息的主要语言：中文提问默认中文回复，英文提问默认英文回复；消息中明确指定的输出语言优先。代码、命令、路径和标识符不会被当作语言判断依据。

## 任务规范

可以直接指定任务：

```bash
pi-agent-tui . --task "实现健康检查命令" --verify "npm test"
```

复杂任务推荐使用文件：

```bash
pi-agent-tui . --task-file examples/task.yaml
```

```yaml
id: add-health-command
objective: Add a health-check command and document how to use it.
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

## 失败经验与候选实验

没有现成评测任务时，可接入 Exercism JavaScript 的全部 9 道官方困难题（8–9 分）：

```powershell
npm run benchmark:exercism -- D:\exercism-js-hard-v1
```

目标目录必须尚不存在。工具准备独立 Git 题库、锁定依赖、逐题 TaskSpec，并实际校验骨架失败和参考实现全通过；所有跳过测试启用，参考答案不进入题库或 Git 历史。此步骤不调用模型。已有题库无需重复准备；真实 record、经验分析与配对实验见[困难题库使用指南](docs/exercism-hard-benchmark.md)。

此功能把“失败记录 → 经验候选 → 新鲜对照实验 → 人工晋升 → 按需使用”串成闭环。候选是指导文本，不会自动改写程序、安装全局 Skill，或改变工具权限与验证器。Skill 候选是过程性 Markdown，不是可执行插件。

经验生成结果保留统一 JSON 结构，候选的 `content` 正文使用 Markdown。输入兼容纯 JSON，以及包住整个响应的三反引号代码围栏（`json` 标签，不区分大小写，或不带语言标签）。围栏之外不能附加解释，也不接受多个响应块、YAML 或自由文本；解包后仍严格校验字段、证据引用、内容长度和敏感信息。此兼容只处理外层包装，不修复损坏或截断的 JSON。已有失败记录不会自动重写，需要重新执行 `--analyze-run` 生成新记录。

先选一个**配置了验证器**的失败 run，再提炼：

```powershell
pi-agent-tui --list-runs
pi-agent-tui --analyze-run RUN_ID
pi-agent-tui --list-experiences
pi-agent-tui --show-experience EXPERIENCE_ID
```

将示例中的大写 ID 替换为实际 ID。分析会区分程序判定的失败事实与模型提出的原因假设，保存证据引用、适用条件、不适用条件、候选哈希和生成成本。模型生成使用来源 run 的模型配置，但以独立、无工具的请求运行；只发送有上限的脱敏评测证据，不读取原生会话内容。模型不可用、超时或返回格式不合格时保留观察记录，生成状态为 `failed`，不会伪造候选。

没有验证器、运行不完整或 setup 失败时不会生成编码策略；成功运行会被忽略。没有验证器的旧 run 应重新录制并添加 `--verify`，直接重放不会补出缺失的验证标准。历史 trace 缺少错误细节时，系统只报告证据限制，不猜测未记录的代码过程。

查看候选后，先做小规模探索，或使用默认 3 对实验：

```powershell
pi-agent-tui --experiment SOURCE_RUN_ID --candidate CANDIDATE_ID --pairs 1
pi-agent-tui --experiment SOURCE_RUN_ID --candidate CANDIDATE_ID
pi-agent-tui --list-experiments
pi-agent-tui --show-experiment EXPERIMENT_ID --json
```

默认 3 对意味着最多 **6 次新的模型任务**，每个任务可能包含多次 API 请求并产生费用；历史 run 不充当对照。两臂在不同新 worktree 上交替执行，使用内存会话，并锁定来源任务、Git 提交、模型、思考级别、工具、setup、验证器和上下文哈希。treatment 只增加冻结候选文本。源仓库需保持干净；实验 worktree 在结束后清理，运行证据保留。`Ctrl+C` 请求中止，已完成的证据仍会保存。

实验的模型阶段默认 15 分钟超时。已经启动的 setup/verifier 命令仍按来源配置的命令超时结束，不会被 `Ctrl+C` 立即终止；收到中止请求的实验不能用于晋升。

`observed_improvement` / `no_observed_gain` / `observed_regression` 表示配对中观察到的结果；不完整运行、证据不足与配置不一致分别归入 `inconclusive` 或 `invalid_isolation`。少量配对不能证明统计显著性或跨任务普遍收益。

普通 record/replay 不加载候选。实验运行的 v2 manifest 额外冻结候选文本、渲染版本与有效 prompt 哈希；对其 `--replay TRIAL_RUN_ID` 会恢复同一候选。旧 v1 运行仍可读取和回放。

### 晋升、使用与撤销

晋升要求同一候选在同一仓库的至少两个不同任务上完成实验，其中至少一个不是经验来源任务；每项证据至少 3 对完整运行，至少一项观察到改善，且不能含退化、越界或隔离失败。仅修改任务 ID 不算新任务。程序门槛不能替代人工阅读候选与确认适用性。

```powershell
pi-agent-tui --experiment HOLDOUT_RUN_ID --candidate CANDIDATE_ID
pi-agent-tui --promote-candidate CANDIDATE_ID --evidence EXPERIMENT_ID_1 --evidence EXPERIMENT_ID_2 --approve
pi-agent-tui D:\projects\my-repo --list-promotions
```

`--approve` 是明确的人工晋升/撤销确认，不是自动优化开关。晋升绑定仓库、候选哈希和实验证据，日常会话仍默认关闭；进入该仓库 TUI 后选择：

固定验证命令不代表测试文件不可修改：当前文件工具不限制测试文件写入，仍可能出现“改测试而不是修实现”的假改善。晋升前应审查各臂变更，并尽可能使用不能被任务改写的外部验证器或留出检查；本功能不提供防作弊沙箱。

```text
/experience list
/experience use CANDIDATE_ID
/experience off
```

每轮重新检查晋升与证据；候选变更、撤销、记录损坏或读取失败会停止注入，会话切换也会清空选择。TUI 把候选作为单独的用户级补充消息；实验使用任务提示末尾补充，两者的会话历史和消息布局不同，因此不能直接把实验提升视为日常 TUI 的同等提升。

```powershell
pi-agent-tui --revoke-candidate CANDIDATE_ID --approve
```

撤销保留审计历史，即使原候选或来源 run 已丢失，也可依据有效晋升日志撤销。停止注入不会抹掉旧会话中已有的指导文本，需要干净上下文时请新建会话。经验、实验和晋升文件不可手工改写；修改候选应产生新版本并重新评估。日志 head 或证据哈希不匹配时拒绝启用，不自动退回旧晋升状态。

## TUI 命令

交互模式支持 Pi 自带的完整命令集，包括 `/login`、`/logout`、`/model`、`/settings`、`/resume`、`/new`、`/name`、`/session`、`/tree`、`/fork`、`/clone`、`/compact`、`/copy`、`/export`、`/import`、`/share`、`/reload`、`/hotkeys` 和 `/quit`。此外，本项目注册以下宿主命令：

| 命令 | 作用 |
| --- | --- |
| `/task <目标>` | 修改当前任务目标 |
| `/allow <glob>` | 旧命令兼容入口；提示路径限制已取消，无需再配置 |
| `/verify-add <命令>` | 增加验证命令 |
| `/run` | 执行当前任务目标 |
| `/temp` | 新建关闭后自动删除的临时会话 |
| `/sessions` | 打开选择器并切换会话（Switch session） |
| `/sessions <session-id>` | 按完整 ID 或唯一 ID 前缀切换会话 |
| `/verify` | 仅运行验证器 |
| `/diff` | 查看变更文件和 diff 统计 |
| `/status` | 查看宿主任务、工作区、模型与会话；用量使用 Pi 的 `/session` 查看 |
| `/experience [list \| use <ID> \| off]` | 列出、选择或停用本仓库已晋升的经验候选 |

Pi 自带的 `Esc`、`Ctrl+C`、队列、模型切换和完整快捷键行为保持不变；使用 `/hotkeys` 查看当前配置。

## 数据位置

会话内容仍使用 Pi 的 JSONL 格式；本项目按源仓库路径建立稳定的会话目录，并原子记录 session ID，使尚未产生首条模型回复的空会话也可被发现。已物化会话的内容和 ID 仍以 JSONL 为事实源；同一持久会话同时被另一个进程占用时会拒绝打开，避免并发追加损坏上下文。

所有应用运行期数据默认集中在项目根目录的 `.picoding/` 中：

```text
.picoding/
├── runs/       受控评测、回放及其证据
├── experiences/ 失败观察、经验卡和不可变候选
├── experiments/ 新鲜配对实验、各臂引用及成本对比
├── promotions/ 人工晋升、撤销历史与完整性 head
├── worktree/   受控运行创建的 Git 工作树
├── sessions/   按源仓库隔离的持久会话
├── reports/    交互模式的验证报告
├── temp/       `/temp` 使用并在关闭后清理的临时会话
└── agent/      Pi 认证、模型设置和全局资源
```

在本仓库中默认根目录是 `D:\Agent\.picoding`。可用 `PI_TUI_AGENT_DATA_DIR` 改写整个数据根目录；各分类目录仍保持上述结构。`.picoding/` 已被 Git 忽略，其中的 `agent/auth.json` 可能包含凭据，不应提交或分享。

数据根及托管分类目录必须是普通目录，不接受这些目录自身为 symlink/junction；需要迁移数据时将覆盖项指向实际目录。哈希用于发现文件损坏和版本变化，不抵御能够同时改写数据与哈希的本机管理员。

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
- `src/runtime/controlled-pi-runtime.ts`：record/replay 使用的受控无界面运行时。
- `src/policy/`：路径和命令护栏。
- `src/workspace/git.ts`：当前检出目录解析，以及受控记录/回放使用的 worktree 生命周期。
- `src/verifier/verifier.ts`：确定性验证。
- `src/report/report.ts`：运行证据报告。
- `src/evaluation/`：受控运行、manifest、Trace、回放与对比。
- `src/experience/`：失败分类、证据提炼、候选生成与人工晋升。
- `src/experiment/`：配对运行、配置隔离检查与结果比较。

## License

MIT

### 路径策略兼容性

`allowedPaths`（含 `allowed_paths`）和 CLI `--allow` 仅兼容旧输入，不再限制工具或验证结果；新任务无需配置。启动目录仍用于解析相对路径、执行默认命令和保存仓库会话，但不再是访问边界。Git 变更报告只覆盖启动仓库，目录外修改不会自动被列入报告。

普通交互、record/replay 和配对实验均使用此策略。受管 worktree 只提供独立检出，不保证目录外副作用隔离。策略版本已提升为 2；旧策略运行不能作为新策略配对实验的同配置来源，应重新记录运行。回放旧记录会标记策略版本差异，不能当成等价复现。删除审批、敏感文件保护和系统命令限制仍然有效。

### 命令拦截诊断

被拒绝的 Shell 调用返回规则 ID、拒绝原因和脱敏命令预览；受控运行在 `trace.jsonl` 的 `tool_end.data.policyFailure` 保存这些信息，通过同一条记录的 `toolCallId` 关联调用。预览最长约 1200 字符，凭据与终端控制字符经过处理；涉及环境变量枚举或 `.env` 的命令整体隐藏。普通命令正文和工具输出仍不记录。脱敏为尽力识别，不能保证识别任意自定义秘密格式。

`format` 按调用位置识别，普通路径（如 `tests/format/`）和源码变量不再触发磁盘格式化拒绝。识别覆盖直接调用和常见 Shell/进程包装，不是完整解释器或沙箱。此变更将运行策略版本提升为 3；旧策略实验不能视为同配置结果。
