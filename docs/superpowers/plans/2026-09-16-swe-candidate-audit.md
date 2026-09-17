# SWE 单候选 A＋B 审核实施计划

> 执行：采用 subagent-driven-development 分工实现独立模块，根代理协调执行与最终审核。不提交 Git，不创建日常开发 worktree；遵守仓库约定在当前目录保存改动。

**目标：** 为固定候选完成两题各三对真实 SWE 运行及证据资格审核。

**架构：** SWE 独立协议和审核，复用 runSweTask 与官方评分，保留普通 worktree 的全部拒绝规则。

**技术栈：** TypeScript ESM、Vitest、Docker、现有 Pi 模型运行时。

**设计：** `docs/superpowers/specs/2026-09-16-swe-candidate-audit-design.md`。

## 全局约束

- 只注入固定单候选；12 次新任务；不修改历史证据、不自动晋升。
- 同题各臂固定模型、任务、镜像、工具、评分器、源码及依赖快照。
- 不隐瞒失败或付费中断，不通过自动重试筛选成功。

## 工作项

- [x] 1. 新增 `src/benchmark/swe-candidate-evidence.ts` 与 `test/swe-candidate-evidence.test.ts`。纯审核接口消费协议与绑定的运行证据，返回逐题配对结果、门槛和 eligible；先写含字面期望的失败测试，再实现。验证 `npm test -- test/swe-candidate-evidence.test.ts`。
- [x] 2. 新增 `src/benchmark/swe-candidate-cli.ts` 和必要的存储/恢复模块。先通过测试验证槽位顺序、完整绑定、未知中断拒绝、重复证据拒绝。新批次冻结公共任务、私有评分文件、图像及源码；只在完整预检后调用 runSweTask。
- [x] 3. 运行 `npm run check`、`npm test`、`npm run lint`、`npm run build`，独立 review 后修复缺陷。保存源码和依赖指纹，拒绝运行期间漂移。
- [x] 4. 执行 A+B 红/金预检及 12 次真实任务，逐次保存证据；审阅所有 patch 和评分输出，生成中文审核报告、机器可读报告和可重算证据索引。

## 实施记录

- 用户已选择 A+B。来源候选和 A 已固定；B 选择依据只用公共问题与候选适用范围，披露是否在旧 holdout 出现过。
- Docker 初始未运行，已启动 Docker Desktop，等待健康检查。

- 2026-09-16：check、47文件465测试（maxWorkers=2）、lint、build通过。已冻结独立执行目录；Docker由用户恢复，三个镜像ID与协议一致。真实批次位于 .picoding/benchmarks/swe-candidate-2d5f07e8-ab-20260916，12次运行已启动调度，尚在预检。

- 2026-09-16：12次已完成、进程正常退出、批次容器已清理。A三对全持平；B三对一次改善、零退化（对照2/3、候选3/3）。11次独立官方评分，1次空补丁按既有规则判失败；该对照在只读Git查询被策略拦截后结束，不能证明拦截是结束的原因。红/金预检完整，结束后的源码、依赖、来源、配置及绑定审核无漂移。自动审核唯一待办为一份新增测试补丁，已逐份复核未弱化验证，独立复核同意空补丁可计入该冻结规则下的完整配对。qualification-review.json和审核报告.md记录效果门槛通过，未执行人工晋升，不能直接输入旧晋升命令。2次用量不完整，总Token/费用未知，不宣称节省。
