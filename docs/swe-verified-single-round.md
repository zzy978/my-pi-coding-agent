# SWE-Verified 多仓库单轮运行

该入口执行 50 道未见任务，每题只进行一次无经验修复与独立官方评分，随后生成符合证据条件的经验。没有 B 轮，不启用 critic，不自动晋升候选。候选生成后沿用经验服务的独立检索描述流程；候选数量可以为零。

任务来自 `princeton-nlp/SWE-bench_Verified`，revision 固定为 `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`。选择只使用题目公开字段，排除历史任务 ID 与规范化后重复的问题描述，再以固定种子排序、逐仓库轮转。仓库均衡样本适合补充经验来源，不能直接当作完整 Verified 的总体通过率。

## 准备与运行

需要 Node >=22.19.0、已安装依赖、Linux Docker 引擎、`picode-swe-evaluator:4.1.0` 和项目模型配置。为每批使用独立目录，并先准备两个输入：`dataset-private.json` 为上述固定 revision 的完整数据，`excluded.json` 为 `{ "tasks": [...] }`，包含历史任务公开字段。私有参考补丁只提供给评分器，不提供给修复模型。

```powershell
$batchRoot = 'D:\Agent\.picoding\benchmarks\swe-verified-diverse50-20260921-r1'
npm run benchmark:swe-verified -- catalog $batchRoot
npm run benchmark:swe-verified -- run $batchRoot
npm run benchmark:swe-verified -- status $batchRoot
```

`catalog` 不调用模型，生成 `selection.json`、`catalog.json`、`private/` 与完整题单 `tasks.md`。`run` 为每题按需拉取并锁定镜像 ID，先检查原始代码评分失败、参考修复评分通过，再启动一次独立容器中的 R0 修复。每题完成后清理该题执行容器，保留镜像与运行证据。

模型和时限读取当前配置，修复使用 high 思考级别与容器 Bash 工具。50 次指任务执行数，不是 API 请求数；每题内部可有多轮请求，另有 proposer 和候选检索描述生成请求。官方评分测试不回传给修复模型。

本批对成功运行执行严格门槛：工具调用少于 6 次直接跳过经验生成，即使出现失败恢复也不例外；达到 6 次仍须通过已有证据分类。失败运行按现有失败证据规则筛选。复盘显式设置 `reviewMode: proposer` 和 `minSuccessToolCalls: 6`。模型超时或无效执行不生成经验。

## 状态与恢复

- `protocol.json`：任务、源码、评分材料、模型、筛选规则及配置指纹；恢复时拒绝漂移。
- `batch.json`、`summary.json`：检查点、逐题结果、候选数及已知 token 用量。

- `agent-data/runs/<runId>/`：manifest、trace、result、模型补丁与官方评分绑定。
- `agent-data/experiences/`：经验与独立检索描述；未晋升候选不会自动进入日常 TUI。
- `images.json`、`preflight.json`、`logs/run_evaluation/`：镜像与评分环境证据。

`batch.json` 是恢复依据，保存失败时停止后续请求。`summary.json` 是可重建的统计视图，单独写入失败会记录警告并在后续检查点重建，不中断任务；遇警告时以 `batch.json` 为准。JSON 原子替换遇 `EPERM`、`EACCES` 或 `EBUSY` 会有界退避重试，不通过删除旧目标文件绕过占用。

再次执行 `run` 跳过已完成的任务及复盘；未知付费中断拒绝自动重试。强制结束后先核验锁内 PID 已退出及运行产物，再处理残留 `batch.lock`。准备阶段可以继续；修复中断只恢复已保存的 `trial.json`，复盘中断须人工核验，避免重复付费。基础设施或服务错误停止后续任务。

每题准备前后检查批次所在盘可用空间，少于 15 GiB 停止后续调用。此检查不是持续磁盘配额：单次镜像下载仍可能占用较多空间；Docker 数据盘应与批次盘一致或单独检查。入口不自动清理历史镜像、卷或其他服务。
