# 经验检索 V2 日常集成实施计划

> 使用 writing-plans、test-driven-development、subagent-driven-development 按任务实施。用户已确认上一轮提出的“经验生成后自动建索引、Task 执行前统一筛选”并要求完成集成；不重复请求确认。遵循仓库要求直接在当前检出目录实施，不自动提交或推送。

**目标：** 新经验自动生成绑定版本的检索描述；普通任务默认从同仓库有效晋升候选中检查条件、阶段并去重；新 SWE holdout 批次使用相同 V2 筛选，历史重放保持冻结语义。

**约束与边界：** 不自动晋升、不扩大候选资格；record/replay/显式候选配对不临时检索；当前仅支持 initial 阶段，after_inspection/after_error 暂不注入。不回写历史经验、V1 批次和原候选正文。模型判断错误或索引损坏时不注入；保存用量与拒选理由。测试用模拟完成器或本机 HTTP，不跑付费修复实验。

## 接口与任务

- [x] 1. 中立检索核心和共享选择服务（主代理）：将检索输入从 SWE 类型解耦为 RetrievalTask { problem_statement } 和 RetrievalEntry { title, applicability, contraindications, candidate }；提示移到 experience，benchmark 保留兼容 re-export。共享 selectIndexedGuidance(task, entries, cards, complete) 返回 selection/ranking/decisions/usage/error；selectTaskExperience 为普通任务加载或补建合格候选索引，保存选择审计。
- [x] 2. 索引生成和保存（独立实现者）：新增 retrieval-index.ts；ensureSearchIndex(entry, filePath, options) 复用有效绑定记录、拒损坏、失败不静默重试；loadSearchIndex 只读；candidateIndexPath/toRetrievalEntry/indexExperience 为经验生成入口提供适配。analyzeRun 最终保存后自动索引，compare 保存的独立经验分别绑定；索引失败不抹除经验正文。显示命令可查看索引状态，不发模型请求。
- [x] 3. 普通交互接入（独立实现者）：experience-extension 默认 auto，从有效晋升池检索，use 限定候选但不绕过检查，off 停用；增加 auto 命令。模型请求返回后重查晋升与任务/会话/配置漂移，过期结果不注入。pi-interactive 接入真实共享服务。覆盖默认自动、零注入、撤销、off、会话切换、计划模式及异步竞争。
- [x] 4. SWE 新批次接入（独立实现者）：为新批次冻结 V2 索引和选择，control 不注入；旧协议使用原检索且不能混跑。status 不发模型请求。测试以模拟模型验证实际使用的候选、漂移拒绝和旧批次兼容，不运行 Docker。
- [x] 5. 整体复核：修复集成问题，更新 README/AGENTS/使用指南，完整执行 check、test（两个 worker）、lint、build、diff --check。明确各入口默认行为与限制。

## 共享接口契约

`RetrievalCompletion = (material: unknown, systemPrompt: string) => Promise<SynthesisResponse>`。

`IndexModelOptions = { model: { provider, id }, dataDirectory, modelConfig?, complete? }`。

`SearchIndexRecord` 至少具有 status（pending/completed/failed）、card（SearchCard|null）、error（string|null）、usage（RunUsage|null）、entrySha256、model、generatorVersion。副文件使用候选元数据和正文哈希绑定，不修改 ExperienceBundle 的历史格式。

`TaskExperienceSelection` 扩展 GuidanceSelection，增加 auditId、status（selected/empty/failed）和可选 error。

## 决策记录

- 选用独立索引副文件，避免历史 experience.json 哈希迁移；旧的合格晋升候选可首次使用时补索引，失败有记录且不反复收费。
- 用户已授权默认自动筛选，覆盖旧“仅手动选择”的日常行为；人工晋升门槛不变。
- record/replay 与候选配对维持冻结输入，不把默认自动检索扩散进对照臂。
- 子任务 2 提供索引接口给任务 1 和 4；任务 1 提供选择结果给任务 3 和 4；各实现者只编辑所属文件。README/AGENTS 由主代理统一更新。
- 本计划不自动提交；上一轮 commit/push 授权已完成，不推断为以后每次修改都自动发布。

## 验证记录

2026-09-21：全量 61 个测试文件、685 项测试通过（两个 worker）；独立复核的问题已修正。lint 发现的模拟测试写法问题已修复，相关两文件 48 项、共享服务 7 项再次通过。check、lint、build 与 diff 检查通过。未调用真实付费模型，未重新运行修复收益实验；改动保留在工作区，未提交或推送。
