# SWE 经验沉淀与泛化实验：会话交接

更新日期：2026-09-20。工作区：`D:\Agent`。会话 ID：`01a08e8b-456a-7f82-a310-066d4ab8324b`。

## 1. 接手结论

本会话已完成 Mini 50 题的 R0/B 实验，以及 Mini 外 40 题的无经验/经验库对照，共计 180 次任务运行。历史批次不需要重启。后续用户主要在询问经验生成链路、critic 和 TaskSpec；最新要求是生成本交接文档，没有要求启动新实验。

2026-09-20 只读核验结果：

- Mini：`batch.status=completed`，R0 50 次、B 50 次。
- Holdout：`batch.status=completed`，40 题、80 次运行。
- 冻结库包含 39 条 Mini 首候选，40 道新题均有冻结检索记录。
- Holdout 的 `agent-data/experiences/` 为空：新 40 题没有自动复盘、生成或更新经验。
- 80 份 manifest 均有 TaskSpec；每题两组 `task.sha256` 相同。
- 自动跟进 `swe` 已暂停，配置中的 `status=PAUSED`；当前 goal 查询没有活动目标。
- 写本文档前 `git status --short` 为空。当前 HEAD 为 `83746aa`（2026-09-17）；它不是历史实验启动时的源码版本。

## 2. 用户目标与实验边界

用户希望验证：任务完成后总结的经验、策略或提示，是否能提高修复成功率、降低 Token 消耗，并迁移到新题。

实验分两步：

1. **Mini 同题复用**：R0 先做 50 题，基于 R0 复盘，再让 B 使用对应题目的冻结经验重做同样的 50 题。它不能单独证明泛化。
2. **新题泛化对照**：排除 Mini 题目后固定 40 道新题，每题各跑无经验组 `control` 和经验库组 `experience`。两组均为新运行，按题交替执行先后顺序；测试期间不学习新题。

重要约束：不更换失败题、不缩减题数、不放宽评分、不把普通模型失败当设施故障重跑、不用历史失败代替新鲜对照。完整评分与不完整用量必须分开处理，未知费用不能补零。

## 3. 实测结果及允许的表述

### Mini：50 题

| 指标 | R0 | B |
| --- | ---: | ---: |
| 通过数 | 36/50 | 36/50 |
| 通过率 | 72% | 72% |

4 题改善、4 题退化。50 次复盘处理为 39 次提炼完成、9 次提炼失败、2 次因执行异常跳过。不能把 48 个复盘记录目录等同于 48 条有效经验。

### Holdout：40 题

| 分组 | 无经验组 | 经验库组 | 改善 / 退化 |
| --- | ---: | ---: | ---: |
| 全部新题 | 31/40（77.5%） | 35/40（87.5%） | 5 / 1 |
| 原仓库新问题 | 16/20（80%） | 18/20（90%） | 2 / 0 |
| 新仓库问题 | 15/20（75%） | 17/20（85%） | 3 / 1 |

整体净增 4 题，即增加 10 个百分点；共同成功 30 题，共同失败 4 题。

| 效率口径 | 对数 | 无经验 Token | 经验库 Token | 变化 |
| --- | ---: | ---: | ---: | ---: |
| 两组用量均完整 | 39 | 27,106,096 | 29,492,859 | +8.81% |
| 两组均成功且用量完整 | 29 | 15,011,257 | 18,176,280 | +21.08% |

39 对完整用量的记录费用分别为 `0.333501112`、`0.3589875464`，增加约 7.64%。费用沿用 SDK `usage.cost`，没有核对服务商账单，也不包含 Mini 经验构建、宿主成本或其他开销。Token 包含缓存读取。`sphinx-doc__sphinx-9658` 无经验组用量不完整，整对从效率比较中排除，但其修复评分仍计入成功率。

允许表述：**本次单次配对观察中，经验组成功率较高，但未观察到 Token 或记录费用节省。** 每题每组只运行一次，不能排除随机性，也不能确认稳定泛化收益或单条经验的因果贡献。

## 4. 必须保留的源码审计限制

实验于 2026-09-13 在后台进程 PID 20584 中运行，最终正常结束并释放批次锁。运行期间其他工作修改了交互扩展及 `package-lock.json`，整仓源码哈希与冻结协议不一致。

当时进一步核验：受控评测入口的 30 个本地运行依赖，与交互修改前的提交 `1c3897c` 相比，规范化换行后没有内容变化，且未发现动态导入。它支持“未发现受控本地代码链路变化”，但不能还原原始整仓字节快照，也不能证明所有外部依赖和运行环境绝对未变。

- `final-audit.json` 明确记录 `strictWholeTreeAuditPassed=false`。
- 不能通过修改协议哈希、删除告警或重写旧记录，让历史实验变成“审计全部通过”。
- `audit.json` 中的 `complete` 表示运行数和批次状态完成，不等于 `problems` 为空。
- 历史审计文件有生成时间。今天的源码已有新增功能，重跑基于当前源码的旧审计脚本可能得到更多漂移；不要覆盖历史审计后将新结论冒充当时结论。

## 5. 数据与证据位置

所有路径均相对于 `D:\Agent`。`.picoding` 是本机运行数据，不应假设克隆仓库后就有这些产物。

| 路径 | 用途 |
| --- | --- |
| `.picoding/benchmarks/swe-mini-r0-b-v1/` | Mini 原始批次 |
| 上述目录的 `agent-data/experiences/<experienceId>/experience.json` | 原始复盘，含证据、候选、生成状态及来源绑定 |
| 上述目录的 `guidance.json` | 每题冻结的首候选 |
| `.picoding/benchmarks/swe-holdout-v1/` | 40 题对照批次，以下文件均在此目录 |
| `library.json` | 39 条冻结经验及来源 ID、哈希 |
| `retrieval.json` | 40 题检索命中、分数及实际注入候选 |
| `catalog.json`、`source-catalog.json` | 新题与来源 Mini 题目清单 |
| `protocol.json`、`effective-model.json` | 冻结协议及模型快照，不含密钥 |
| `batch.json` | 两组运行、评分、用量及终态 |
| `summary.json`、`report.md` | 汇总统计与含限制说明的最终报告 |
| `agent-data/runs/<runId>/` | manifest、trace、结果、补丁、benchmark 元数据、trial |
| `logs/run_evaluation/<runId>/picode/<instanceId>/` | 非空补丁的官方评分报告和测试输出 |
| `final-audit.json`、`audit.json` | 最终及逐运行核验；必须同时看告警 |
| `preflight-audit.json` | 40 题基线失败、标准补丁通过的证据索引 |
| `source-drift-audit.json`、`runtime-closure-audit.json` | 源码差异与运行依赖核验 |
| `network-fixture-recovery.json` | Requests 评分网络环境修复记录 |

最终报告：[report.md](../../.picoding/benchmarks/swe-holdout-v1/report.md)。

## 6. 实际经验沉淀链路

```text
Mini R0 运行并记录
→ 跳过评分未知 / 执行异常的运行
→ analyzeRun 加载运行并收集证据
→ classifyRun 判断是否有资格提炼
→ proposer 独立模型请求，输出经验卡和最多 3 个候选
→ 校验 JSON、引用、来源及哈希，保存 experience.json
→ 每题固定取首候选，冻结 guidance.json
→ Mini B 同题复用
→ 汇总 39 条首候选到 library.json
→ 新题 BM25 检索，经验组追加文本指导
```

- `src/benchmark/swe-mini-cli.ts` 明确使用 `reviewMode: "proposer"`、`minSuccessToolCalls: 0`。
- 成功和失败都可提炼，但不能绕过验证结果、完成状态及动作证据门槛。
- `src/experience/evidence.ts` 最多提供 80 条、32,000 字符证据，优先保留验证问题和失败恢复，进行脱敏并保留引用位置。
- `src/experience/synthesizer.ts` 独立请求来源模型，不执行工具、不加载资源；允许没有合格候选。经验卡中的解释是有证据引用的假设。
- `src/experience/service.ts` 保存成功、失败或跳过状态；失败候选不放行。
- `src/benchmark/swe-mini.ts` 的 `freezeGuidance` 固定选择首候选，没有根据 B 轮输赢反向挑选。
- `src/benchmark/swe-holdout-cli.ts` 校验首候选与原始经验、来源 R0 运行绑定后冻结 39 条。
- `src/benchmark/swe-holdout.ts` 使用固定 BM25（k1=1.2，b=0.75），至少匹配两个有效词，最多 3 条、9,000 字符；仅用公开仓库名和问题描述检索，不调用模型。

这不是模型权重训练，也不是自动安装 Skill；39 条是首候选合集，不是已经合并去重、验证每条贡献后的成熟知识库。没有自动晋升到日常 TUI，也没有在 40 题测试中持续更新。

## 7. critic：已解释，但本批次未使用

当前 `src/experience/review.ts` 支持另一次无工具模型请求，读取 observation、原始证据、经验卡及最多三个提案。它检查证据支持、因果夸大、答案记忆、适用范围、反例、空泛建议和削弱验证/权限的行为。

每条提案必须恰好有一次 `accept` 或 `reject`，附具体理由和有效证据引用；critic 不能重写或新增提案。程序只保留被接受的原候选。请求、格式或引用校验失败会保存失败状态及已知用量，本次不放行候选。独立指独立请求和提示，默认仍是同一来源模型；接受只代表允许进入实验，不证明有效。

`analyzeRun` 的 `critic` 模式是“先 proposer，再审查”；`compare` 对同一次新 proposer 输出保存筛选前后两个产物。**直接重新 analyze-run 不等于只审查现有冻结的 39 条候选**，因为会重新生成提案。若后续要比较现有 V1 与 critic V2，应先设计对既有候选的绑定和独立版本输出，避免混淆提炼变化与审查效果。

用户曾追问为何没启用 critic。本会话已说明：这是当时选择的简化实验配置，并非必然要求；应该提前说明这一选择。不要改称“critic 不支持”或“critic 已执行失败”。用户目前没有授权一个新的 critic 付费批次。

## 8. TaskSpec：已生成，嵌入 manifest

`src/benchmark/swe-run.ts` 的 `runSweTask()` 按固定模板调用 `parseTaskSpec()`，并经 `RunRecorder.create()` 保存。

- `id`：SWE instance ID。
- `objective`：统一修复要求及原始问题描述。
- `allowedPaths`：兼容字段，默认 `**/*`，当前不作为路径隔离。
- `verify`：`swebench-official-evaluation` 标识，记录超时 300,000 ms。
- `doneWhen`：修复问题并保留既有行为。
- 内容和哈希在每份 `manifest.json` 的 `task.content`、`task.sha256` 中。

没有单独导出 40 个 TaskSpec YAML。两组使用相同 TaskSpec，经验通过 `renderCandidatePrompt()` 追加到任务提示，不修改任务规范。官方评分由 `scorePatch()` 收集补丁后独立执行；verify 名称不是直接运行的 Shell 命令。

2026-09-17 增加的通用验证修复闭环，不应追溯到此次 9 月 13 日批次。当前 AGENTS.md 也明确 SWE 官方评分流程保持独立。历史 TaskSpec 缺少 `maxRepairAttempts` 时不能补字段改变哈希。

## 9. 已处理故障与验证边界

- GHCR 镜像下载失败：在确认停止后恢复已有准备进度，40 张镜像及所有预检最终完成。
- Requests 测试假设 `10.255.255.1` 连接超时，但本机 Docker 环境实际快速连接成功。修复局限于评分容器网络命名空间，通过 `network_fixture.py` 配置目标路由并验证真实超时，保留 `SCORER_TARPIT_CONNECT_TIMEOUT_OK` 标记。没有放宽断言或修改任务容器权限；缺失标记按设施失败处理。
- 40 题均核对红/绿预检；Requests 的 9 次非空补丁评分有成功标记，另 1 次为空补丁失败，不存在测试输出是预期情况。
- 用量缺失保留 `usageComplete=false`；不能因为最终重试成功就认定之前缺失的用量为零。
- 原实现阶段曾通过 TypeScript 检查、39 个文件/387 个测试、lint、build；后续 Python 环境修复有 8 项测试及真实红绿预检。这些是历史验证结果，不代表当前 HEAD 已在本次文档工作中重新测试。

## 10. 后续接手方式

本交接任务只写文档，不调用模型、不重跑实验、不晋升经验。阅读入口：`docs/swe-mini-r0-b.md`、`docs/swe-holdout.md`，随后查看对应批次 report、summary、final-audit 和原始运行。

后续若用户要求新实验：

1. 保留 Mini、Holdout、冻结库及历史审计原件，新版本写到独立目录。
2. 先说明验证目标：critic 筛选效果、单候选贡献、复盘新 40 题，三者不是同一个实验。
3. 若复盘新 40 题，它们从此属于学习材料，不能再作为新经验库的未见测试集。
4. 用独立执行快照固定源码、实际依赖、任务、模型和评分器，避免再次发生并发工作区漂移。
5. 不以拒绝率替代经验有效率，不用模拟测试证明真实模型收益，不把一次成功率差异写成稳定提升。

当前仓库还存在 `docs/swe-candidate-audit.md`、`src/benchmark/swe-candidate-cli.ts` 和批次 `.picoding/benchmarks/swe-candidate-2d5f07e8-ab-20260916/`。这些属于后续其他工作；本次只确认其存在及文档说明，未审核其结果。不能将它们自动并入本会话的 80 次运行或推断已完成晋升。

自动化 `swe` 保持暂停；不要仅因读到旧锁文件路径、旧 PID、旧“继续跟进”消息就恢复调度。需要查看运行状态时优先读取批次 JSON；PID 必须结合启动时间和命令确认，历史 PID 可能复用。保护其他 Docker 容器，不进行全局清理。严禁输出 `.env` 或认证内容。
