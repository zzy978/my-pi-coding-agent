# 使用 Exercism JavaScript 困难题评估失败经验

本题库包含固定版本 `a01edc6f5b1de1b442c7a2295f841eee2e692ae4` 的全部 9 道官方困难题。没有简单题或中等题。它复用现有 `--record`、`--analyze-run` 和 `--experiment`，不改变模型、策略权限或晋升门槛。

| 题目 | 官方难度 | 分组 | 内容 |
| --- | --- | --- | --- |
| forth | 8 | 经验提炼 | 简化 Forth 解释器 |
| circular-buffer | 8 | 经验提炼 | 环形缓冲区 |
| word-search | 8 | 经验提炼 | 二维单词搜索 |
| change | 8 | 经验提炼 | 最少硬币找零 |
| simple-linked-list | 8 | 留出评估 | 单向链表 |
| bowling | 8 | 留出评估 | 保龄球计分与合法性 |
| react | 8 | 留出评估 | 响应式单元和回调，不是 React UI 框架 |
| zipper | 8 | 留出评估 | 树的导航和不可变修改 |
| crypto-square | 9 | 留出评估 | 文本归一化、矩阵转置和填充 |

难度是面向学习者的官方标签，不是模型失败率预测。公开题目可能已存在于模型训练数据；本题库用于初步效果评估，不证明模型对未知任务的广泛泛化。

## 准备题库（无模型调用）

在本项目目录执行，目标路径必须尚不存在：

```powershell
cd D:\Agent
npm run benchmark:exercism -- D:\exercism-js-hard-v1
```

需要 Node.js >= 22.19.0、Git，以及 GitHub raw/npm 网络访问。工具下载固定版本的题意、骨架和测试，保留许可证和作者来源，安装 Jest 29.7.0，生成锁文件和逐题 TaskSpec。所有 `xtest` 和 `test.skip` 都启用，保持官方断言不变。

工具逐题实际运行骨架与参考实现：骨架必须完成测试收集并至少有一项断言失败，参考实现必须全部通过，没有跳过、待办或测试运行错误。通过后才创建独立 Git 仓库和基线提交；参考代码只在临时校验目录中运行，随后清理，不进入题库及 Git 历史。校验结果位于题库根目录的 `validation.json`，它不是 Agent 成绩。

固定版本存在两处参考答案适配：`word-search` 的 CommonJS 默认导出在临时 QA 中转换为 ESM；`crypto-square` 官方参考答案无法通过启用后的长文本测试（7/8），临时 QA 参考修正了转置后分组与填充方式。后者的原版与修正后结果分别保存在 `upstreamReference` 和 `reference`，全部官方测试断言保持不变。

已有目录绝不覆盖。准备失败会保留已创建的目录供排查；修复原因后换一个新目录重试。不要把失败目录当作已完成的题库。

同一个生成结果的 `package-lock.json` 固定完整依赖树，供 record/replay/实验使用。重新准备另一个目录可能解析出不同间接依赖，不能直接合并为同一配置的实验。

## 采集真实失败

建议将评测数据放在独立目录，并在整个 record、分析、实验过程中保持相同配置：

```powershell
cd D:\Agent
$env:PI_TUI_AGENT_DATA_DIR = 'D:\Agent\.picoding\exercism-hard'
npm run dev -- D:\exercism-js-hard-v1 --doctor
```

新的数据目录也使用独立的 `agent` 配置目录。首次需通过本项目交互界面的模型配置/登录流程配置可用模型；不要复制或提交认证文件。`--doctor` 用于检查当前目录下模型可用性，不能代替真实调用验证。

配置好模型后，先选一题运行：

```powershell
npm run dev -- D:\exercism-js-hard-v1 --record --task-file D:\exercism-js-hard-v1\tasks\forth.json --no-session
npm run dev -- --list-runs
npm run dev -- --show-run RUN_ID --json
```

将 `RUN_ID` 替换为实际 ID。每次 record 在新 worktree 中执行，通过锁文件自动运行 `npm ci --ignore-scripts`；不要添加 `--no-setup`。任务只允许修改本题的实现文件，验证命令是 `node verify.cjs forth`。验证器检查题意、测试、任务和配置等文件的哈希，以及完整测试数。

只有 Agent 尝试后的失败记录，才是经验分析的来源。骨架校验失败不等于 Agent 失败。遇到模型连接、认证、依赖安装或环境问题，先修复环境，不把它们作为代码策略收益。若困难题全部做对，报告没有获得可提炼的编码失败，不人为损坏测试制造失败。

## 分析与配对实验

```powershell
npm run dev -- --analyze-run RUN_ID
npm run dev -- --show-experience EXPERIENCE_ID
npm run dev -- --experiment RUN_ID --candidate CANDIDATE_ID --pairs 3
npm run dev -- --show-experiment EXPERIMENT_ID --json
```

以上 ID 均替换为实际输出。分析只对 eligible 观察调用来源模型，生成的 `prompt`、`skill`、`strategy` 都是文本候选。阅读引用的失败诊断，区分观察事实与根因假设。

先仅使用 4 道经验提炼题形成并选定候选；冻结候选后，在留出题上建立各自的 record，再以留出题的 run ID 运行同一个候选的配对实验。留出题的原始 record 可以成功，不必为了实验等它失败。不要分析留出题来修改当前候选，或按留出结果挑选最有利候选后继续称为留出评估。

一次 `--pairs 3` 正常完成时有 6 次模型任务运行，每次可能包含多次 API 请求。对照和候选均重新运行，不复用历史失败作为对照。开始批量运行前确定模型、题目数、配对数和费用预算。准备命令本身不调用模型，也不会自动执行这些付费步骤。

报告成功率、配对胜负、耗时、工具调用、token、模型上报费用和越界情况，并单独列出环境故障。原本成功的困难题也应纳入退化检查。费用为模型 SDK 上报值，不保证等于账单。小样本结果只表示初步观察。

测试在工作副本内公开可读，不是隐藏验证集。哈希和 allowedPaths 用于降低误改评分材料的风险，不是沙箱；正式结论仍应检查各臂 diff。当前接入不新增工作区外的留出测试，也不证明模型未看过参考答案。

晋升仍需原有跨任务证据和明确人工确认。接入、分析或实验都不会自动晋升候选，也不会自动注入日常 TUI。

## 来源

- [Exercism JavaScript 固定版本](https://github.com/exercism/javascript/tree/a01edc6f5b1de1b442c7a2295f841eee2e692ae4)
- [官方难度规则](https://exercism.org/docs/building/tracks/config-json)：1–3 简单，4–7 中等，8–10 困难。
