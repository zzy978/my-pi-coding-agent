# 验证修复闭环实施计划

目标与约束见 [设计](../specs/2026-09-17-verification-repair-design.md)。在当前检出目录实施，保留原有改动。

- [x] 配置与共用判定：TaskSpec 可选 `maxRepairAttempts`；CLI 默认 2、范围 0..5，管理模式拒绝覆盖。旧任务缺字段不改变哈希。先用受控失败后写入正确文件的测试证明现状不能闭环。
- [x] 共用反馈：仅有正常退出码的失败命令进入修复；安全审计与超时失败终止；反馈用现有脱敏器处理并限长。
- [x] 受控 runner：原 prompt 后执行完整验证，按上限继续 prompt；每轮保存 verification-N.json 和带轮次的 trace，累计预算，错误保留已有结果。测试最终文件内容、验证历史、上限和 replay 参数。
- [x] 交互宿主：输入/结束/settled 生命周期驱动；防并发、任务漂移和旧会话续跑；新增 `/repair`，手动 `/verify` 不续跑。用实际扩展事件及隔离目录测试，不模拟判定函数。
- [x] 文档与复核：同步 README、帮助与 AGENTS；检查边界与脱敏；依次执行 `npm run check`、`npm test`、`npm run lint`、`npm run build`、`git diff --check`。

验证结果：2026-09-17，npm run check、npm test（50 个文件 / 508 项）、npm run lint、npm run build 和 git diff --check 均通过。构建后 CLI 帮助已包含修复参数。独立只读审查发现的扩展输入重置预算、取消时结果冲突、新旧验证交错及计时器边界已修复，并补回归测试；手动验证取消待发送续跑也已验证。未调用真实模型，未提交代码。
