# Pi TUI Coding Agent

一个建立在 [Pi coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 之上的终端编程代理。交互模式直接复用 Pi 的完整 TUI、模型、会话、资源和工具能力，同时增加任务边界、可重复验证、运行报告与评测回放。

## 能做什么

- 使用 Pi 官方完整交互界面，包括模型与登录管理、会话树、分叉、压缩、导入导出、分享、设置、主题和快捷键。
- 自动发现 Pi Extensions、Skills、Prompt Templates、Themes 和项目上下文文件，并支持 `/reload`。
- 从自然语言或 YAML/JSON `TaskSpec` 接收任务。
- 在终端当前目录或指定目录中执行交互任务，支持普通目录、无提交仓库和仓库子目录，不额外创建 Git 仓库、worktree 或分支。
- 文件工具支持绝对路径、`../` 和跨目录符号链接，不再限制在启动目录，也不执行 `allowedPaths` 白名单；`.git`、`.env*` 和 `node_modules` 仍禁止写入，公开模板 `.env.example` 除外（受保护目录中的同名文件仍受保护）。
- 在每轮模型执行后运行确定性的验证命令。
- 把任务、变更文件、验证输出和模型/会话信息写入 JSON 与 Markdown 报告。
- 在 TUI 内新建持久会话、切换同一源仓库的已记录历史会话，或使用不落盘的临时会话。
- 从失败评测提炼有证据引用的经验与 prompt/skill/strategy 候选；新鲜配对实验验证后，经人工晋升在 TUI 按需启用，并可撤销。
- 提供 `read`、`grep`、`find`、`ls`、`edit`、`write` 和 Shell 全套编码工具；识别到删除或丢弃工作区内容的 Shell 命令时，在进程启动前要求人工单次审批，也可用 `--no-shell` 完全关闭 Shell。

## 环境要求

- Node.js 22.19.0 或更高版本，推荐 Node.js 24 LTS。
- Git 为交互模式的可选依赖；Git 变更审计、record/replay 和配对实验需要 Git。
- 至少一个已在 Pi 中配置的模型。

可以通过下面的 `.env` 配置 API 密钥，也可以使用 Pi 的登录认证：

```bash
npx @earendil-works/pi-coding-agent
```

在 Pi 中执行 `/login`，完成模型提供商认证。

## 模型配置

在应用安装目录将 `.env.example` 复制为 `.env`，填写 provider、模型 ID、密钥和服务地址。本地开发或 `npm link` 安装时，默认文件为 `D:\Agent\.env`；从其他项目启动 `picode` 仍读取这个文件。已有 `.env` 时不要覆盖。

```powershell
if (-not (Test-Path -LiteralPath D:\Agent\.env)) {
  Copy-Item D:\Agent\.env.example D:\Agent\.env
}
```

`.env` 已被 Git 忽略，`.env.example` 可提交且只包含空密钥、默认值和说明。修改配置后重启 `picode`，不需要重新构建。模型必须是 Pi 已知模型，或先在应用数据目录的 `agent/models.json` 中注册；仅填写一个未知模型名称不会自动定义其协议和能力。

| 参数 | 含义与默认值 |
| --- | --- |
| `PICODE_MODEL_PROVIDER` | 提供商，如 `deepseek`；留空保留 Pi 模型选择 |
| `PICODE_MODEL_ID` | 默认模型，如 `deepseek-v4-flash`；填写时必须指定 provider |
| `PICODE_MODEL_API_KEY` | API 密钥；留空使用已有 Pi 认证 |
| `PICODE_MODEL_BASE_URL` | 可选 HTTP(S) API 根地址；不得含用户名、密码、查询参数或片段 |
| `PICODE_MODEL_REQUEST_TIMEOUT_MS` | 单次模型请求的墙钟上限，包含该请求内部重试；默认 `120000` 毫秒 |
| `PICODE_MODEL_MAX_OUTPUT_TOKENS` | 单次输出上限，默认 `16384`；包含共享输出预算的思考 token，实际值还受模型能力和剩余上下文约束 |
| `PICODE_MODEL_TASK_TIMEOUT_MS` | 一轮代理任务的总时限，包含多次请求与工具执行；默认 `0`，不设置额外总时限 |
| `PICODE_SYNTHESIS_TIMEOUT_MS` | 经验提炼全过程时限，默认 `120000` 毫秒 |
| `PICODE_SYNTHESIS_MAX_OUTPUT_TOKENS` | 经验提炼输出上限，默认 `16000` |

普通运行中，同名系统环境变量优先于 `.env`；未填写的参数使用上述默认值或已有 Pi 配置。可通过系统环境变量 `PICODE_ENV_FILE` 指定其他配置文件。`.env` 中的模型密钥只加载到内存中的模型运行时，不自动写回 `auth.json` 或导出给 Shell；系统环境变量原本已有的密钥仍会被子进程继承。`.env` 是明文文件，Git 忽略和工具保护不是操作系统沙箱。

交互、受控运行和 `--doctor` 使用同一个配置入口；经验提炼使用同样的认证/地址配置，但坚持使用来源记录中的模型和独立的提炼上限。任务总时限通过取消信号停止执行，不包含 setup 和后续验证，也不能保证强制终止不响应取消的第三方扩展。输出上限是单次调用上限，不是整个任务累计 token 预算。

### 查看配置与提示来源

```powershell
picode D:\projects\my-repo --diagnostics
picode D:\projects\my-repo --diagnostics --json
```

`--diagnostics` 无需 TTY 或 Git，只读取配置和当前磁盘上的上下文文件，不创建数据目录、执行 setup、加载扩展或发起模型请求。输出包括配置值及来源（系统环境变量、配置文件、默认值）、上下文文件 SHA-256 和宿主内置工具清单；可用 `--no-shell` 查看关闭 Shell 的工具集合。不能与任务、验证、setup、会话恢复或其他运行模式混用。

启动前无法确定会话最终选择的模型和扩展工具；在交互会话中使用 `/diagnostics` 或 `/diagnostics --json` 查看实际模型、有效单次输出上限、已加载上下文和 system/append 提示片段哈希、扩展路径、加载错误数量及活动工具。配置来源保留该会话运行时启动时的快照，不会因事后修改 `.env` 而冒充已经生效。密钥仅显示是否配置及来源，服务地址仅显示指纹；不显示提示正文。未配置 `PICODE_MODEL_API_KEY` 不代表 Pi 认证不可用。

JSON 的 `mode` 区分 `preflight` 与 `session`；可保存同类快照后比较 `configuration`、`model`、`contextFiles`、`prompts` 和 `tools`。启动前的空扩展列表表示未加载，不代表没有扩展；提示片段哈希也不代表完整模型请求或历史运行快照。

新记录在 manifest 中保存请求上限、输出上限、任务总时限和模型服务地址的 SHA-256 指纹，不保存密钥。重放与配对实验恢复记录的上限，当前服务地址变化或模型无法满足记录的输出上限时拒绝提交模型任务；配对实验自身的时限继续生效，多个总时限取较短者。旧记录仍可查看和重放，但缺少新配置快照的旧记录不能与新运行判定为配置一致，需重新记录后再做配对实验。当前运行策略版本为 `5`。

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

在 `D:\Agent` 完成一次构建和全局链接后，即可从其他项目目录使用 `picode`：

```powershell
cd D:\Agent
npm run build
npm link

cd D:\projects\my-repo
picode
```

`picode` 与 `pi-agent-tui` 指向同一个入口；省略路径时使用终端当前目录，支持非 Git 目录和尚无提交的仓库。从仓库子目录启动时，工作区保持为该子目录。也可以运行 `picode --doctor` 检查当前目录，或使用 `picode D:\projects\my-repo` 指定目录。全局链接保留后，日常启动只需输入 `picode`；修改 Agent 源码后在 `D:\Agent` 重新运行 `npm run build` 即可更新。

```powershell
npm run dev -- D:\projects\my-repo --task "修复解析器并补充回归测试" --verify "npm test"
```

交互式 TUI 直接在指定目录中工作，保留已有文件和未提交变更，不会自动执行 `git init` 或创建分支、worktree。持久会话按实际工作目录归组；父目录与子目录分别保存会话，`--continue` 和 `/sessions` 只恢复当前目录的会话。此前从仓库根目录创建的会话仍可在仓库根目录恢复。

Git 可用时，验证命令在当前工作目录执行，变更审计覆盖整个所属仓库，文件列表中的路径相对于仓库根目录。Git 不可用时，文件工具、会话和验证命令仍可使用；`/diff` 会提示不可用，报告明确标记变更文件与受保护文件状态未知。即使验证命令全部通过，缺少变更审计的运行仍标记为不完整，不会宣称完整验证成功。record/replay 和配对实验仍要求已有提交的 Git 仓库。

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

### 验证失败后自动修复

普通交互和新建 `--record` 任务默认最多自动修复 **2 次**。Agent 正常结束后，宿主执行全部配置的验证命令；若有命令正常退出但结果失败，则将脱敏、限长的失败输出反馈给同一 agent，修复后重新验证。最多执行首次任务加 2 轮修复，不限制为 3 次 API 请求。

```powershell
picode . --task "修复解析器" --verify "npm test" --verify "npm run lint" --max-repair-attempts 2
picode . --max-repair-attempts 0
```

`--max-repair-attempts` 范围为 0–5，0 表示关闭；也可在 YAML/JSON TaskSpec 顶层配置 `maxRepairAttempts: 2`，CLI 设置优先。交互中可用 `/repair off` 取消后续自动修复，或 `/repair 2` 设置上限，更新设置不会立即启动模型，后续正常执行结束后按新设置处理；不回滚已完成的修改或终止已经启动的验证命令。手动 `/verify` 只检查，不启动模型修复。

验证成功即停止。达到上限、模型错误或用户中止、验证超时或进程启动异常、Git 审计不可用、存在受保护文件变更时停止自动修复。新输入、任务配置变化和会话切换会使旧任务待发送的修复反馈失效；计划模式暂停验证和修复。自动修复会产生额外模型请求及费用。

受控运行在宿主验证期间收到取消信号时，已启动的验证按自身超时完成，保留实际通过或失败结果，并阻止后续模型修复；取消不回滚文件修改。

修复沿用已有工具权限和验证命令，不自动发现或添加测试、lint，也不放宽验收条件。测试文件仍可被文件工具修改，因此不能把验证通过当成需求全覆盖或防作弊保证；`doneWhen` 仍为提示条件。

受控运行把修复上限纳入任务快照及哈希，replay 和配对实验恢复该值，不允许用 CLI 覆盖。旧 manifest 没有 `maxRepairAttempts` 时保持零次修复，不补写字段或改变原哈希。各轮结果保存在 `verification-0.json`、`verification-1.json` 等文件中，trace 含轮次、修复开始和停止原因；`verification.json` 保存最后一次实际验证，模型失败时最终状态仍为执行失败。受控运行的模型任务时限由首次执行和所有修复共享，不包含 setup 和宿主验证耗时；交互模式沿用每次 agent 执行的时限及有限修复次数。SWE-bench 官方评分路径不参与自动修复，不向模型回传隐藏评分测试。

## 可复现评测与回放

受控运行采用 `prompt → verifier → 有限修复 → verifier → evidence` 流程。它始终从干净源仓库创建新的受管 worktree，不进入交互式 TUI：

```bash
pi-agent-tui /path/to/repository --record --task-file examples/task.yaml --no-session
pi-agent-tui --list-runs
pi-agent-tui --show-run <runId>
pi-agent-tui --replay <runId>
```

`--replay` 从原 manifest 固定的 Git commit 创建另一个全新 worktree，并恢复 TaskSpec、verifier、模型、thinking level 和工具策略。回放沿用原运行是否启用 Shell 的记录，不会因为当前默认值而升级或降低工具权限；显式且冲突的 `--no-shell`/兼容参数 `--unsafe-shell` 会被拒绝。为了保持可比性，受控 record/replay 不加载当前机器上可能随时间变化的 Extension、Skill、Prompt Template 和 Theme；完整资源发现只用于交互模式。

需要探索“按任务选择经验”时，对**普通原始 run** 显式启用选择；不传 `--replay-candidate` 时使用同仓库有效晋升池，传入一个或多个 ID 时只在这些候选中选择，也可评估尚未晋升的候选：

```powershell
pi-agent-tui --replay SOURCE_RUN_ID --replay-experience auto
pi-agent-tui --replay SOURCE_RUN_ID --replay-experience auto --replay-candidate CANDIDATE_ID
```

此入口要求原任务配置验证器，使用原任务目标做检索和适用性判断；结果可能是注入、零注入或检索失败后零注入。选择审计写入 `reports/retrieval/<审计ID>.json`；新 replay 的 v3 manifest 保存候选池哈希、审计哈希、选择状态、所选 ID、候选快照与有效提示哈希。对该 replay 再运行普通 `--replay` 会复用冻结的选择，不重新调用检索模型。显式选择会增加索引/适用性模型请求的费用；没有额外审批时不会自动晋升候选。

`comparison.json/.md` 把经验介入列为单次观察：若只有经验输入变化且基线、任务、模型、策略、上下文和验证器一致，报告通过状态的观察改善、退化或无收益；若没有注入则为 `not_evaluated`，其他条件漂移为 `invalid_isolation`。经验介入不是严格的同提示回放，因此原有 `status` 仍为 `not_comparable`。一次原始运行加一次 replay 不能证明经验导致变化；需要有效性证据时继续使用新鲜对照与候选配对实验。

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

## 运行复盘与候选实验

没有现成评测任务时，可接入 Exercism JavaScript 的全部 9 道官方困难题（8–9 分）：

```powershell
npm run benchmark:exercism -- D:\exercism-js-hard-v1
```

目标目录必须尚不存在。工具准备独立 Git 题库、锁定依赖、逐题 TaskSpec，并实际校验骨架失败和参考实现全通过；所有跳过测试启用，参考答案不进入题库或 Git 历史。此步骤不调用模型。已有题库无需重复准备；真实 record、经验分析与配对实验见[困难题库使用指南](docs/exercism-hard-benchmark.md)。

此功能把“成功或失败记录 → 筛选与复盘材料 → 经验候选 → 可选 critic 审查 → 新鲜对照实验 → 人工晋升 → 按需使用”串成闭环。候选是指导文本，不会自动改写程序、安装全局 Skill，或改变工具权限与验证器。Skill 候选是过程性 Markdown，不是可执行插件。

经验生成结果保留统一 JSON 结构，候选的 `content` 正文使用 Markdown。输入兼容纯 JSON，以及包住整个响应的三反引号代码围栏（`json` 标签，不区分大小写，或不带语言标签）。围栏之外不能附加解释，也不接受多个响应块、YAML 或自由文本；解包后仍严格校验字段、证据引用、内容长度和敏感信息。此兼容只处理外层包装，不修复损坏或截断的 JSON。已有失败记录不会自动重写，需要重新执行 `--analyze-run` 生成新记录。

先选一个**配置了验证器**的已记录 run，再提炼：

```powershell
pi-agent-tui --list-runs
pi-agent-tui --analyze-run RUN_ID
pi-agent-tui --list-experiences
pi-agent-tui --show-experience EXPERIENCE_ID
```

将示例中的大写 ID 替换为实际 ID。分析会区分程序判定的失败事实与模型提出的原因假设，保存证据引用、适用条件、不适用条件、候选哈希和生成成本。模型生成使用来源 run 的模型配置，但以独立、无工具的请求运行；只发送有上限的脱敏评测证据，不读取原生会话内容。模型不可用、超时或返回格式不合格时保留观察记录，生成状态为 `failed`，不会伪造候选。

没有验证器、运行不完整或 setup 失败时不会生成编码策略。成功 run 默认要求至少 6 次工具调用；有可核查的工具失败后成功动作时，即使调用较少也可复盘。阈值是节约成本的启发式，不代表复杂度或经验价值；成功还必须有一致的验证结果、关联的工具动作和结果摘要。没有验证器的旧 run 应重新录制并添加 `--verify`，直接重放不会补出缺失的验证标准。历史 trace 缺少动作摘要时，不根据调用数猜测成功原因。

```powershell
pi-agent-tui --analyze-run RUN_ID --min-success-tool-calls 8
pi-agent-tui --analyze-run RUN_ID --force-review
pi-agent-tui --analyze-run RUN_ID --review-mode critic
pi-agent-tui --analyze-run RUN_ID --review-mode compare
pi-agent-tui --show-review-comparison CRITIC_EXPERIENCE_ID --json
```

`--min-success-tool-calls` 范围为 0–10000。`--force-review` 仅绕过低调用筛选，不绕过验证器、运行完成、setup 和动作证据要求。这两个选项及 `--review-mode` 仅用于 `--analyze-run`。

默认 `proposer` 模式最多调用一次提炼模型。`critic` 在结构与引用检查通过且存在候选时，追加一次独立上下文、无工具的模型审查；逐项检查依据、适用条件、因果过度归因、答案记忆和规则绕过，只接受或拒绝原提案，不改写提案。审查失败会保留提案、错误和已知费用，但不放行候选。模型可以返回 `{"candidates":[],"noCandidateReason":"没有足够的可复用证据"}`；这是正常完成，不是错误，也不会继续调用 critic。

`compare` 复用**同一批 proposer 提案**，保存 proposer 经验以及绑定其 ID/哈希的 critic 经验。用返回的 critic 经验 ID 查看比较。报告列出过滤前后候选数量、已评测候选、观察到的改善/退化、未评测项和两次生成的计费估计。接受的提案内容不变，比较可以共享该内容在两个候选 ID 下的已核验实验；这不改变晋升对候选 ID 和跨任务证据的绑定。

要判断 critic 是否误拒，需使用 proposer 经验里被拒候选的 ID 显式发起 `--experiment`。未评测或无法核验的证据会使比较保持不完整；拒绝率不等于有效率。回顾性可避免评测费用仅统计被拒候选已记录的实验费用，并不表示本次实际省下了这些费用。当前改善判定仍以配对通过/失败为主，单纯减少 token、工具调用或耗时不会获得改善或晋升资格。

新生成的候选会自动建立独立检索描述，保存在 `experiences/<经验ID>/retrieval/<候选ID>.json`，包含触发条件、排除条件、适用阶段及中英文关键词，并绑定原候选和提示版本。索引失败会记录状态并保留原经验，不自动重复收费；只读 `--show-experience` 可查看状态。旧的有效晋升候选首次使用时补建索引，不回写 `experience.json`。索引生成和每轮有召回候选时的适用性检查会额外调用文本模型，使用 `PICODE_SYNTHESIS_*` 上限。选择理由、引句、用量和错误保存于 `reports/retrieval/<审计ID>.json`。

普通 TUI 使用当前模型筛选；普通 record/replay 和显式候选配对保持冻结候选，只有显式 `--replay-experience auto` 才在 replay 前重新检索。当前只在每轮初始阶段判断，需要读代码或出现特定错误后才能适用的经验暂不注入；模型判断仍可能出错。

新经验产物为 v2，旧 v1 仍可读取。新录制的工具结果只保留最多 1000 字符的脱敏文本摘要，不保留图片、任意 details 或思维链；复盘材料包含运行用量和耗时，继续限制为 80 条、32000 字符，并优先保留验证诊断和失败恢复片段。现有 `diffSummary` 仅为变更统计和文件列表，不是完整代码补丁。截断与缺失都会限制可提出的结论。

这些命令无需 TTY，可由外部后台作业调用；当前不会自动订阅普通 TUI、创建常驻复盘队列或自动启动付费评测。重复手动分析会创建新的不可变记录，不覆盖历史。普通 TUI 报告不等于可回放 run；请先用 `--record` 获取受控证据。

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

普通 record/replay 不自动加载候选。实验运行的 v2 manifest 冻结候选文本、渲染版本与有效 prompt 哈希；对其 `--replay TRIAL_RUN_ID` 会恢复同一候选，不能在实验臂上重新选择。显式选择的 replay 使用 v3 manifest；旧 v1/v2 运行仍可读取和回放。

### 晋升、使用与撤销

晋升要求同一候选在同一仓库的至少两个不同任务上完成实验，其中至少一个不是经验来源任务；每项证据至少 3 对完整运行，至少一项观察到改善，且不能含退化、越界或隔离失败。仅修改任务 ID 不算新任务。程序门槛不能替代人工阅读候选与确认适用性。

```powershell
pi-agent-tui --experiment HOLDOUT_RUN_ID --candidate CANDIDATE_ID
pi-agent-tui --promote-candidate CANDIDATE_ID --evidence EXPERIMENT_ID_1 --evidence EXPERIMENT_ID_2 --approve
pi-agent-tui D:\projects\my-repo --list-promotions
```

`--approve` 是明确的人工晋升/撤销确认，不是自动优化开关。晋升绑定仓库、候选哈希和实验证据，日常 TUI 默认从本仓库有效晋升候选中自动筛选；不会自动晋升未验证候选。可在 TUI 中控制：

固定验证命令不代表测试文件不可修改：当前文件工具不限制测试文件写入，仍可能出现“改测试而不是修实现”的假改善。晋升前应审查各臂变更，并尽可能使用不能被任务改写的外部验证器或留出检查；本功能不提供防作弊沙箱。

```text
/experience list
/experience auto
/experience use CANDIDATE_ID
/experience off
```

每轮先检查晋升与证据，再用独立检索描述召回最多8条，判断触发条件、排除条件、适用阶段并去重；仅直接适用、排除条件不存在且适合初始阶段的候选可以注入，最多2条、9000字符，也允许零注入。`use` 限定候选但不绕过这些检查，`off` 关闭，`auto` 恢复自动筛选。计划模式不筛选。会话切换清空手动选择并恢复 auto；候选撤销或异步期间任务、模型、会话发生变化时，旧选择不注入。TUI 把候选作为单独的用户级补充消息；实验使用任务提示末尾补充，两者的会话历史和消息布局不同，因此不能直接把实验提升视为日常 TUI 的同等提升。

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
| `/sessions` | 打开选择器并切换当前工作目录的会话 |
| `/sessions <session-id>` | 按完整 ID 或唯一 ID 前缀切换会话 |
| `/verify` | 执行验证命令并生成报告；Git 不可用时标记变更审计缺失 |
| `/repair [status\|off\|0..5]` | 查看或设置自动修复上限；`off` 取消后续自动修复 |
| `/diff` | 查看所属仓库的变更文件和 diff 统计；Git 不可用时提示原因 |
| `/status` | 查看宿主任务、工作区、模型与会话；用量使用 Pi 的 `/session` 查看 |
| `/diagnostics [--json]` | 查看当前配置来源、实际模型与上限、上下文/提示哈希、已加载扩展和活动工具 |
| `/experience [list \| auto \| use <ID> \| off]` | 查看、自动筛选、限定候选或停用本仓库已晋升经验 |
| `/plan [on \| off \| execute]` | 切换只读计划模式，或执行已生成的计划；快捷键 Ctrl+Alt+P |
| `/todos` | 查看当前计划步骤和完成标记 |
| `/preset [名称 \| off]` | 选择预设，或恢复预设前的设置；Ctrl+Shift+U 循环切换 |
| `/handoff <新目标>` | 用当前模型生成交接摘要，编辑确认后放入新会话输入框 |

### 提问、计划与交接

普通交互模式默认提供 `question`（单个问题）和 `questionnaire`（多个问题）两个模型工具。
你可以输入“先向我提问，确认需求后再开始”；模型会在需要信息时打开选择界面。
使用 ↑↓ 选择、Enter 确认，选择“自行输入”可写自由文本；多题使用 Tab/←→ 切题，答完后提交。
Esc 取消不算同意，也不会把未提交的答案作为决定；中止 Agent 会关闭提问界面。

建议先输入 `/plan`，再描述任务。计划模式只开放读取、搜索和提问工具，阻止模型写入、Shell 和 `!` 命令，暂停自动验证与 `/verify`。
模型在“计划：”标题下列出编号步骤后，你可以选择执行、继续讨论，或输入 `/plan execute`。
`/plan off` 只退出计划模式；执行计划后通过 `/todos` 查看进度。完成标记是模型的步骤记录，测试是否通过仍以验证报告为准。
计划模式不撤销进入前已发生的操作，也不是操作系统沙箱。

内置预设：`/preset review` 使用读取、搜索和提问工具；`/preset implement` 使用正常编码工具；`/preset off` 恢复切换前的模型、思考级别和工具。
计划模式期间切换预设仍保留计划限制。预设不能重新启用 `--no-shell` 禁用的 Shell；Windows 的 Shell 工具名为 `powershell`。

自定义预设放在应用数据目录的 `agent/presets.json`（默认 `D:\Agent\.picoding\agent\presets.json`），或当前工作目录的 `.pi/presets.json`。
同名预设由项目配置覆盖全局配置；保存后使用 `/reload` 重载。示例：

```json
{
  "careful-review": {
    "thinkingLevel": "high",
    "tools": ["read", "grep", "find", "ls", "question", "questionnaire"],
    "instructions": "先核对调用链和测试，再报告有证据的问题。"
  }
}
```

可选的 `provider` 和 `model` 必须成对填写，并使用当前配置中可用的模型；不填写时使用首次切换预设前的模型。
`tools: []` 表示关闭全部模型工具。无效配置或不可用的模型/工具会显示提示，不会静默套用部分配置。
计划和预设状态跟随已保存会话恢复；尚未收到首条模型回复的空会话遵循 Pi 的延迟保存规则，`--no-session` 不跨进程保存状态。

例如 `/handoff 为刚才的修改补充回归测试` 会调用一次摘要生成流程，使用当前模型的请求超时和输出上限。
摘要可编辑；取消、空内容或生成失败时保留原会话。确认后进入相同工作目录的新会话，任务目标更新为交接目标，交接内容留在输入框，按 Enter 才开始执行。
原有验证命令继续保留，新会话不继承旧会话的计划/预设选择。
从 `/temp` 临时会话交接时，新会话保存到正式会话目录，可通过 `/sessions` 恢复；内存会话交接仍保持在内存中。

这些功能仅用于普通交互模式，不加载到 record/replay 或配对实验。
启动命令不变；`/plan` 和 `/preset` 是进入界面后使用的命令，本项目 CLI 不透传上游示例的 `--plan`、`--preset` 参数。

Pi 自带的 `Esc`、`Ctrl+C`、队列、模型切换和完整快捷键行为保持不变；使用 `/hotkeys` 查看当前配置。

## 数据位置

会话内容仍使用 Pi 的 JSONL 格式；本项目按实际工作目录路径建立稳定的会话目录，并原子记录 session ID，使尚未产生首条模型回复的空会话也可被发现。已物化会话的内容和 ID 仍以 JSONL 为事实源；同一持久会话同时被另一个进程占用时会拒绝打开，避免并发追加损坏上下文。

所有应用运行期数据默认集中在项目根目录的 `.picoding/` 中：

```text
.picoding/
├── runs/       受控评测、回放及其证据
├── experiences/ 运行复盘、经验卡、审查记录和不可变候选
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
- `src/workspace/current-workspace.ts`：保留实际工作目录的交互启动，Git 信息可选。
- `src/workspace/git.ts`：Git 变更审计，以及受控记录/回放使用的 worktree 生命周期。
- `src/verifier/verifier.ts`：确定性验证。
- `src/report/report.ts`：运行证据报告。
- `src/evaluation/`：受控运行、manifest、Trace、回放与对比。
- `src/experience/`：成功/失败筛选、证据提炼、候选生成、critic 审查、同批提案比较与人工晋升。
- `src/experiment/`：配对运行、配置隔离检查与结果比较。

## License

MIT

### 路径策略兼容性

`allowedPaths`（含 `allowed_paths`）和 CLI `--allow` 仅兼容旧输入，不再限制工具或验证结果；新任务无需配置。启动目录仍用于解析相对路径、执行默认命令和保存仓库会话，但不再是访问边界。Git 变更报告只覆盖启动仓库，目录外修改不会自动被列入报告。

普通交互、record/replay 和配对实验均使用此策略。受管 worktree 只提供独立检出，不保证目录外副作用隔离。策略版本已提升为 2；旧策略运行不能作为新策略配对实验的同配置来源，应重新记录运行。回放旧记录会标记策略版本差异，不能当成等价复现。删除审批、敏感文件保护和系统命令限制仍然有效。

### 命令拦截诊断

被拒绝的 Shell 调用返回规则 ID、拒绝原因和脱敏命令预览；受控运行在 `trace.jsonl` 的 `tool_end.data.policyFailure` 保存这些信息，通过同一条记录的 `toolCallId` 关联调用。预览最长约 1200 字符，凭据与终端控制字符经过处理；涉及环境变量枚举或 `.env` 的命令整体隐藏。普通命令正文不记录，工具文本仅保留有长度上限的脱敏摘要。脱敏为尽力识别，不能保证识别任意自定义秘密格式。

`format` 按调用位置识别，普通路径（如 `tests/format/`）和源码变量不再触发磁盘格式化拒绝。识别覆盖直接调用和常见 Shell/进程包装，不是完整解释器或沙箱。此变更将运行策略版本提升为 3；旧策略实验不能视为同配置结果。

当前版本允许确定的标签查询：`git tag`、`git tag -l`、`git tag --list 'v*'`，包括管道、`git -C <目录>`、`git --no-pager` 和带引号的 `git.exe` 路径。创建、删除、强制覆盖、签名标签，以及未支持的标签参数和动态展开形式仍被拒绝；需要其他查询参数时可先使用上述基本查询。查询与其他命令组合时，整条命令仍接受拒绝和审批检查。

被识别的 Git 写入或不支持的标签调用会返回错误和合法替代操作，允许代理继续读取源码、查看 diff 或运行测试；原命令不会执行，也不会被自动改写重试。提权、系统操作和磁盘格式化仍会拒绝，并向 Pi 返回 `terminate=true` 终止信号。删除或丢弃工作区改动仍需审批，record/replay 继续拒绝未获审批的操作。

新 trace 在工具结果明确提供布尔值时记录 `tool_end.data.terminate`，并在模型消息结束时记录白名单内的 `message_end.data.stopReason`。字段缺失表示未记录，不能当作 `false` 或正常结束。这次变更将运行策略版本提升为 `5`；使用新策略重跑只能算新运行，不修改历史记录，也不能当作旧策略的等价复现。

### SWE-bench Mini 同题经验复用

需要补充多仓库经验时，可使用 [SWE-Verified 单轮运行](docs/swe-verified-single-round.md)：`npm run benchmark:swe-verified -- catalog|run|status <批次目录>`。固定选取 50 道未见题，每题只运行一次并按证据生成 proposer 经验；成功至少 6 次工具调用，不启用 critic。

SWE-bench Verified Mini 的两轮同题实验见 [运行指南](docs/swe-mini-r0-b.md)。入口为 `npm run benchmark:swe-mini -- prepare|run|status`，流程为 R0 → 逐题复盘 → 冻结经验 → B；共 100 次任务执行，复盘另计。两轮均使用独立 Linux 容器的 Bash 工具，官方评分结果与 token 分别记录，不作为跨任务晋升或泛化收益证据。

冻结 Mini 经验库的新任务泛化实验见 [40题双组运行指南](docs/swe-holdout.md)。入口为 `npm run benchmark:swe-holdout -- catalog|prepare|run|status`；原仓库新题20道、新仓库题20道，每题两组共80次新运行，任务与Mini不重合，实验期间不更新经验库。

经验检索 V2 的独立描述、适用性筛选、零注入与历史配对诊断见 [检索 V2 指南](docs/swe-retrieval-v2.md)。入口为 `npm run benchmark:swe-retrieval -- run|status|report [source-root] [output-root]`。`run` 会调用文本模型但不执行修复任务；`status` 查看缓存状态，`report` 重算已有检查点与人工标签，二者不调用模型。V1 产物保持不变，模型评审和人工指标分别报告，不能把相关性诊断当作修复收益。

### 实验模型阶段预算

内部 `runExperiment()` API 支持 `promptTimeoutMs`（1–3,600,000 毫秒，默认 900,000）。例如 `promptTimeoutMs: 45 * 60 * 1000` 将每个对照臂和候选臂都设为 45 分钟。预算包括模型生成及其工具调用，不包括模型返回后的宿主最终验证。新实验保存统一预算，各臂和回放记录相同值；缺少该字段的旧实验仍按历史 15 分钟解释，读取时不补写字段或改变哈希。当前 CLI 未增加对应选项。
