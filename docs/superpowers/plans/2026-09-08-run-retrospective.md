# 成功与失败运行复盘实施计划

> 执行方式：在当前会话按 executing-plans 逐项实施，使用 TDD 和交付前验证。遵守仓库要求，在当前目录保留既有改动，不创建 worktree、不提交混合改动。

**目标：** 已记录成功与失败 run 共用复盘入口，允许零候选，提供可选 critic 与同批提案对比，继续复用配对实验和人工晋升。

**架构：** 规则筛选 → 有界脱敏材料 → proposer → 结构检查 → 可选 critic → 不可变经验产物。compare 只生成一批提案，保存 proposer 产物及绑定该产物的 critic 产物；只读比较从已验证实验重新统计收益，不能把审查通过率当实测有效率。

**技术栈：** TypeScript ESM、Pi ModelRuntime、Vitest；无新增依赖。

**设计依据：** 用户批准本会话两步方案：统一筛选与材料、支持不产出候选、复用评测和人工晋升，再比较 proposer 与 proposer＋critic。

## 全局约束

- 不覆盖原始 run；新产物 schemaVersion=2，兼容旧版读取。
- 无验证器、未完成、setup 失败不能因手动筛选覆盖而成为有效编码经验。
- 成功的低调用任务默认跳过；明确失败恢复证据例外。阈值可配置，手动覆盖只影响低价值筛选。
- 记录可观察动作、脱敏结果摘要、diff、验证与成本；不记录模型思维链，不从旧 run 虚构缺失信息。
- 模型允许零候选并给出原因。critic 仅接受或拒绝原提案，不能增加或改写内容。
- proposer 默认单次模型调用；critic/compare 最多增加一次审查；无候选时不调用 critic。
- 比较必须共享提案与证据；审查错误不生成获批候选。缺少评测或计费数据必须显示未知。
- 不自动启动模型任务、安装 skill、晋升或向日常会话注入经验。

## 任务 1：统一筛选、证据与零候选

文件：src/experience/{classifier,evidence,schema,service,synthesizer}.ts、src/evaluation/{recorder,redaction}.ts；test/experience-service.test.ts、test/experience-format.test.ts、test/controlled-run-e2e.test.ts、test/tool-result-summary.test.ts。

- [x] 写并运行失败测试：复杂成功可分析；简单成功跳过；低调用但有失败后成功动作进入复盘；缺失过程证据不凭调用数提炼；手动覆盖不越过验证器门槛。
- [x] 以 `classifyRun(bundle, collected, { minSuccessToolCalls, force })` 统一判定，保留 classifyFailure 兼容出口。默认成功阈值 6 次，仅作为可调启发式。
- [x] 工具事件保留调用关联、路径、耗时与脱敏有界结果；证据总量仍为 80 条/32000 字符，先保留验证和关键失败恢复事件。
- [x] 接受 `{ candidates: [], noCandidateReason: "没有可复用结论" }`；非空候选仍要求经验卡与证据引用。生成器及 schema 用版本区分旧契约。
- [x] 定向测试通过并检查原始产物没有修改、模型输入与存储无假密钥泄漏。

## 任务 2：critic 与同批提案比较

文件：新增 src/experience/{review,review-comparison}.ts，修改 schema/service/synthesizer；在 test/experience-service.test.ts 增加独立审查测试组及本机 HTTP 测试。

- [x] 写并运行失败测试：接受子集、全部拒绝、零候选跳过、非法索引/重复/缺失决策/未知引用拒绝、审查失败保留费用与提案但不放行候选。
- [x] `ReviewDecision` 按提案索引绑定接受/拒绝、原因与引用；复用无工具 ModelRuntime，并记录独立 usage。
- [x] compare 保存 proposer 产物后对同一提案审查，critic 产物记录来源 ID 与哈希；加载时验证候选是接受提案的原文。
- [x] 只读 `compareReviewPipelines(experienceId, dataDirectory)` 验证来源绑定，并从实验存储加载重新核验后的证据，报告已评测/未评测、改善/退化、审查成本、被拒候选的实验结果；不凭缺失实验估算节省。
- [x] 定向测试通过；确认新候选仍能通过原有 loadCandidate → experiment → promotion 路径。

## 任务 3：CLI、文档和完整验证

文件：src/{cli-args,learning-cli,main}.ts、README.md、AGENTS.md；test/learning-cli.test.ts、test/learning-loop.test.ts。

- [x] 写并运行失败测试：`--review-mode proposer|critic|compare`、`--min-success-tool-calls N`、`--force-review` 仅可与 `--analyze-run` 使用；`--show-review-comparison ID --json` 为只读。
- [x] 串接 CLI 并展示筛选原因、无候选原因、审查状态、对比产物 ID；真实评测仍显式通过 --experiment 发起。
- [x] 更新帮助和中文文档，注明后台可调用的无 TTY 分析入口、旧证据限制、计费与评测边界。本阶段不自动订阅普通 TUI 或启动常驻队列。
- [x] 执行 `npm run check`、`npm test`、`npm run lint`、`npm run build` 和 `git diff --check`，复核此次 diff，修复发现的问题后重跑相关检查。

## 验收

成功/失败均能按证据生成候选；简单成功跳过；零候选可持久化；critic 失败关闭放行；同批提案可比较；旧产物与人工晋升兼容；完整检查通过。模拟测试只证明工程链路，critic 的真实收益需另做真实模型与跨任务实验。

## 验证记录

- 已按红—绿循环验证成功筛选、零候选、critic 决策与比较；临时 Git 仓库上的端到端链路覆盖新鲜配对、被拒提案仍观察到改善、跨任务晋升与撤销。
- 本机 HTTP 服务验证 proposer 和 critic 的两次独立上下文请求、无工具及独立输出限制，不访问付费模型。
- 独立只读审查发现并修复：JSON 凭据脱敏遗漏、重复提案错误关联候选 ID；后续边界测试发现并修复已脱敏内嵌 JSON 重复处理时的格式破坏。
- 最终 `npm run check`、`npm test`（33 文件 / 356 测试）、`npm run lint`、`npm run build` 均通过；`git diff --check` 无空白错误，Git 提示既有 CRLF 转换。
- 首次完整测试中原有进程超时测试测得 5146ms，超过其 5000ms 断言；单独及完整重跑均通过，未放宽断言或修改进程运行时代码。
- 不新增常驻队列，不自动分析普通 TUI，不修改晋升门槛。diff 材料为既有统计/路径摘要；旧轨迹的缺失动作不可恢复。
