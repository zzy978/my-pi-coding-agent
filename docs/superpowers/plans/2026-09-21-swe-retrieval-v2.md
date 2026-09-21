# SWE 经验检索 V2 实施计划

> 执行方式：使用 writing-plans、test-driven-development 和 subagent-driven-development；用户已确认聊天中的最小方案，在当前检出目录实施，不创建 worktree、不提交历史实验数据。

**目标：** 保留 V1，完成独立检索描述、适用性检查、零注入、选择理由与历史 120 配对的离线诊断。

**架构：** 纯函数检索/校验模块 + 可恢复的独立文本模型流水线 + 独立请求的配对评审和指标。复用现有无工具 completeExperienceStage，不调用 SWE 执行、评分或晋升。

**技术栈：** TypeScript ESM、现有 Pi runtime、Vitest；不添加依赖。

**规格：** 本任务中用户确认的最小版本。V1 候选正文与哈希不改；检索最多 8 条，适用性筛选最多注入 2 条、9000 字符；不确定或请求错误不注入。索引、筛选、评审均绑定输入与版本，检查点不静默重试、不混入隐藏答案、历史输赢或 trace。

## 任务 1：纯检索与适用性契约

- 文件：`src/experience/retrieval.ts`、`test/experience-retrieval.test.ts`。
- 接口：SearchCard 描述绑定 candidateId/contentSha256，含 mechanism、triggers、exclusions、action、stage、keywords、sourceQuotes；rankGuidance 使用中文分词与英文词的 BM25；parseApplicability 校验逐候选决策、任务和经验原文引句；selectGuidance 输出 CandidateSnapshot 或 null 和每候选选择原因。
- 测试先覆盖中文检索、无匹配、损坏绑定、越界引用、遗漏/重复决策、不适用/未知条件不注入、原文不改、去重、条数/长度上限。
- 实现后运行聚焦测试并复核；禁止将结构校验说成语义证明。

## 任务 2：离线指标

- 文件：`src/experience/retrieval-evaluation.ts`、`test/retrieval-evaluation.test.ts`。
- 输入：每任务 V1/V2 选择 ID，独立标注配对（direct/general/inapplicable/unknown），明确 model 或 human 来源。
- 输出：120 历史配对覆盖情况、两组已标注选择比例、直接适用比例、未知数、直接适用命中率（仅评审池条件口径）、全库召回与无适用经验任务错误注入率只在全库标注完整时给出，否则 null。
- 零分母返回 null；遗漏标注不能当不适用；人类指标不能由模型标注补全。

## 任务 3：可恢复流水线与 CLI

- 文件：`src/benchmark/swe-retrieval.ts`、`src/benchmark/swe-retrieval-cli.ts`，必要时分出存储或提示模块；测试使用模拟 completion。
- 新 npm 入口：`benchmark:swe-retrieval -- run|status|report <source-root> <output-root>`；参数错误、同源/嵌套输出、历史漂移拒绝，status/report 不调用模型。
- 流程：验证 V1 library/catalog/retrieval → 39 次检索卡生成 → 40 次 Top-8 适用性检查 → 每题独立评审 V1/V2 并集（按 ID 排序，不告知来自哪组）→ 模型诊断报告、配对 JSON、人工待确认模板。最多 119 次独立请求，逐次保存用量、错误和输入哈希，断点继续不重做已有请求。
- 不读取 batch、score、patch、private 或 trace；不启动 Docker。报告明示模型辅助标签不是人工真值、不是修复收益。
- 测试覆盖中断恢复、漂移、错误降级、用量缺失、模型输入无隐藏字段、只读模式无请求。

## 任务 4：实际数据交付与验收

- 使用用户授权的当前模型配置执行文本整理和判定；输出新目录 `.picoding/benchmarks/swe-retrieval-v2-20260921`。
- 运行前后记录 V1 library/catalog/retrieval 文件 SHA256，确认未改动；实际 120 配对覆盖与费用单列。
- 更新 README 与中文指南。人工标签未提供时保持 pending，不能声称人工已确认或完整召回已测量。
- 顺序运行 `npm run check`、`npm test`、`npm run lint`、`npm run build` 和 `git diff --check`；完成独立代码 review 并修复发现。

## 执行记录

- 已读源码和 Git 状态：起始工作区干净，V1 BM25 无语义筛选；当前 source API 可复用无工具模型调用。
- 决策：离线指不执行修复任务，文本请求仍记录真实 API 用量；独立模型评审仅形成待人工确认诊断。
- 决策：用户项目要求优先，不创建分支/worktree，不由技能自动 commit，不更改 V1 与日常 TUI 晋升边界。
- 接口检查：任务 1 输出提供任务 3 使用；任务 2 只消费规范配对，不依赖任务 1 实现；任务 3 不修改 V1 检索；任务 4 只读历史输入、写独立输出。
- 任务 1–3 已实现；独立 review 后修复冗余链去重、未知标签条件命中率、过期锁恢复、并发异常停止派发、公开题目普通赋值误拒与调用计数口径。
- 全仓默认并发首测 641/642 通过，现有 Git 实验测试超时并触发清理竞争；单文件复测 13/13 通过。限制两个 worker 后两次全仓通过，最新 56 文件 / 643 测试；check、lint、build 通过。
- 第一轮真实文本请求在 `.picoding/benchmarks/swe-retrieval-v2-20260921` 保留：39 个索引成功，前 4 个 Top-8 筛选用满 16000 输出 Token 后截断，主动中止；47 个响应有记录，另 2 个 pending 用量未知。保留旧实现快照，不覆盖协议。
- 真实预检一题使用 low 思考强度完整返回 8 项（输出 13824 Token），仅证明请求完整性，不证明语义准确率。为结构化检索调用提供独立 reasoning 选择，普通经验提炼默认 high 不变；新增回归先失败后通过。
- 后续正式批次目录为 `.picoding/benchmarks/swe-retrieval-v2-20260921-low`，配置冻结为 low / 32000 输出上限 / 180000 ms；三个参数同时变化，不单因归因。旧轮、预检和新轮费用分别保留。
- 正式批次已完成：119 次请求均收到响应，40 道题 / 120 个历史配对全部评审，V1/V2 并集共 143 对；38/39 索引可用，另有 1 次筛选引用校验失败，均保守降级并保留原记录。
- 模型辅助直接适用比例：V1 5/120（4.2%），V2 10/34（29.4%）；V2 向 24/40 题注入，16 题零注入。22/34 个 V2 选项仍只被判为 general，不能声称匹配问题已全部解决或修复成功率提高。
- 正式批次 SDK 费用 0.2667403984，全部开发诊断已知费用 0.3287538632；前置中断轮另有 2 次用量未知，总费用不完整。V1 三个来源文件哈希复核未变。
- 对实际完整产物执行恢复与 report 重算验证：新增模型调用 0，全部 119 个检查点字节哈希未变，summary 与重算结果完全一致；最终 `git diff --check` 通过。任务 4 已完成，未运行 Docker 修复、未自动晋升、未提交 Git。
