# Session Handoff：失败经验提炼与配对实验

更新日期：2026-09-06。仓库：`D:\Agent`（pi-tui-coding-agent / pi-agent-tui）。

## 1. 接手摘要

本次会话已完成“记录失败 → 提取证据 → 生成经验与候选 → 新鲜配对实验 → 人工晋升 → TUI 按需使用 → 撤销”的工程实现和离线验证。尚未完成真实模型收益验证，也没有接入外部 benchmark。

写本文档前，工作树干净，HEAD 为 `12e42c8`，提交内容为失败经验提炼、候选、实验、晋升与撤销功能。没有核查远端推送状态。本轮只新增交接文档，不修改实现、不运行付费模型、不提交或推送。

用户最后的业务问题是：没有现成失败经验或值得复现的评测，应该怎样测试，GitHub 上有哪些可直接利用的资源？对此已给出分层测试建议；下一项开发尚未被授权。当前明确请求仅为整理本 session 的 handoff。

## 2. 目标、决策与范围

最初目标：将评测与重放中的失败过程沉淀为历史经验，分析失败模式，生成策略、skill 或 prompt 候选。

用户明确决定：借鉴已有研究的做法应用到项目即可，不再追求额外算法创新。讨论中的参考包括 Reflexion 的反思记忆、ExpeL 的跨任务经验、Voyager 的技能库、GEPA 的轨迹反思与 prompt 评估，以及 ReasoningBank 的经验蒸馏。

本项目是对这些思路的工程借鉴，不是逐篇论文的完整复现，也不是训练或微调模型。

关键决策：

- 保留评测与 replay 为独立基础设施；生成候选不能替代效果验证。
- 先做有证据引用的文本指导，不自动执行生成代码或安装全局 Skill。
- 先固定变量、重新跑对照，再讨论收益；不拿历史失败充当对照。
- 晋升必须有人确认，日常 TUI 默认不注入经验。
- 不为了测试制造永远失败的验证器，不把 setup 或环境故障硬归因为编码失败。

## 3. 已实现链路与代码入口

```text
已记录 run
  → 确定性分类 + 有界脱敏证据
  → eligible 时调用来源模型生成严格 JSON
  → 经验卡 + prompt / skill / strategy 文本候选
  → 同配置、新 worktree、新会话的对照/候选实验
  → 跨任务证据检查 + 人工晋升
  → /experience 手动选择、每轮复核、撤销或停用
```

| 入口 | 职责 |
| --- | --- |
| `src/experience/classifier.ts`、`evidence.ts` | 确定性失败分类、有界证据与引用；失败和超时诊断优先 |
| `src/experience/synthesizer.ts`、`service.ts` | 独立无工具的 `ModelRuntime.completeSimple()`；严格 JSON；生成失败仍保存观察 |
| `src/experience/candidate.ts`、`schema.ts`、`store.ts`、`artifact-io.ts` | 文本候选、快照、哈希、产物校验与存储 |
| `src/experiment/service.ts`、`schema.ts`、`store.ts` | 新鲜配对、冻结配置、清理与中止、证据重算、实验存储 |
| `src/experience/promotions.ts` | 同仓库跨任务晋升门槛、锁、历史完整性与撤销 |
| `src/runtime/experience-extension.ts` | `/experience`；默认关闭、仓库隔离、每轮复核、会话切换清空 |
| `src/learning-cli.ts`、`cli-args.ts`、`main.ts` | CLI 分流、参数互斥、中文输出、帮助与实验中止 |
| `src/evaluation/` | 实验候选快照与 replay 元数据、记录和比较 |
| `src/runtime/process.ts` | Windows 验证命令引号与退出码修复 |

普通运行 manifest 保持 v1；实验使用含冻结候选和有效提示哈希的 v2 manifest；result/trace 保持 v1。实验臂 replay 恢复原候选快照，不能临时替换候选。

数据位于 `.picoding/`，新增 `experiences/`、`experiments/`、`promotions/`；可用 `PI_TUI_AGENT_DATA_DIR` 隔离测试数据。不要读取、复制或提交 `agent/auth.json` 等认证材料。

## 4. 必须保持的不变量

### 失败与生成

- 未配置验证器、setup 失败或证据不足不能直接当编码失败；只有 `eligible` 观察进入模型提炼。
- 经验卡中的原因解释是附证据的假设，置信度不是实测提升。
- `prompt`、`skill`、`strategy` 都是文本指导；不具备可执行扩展权限。
- 候选不能修改任务、路径权限、验证器、setup、模型或工具权限。
- 证据提取不把凭据放入提示或产物；模型调用仍需要 SDK 正常认证。

### 配对实验与晋升

- 两个实验臂都重新运行，使用新 worktree 和临时会话，交替执行顺序。
- 冻结基线提交、任务、验证器、setup、模型、思考级别、工具和策略；配置漂移与不完整证据不能判为有效提升。
- `--pairs` 范围 1–20，默认 3 对，即正常完成时 6 次任务运行；每次任务可能包含多次 API 请求。
- 晋升需要同仓库 2–20 项不重复实验，覆盖至少两个不同任务，至少一个不是候选来源任务。仅改任务 ID 不算新任务。
- 每项晋升证据至少 3 对完整运行，至少一项改善，且不得有退化、越界或隔离失败。
- 晋升和撤销需要明确 `--approve`，不能由代理擅自代替用户决定。
- 实验载入重新核查关联 run 并计算指标，不相信产物里单独写下的“成功”结论。

### TUI 与安全边界

- `/experience use` 只选择当前仓库有效晋升候选；每轮复核，失败即停用。
- 会话开始或切换时清空选择，避免跨会话残留选择。
- 实验在任务提示末尾补充文本，TUI 使用独立补充消息；不能把实验收益直接视为日常 TUI 的同等收益。
- 撤销或 `/experience off` 只阻止后续注入，不删除历史上下文；要干净上下文需新建会话。
- 哈希用于发现损坏与版本不一致，不提供针对本机攻击者的防篡改保证。
- worktree、路径与命令策略不是操作系统沙箱；固定验证命令也不保证测试文件不可被修改。晋升时仍要检查 diff 和验证器有效性。
- 实验中止会使结果不可晋升；正在执行的 setup/verifier 可能等待原命令 timeout，不能假设立即停止。

### 已发现的文档与源码口径差异

2026-09-06 核查 `src/runtime/controlled-pi-runtime.ts`：受控运行显式禁用了资源发现中的扩展、Skills、Prompt Templates 和 Themes，但没有设置 `noContextFiles`；代码还从 `getAgentsFiles()` 收集上下文文件路径和哈希。

因此，不应沿用“受控运行绝不加载上下文文件”的绝对说法。是否以及如何加载具体文件要以 SDK 行为和实际 manifest 为准。后续如需完全禁用，应先验证兼容性并单独实现，本轮没有修改这一行为。

## 5. 已验证内容与证据等级

| 时间 | 实际验证 | 可得结论 |
| --- | --- | --- |
| 2026-09-05 实现收尾 | `npm run check`、`npm run lint`、`npm run build` 通过 | 类型、静态检查、构建通过 |
| 2026-09-05 实现收尾 | `npm test`：26 个文件、203 个测试通过 | 当时完整自动化套件通过 |
| 2026-09-05 实现收尾 | `git diff --check`、构建后 `--help`、隔离目录列表 smoke 通过 | 差异格式与只读入口可用 |
| 2026-09-06 测试资源讨论 | `npm test -- test/learning-loop.test.ts`：1 文件、1 测试通过，约 89 秒 | 离线端到端闭环仍可运行；不是重跑全量 203 项 |
| 本次 handoff | 核查 Git、相关源码、README 和实施记录 | 交接状态更新；不新增真实模型效果证据 |

`test/learning-loop.test.ts` 使用真实临时 Git、worktree、验证命令和产物存储，但模型运行时与生成器是确定性替身。它覆盖失败记录、候选、两任务各三对实验、晋升、启用资格与撤销，并检查原始 run 不被改写、源仓库不被污染。

这能证明工程链路按预期协作，不能证明真实模型学会了经验。测试在 finally 中清理临时数据，因此跑完后真实 CLI 列表中没有示范经验是正常现象。

会话中没有开展付费真实模型实验，没有候选真实收益数据。外部 GitHub 资源只完成了检索，没有下载、安装或本机运行验证。

实现收尾 review 已修复的重要问题：

- Windows cmd 引号经转义后导致验证命令未真正执行、退出码错误；补充输出、非零退出与带空格路径回归。
- JSON 序列化后脱敏遗漏带引号或反斜杠的秘密值；改为先递归脱敏原始字符串。
- 证据截断遗漏较后位置失败；改为失败/超时优先并保持原始引用索引。
- 终端控制字符、晋升历史尾部缺失、材料损坏后无法撤销、链接目录和实验取消一致性问题。

## 6. 立即可用的测试与操作入口

无需失败历史、无需模型 API 的功能闭环测试：

```powershell
cd D:\Agent
npm test -- test/learning-loop.test.ts
```

要求 Node.js >= 22.19.0。仅在首次安装或锁文件变化时执行 `npm ci`，不是每次运行都需要安装依赖。

下面是已有 CLI 工作流索引，不代表授权执行付费任务或晋升。大写 ID 和路径必须替换为实际值；真实 record/replay/experiment 执行前确认任务、环境、预算与数据目录。

```powershell
npm run dev -- --list-runs
npm run dev -- --show-run RUN_ID --json
npm run dev -- D:\projects\benchmark-repo --record --task-file D:\tasks\task.yaml --no-session
npm run dev -- --replay RUN_ID

npm run dev -- --analyze-run RUN_ID
npm run dev -- --list-experiences --json
npm run dev -- --show-experience EXPERIENCE_ID
npm run dev -- --experiment RUN_ID --candidate CANDIDATE_ID --pairs 3
npm run dev -- --list-experiments --json
npm run dev -- --show-experiment EXPERIMENT_ID

npm run dev -- --promote-candidate CANDIDATE_ID --evidence EXPERIMENT_ID_1 --evidence EXPERIMENT_ID_2 --approve
npm run dev -- D:\projects\benchmark-repo --list-promotions
npm run dev -- --revoke-candidate CANDIDATE_ID --approve
```

`--analyze-run` 只有合格失败才可能调用模型；列表和查看不调用模型。`--json` 仅支持只读 list/show 类命令。除 `--list-promotions` 外，经验命令从证据恢复仓库，不附带工作区或执行配置覆盖。

TUI 命令为 `/experience list`、`/experience use CANDIDATE_ID`、`/experience off`。

## 7. 没有失败经验时怎样测试

应分开回答三个问题：

1. 功能有没有接通：使用现有离线闭环测试，不依赖用户自己的失败历史。
2. 能否形成真实失败证据：让本项目 Agent 在有效任务上 `--record` 尝试，失败才形成自身可分析轨迹。
3. 提炼的候选是否有效：在同配置新鲜对照和非来源任务上测量，兼顾成功率、回归与成本。

外部题库中有 bug，不等于本项目 Agent 已经失败；外部 trajectory 也不等于可直接 replay 的本项目 run。目前没有外部 benchmark 导入器，也没有持久化 demo 经验导出命令。

上一轮建议的最小路线（尚未实施）：

- 从 Exercism JavaScript 挑约 10 道题，整理在同一个独立 Git benchmark 仓库中，以符合后续同仓库跨任务晋升门槛。
- 每题提供 TaskSpec、受限修改路径和确定性验证器；固定依赖，确认未修实现失败、参考实现通过。
- 启用需要的测试，移除 Agent 工作副本中的参考答案；更正式评估使用工作副本之外的留出验证。
- 部分任务供经验提炼，其他任务留出，不用来源题反复调到通过来冒充泛化。
- 保留原本能成功的任务检测回归；若题目全部通过就增加难度，而不是故意破坏验证器。
- 初期少量真实运行确认流程和成本，随后才开展用于晋升的多对、跨任务实验。

## 8. GitHub 资源与接入成本

以下为本 session 在 2026-09-06 检索的官方资源，不代表已在本机跑通。

| 资源 | 可以复用什么 | 本项目接入注意事项 |
| --- | --- | --- |
| [Exercism JavaScript](https://github.com/exercism/javascript) | 小型 JS 任务、骨架、测试和参考实现；建议优先使用 | 需包装 TaskSpec/verifier；原仓库测试流程可能跑参考实现，不能直接当 Agent 成绩 |
| [BugsJS bug-dataset](https://github.com/BugsJS/bug-dataset) | 真实 JS 缺陷、版本和复现测试；适合作为下一阶段 | 需要恢复相应依赖，选择正确缺陷与测试版本；不保证当前 Node 原生可运行 |
| [SWE-bench](https://github.com/SWE-bench/SWE-bench) | 真实仓库 issue 修复任务与评测基础设施 | 环境更重，涉及 Docker、任务和 patch 适配，不是 clone 后直接接本项目 replay |
| [SWE-smith](https://github.com/SWE-bench/SWE-smith) | 合成修复任务和公开 Agent 轨迹 | 官方说明以 Ubuntu/Docker 为主，不支持 Windows/macOS 原生；需要独立适配 |

具体陷阱：

- [Exercism binary-search 测试](https://github.com/exercism/javascript/blob/main/exercises/practice/binary-search/binary-search.spec.js) 存在 `xtest` 跳过项，准备任务时要确认测试覆盖。根目录 `scripts/test.mjs` 面向示例/参考方案，不应直接作为 Agent 实现的验证器；`.meta` 里的答案不能留给待测 Agent。
- BugsJS 的 `buggy`、`fixed-only-test-change`、`fixed` 用途不同。需要揭示缺陷的新测试时，注意选择保留缺陷代码但含测试变化的版本。环境参考：[BugsJS Docker](https://github.com/BugsJS/docker-environment)。
- SWE-smith 的[公开轨迹数据](https://huggingface.co/datasets/SWE-bench/SWE-smith-trajectories)并非全部失败。可用于研究失败模式，但不能直接交给当前 `--replay`；本项目 replay 依赖自身 manifest、配置和仓库证据。

## 9. 接手后的优先级与授权边界

已完成：实现、离线回归、资源路线讨论。未完成：可持久查看的 demo 包、外部任务适配、真实失败采集、真实候选收益与成本报告。

如果用户下一步授权“帮我接入测试题”，建议先做独立的小型 JavaScript benchmark 包，而不是同时引入多个大评测框架。建议验收：

- 每题能独立复现，未修版本红、参考版本绿，明确依赖和运行方式。
- 测试不能主要处于 skip 状态，也不能误测参考答案。
- 本项目能够从题目产生自己的 record 包；没有失败时如实报告，不伪造失败轨迹。
- 学习题和留出题可辨别，晋升证据符合现有门槛，原始记录与源仓库保持完整。
- 报告明确区分模拟测试、环境失败、模型失败和真实收益；真实模型运行单独确认预算。

接手时先读最新 AGENTS.md 并检查 Git 状态；源码优先于设计文档。不要因为已有实现清单而重复搭建系统，也不要把用户此前的实现确认解释为无限期付费实验授权。

仅改文档：核对链接、命令、事实与 `git diff --check`。后续改代码：先理解调用链，再运行 `npm run check`、`npm test`、`npm run lint`、`npm run build`，按风险补充回归测试。不要编辑或提交 `dist/`、`coverage/` 和运行认证数据。

## 10. 相关仓库文档

- [项目 README](../../README.md)
- [经验学习设计规格](../superpowers/specs/2026-09-05-experience-learning.md)
- [实施计划与 2026-09-05 验证记录](../superpowers/plans/2026-09-05-experience-learning.md)
- [离线闭环测试源码](../../test/learning-loop.test.ts)

设计和计划用于理解决策，不单独作为真实运行效果证据。接续工作应从“取得可靠任务与有效验证器”开始，而不是继续叠加学习机制。
