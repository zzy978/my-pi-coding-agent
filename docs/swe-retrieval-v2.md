# 经验检索 V2：适用性筛选与离线诊断

V2 在现有经验库上增加独立检索描述和适用性检查。原经验正文、候选 ID、V1 检索和历史修复结果保持不变。新增入口只处理文本，不运行 Docker 修复或官方评分，也不改变日常 TUI 的人工晋升和选择规则。

## 使用方式

```powershell
# 查看帮助或缓存状态，不调用模型
npm run benchmark:swe-retrieval -- --help
npm run benchmark:swe-retrieval -- status .picoding/benchmarks/swe-holdout-v1 .picoding/benchmarks/swe-retrieval-v2-20260921-low

# 建库、选择、独立请求评审；会使用当前配置的模型 API
$env:PICODE_SYNTHESIS_MAX_OUTPUT_TOKENS = "32000"
$env:PICODE_SYNTHESIS_TIMEOUT_MS = "180000"
npm run benchmark:swe-retrieval -- run .picoding/benchmarks/swe-holdout-v1 .picoding/benchmarks/swe-retrieval-v2-20260921-low

# 填写人工标签后，从原检查点重算报告，不调用模型
npm run benchmark:swe-retrieval -- report .picoding/benchmarks/swe-holdout-v1 .picoding/benchmarks/swe-retrieval-v2-20260921-low
```

省略目录时，来源默认为 `.picoding/benchmarks/swe-holdout-v1`，输出默认为 `.picoding/benchmarks/swe-retrieval-v2`。输出不能与来源重合或互为父子目录；不支持输出路径中的符号链接或 junction。

上述环境变量用于匹配已交付批次的协议，仅影响当前 PowerShell 及其子进程；在同一窗口后续运行其他经验提炼时也会生效。新目录可使用其他上限，但恢复已有目录必须与其 `protocol.json` 一致。无需重新调用模型时直接用 `report`。

`run` 使用安装目录模型配置及环境变量覆盖，必须配置 provider 和 model ID。检索文本判定固定使用 `reasoning: low` 并写入协议；普通经验提炼仍默认 high。使用 `PICODE_SYNTHESIS_TIMEOUT_MS`、`PICODE_SYNTHESIS_MAX_OUTPUT_TOKENS` 控制每次文本请求。39 条经验、40 道题最多尝试 119 次 completion：39 次描述生成、40 次选择、40 次独立配对评审，并发上限 2。无候选时跳过相应请求。费用按 SDK 返回记录；未收到响应的尝试不声称一定已发出，用量未知不能补零。

## 选择依据

1. 从原经验生成独立描述，记录机制、触发条件、排除条件、动作、适用阶段、中英文关键词及原文引用。不改写注入正文。
2. 对描述执行中文分词和英文词 BM25，最多召回 8 条。查询只使用公开问题描述，不读取答案、评分结果、补丁或执行 trace。
3. 无工具模型请求逐条判断：`direct`（直接适用）、`general`（只有通用帮助）、`inapplicable`（不适用）、`unknown`（证据不足）。
4. 仅 `direct + absent + initial` 可注入，即直接适用、排除条件未命中、适合当前初始阶段。要求任务和经验原文引句有效，但引句存在不等于语义判断正确。
5. 沿原文哈希和冗余引用链去重，最多选择 2 条，连同分隔文本不超过 9000 字符。不截断原候选；超长项跳过。没有合格项就返回 null。

描述生成和筛选失败会保存错误及已有用量，不放行该条描述或该题选择。模型不允许获得工具、执行权限或修改验证器。检索描述建议简短，解析器另有防止无界输出的硬上限；模型建议不是自动验证过的知识。

## 产物与证据

| 文件 | 内容 |
| --- | --- |
| `protocol.json` | 来源字节哈希、公开输入哈希、实现指纹、Node/ICU、依赖锁文件、模型地址指纹及上限 |
| `inputs.json` | 公开题目、39 条原候选和 V1 检索，不复制隐藏字段 |
| `calls/` | 每次请求的输入哈希、时间、状态、脱敏文本响应、结构化结果和已知用量；不保存思维链 |
| `index.json` | V2 独立描述及其哈希，绑定原候选 |
| `retrieval-v2.json` | 每题组合候选或 null；候选类型兼容 `runSweTask` 的 candidate 输入，但不会自动启动任务 |
| `selection-audit.json` | Top-8 排名、逐条判断、引用、禁忌条件、拒选与选择理由 |
| `pair-labels.json` | 独立请求对 V1/V2 选项并集的模型标签 |
| `human-labels.json` | 待人工填写的独立模板，默认 verdict 为 null |
| `summary.json`、`report.md` | 模型与人工分开的指标、调用费用、覆盖与限制 |

评审请求按候选 ID 排序，只读取原经验和公开问题，不知道候选来自哪个检索方案、原排名或历史输赢。但评审仍使用同一模型，不等于独立人工真值。不要把独立请求称为独立模型验证。

## 人工确认与指标

人工核对 `inputs.json` 的任务和候选后，在 `human-labels.json` 对应行填写 verdict、reason、两类原文引句、contraindication、stage、reviewedBy、reviewedAt（ISO 时间）。保留 taskSha256 和 contentSha256。不要把模型标签直接复制成已确认人工结论。模型评审与人工确认分别计算，未填写的行保持未知。

- **直接适用比例**：direct / 选择条数；选择未全部标注或零选择时为 null。另列已标注子集比例和 unknown 数量。
- **任务注入覆盖**：至少选择一条经验的任务比例，防止用几乎不注入制造漂亮精度。
- **条件命中率**：只在评审池已知至少有一个 direct 的任务上计算；未确定选项可能改变命中判断时为 null。不是全库召回率。
- **全库召回、无适用项任务错误注入率**：只有任务 × 全库候选矩阵全部标注且没有 unknown 才计算；默认并集评审不满足，显示 null。

历史 40 题 × 3 条共 120 对是 V1 覆盖基数。V2 新选项可能增加评审对数。没有运行新的修复对照，不能从精度、字符数或拒绝率推断成功率、任务 Token 或费用节省。后续最终泛化测试应使用未参与调整的新题。

## 2026-09-21 本机诊断结果

本机产物在 `.picoding/benchmarks/swe-retrieval-v2-20260921-low/`：`analysis.md` 提供分仓库结果和选择集中度，`report.md` 提供完整逐题统计。119 次正式请求均收到响应，历史 120 对全部评审，并集共 143 对。模型判为直接适用的比例从 V1 的 5/120（4.2%）变为 V2 的 10/34（29.4%），V2 向 24/40 题注入。仍有 22/34 个 V2 选项仅被判为一般帮助，尚无人工确认或修复收益验证。

本轮 38/39 份索引可用：一条生成关键词 `resolved=false` 被现有环境赋值校验误拦截；另有一道题的非原文引用导致筛选失败并零注入。产物状态为 `completed_with_failures`，这两项错误均保留在检查点中，未当作语义不适用结论。前置截断轮和单题预检另有独立记录，费用见 `analysis.md`。

## 恢复与一致性

重新运行同一 `run` 会核对协议并复用已经完成或失败的检查点，不自动重试计费请求。遗留 pending 标记为失败、发送结果和用量未知；不冒充未发生调用。

同主机且 PID 已退出的 `workflow.lock` 可以保守回收；存活 PID、未知主机、损坏锁不会被抢占。PID 复用时保守拒绝。若系统恰在回收锁期间退出并遗留 `workflow-recovery.lock`，先确认关联进程已结束，再人工处理该具体锁文件；不要全局清理。

`status` 返回的是缓存摘要（`cached: true`），不重新验证全部来源与检查点。`report` 会重新验证并重算。代码、输入、Node/ICU、依赖锁文件或模型配置变化必须使用新输出目录，不能覆盖历史协议。哈希防止意外漂移，不保证本机攻击者无法同时改写产物与哈希。
