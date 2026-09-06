# 实现计划

以已确认的 [设计](../specs/2026-09-05-experience-learning.md) 为准，在当前 checkout 实现，保留 AGENTS.md 的用户修改。

## 模块契约与所有权

### 经验模块（实现者 A）

拥有 src/experience/**（promotions.ts 除外）及 test/experience-*.test.ts。

公开契约：

```ts
// experience/candidate.ts
type CandidateKind = "prompt" | "skill" | "strategy";
interface CandidateSnapshot {
  id: string; kind: CandidateKind; content: string;
  contentSha256: string; rendererVersion: 1;
}
interface ExperienceCandidate extends CandidateSnapshot {
  sourceRunId: string; sourceExperienceId: string; createdAt: string;
  title: string; applicability: string[]; contraindications: string[];
}
// Text is a frozen supplement; ordinary prompt must not change.
renderCandidatePrompt(basePrompt: string, candidate: CandidateSnapshot): string;
parseCandidateSnapshot(value: unknown): CandidateSnapshot;
// experience/store.ts
loadCandidate(candidateId: string, dataDirectory: string): Promise<ExperienceCandidate>;
loadExperience(experienceId: string, dataDirectory: string): Promise<ExperienceBundle>;
listExperiences(dataDirectory: string): Promise<ExperienceBundle[]>;
// experience/service.ts
analyzeRun(runId: string, dataDirectory: string): Promise<ExperienceBundle>;
```

bundle 至少包含 id、sourceRunId、observation、candidates、synthesis（明确状态），其余由 A 实现并报告契约。

### 实验模块（实现者 B）

拥有 src/experiment/**、src/evaluation/** 的必要修改，相关 test/experiment-*.test.ts 及 evaluation 测试。不得修改 CLI/main、data-dir 或经验模块。

```ts
// experiment/service.ts
runExperiment(options: {
  sourceRunId: string; candidate: ExperienceCandidate; dataDirectory: string;
  pairs?: number; onStatus?: (message: string) => void;
}): Promise<ExperimentBundle>;
// experiment/store.ts
loadExperiment(id: string, dataDirectory: string): Promise<ExperimentBundle>;
listExperiments(dataDirectory: string): Promise<ExperimentBundle[]>;
```

bundle 至少含 id、sourceRunId、sourceRepository、taskSha256、candidate（快照）、pairsRequested、pairsCompleted、outcome、scopeViolations、createdAt、trials（每臂标准 run ID 与结果）；用于晋升检查。outcome 为 observed_improvement / no_observed_gain / observed_regression / inconclusive / invalid_isolation。完整数据自行设计并及时通知 root。暴露 replay plan 的 experiment 元数据并由 root 在 main 中传回 executeControlledRun。

### 日常 TUI（实现者 C）

拥有新 src/runtime/experience-extension.ts、必要的 pi-interactive.ts 装配与 test/experience-extension.test.ts。不修改 interactive-host-extension.ts 和 policy-extension.ts，除非先与 root 协调。使用独立扩展注册 /experience 命令及 before_agent_start 钩子，在每轮只注入用户选择且仍有效的候选；session_start 清空选择。候选不得成为 executable extension/skill。

依赖 root 提供：

```ts
// experience/promotions.ts
listActiveCandidates(sourceRepository: string, dataDirectory: string): Promise<ExperienceCandidate[]>;
```

### 集成与晋升（root）

拥有 cli-args.ts、main.ts、data-dir.ts、experience/promotions.ts、README.md、集成/晋升/CLI 测试与此文档。CLI 模式：--analyze-run、--list-experiences、--show-experience；--experiment + --candidate + 可选 --pairs；--list-experiments、--show-experiment；--promote-candidate + --evidence（可重复实验 ID）+ --approve；--revoke-candidate + --approve；--list-promotions。只读列表/show 支持 --json。晋升检查实验与 run 的哈希和仓库一致性，不相信调用者的成功布尔值。

## 执行清单

- [x] 阅读调用链与确认边界。
- [x] 写入设计、契约和验证计划。
- [x] A：事实提炼、严格生成、不可变存储、测试。
- [x] B：冻结候选实验、新鲜对照、兼容 replay、测试。
- [x] C：TUI 按需选择、重新验证、撤销/会话切换测试。
- [x] root：CLI/目录、人工晋升/撤销、跨任务门槛、使用文档。
- [x] 独立 review 并修复发现。
- [x] check、完整 test、lint、build 与无网络 smoke 验证。

## 验证记录（2026-09-05）

- `npm run check`、`npm run lint`、`npm run build` 均成功。
- `npm test`：26 个文件、203 个测试全部通过。
- 真实临时 Git、验证命令与各层存储完成两任务闭环；模型为确定性替身，未发生付费调用，不作为真实模型效果证据。
- 构建后 help 与隔离数据目录上的 experience/experiment/promotion 列表 smoke 成功，未写入模型认证或创建 worktree。
- 独立 review 修复：JSON 转义前脱敏、后置失败诊断优先、终端控制字符、完整晋升 head、材料损坏后撤销、直接链接目录拒绝、实验预算/压缩/取消一致性。
- 实验测试另复现并修复已有 Windows cmd 引号转义造成验证命令未真正执行的问题；新增输出、失败退出码和带空格路径回归。

不运行付费真实模型实验作为开发测试，不提交或推送 Git，不改写历史评测、认证或原生会话文件。
