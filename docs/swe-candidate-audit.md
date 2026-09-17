# SWE 单候选 A＋B 审核

用于对一条冻结候选执行来源任务 A 与同仓库另一任务 B 的重复对照。每题三对，共十二次新任务运行；候选组只加入该条候选。真实运行会调用配置的模型并产生费用。

## 准备

请求文件示例（路径和 ID 应替换为实际记录）：

```json
{
  "root": "D:/Agent/.picoding/benchmarks/my-candidate-audit",
  "sourceData": "D:/Agent/.picoding/benchmarks/swe-mini-r0-b-v1/agent-data",
  "candidateId": "候选ID",
  "selectionReason": "说明A来源、B适用范围和是否曾参与历史筛选",
  "tasks": [
    { "benchmarkRoot": "A所在评测目录", "instanceId": "A任务ID", "sourceRunId": "A来源运行ID" },
    { "benchmarkRoot": "B所在评测目录", "instanceId": "B任务ID", "sourceRunId": "B用于冻结配置的运行ID" }
  ]
}
```

在项目目录执行 `node --import tsx src/benchmark/swe-candidate-cli.ts prepare 请求文件路径`。准备阶段不调用模型，将来源记录与评分数据复制到新的批次目录，并复制执行源码、实际 node_modules、依赖锁文件。输出目录必须不存在；历史结果不作为新对照。

## 运行

进入新批次的 `runtime` 目录，使用该目录中的入口：

```powershell
# 若没有自定义 PICODE_ENV_FILE，指向原安装目录配置；密钥不会复制进执行快照。
$env:PICODE_ENV_FILE = 'D:\Agent\.env'
Set-Location 'D:\Agent\.picoding\benchmarks\my-candidate-audit\runtime'
node --import tsx src/benchmark/swe-candidate-cli.ts run 'D:\Agent\.picoding\benchmarks\my-candidate-audit'
```

已设置自定义配置路径时保留原值。运行前验证 Docker 镜像、评分器、源码和实际依赖的固定哈希；每题必须完成红基线失败、金补丁成功的独立评分预检。模型、上限、工具和任务在每次请求前检查。每对交替先执行无经验组或候选组。

中断时保留 `batch.json` 和启动绑定；有完整结果的付费运行可恢复，未知请求不自动重跑。进程强制退出可能留下 `.lock`，其中保存 PID；必须确认原进程已经退出再处理残留锁，不能删除活动锁。设施或模型错误会停止后续运行，不能靠重试挑选成功记录。

## 审核

执行 `node --import tsx src/benchmark/swe-candidate-cli.ts audit 批次目录` 不调用模型。`audit.json` 和 `report.md` 给出逐题改善/退化、完整性、用量及门槛结论；原始运行、补丁、独立评分与文件哈希分别位于 `agent-data/runs/`、批次根目录和 `bindings/`。

资格要求两题各三对完整运行，至少出现一次改善，没有任何配对退化、受保护文件变更或证据漂移。测试文件改动需逐份核查，防止修改验证条件制造通过。Token 或耗时改善不能替代成功结果改善。

`eligible` 仅表示 SWE 实验证据门槛，不代表统计显著性、稳定泛化或已晋升。此入口不创建本地 Git worktree 晋升事件，产物不能直接传给旧 `--promote-candidate`；普通实验与晋升原有校验保持不变，后续应用仍需单独确认和对应的仓库接入。
