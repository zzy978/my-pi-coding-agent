# 仓库指南

## 命令拒绝与继续执行（2026-09-20）

- 当前 `PROMPT_POLICY_VERSION=5`，覆盖下文历史版本说明。`git-command.ts` 只放行可确认的标签查询（无参数、`-l`、`--list` 加普通模式），支持管道、`-C`、`--no-pager` 和带引号的 Git 可执行路径；同一识别逻辑检查 Git 写入与需审批的工作区操作。标签写入、未支持的参数及动态展开保守拒绝。不是完整 Shell 解析器或沙箱。
- `CommandPolicyResult.onDeny` 区分 `continue` 与 `stop`：被识别的 Git 写入及不支持的标签调用继续拒绝，但向模型返回错误和合法替代操作；提权、系统操作、磁盘格式化及 Shell 关闭仍返回 `terminate=true` 终止信号。整条命令先检查高风险拒绝，再检查 Git 和审批规则，查询例外不能遮蔽其他风险。
- `recorder.ts` 仅在工具结果明确提供布尔值时保存 `tool_end.data.terminate`，仅对白名单内的 assistant `stopReason` 保存 `message_end.data.stopReason`；不存任意 details、模型正文或思维。历史缺失字段保持未知，不补写旧产物或哈希。
- 回归测试用本机模拟 HTTP 驱动真实 Pi 循环，验证被拒命令不执行、可恢复错误后能调用合法工具、高风险仍停止。测试通过不代表真实模型一定继续修复或 SWE 得分提高；使用新策略的实验必须独立记录。

## 验证修复闭环（2026-09-17）

- 新 CLI 任务（普通交互、record）默认 `maxRepairAttempts=2`，`--max-repair-attempts 0..5` 覆盖 TaskSpec，0 关闭；只读、replay 和经验管理命令拒绝覆盖。历史 TaskSpec 缺字段仍为零次，解析不得补字段改变哈希。
- `src/verifier/repair.ts` 共享失败筛选与脱敏反馈。仅正常结束后的、有退出码的验证命令失败可以修复；无验证器、审计不可用、受保护变更、验证超时或启动异常不能自动续跑。
- 交互宿主在 settled 事件完成分发后发送反馈，冻结当前链的任务配置，用户新输入、配置变化、会话切换及 `/repair off` 取消旧续跑。`/verify` 不调用模型，计划模式暂停验证。正常结束以 assistant stopReason=stop 判断。
- 受控 runner 在同一 run/session/worktree 内有限循环，首次 prompt 和后续修复共享模型阶段时限；每轮保存 verification-N.json 和带轮次的 trace。最后验证通过不能覆盖后续模型异常。SWE 官方评分流程保持独立。
- 测试覆盖次数上限、取消、任务漂移、历史记录兼容和证据脱敏，不调用真实付费模型。不把测试文件可修改的验证流程描述为防作弊或全需求完成证明。

## 只读诊断更新（2026-09-11）

- `--diagnostics [--json]` 在创建数据目录前分流，不启动会话、setup、扩展或模型请求；只提供配置来源、磁盘上下文哈希及内置工具预览。支持工作目录与 `--no-shell`，拒绝混用执行参数及其他模式。
- `/diagnostics [--json]` 从已启动会话的资源加载器和活动工具读取真实状态，配置来源保留启动时快照。`src/diagnostics.ts` 使用允许公开的字段投影，凭据仅显示配置状态/来源，地址仅显示哈希，所有动态字符串脱敏并转义终端控制字符。
- `readModelConfigWithSources` 与 `readModelConfig` 共享解析；空环境变量屏蔽文件值后采用默认值。不能为诊断复制一套配置优先级或打印完整配置对象。
- `preflight` 不是历史运行或正在运行会话的证明；空扩展列表表示尚未加载。新增诊断字段须验证 JSON/文本均不泄漏秘密，且只读命令不产生数据目录或执行扩展。

本仓库是 **pi-tui-coding-agent**（`pi-agent-tui`）：一个建立在 Pi 之上的可验证、原地执行的 TUI 编程代理。常规使用复用 Pi 官方交互界面，并增加任务边界（`TaskSpec`）、确定性验证、运行报告、按仓库隔离的会话、可复现的 record/replay 评测，以及基于失败证据的经验提炼与配对实验。普通交互直接使用目标 Git 仓库的当前检出目录；受控 record/replay 和配对实验才创建受管 worktree。

## 协作与交付要求

- 必须用中文回复；说明、开发文档和新增指南使用中文，代码标识符、命令与既有协议字段保持原名。
- 先拆解目标、已知输入、约束、不可违反条件，区分事实与假设；先给最小可行方案，再说明必要的稳健性改进，不直接套用常见架构。
- 修改前读取相关源码、调用链、测试与 Git 状态，解释当前逻辑、最小改动点、风险和验证方案，再开始实现。README 和设计文档用于定位，实际行为以当前源码及验证证据为准。
- 用户提出的方案应作为待验证假设：指出关键假设、失败场景及更合适的替代方案。修复应解决根因，说明现有设计为何允许问题发生，避免只掩盖症状。
- 保留已有未提交改动和未跟踪文件，不擅自重置、覆盖或清理。普通开发在当前检出目录执行，不为日常任务自动创建分支或 worktree。
- 在已授权范围内自主阅读、实现、复核并验证；交付说明改了什么、为什么、验证结果和未验证的限制。不得把模拟测试通过表述为真实模型效果已验证。
- 用户可见页面、TUI、文章和视觉稿只呈现最终用户需要的内容，不混入作者备注、技术选型、制作过程或内部验收安排；内部规范放入开发文档。

## 核心运行链路

1. `cli.ts → cli-args.ts → main.ts`：检查 Node、解析并校验参数，按模式分流。帮助、版本、运行管理、经验管理、受控运行与健康检查不要求 TTY；只有普通交互要求 stdin/stdout 均为 TTY。
2. 普通交互：准备当前工作区与 setup → `runPiInteractive()` → 官方 TUI、策略扩展、宿主扩展与经验扩展。宿主维护任务，在执行后验证并写报告。
3. 受控运行：创建新 worktree → 恢复或构建任务和 setup → `ControlledPiRuntime` → `executeControlledRun()` → 验证、记录与报告；replay 通过 manifest 恢复配置。
4. 经验流程：已记录 run → 确定性失败分类和证据收集 → 合格时调用模型生成候选 → 新鲜对照/候选配对实验 → 人工晋升 → TUI 手动选择。各阶段有独立产物，不以生成候选代替效果验证。

## 项目结构与架构

所有生产 TypeScript 位于 `src/` 下，且为 ESM（`"type": "module"`）。相对导入**必须**带 `.js` 扩展名（NodeNext 解析）。

- `src/cli.ts` — 可执行入口：校验最低 Node 版本、解析参数、设置 `process.exitCode`。
- `src/main.ts` — 模式路由与编排，依次处理 help/version、运行管理、经验管理、受控 record/replay、`--doctor` 或交互式 TUI；维护 `helpText()`。
- `src/learning-cli.ts` — 经验分析、经验/实验查看、配对实验、晋升与撤销的命令分发及中文输出；处理实验中止，过滤不安全的终端控制字符。
- `src/cli-args.ts` — 参数解析，含详尽的互斥校验（如 `--task` 与 `--task-file`、`--continue` 与 `--no-session`、`--record` 与运行管理、`--replay` 附带多余任务参数、`--unsafe-shell` 与 `--no-shell`）。改动参数时须同步 `src/main.ts` 中的 `helpText()`。
- `src/config.ts` — `APP_NAME`、`APP_VERSION`、最低 Node 版本（`>= 22.19.0`）及对应检查。
- `src/doctor.ts` — 非交互式健康检查：Node、Git、工作区可访问性、仓库根目录、已配置的 Pi 模型。
- `src/task/task-spec.ts` — 从 YAML/JSON 加载并校验 `TaskSpec`，或由 CLI 参数构建。默认值：随机 `id`、`allowedPaths: ["**/*"]`、`doneWhen` 列出验证成功标准。
- `src/policy/` — 安全敏感护栏：
  - `path-policy.ts` — 工作区包含性、`allowedPaths` glob 匹配（`matchBase`）、任意层级下始终受保护的写入路径（`.git`、`.env*`、`node_modules`）、敏感读取路径（`.git`、`.env*`）。
  - `command-policy.ts` — 对 shell 命令分类：永久拒绝（提权、系统级变更、写入 Git 历史）与需审批的危险命令。
  - `safe-tools.ts` — 将 Pi 工具定义（`read`、`grep`、`find`、`ls`、`edit`、`write`、Shell、PowerShell）封装在策略之后；解析符号链接以强制包含性，并拒绝修改多硬链接文件。
  - `policy-extension.ts` — 在交互模式下以扩展形式向 Pi 暴露安全工具。
- `src/workspace/` — Git 与 setup 相关：
  - `git.ts` — 解析 Git 根目录、分支与提交；列出变更文件（含重命名/复制的已跟踪文件及未跟踪文件）；为 record/replay 创建与销毁**受管 worktree**。交互模式始终为原地执行（`managedWorktree: false`）并保留已有未提交改动。
  - `setup.ts` — setup 规划：`auto`（lockfile 变化时安装依赖）、`explicit`（`--setup` 命令）或 `disabled`（`--no-setup`）。
- `src/verifier/verifier.ts` — 确定性验证：以超时与输出上限运行每条已配置命令，并按 `allowedPaths` 审计全部变更文件，返回 `VerificationReport`。成功要求每条已配置命令通过**且**无越界变更文件；未配置任何命令的运行永远不会判定成功。
- `src/report/report.ts` — 写入机器可读与人可读的运行报告。
- `src/runtime/` — 两套运行时与会话基础设施：
  - `pi-interactive.ts` — 交互式 Pi 运行时，装配官方 TUI 并做完整资源发现（扩展、Skills、Prompt Templates、Themes、上下文文件）。
  - `interactive-host-extension.ts` — 隐藏的内联 `pi-tui-host` 扩展，注册 `/task`、`/allow`、`/verify-add`、`/run`、`/temp`、`/sessions`、`/verify`、`/diff`、`/status`；持久化任务目标并在每轮执行后运行验证、生成报告。
  - `controlled-pi-runtime.ts` — record/replay 与配对实验共用的无界面运行时。为保证可比性，它**不**加载扩展、Skills、Prompt Templates、Themes 或上下文文件。
  - `experience-extension.ts` — 注册 `/experience [list | use <ID> | off]`，只允许选择当前仓库有效晋升的候选；每轮复核候选哈希与证据，验证失败即停用，会话开始或切换时清空选择。
  - `session-store.ts` — 按源仓库隔离的持久会话存储，原子记录 session ID 并加锁，避免同一会话被两个进程并发写入。
  - `data-dir.ts` — 应用根目录下 `.picoding/` 的目录布局（`runs`、`experiences`、`experiments`、`promotions`、`worktree`、`sessions`、`reports`、`temp`、`agent`）及 `PI_TUI_AGENT_DATA_DIR` 覆盖项；数据根与分类目录必须为普通目录。
  - `process.ts` — 子进程执行，带超时、输出字节上限与脱敏钩子。
- `src/tui/` — `session-picker.ts`（会话切换界面）与 `theme.ts`。
- `src/evaluation/` — 受控运行：`schema.ts`（manifest/result/comparison 校验）、`runner.ts`（编排）、`recorder.ts`（可观察事件 trace）、`redaction.ts`（产物中的密钥与工具参数脱敏，以及 `assertRecordableCommands`——拒绝需审批或永久拒绝的命令进入 record/replay）、`replay.ts`（按记录的 manifest 重建运行：锁定提交、任务、验证器、模型、思考级别、工具集与 shell 策略）、`comparison.ts`、`store.ts`（运行包持久化到 `.picoding/runs/<runId>/` 下）。
- `src/experience/` — `classifier.ts` 确定性分类，`evidence.ts` 收集有界证据；`synthesizer.ts` 通过 Pi `ModelRuntime.completeSimple()` 调用来源模型生成严格 JSON，不启用工具或资源发现；`service.ts` 编排并保留生成失败状态；`candidate.ts` 管理文本候选、哈希与提示渲染；`schema.ts`、`store.ts`、`artifact-io.ts` 负责校验和存储；`promotions.ts` 管理按仓库隔离、带锁与完整性校验的晋升/撤销历史。
- `src/experiment/` — `service.ts` 从来源 manifest 冻结配置，为每个实验臂创建新 worktree 和临时会话，交替执行对照/候选顺序，结束后清理 worktree；`schema.ts` 核查隔离条件并由绑定的运行证据重新计算指标与结论；`store.ts` 存储并加载实验产物。

测试位于 `test/**/*.test.ts`，共享夹具在 `test/helpers/`（`git-repository.ts` 用于构建一次性 Git 仓库）。示例任务规范在 `examples/task.yaml`。不要编辑或提交生成的 `dist/` 与 `coverage/` 产物。

`docs/superpowers/specs/` 和 `docs/superpowers/plans/` 保存设计与实施计划；它们不是已实现功能或测试通过的证明。新增参数需同步参数解析、帮助文本、README 与相关测试；修改宿主命令需同步 README 的 TUI 命令表。

## 经验与实验的不变量

- 无验证器、setup 失败或证据不足不能直接归因为编码失败；只有分类为 `eligible` 的观察才进入模型提炼。经验卡中的解释是附证据引用的假设，置信度不是实测效果。
- `prompt`、`skill`、`strategy` 候选都是文本指导，不是可执行扩展或自动安装的 Skill。不得改变任务、路径权限、验证器、setup、模型或工具权限。
- 对照与候选臂都必须重新运行，不得拿历史失败结果充当对照。冻结基线提交、任务、验证、setup、模型、思考级别、工具和策略；配置漂移或不完整证据不能判为有效提升。
- 晋升需要同仓库的 2–20 项不重复实验证据，覆盖至少两个不同任务，其中至少一个不是候选来源任务；每项至少 3 对完整运行，至少一项改善，且没有退化、越界或隔离失败。仅改任务 ID 不算新任务。
- 晋升和撤销要求明确人工确认 `--approve`，不能自动代替用户确认。晋升绑定候选快照、哈希和实验证据，仍不会自动注入日常会话。
- TUI 通过独立补充消息注入所选候选；实验通过任务提示末尾补充。消息布局和会话历史不同，实验收益不能直接视为日常 TUI 的同等收益。
- 撤销或停用只阻止后续注入，不抹除旧会话已有文本；需要干净上下文时新建会话。候选变更应产生新版本并重做评估，不手工篡改产物或回退损坏的晋升历史。
- 哈希检测损坏和版本不一致，不提供对本机攻击者的防篡改保证。固定验证命令也不代表测试文件不可修改；晋升时仍须检查各臂 diff 和验证器有效性。

## 构建、测试与开发命令

需要 Node.js >= 22.19.0；用 `npm ci` 安装锁定依赖。

- `npm run dev -- <repo> [--task "..." | --task-file ...] [--verify "..."] [--allow "..."]` — 通过 `tsx` 运行 CLI（交互模式需要 TTY）。
- `npm run check` — 严格 TypeScript 检查且不输出文件（`tsc --noEmit`）。
- `npm test` — 完整 Vitest 套件（`vitest run`）。
- `npm run test:coverage` — 将 V8 覆盖率报告写入 `coverage/`。
- `npm run lint` — 类型感知的 ESLint 规则。
- `npm run build` — 将可发布的 ESM 编译到 `dist/`（`tsc -p tsconfig.build.json`）。
- `node dist/cli.js --doctor <repo>` — 构建后的非交互式健康检查。
- `npm run dev -- <repo> --record --task-file examples/task.yaml`、`--list-runs`、`--show-run <runId>`、`--replay <runId>` — 受控评测工作流。

提交改动前请依次运行 `npm run check`、`npm test`、`npm run lint` 和 `npm run build`。

经验流程的命令示例（将大写 ID 替换为实际值）：

```powershell
npm run dev -- --analyze-run RUN_ID
npm run dev -- --list-experiences --json
npm run dev -- --show-experience EXPERIENCE_ID
npm run dev -- --experiment RUN_ID --candidate CANDIDATE_ID --pairs 3
npm run dev -- --list-experiments --json
npm run dev -- --show-experiment EXPERIMENT_ID
npm run dev -- --promote-candidate CANDIDATE_ID --evidence EXPERIMENT_ID_1 --evidence EXPERIMENT_ID_2 --approve
npm run dev -- D:\projects\my-repo --list-promotions
npm run dev -- --revoke-candidate CANDIDATE_ID --approve
```

分析合格失败可能调用模型；配对实验默认 3 对，最多执行 6 次模型任务，CLI 的 `--pairs` 范围为 1–20。此处次数指任务运行数，不是底层 API 请求数。查看命令不调用模型，`--json` 仅支持只读 list/show 类命令。除 `--list-promotions` 外，经验命令从证据恢复仓库，不附带工作区路径或执行参数覆盖；`--candidate`、`--pairs` 仅用于 `--experiment`。

`npm ci` 用于首次安装或同步锁定依赖，不是每次启动的必做步骤。仅修改文档时核对路径、命令、内容与 `git diff --check`；不以文档核对替代代码改动所需的检查，也不为文档更新启动付费模型任务。

## 编码风格与命名约定

遵循现有 TypeScript 风格：两个空格缩进、双引号、分号、ESM 并带显式 `.js` 导入说明符；变量/函数用 `camelCase`，类型/类用 `PascalCase`，文件名用 kebab-case（如 `task-spec.ts`）。在模块边界优先给出显式类型，类型专用导入使用 `import type` / `export type`（由 ESLint 强制）。保持 Promise 被妥善处理：`@typescript-eslint/no-floating-promises` 与 `no-misused-promises` 均为 error。

保留 `tsconfig.json` 中的严格编译保证：`noUncheckedIndexedAccess`（索引读取为 `T | undefined` —— 使用前先收窄）、`exactOptionalPropertyTypes`（绝不把 `undefined` 赋给可选属性；要么省略它，要么将该字段设为非可选）。`verbatimModuleSyntax` 已开启，因此类型专用导入必须用 `import type`。

## 测试指南

使用 Vitest，以描述性的 `describe`/`it` 块组织，并显式 `import { describe, expect, it } from "vitest"`。文件命名为 `<behavior>.test.ts`，优先复用 `test/helpers/git-repository.ts` 搭建 Git 夹具，而不是重复造轮子。

- 每个缺陷修复都需要一个修复前会失败的回归测试。
- 涉及路径/命令策略、工作区/worktree 处理、验证、中止处理、setup 或报告的改动，必须**同时**覆盖允许/接受与拒绝/失败行为（例如受保护的 `.git`/`.env*`/`node_modules` 路径、工作区外路径、`--task`+`--task-file` 冲突、未配置验证命令的运行、setup 失败后的清理）。
- 不强制数值覆盖率门槛，但不得降低所改动逻辑的有效覆盖率。
- 经验改动覆盖：无验证器/证据不足时跳过生成、来源模型不可用、生成失败与非法 JSON、未知证据引用、候选哈希不匹配、脱敏与终端控制字符处理。
- 实验和晋升改动覆盖：新鲜配对与配置隔离、部分失败/超时/中止后的清理、指标重算、证据损坏、跨任务门槛、人工确认、并发锁及撤销历史；TUI 覆盖默认关闭、跨仓库拒绝、每轮复核与会话切换。
- 测试优先注入模拟模型/运行时，并使用临时仓库和隔离数据目录；真实模型实验须有任务授权，单独报告实际调用、费用与证据限制。

## 安全与配置

把 worktree、`allowedPaths` glob 与命令过滤视为降低误操作风险的护栏，而非沙箱。交互模式默认启用 Shell；危险命令（如 `rm`、`Remove-Item`、`git clean`）在进程启动前需要一次人工审批，record/replay 则直接拒绝。提权、系统级操作与写入 Git 历史始终被拒绝。保持通用 shell 访问可通过 `--no-shell`/`--unsafe-shell` 控制，绝不放宽永久拒绝项，并在任意层级保护 `.git`、`.env*` 与 `node_modules`。

扩展是拥有进程自身权限的可执行代码——绝不要假定它们受策略约束。绝不要把真实凭据、模型 token 或 API 密钥加入代码库、测试或示例。运行期数据与 Pi 认证（`agent/auth.json`）位于被 Git 忽略的 `.picoding/` 目录下；测试与受控运行应使用 `PI_TUI_AGENT_DATA_DIR` 指向隔离的临时数据目录，而不是默认位置。改动脱敏或 trace 逻辑时，务必验证密钥不会泄漏进 `trace.jsonl`、`verification.json` 或报告。

## 提交与拉取请求

遵循 Conventional Commit 规范（`feat: ...`、`fix: ...`、`refactor: ...`、`test: ...`）。提交保持聚焦。拉取请求应说明意图与风险、列出已运行的验证命令（`npm run check`、`npm test`、`npm run lint`、`npm run build`）、关联相关 issue，并仅在 TUI 输出有变化时附终端截图。安全边界、会话格式或 manifest/schema 兼容性改动必须显式说明。

## 路径策略更新（2026-09-07，覆盖上文旧路径限制描述）

- 文件工具和策略扩展不再执行工作区包含性或 `allowedPaths` glob 限制；支持绝对路径、父目录、跨目录和跨目录符号链接。Shell 允许跨目录 `cd`。
- `allowedPaths`、`allowed_paths`、`--allow` 保留旧输入兼容，但不再限制操作；`/allow` 仅提示已取消。验证器只对受保护文件变更执行拒绝审计，不再按白名单拒绝。
- `.git`、`.env*`、`node_modules` 写保护、敏感读取保护、多硬链接写保护和危险命令审批继续生效。符号链接检查用于保护真实目标，不用于目录隔离。
- 所有运行模式一致；worktree 不是文件系统隔离。报告仅覆盖启动仓库，不能证明目录外没有副作用。策略版本为 2，旧策略来源需重新记录后再做配对实验。

## 命令策略诊断更新

- 当前 `PROMPT_POLICY_VERSION` 为 3。`format-command.ts` 识别磁盘格式化调用位置，保留其拒绝规则，不再把普通 format 路径或变量当成命令。
- `command-policy.ts` 为拒绝和审批规则返回稳定 `ruleId`；`command-diagnostics.ts` 统一返回脱敏原因和命令预览。`recorder.ts` 在 `tool_end.data.policyFailure` 记录可通过 `toolCallId` 关联的策略错误，不保存普通命令正文。
- 修改时同时验证真正危险调用仍拒绝、普通格式化代码被接受、预览脱敏和长度边界、trace/result 无测试凭据泄漏。不能将命令扫描描述为完备沙箱。

## 普通目录交互更新（2026-09-08，覆盖上文 Git 前置与会话归组描述）

- 全局 `picode` 与 `pi-agent-tui` 共用入口。普通交互经 `prepareReadyCurrentWorkspace` → `prepareCurrentWorkspace`，只要求目标为存在的目录；支持非 Git 目录、无提交仓库和仓库子目录，不自动初始化 Git。
- `workspace.workspace` 始终保留启动目录；Git 可用时 `sourceRoot` 为仓库根目录，否则为启动目录并设置 `gitUnavailable: true`。交互模式缺少提交时 `baselineCommit` 为空字符串，不伪造提交。受控 `prepareWorkspace` 仍严格要求 Git 和有效提交。
- 交互会话按 `workspace.workspace` 归组，父子目录相互独立；原仓库根目录会话不迁移，继续从原根目录恢复。工具、setup 和验证命令使用实际工作目录，Git 变更审计与 `/diff` 文件列表使用整个仓库的根目录相对路径。
- 只有交互宿主显式开启 `allowUnavailableGit`：Git 审计失败时仍保存命令结果与报告，设置 `changeAuditUnavailable: true`、`success: false`；空文件数组此时代表未知，不能描述为零变更或无受保护文件变更。受控验证仍遇审计失败即拒绝。
- `--doctor` 按普通交互的可用性检查；Git 不可用只是可选能力缺失。非 Git 目录不加载仓库晋升候选。文件写保护和危险命令审批保持生效。

## 模型环境配置更新（2026-09-08）

- `src/model-config.ts` 统一读取安装目录 `.env`，系统环境变量 `PICODE_ENV_FILE` 可指定路径；同名系统变量优先。`src/runtime/model-configuration.ts` 接入交互、受控运行和 doctor，经验提炼共享认证/地址配置并使用独立上限。
- `.env`、`.env.*` 忽略 Git，仅 `.env.example` 作为公开模板例外。模型密钥只进入内存运行时和脱敏注册表，不自动注入 `process.env` 或回写 Pi 认证文件。不能打印完整配置对象。
- `PICODE_MODEL_REQUEST_TIMEOUT_MS`、`PICODE_MODEL_MAX_OUTPUT_TOKENS` 与 `PICODE_MODEL_TASK_TIMEOUT_MS` 分别控制单次请求、单次输出和代理任务阶段；`PICODE_SYNTHESIS_*` 控制经验提炼。不宣称单次输出上限等于整个任务累计预算。
- manifest 的可选 `agent.modelConfig` 保存三个上限及地址指纹，重放恢复上限并校验地址/能力，实验与比较校验快照；无快照旧证据需重新记录。凭据始终从当前机器配置获得，不写入 manifest。
- `PROMPT_POLICY_VERSION` 现为 `4`。只有最终路径组件精确为 `.env.example` 时允许模板读写；受保护祖先、链接真实目标和多硬链接保护仍生效。
- Vitest 的 `test/helpers/model-env.ts` 将配置指向公开模板并清除本机模型覆盖项，避免测试加载用户真实密钥。新增测试应使用隔离配置、本机模拟 HTTP 服务和假密钥；验证真实请求参数与取消行为，不调用付费模型。

## 成功与失败复盘更新（2026-09-08，覆盖上文仅失败提炼描述）

- `classifyRun` 统一筛选成功/失败；默认成功调用阈值 6，可通过 `--min-success-tool-calls` 配置（0–10000）。有证据的工具失败后成功动作可绕过低调用筛选。`--force-review` 只影响低调用筛选，不能绕过验证器、完成状态、setup 或成功动作证据门槛。
- `--analyze-run` 默认 proposer；`--review-mode critic` 追加一次独立无工具审查；`compare` 保存同一 proposer 输出的两个经验产物，返回 critic 产物 ID。`--show-review-comparison ID [--json]` 为只读，不调用模型。
- 新经验 schemaVersion=2，兼容旧版读取。允许零候选并保存 noCandidateReason；不能要求模型为了凑数而生成经验。critic 只接受/拒绝原提案；解析、引用或请求错误必须保留审查状态与已知 usage，并禁止候选放行。
- `review.ts` 管理审查输入/决策及提案绑定；`review-comparison.ts` 验证 proposer 产物和来源 run，读取并核验实验，比较筛选前后同批候选。缺失实验与费用显示未知；拒绝率不能当有效率，回顾性可避免费用不等于实际节省。
- 记录器保留最多 1000 字符的脱敏工具文本摘要，排除图片、任意 details 和模型思维链；经验材料仍限制 80 条/32000 字符，优先保留验证与失败恢复。旧 trace 没有记录的动作结果不可推测。
- 现有实验/晋升门槛不变：计费、token、耗时虽可查看，但效率变化不单独触发 observed_improvement。对同批候选共享实验结果的比较不能改变晋升对候选 ID 和跨任务证据的要求。
- 本阶段没有常驻后台队列、自动 TUI 订阅、自动经验注入或 skill 安装。复盘入口可由外部后台调用；重复分析产生新记录。真实模型收益需额外的真实实验，不得用模拟测试证明 critic 有效。
