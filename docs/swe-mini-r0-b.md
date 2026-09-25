# SWE-bench Verified Mini 同题经验复用

固定使用 `MariusHobbhahn/swe-bench-verified-mini` 的 50 题。R0 无经验执行；完成全部 R0 后逐题复盘；冻结每题 proposer 的首个候选后，B 在全新容器与会话中重做相同任务。没有候选的题仍正常运行 B。不会自动晋升、安装 Skills 或调用 critic。

本实验衡量同题经验复用的前后变化，不证明未见任务泛化，也没有额外无经验重跑组来排除模型随机性。两轮均使用 Pi 受控会话与单一容器 Bash 工具，而非日常 Windows TUI 的全工具配置。

R0 总是先于 B，供应商缓存预热也可能影响费用；应结合 cacheRead/cacheWrite 判断，不能把缓存折扣直接归因为经验收益。

## 环境准备

需要 Node >=22.19.0、Linux Docker 引擎和磁盘空间。任务镜像来自 Epoch 的公共共享层镜像，评分使用官方 swebench 4.1.0；镜像通过参考补丁检查后锁定 ID。已有模型配置按项目 `.env` 读取，密钥留在宿主内存，不传给任务容器。首次安装依赖使用 `npm ci`。

```powershell
docker build -t picode-swe-evaluator:4.1.0 benchmarks/swe-mini
npm run benchmark:swe-mini -- prepare
npm run benchmark:swe-mini -- run
npm run benchmark:swe-mini -- resume-b
npm run benchmark:swe-mini -- status
```

可在操作名后指定独立数据根；默认 `.picoding/benchmarks/swe-mini-r0-b-v1`。数据集 revision、镜像 ID、源码哈希、模型及上限固定后不允许在同批中更改。`prepare` 不调用模型，下载镜像并检查原始代码红、参考修复绿。参考补丁和评分测试只在独立评分侧使用。

`run` 会执行 100 次模型任务，另加最多 50 次 proposer 调用。使用配置的模型和 high 思考级别；任务时限为 0（当前默认值）时不限制任务总时长，正数按毫秒生效。单次请求超时仍独立生效。每条容器命令最多 120 秒。单次输出上限不是整个任务累计 token 预算。

## 结果与恢复

`resume-b` 只执行剩余复盘与 B 轮，要求已有全部 50 个唯一、已评分的 R0 结果；不执行 R0。它仍核验冻结协议，不能绕过源码漂移或未知中断检查。修复导致的源码变更须保留原协议、原批次及迁移说明，再明确恢复；未保存 usage 的旧复盘调用费用保持未知。

- `batch.json`：阶段与逐题检查点；`batch.lock`：进程互斥。
- `protocol.json`、`guidance.json`：固定协议与冻结经验。
- `agent-data/runs/`：manifest、result、trace、补丁和 benchmark 附加元数据。
- `agent-data/experiences/`：有证据引用的复盘产物。
- `logs/run_evaluation/`：官方 4.1.0 评分日志；`summary.json`、`report.md`：统计与中文结果。

完整完成的任务在恢复时跳过。评分失败时复用已保存补丁重新评分，不重复调用模型；原始证据保留，追加 regrade 记录。若中断发生在付费调用中但没有最终产物，程序拒绝自动重试，应先核对进程、run 和账单；不能删除记录后把重复调用隐藏起来。强制结束进程后，只有确认锁中 PID 已退出才能删除残留锁。环境或服务错误会停止后续调用；任务达到时限的开销仍记录。

成功率分母始终为 50，未完成期间属于暂定值；缺失评分单独显示。token 分为输入、输出、缓存读取和写入，并保存 SDK 总量；未知 usage 不填零。复盘开销单独统计。比较全部任务与两轮均成功任务，避免将提前放弃误认为提效。费用为 SDK 估算，不等于供应商最终账单。

容器没有网络或宿主目录挂载；评分材料、凭据和其他题的产物不进入任务容器。命令策略仍为误操作护栏，不能描述成完备代码沙箱。SWE 官方评分结果与项目文件保护审计分别保留；运行不作为现有跨任务晋升证据。
