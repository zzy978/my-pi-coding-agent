# Prettier 真实修复与失败经验流程交接

日期：2026-09-07。项目：`D:\Agent`（pi-tui-coding-agent）。

## 1. 当前结论与目标

用户的目标是通过真实项目修复，收集失败证据、分析失败模式、生成策略，再用新鲜配对实验验证迁移收益。Exercism 困难题曾全部通过，区分度不足，因此接入 SWE-PolyBench Verified 中的 10 个 Prettier 历史缺陷。

本次交接只新增文档并做只读核对，没有启动模型任务，没有修改历史运行或候选文件。

- 用户最新反馈：10 题已有 9 题至少通过一次验证，“还没有出错”。
- 本次从 `D:\Agent\.picoding\prettier-real-v1\runs` 的 manifest/result 核对到 9 个不同任务存在 `verification_passed`，尚未找到 `8046` 的通过记录。
- 这是累计跨版本的至少一次成功，不是同版本单轮 90% 通过率，也不是策略带来提升的证明。“还没有出错”不能理解为历史上从未失败或当前所有尝试均通过。
- 当前源码 `PROMPT_POLICY_VERSION = 3`。本次开始时 `git status --short` 为空；HEAD 为 `a115bfb`（支持跨目录读写，不再被启动目录限制）。
- 当前仍未得到本会话候选的有效跨任务晋升证据。不要自动晋升或启动付费重跑。

## 2. 最新策略必须优先于历史讨论

以当前 AGENTS.md 末尾“路径策略更新”和“命令策略诊断更新”为准；前文旧白名单/工作区包含性描述已被覆盖。

1. 文件工具允许绝对路径、`../`、跨目录读写和跨目录符号链接；Shell 允许跨目录 `cd`。
2. `allowedPaths`、`allowed_paths`、`--allow` 只保留输入兼容，不限制操作；`/allow` 仅提示已取消。验证器不按白名单拒绝变更。
3. `.git`、`.env*`、`node_modules` 写保护、敏感读取保护、多硬链接写保护及危险命令审批仍有效。真实符号链接目标仍需检查。
4. worktree 不是文件系统沙箱；报告只覆盖启动仓库，不能证明外部目录没有副作用。
5. `format-command.ts` 识别磁盘格式化调用位置，普通 format 路径或变量不再按旧规则直接拒绝。
6. `command-policy.ts` 返回稳定 `ruleId`；`command-diagnostics.ts` 提供脱敏原因和命令预览；`recorder.ts` 将策略失败写入 `tool_end.data.policyFailure`，用 `toolCallId` 关联。普通命令正文仍不保存。
7. 旧策略来源需重新 record 后再用于当前策略配对实验。不能手改 manifest 版本或哈希来绕过版本检查。

相关源码：`src/policy/path-policy.ts`、`safe-tools.ts`、`command-policy.ts`、`format-command.ts`、`command-diagnostics.ts`、`src/task/task-spec.ts`、`src/evaluation/recorder.ts`。

## 3. 文件与数据位置

| 用途 | 绝对路径 |
|---|---|
| 代理源码 | `D:\Agent` |
| Prettier 源仓库 | `D:\prettier-real-v1` |
| Prettier 独立运行数据根 | `D:\Agent\.picoding\prettier-real-v1` |
| 运行证据 | `D:\Agent\.picoding\prettier-real-v1\runs\RUN_ID` |
| 经验与候选 | `D:\Agent\.picoding\prettier-real-v1\experiences` |
| 实验证据 | `D:\Agent\.picoding\prettier-real-v1\experiments\EXPERIMENT_ID` |
| 基准脚本/清单/历史汇总 | `D:\Agent\.picoding\benchmarks\prettier-real-v1` |
| 容器验证原始输出 | `D:\Agent\.picoding\benchmarks\prettier-real-v1\evaluations` |
| 前一份交接 | `D:\Agent\docs\handoffs\2026-09-06-experience-learning-session.md` |

基准目录有 `prepare.mjs`、`run.mjs`、`verify.mjs`、`adapter.mjs`、`v2/`、`catalog.json`、`batch.json`、`report.mjs`、`summary.json`、`report.md`、`audit.mjs`、`使用说明.md`。

重要：`summary.json` 目前仍是 9 月 6 日首轮 2/10 的历史汇总；不能当成最新累计结果。旧 run.mjs 有跳过已完成记录的逻辑，不能假定再次执行它就会按当前策略重录所有任务。

这些脚本和运行产物位于被 Git 忽略的 `.picoding`，普通 clone 不包含它们。不要分享 `agent` 中的认证文件。`upstream-private.json` 含参考补丁，不作为模型任务上下文；放宽路径后需另行核对评测答案泄漏风险，不能仅凭路径护栏声称答案不可访问。

## 4. 已核对的成功记录

下面每题列一条成功记录；是 manifest/result 的只读核对，不是重新执行测试或完整重审补丁。

| 任务 | 问题 | 成功 Run ID | 策略版本 |
|---|---|---|---:|
| 11000 | CLI 目录尾斜杠 | f909e574-aa60-48ef-bcf2-1522609ca1b5 | 2 |
| 12930 | TypeScript enum 计算键 | 206ac4dc-2c1e-43e4-9634-878487d989f4 | 3 |
| 9850 | prettier-ignore 分号 | 286f6f0e-f82d-44e2-849c-fddc4f94e1dc | 3 |
| 8777 | 未打印注释错误 | 5c805ee6-6e1a-4dc9-975e-b9a327fa213d | 3 |
| 8046 | babel-ts 类型断言崩溃 | 尚未找到通过记录 | — |
| 6604 | TypeScript 类型括号 | eed05141-a7bf-48d7-833c-5ed43196e022 | 3 |
| 5025 | Markdown 长脚注 | 10c91da1-ccb5-498a-b811-68a410fdcbe1 | 3 |
| 11637 | SCSS @use 换行 | 902e7df2-dff7-4c07-b2ab-21ac082973c1 | 3 |
| 3515 | CLI --write 日志级别 | a8b78f0b-9af4-45d1-b32c-8d8141faaf52 | 2 |
| 3436 | 联合/交叉类型括号排版 | 9fc0e4e4-d6b8-4e2f-a8e1-f6fd8adb6e2d | 3 |

过去基准准备已确认每题原始代码红、参考补丁绿，共 172 项所选测试；不代表 Prettier 完整测试套件。官方镜像格式：`ghcr.io/timesler/swe-polybench.eval.x86_64.prettier__prettier-N:v1.1`，需 Docker Desktop Linux 引擎。

首轮正式运行模型为 `deepseek/deepseek-v4-flash`、high、无候选注入，结果 2 通过/8 失败，8 个失败均无最终源码 diff。正式 SDK 费用约 $0.13978807，另 3 次排查尝试约 $0.01147386，合计约 $0.15126194。这只是首轮历史费用，不含后续重跑、分析和实验。

最初前 5 题为 learning、后 5 题为 holdout。若使用留出题的错误调整策略，应披露已参与开发，不能继续当作未见任务。

## 5. 经验生成的改动与诊断

当前 `src/experience/synthesizer.ts`：`reasoning: high`、`maxTokens: 16_000`、120 秒超时；`service.ts` 记录 `thinkingLevel: high`。旧经验文件不会自动更新。

曾遇到两种错误：

- `Generator did not return a complete text answer (length)`：当时输出恰好 8,000 token，上限导致截断；后来提高预算。
- `Synthesis output is not strict JSON`：返回文本 JSON 解析失败，不能由该报错认定没有策略。原始回答未保存，无法追溯确切格式错误。

已按用户批准实现有限兼容：`parseSynthesisOutput` 接受纯 JSON，或包住整个响应的三反引号 `json`/无标签围栏（标签大小写兼容）。候选 content 使用 Markdown；围栏外解释、多块、YAML、损坏 JSON 仍拒绝。仍校验字段、引用、长度和敏感信息，不自动修复截断文本，不引入自动模型重试。

测试文件：`test/experience-format.test.ts`、`experience-service.test.ts`、`experience-synthesizer.test.ts`。当时相关 36 项通过，check/lint/build 通过；全套 246 项中 245 项通过，真实 npm ci 工作区测试发生 30 秒超时及清理超时，该项单独复跑通过。这是当时的证据，不代表 9 月 7 日新策略已在本次交接重新跑过全部测试。

历史 `thinkingLevel: low` 且 `synthesis.status: skipped` 的记录可能只是旧配置元数据，尤其 `no_verifier` 观察根本未调用模型；查看时先确认 createdAt、sourceRunId 和数据目录。

## 6. 关键经验与旧配对实验

来源任务：12930。旧来源运行：`fbf702d0-2120-43e4-b280-d9b6bc77f83e`（策略 1）。

已成功生成的经验 ID：`48ee30e5-31a4-457c-ab83-d9d68865a49c`，high，包含三个候选：

| 候选 ID | 说明与评价 |
|---|---|
| 932f992c-ff8f-47ed-9d0c-5bc3b7e31c03 | 先落盘再验证；错误地阻止空 diff 时基线验证，且写死本题命令，不建议直接采用 |
| 24bd31e2-6aca-498d-81d6-0db1b6de4ad6 | 工具错误恢复；同样限制空 diff 验证，并有环境推断，需修订 |
| 48380908-3ff2-4af6-92f3-7552b82e812c | 根据快照修复 enum 计算键；可作来源题探索，但高度题目特定，不能直接当成通用策略 |

第三候选哈希：`a95d5befae779db9dec6bd260651929e518e8940c639400a30b03b5841473697`。

旧实验：`8ff9f72a-9520-45c3-a6b9-273e7918b8a5`，计划 3 对，实际只完成 1 对，结果 inconclusive：

| 顺序 | Run ID | 结果 |
|---|---|---|
| 第 1 对 control | a37873f6-ed78-45a2-aadf-1ad0ec9c3195 | 无 diff，验证失败 |
| 第 1 对 treatment | e941c9a4-f54d-4a1f-9bf8-116fc1c139d8 | 无 diff，验证失败 |
| 第 2 对 treatment | ec65c88e-eacf-46b2-8a23-79f45969a4cc | 约 15 分钟后 execution_failed，Experiment model phase timed out，未最终验证 |

随后清理抛出 `Could not remove unused worktree:`，覆盖了实验层原执行错误。旧 Git 检查曾有 prunable 残留；本次未清理，也未确认该残留当前是否仍在。

当前 `src/workspace/git.ts` 的清理仍用 120 秒 `git worktree remove --force`，异常仅拼 stdout/stderr；应继续检查 `src/experiment/service.ts` 的 finally 异常是否仍覆盖原错误，不能假定已修好。该旧实验不得用于晋升。

## 7. 空 diff 的证据边界

此前三次实验都没有 edit；第 1 对 treatment 唯一 write 是工作区外 Windows Temp 中的 inspect.js，调用失败；其他运行只见 read/find/grep/ls/powershell。旧规则允许源码路径，但拒绝外部临时脚本及根目录 inspect.js，且正常 format 路径和进入自身 worktree 的绝对 cd 被误拦截。

所以历史证据支持“探索/调试受到限制”，不支持“模型尝试修改合法源码时被权限拒绝”。Shell 正文被省略，不能断言不存在 Shell 写入尝试。当前策略已变化，不应再照搬旧诊断作为当前事实。

旧 trace 不含完整工具结果；当前新增 policyFailure 只改善策略错误诊断，不等于保存完整对话。经验证据收集是否将新增 policyFailure 送入模型，接手时需检查 `src/experience/evidence.ts`，不能只因 recorder 有字段就认为经验模型能看到。

## 8. 接手后的顺序

1. 读取当前 AGENTS.md，核对 Git 状态和策略版本，不覆盖现有工作。
2. 核对 8046 的最新运行与用户进度，明确是未完成、仍失败还是后来已通过；不要直接启动新批次。
3. 建立按任务、策略版本、run ID 区分的最新结果表，避免旧 summary.json 的 2/10 与累计 9/10 混淆。
4. 若继续验证策略，使用当前策略的新来源记录；同一实验两臂冻结同一环境，不能把旧策略失败当新对照。确认候选适用性，修订必须产生新版本并重新评估。
5. 优先处理剩余可观测性问题：原执行错误与清理错误都保留，清理错误包括退出码/超时状态，policyFailure 进入有界脱敏经验依据。
6. 复核新策略下的答案隔离与目录外副作用边界，再把成功记录作为评测结论。不能把“没有宿主报错”“至少成功一次”“策略有效”混为一谈。

晋升仍需同仓库至少两个不同任务（含非来源任务）、每项至少 3 对完整实验、有改善且无退化等门槛，并由用户明确 `--approve`。晋升后不自动注入，需 TUI `/experience use CANDIDATE_ID`。

## 9. 常用命令

以下为 PowerShell。新终端需重新设置独立数据目录，否则会看到默认 `.picoding` 下的其他历史记录。

```powershell
cd D:\Agent
$env:PI_TUI_AGENT_DATA_DIR = 'D:\Agent\.picoding\prettier-real-v1'
npm run dev -- --list-runs --json
npm run dev -- --show-run 206ac4dc-2c1e-43e4-9634-878487d989f4
npm run dev -- --list-experiences --json
npm run dev -- --show-experience 48ee30e5-31a4-457c-ab83-d9d68865a49c
npm run dev -- --show-experiment 8ff9f72a-9520-45c3-a6b9-273e7918b8a5
```

上述只读命令不调用模型。`--analyze-run` 可能调用模型；`--experiment NEW_RUN_ID --candidate CANDIDATE_ID --pairs 3` 最多运行 6 次模型任务，并非 6 次底层 API 调用。不要再直接复制旧策略来源 ID 作为新实验。

本次没有提交文档、修改经验文件、启动付费模型、清理 worktree 或更新记忆库。
