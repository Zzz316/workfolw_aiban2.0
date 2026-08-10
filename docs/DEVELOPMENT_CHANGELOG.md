# AiBan Workflow 2.0 开发文档变更记录

本文件只记录开发计划、开发任务书和进度基线的版本变化。产品包版本、数据库 schema 版本和协议版本必须在各自文件中独立维护，不能用文档版本代替产品发布版本。

## 版本规则

开发文档使用语义化版本：

- 主版本：核心架构、里程碑体系或任务拆分方式发生不兼容调整。
- 次版本：新增任务、模块、验收门槛或对排期进行实质调整。
- 修订版本：文字、日期、链接和不改变任务范围的修正。

版本更新要求：

1. 修改文档版本和更新日期。
2. 在本文件记录变更内容、影响范围和迁移说明。
3. 同一任务的代码、测试和协议变更使用独立 Git 提交，不与无关文件混合。
4. 里程碑验收通过后才允许创建里程碑标签。
5. `v2.0.0` 产品标签只能在 M7 发布验收完成后创建。

## 当前版本

| 文档 | 当前版本 | 日期 | 状态 |
|---|---|---|---|
| `WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md` | v3.0.15 | 2026-08-09 | 当前有效 |
| `WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md` | v1.0.15 | 2026-08-09 | 当前有效 |
| `docs/BASELINE_2026-07-22.md` | v1.0.0 | 2026-07-22 | M0 验收基线 |

## 变更记录

### 2026-08-09

#### 开发计划 v3.0.15 / 开发任务说明书 v1.0.15

- T21 更新为 100% 和 `DONE`：新增 `CustomFlowRuntime`、`aiban-custom-flow` 节点、受控 JSON guard/action DSL、示例 flow 和 `docs/CUSTOM_FLOW_CONTRACT.md`。
- T21 专项覆盖变量、timer、组合 guard、安全拒绝字符串表达式、source/session 隔离、scene 中断、Deploy 恢复和受控 Custom Flow 场景表达。
- T22 更新为 100% 和 `DONE`：新增 `tools/release_gate.js`、`docs/RELEASE_GATE_V2.md` 和门禁专项，自动检查节点、文档、示例、T21/T22 记录和 T16～T18/现场签字门禁。
- T23 完成 2.0-only 功能隔离收口：补齐多模型/二阶子框事实、Advanced Sequence process monitoring/cycle record、API trigger、Socket 输出和 Custom Flow tracker，并移除非当前发布面的入口、节点和框架文件。
- Node.js 全量回归更新为 218/218；指定 Python 环境 unittest 更新为 11/11。
- 当前正式发布状态仍为 `BLOCKED`：T16 真实 SDK、T17 真实 MySQL/API、T18 24 小时/故障矩阵和现场签字未完成，不能创建 `workflow-v2.0.0` 标签。

本次收口的是剩余可开发交付物；真实现场门禁仍按 T16～T18 和发布签字独立验收，不以 Mock 自动化替代。

### 2026-08-01

#### 开发计划 v3.0.14 / 开发任务说明书 v1.0.14

- 审核并修复 T16 Mock 标签、source pause 隔离、验证器事件匹配/编码和 Node 集成测试等待问题；Mock 验证器 17/17、Node T16 专项 12/12。
- 真实 T16 已执行：Pipeline YAML 可解析，但 `libAiBanVideoPy3_9` 原生 DLL 初始化失败，Runner 未到 `runtime_ready`，因此 T16 保持 `DOING`/现场失败待修复。
- T17 完成标准结果表 UNIQUE schema、MySQL 幂等队列/重试/失败重放、API Output SQLite ledger 和 9/9 专项；真实 MySQL/API 联调仍待执行。
- T18 完成 24 小时 harness、稳定性指标和双 source 短时冒烟；正式 24 小时及完整现场故障矩阵仍待执行。
- T19 Advanced Sequence 和 T20 Monitor/Timer Record 的独立规则层、状态持久化、统一 outcome、示例及各 10/10 专项完成，开发状态更新为 `DONE`。
- 修复同类型多节点共享 `logic-state.db` 时可能跨节点消费恢复状态的问题；持久状态改为稳定 Node-RED 节点 ID 命名空间，并纳入恢复回归。
- 全量测试固定 `--test-concurrency=1`，避免 Windows 真 Runner 生命周期验收与其他进程测试并发争用。
- Node.js 全量回归更新为 202/202，指定 Python 环境 unittest 保持 31/31。

本次将开发/自动化完成度与现场验收门禁分开记录；T19/T20 完成不代表 T16～T18 生产闭环通过。

### 2026-07-29

#### 开发计划 v3.0.13 / 开发任务说明书 v1.0.13

- T13 更新为 100% 和 `DONE`：Scene Manager 默认接入 Runtime/Scene Registry API，所有写操作使用 revision；错误提示、三类状态、绑定 Tab 跳转和显式 Demo 模式完成。
- T13 使用本地 Mock Registry 完成浏览器交互验收，覆盖创建、刷新持久、启用、revision 冲突、未绑定 Tab 指引、Demo 标识和控制台错误检查。
- T14 更新为 100% 和 `DONE`：新增 `aiban-scene-control`、`aiban-scene-router`、固定输出端口路由、exclusive/parallel 独立副本和 diagnostics。
- Router 在 scene 选择切换、scene/group 停用时向旧 route 发送 `aiban-interrupt`，不调用 Runtime 或 SDK start/stop。
- T15 更新为 100% 和 `DONE`：新增 `aiban-scene-entry` 身份边界，TopologyCompiler 支持 scene entry，未完成周期按 scene/workflow 隔离输出 `INTERRUPTED`。
- `docs/PHASE2_MESSAGE_CONTRACT.md` 更新为 `2.2-scene`，补充 route 字段、独立消息副本和 `aiban-interrupt` 合同。
- `node-red/flows.json` 已拆为主流程和 `group/1/scene/plug-sequence` 场景 Tab；新增可导入的 Mock 示例 `examples/group-scene-flow.json`。
- Node.js 全量自动化由 153 项增加为 163 项并全部通过；指定 Python 环境 unittest 31/31 通过。
- M3、M4 更新为 100%，剩余基准工作量由 65 人日更新为 52 人日，当前主线进入 T16。

本次完成 T13～T15 的场景配置和路由骨架，不替代 T16 真实 SDK、T17 真实 MySQL 或 T18 长稳验收，因此使用修订版本号。

#### 开发计划 v3.0.12 / 开发任务说明书 v1.0.12

- T11 更新为 100% 和 `DONE`：新增 SQLite Scene Registry Store，保存 Scene、exclusive selection 和 append-only audit。
- Scene 和 selection 分别使用 revision 做乐观并发控制；重复 scene、未知 group、非法 mode/scene 和旧 revision 均有稳定拒绝语义。
- T12 更新为 100% 和 `DONE`：新增 runtime metadata、Scene CRUD、enable/disable、exclusive select、current/history 和 tab 绑定 API。
- 权限拆分为 `aiban-scene.read`、`aiban-scene.edit`、`aiban-scene.control`；Runtime 运维继续独立使用 `aiban-runtime.write`。
- API 新建 scene 固定为 disabled，enabled 或仍被选择的 scene 不能删除；Scene API 不调用 Runtime 或 SDK start/stop。
- 新增 `docs/SCENE_REGISTRY_API.md` 和 `docs/TEST_REPORT_V2_SCENE_REGISTRY.md`。
- 新增 10 项 Scene Registry 专项测试，Node.js 全量由 143 项增加为 153 项并全部通过；指定 Python 环境 `D:\my_env\python.exe` 的 unittest 31/31 通过。
- 剩余基准工作量由 73 人日更新为 65 人日，当前主线进入 T13。

本次完成 T11/T12，不调整 T13 之后的范围或目标日期，因此使用修订版本号。

### 2026-07-24

#### 开发计划 v3.0.10 / 开发任务说明书 v1.0.10

- T10 更新为 100% 和 `DONE`：`aiban-runtime` 缓存最近一次 `runtime_ready` 元数据，并通过 `ready_metadata` / `ready_metadata_summary` 暴露给 `getRuntimeStatus()`、HTTP 状态接口和编辑器。
- heartbeat 状态消息只附带 `aiban.ready_metadata_summary`，避免重复发送完整 group/source/model 静态配置。
- 新增 runtime metadata 缓存、状态接口、只读拷贝和 heartbeat summary 自动化测试；编辑器脚本测试覆盖 metadata 摘要展示。
- 当前验证结果：Node.js 全量自动化由 142 项增加为 143 项，执行结果 143 / 143 通过；Python unittest discover 31 / 31 通过。
- M3 Group 元数据（T09～T10）更新为 100%，剩余基准工作量由 75 人日更新为 73 人日，当前主线进入 T11。

本次完成 T10，不调整 T11 之后的范围或目标日期，因此使用修订版本号。

#### 开发计划 v3.0.9 / 开发任务说明书 v1.0.9

- T09 更新为 100% 和 `DONE`：新增 `python_runtime/pipeline_config.py` 权威解析器，解析 `GroupArrary/Sources/Infers/ModelArrary` 并输出规范化 group/source/model metadata。
- 新增脱敏 YAML fixtures 和 Python 测试，覆盖多 group、多 source、禁用 group、重复 ID、缺失 source config、未知 model 引用和 READY 前失败。
- Runner 真实 SDK 模式在 `checkAllConfig()` 前解析配置；解析失败返回 `PIPELINE_CONFIG_*` 错误码且不发送 `runtime_ready`。Mock 模式输出同一 metadata 合同，避免被现场路径或本机 PyYAML 环境阻断。
- `runtime_ready.payload` 已移除临时 `groups: [1]`，开始携带规范化 `groups`、`sources_per_group`、`models_loaded`、`models` 和 `pipeline_config` 摘要。
- 当前验证结果：Node.js 全量自动化 142 / 142 通过；Python unittest discover 31 / 31 通过。
- 剩余基准工作量由 78 人日更新为 75 人日，当前主线进入 T10。

本次完成 T09，不调整 T10 之后的范围或目标日期，因此使用修订版本号。

#### 开发计划 v3.0.8 / 开发任务说明书 v1.0.8

- T08 更新为 100% 和 `DONE`：新增 `result-message` 归一化层，`aiban-result-db` 可消费标准 `workflow.outcome/result`，并继续兼容旧 `abc_result.event_id`。
- 新增 `test/aiban-result-db-compatibility.test.js`，覆盖 function/switch 风格 NG outcome、timer TIMEOUT outcome、旧 `abc_result.event_id` 和错误 `result_event_id`。
- 更新 `docs/PHASE2_MESSAGE_CONTRACT.md` 和 `examples/outcome-mode-flow.json`，并完善 `abc-sequence-flow.json` 的 `simple-sequence` 配置。
- M2 结果协议与分层更新为 100%，T05～T08 全部完成；剩余基准工作量由 81 人日更新为 78 人日，当前主线进入 T09。
- 当前 Node.js 全量自动化由 138 项增加为 142 项，执行结果 142 / 142 通过。

本次完成 M2 结果分层，不调整 T09 之后的范围或目标日期，因此使用修订版本号。

#### 开发计划 v3.0.7 / 开发任务说明书 v1.0.7

- T07 更新为 100% 和 `DONE`：`aiban-result` 新增 `simple-sequence` 与 `outcome` 双模式结果出口。
- outcome 模式直接接收 `msg.workflow.outcome`，不反向解析拓扑；负责校验 outcome、生成或校验 `result_event_id`、终态去重、截图失败保底输出和统一审计。
- 新增 `test/aiban-result-outcome-mode.test.js`，覆盖手工 OK/NG/TIMEOUT/INTERRUPTED、重复终态、截图失败和错误 `result_event_id`。
- M2 结果协议与分层进度由 70% 更新为 82%，剩余基准工作量由 8 人日更新为 3 人日；当前主线进入 T08。
- 当前 Node.js 全量自动化由 134 项增加为 138 项，执行结果 138 / 138 通过。

本次完成结果出口双模式，不调整 T08 之后的范围或目标日期，因此使用修订版本号。

#### 开发计划 v3.0.6 / 开发任务说明书 v1.0.6

- T05 更新为 100% 和 `DONE`：新增 `workflow-contract`，冻结 `workflow-outcome/v1` 与 `workflow-result/v1`，并在 `aiban-result` 输出中新增 `msg.workflow.outcome` 与 `msg.workflow.result`。
- T06 更新为 100% 和 `DONE`：新增 `SequenceRuntime` 与 `TopologyCompiler` 公共入口，顺序引擎终态事件直接携带标准 outcome，同时保留旧 `abc_result` 兼容层。
- M2 结果协议与分层进度由 55% 更新为 70%，剩余基准工作量由 13 人日更新为 8 人日；当前主线进入 T07。
- 当前 Node.js 全量自动化由 125 项增加为 134 项，执行结果 134 / 134 通过；孤儿 Python 扫描 fallback 显示 0 个 `python.exe` 进程。
- `docs/PHASE2_MESSAGE_CONTRACT.md` 更新为 `2.1-outcome`，补充字段必填性、兼容策略、截图失败不阻断结果和确定性 `result_event_id` 规则。

本次完成结果协议和顺序引擎公共边界，不调整 T07 之后的范围或目标日期，因此使用修订版本号。

### 2026-07-22

#### 开发计划 v3.0.5 / 开发任务说明书 v1.0.5

- T04 更新为 100% 和 `DONE`，实际完成日期为 2026-07-22，测试、工具和运维提交为 `f83ccb8`。
- M1 Runtime 生命周期稳定化更新为 100%，T01～T04 全部完成；下一任务 T05 保持 `READY`，按用户要求暂停。
- M1 剩余工作量由 3 人日更新为 0；全项目成熟度由约 42% 更新为约 43%，剩余基准工作量由 94 人日更新为 91 人日。
- 当前全量自动化由 118 项增加为 125 项，执行结果 125 / 125 通过。
- Windows 真子进程完成旧 PID→新 PID 唯一替换和节点删除回收；一键验收前后均扫描到 0 个 AiBan Runner。

本次只记录 T04 和 M1 完成事实，不调整 T05 之后的范围或目标日期，因此使用修订版本号。

#### 开发计划 v3.0.4 / 开发任务说明书 v1.0.4

- T03 更新为 100% 和 `DONE`，实际完成日期为 2026-07-22，功能与协议提交为 `f242d15`。
- 当前主线进入 T04；T04 因 T02、T03 依赖满足更新为 `READY`。
- M1 模块进度由约 86% 更新为约 94%，剩余工作量由 5 人日更新为 3 人日。
- 全项目成熟度由约 40% 更新为约 42%，剩余基准工作量由 96 人日更新为 94 人日。
- 当前全量自动化测试由 116 项增加为 118 项，执行结果 118 / 118 通过；回归后 Windows 扫描为 0 个 AiBan Runner 进程。

本次只记录 T03 完成事实和进度变化，不调整后续任务范围、依赖或目标日期，因此使用修订版本号。

#### 开发计划 v3.0.3 / 开发任务说明书 v1.0.3

- T02 更新为 100% 和 `DONE`，实际完成日期为 2026-07-22，功能提交为 `7ac8f59`。
- 当前主线进入 T03；T04 仍等待 T03 完成后进入 `READY`。
- M1 模块进度由约 78% 更新为约 86%，剩余工作量由 8 人日更新为 5 人日。
- 全项目成熟度由约 38% 更新为约 40%，剩余基准工作量由 99 人日更新为 96 人日。
- 当前全量自动化测试由 107 项增加为 116 项，执行结果 116 / 116 通过。

本次只记录 T02 完成事实和进度变化，不调整后续任务范围、依赖或目标日期，因此使用修订版本号。

#### 开发计划 v3.0.2 / 开发任务说明书 v1.0.2

- T01 更新为 100% 和 `DONE`，实际完成日期为 2026-07-22，功能提交为 `aea6e9a`。
- T02、T03 因依赖满足更新为 `READY`，当前主线进入 T02。
- M1 模块进度由约 70% 更新为约 78%，剩余工作量由 11 人日更新为 8 人日。
- 全项目成熟度由约 36% 更新为约 38%，剩余基准工作量由 102 人日更新为 99 人日。
- 当前全量自动化测试由 M0 的 91 项增加为 107 项，执行结果 107 / 107 通过。

本次只记录 T01 完成事实和进度变化，不调整后续任务范围、依赖或目标日期，因此使用修订版本号。

#### 开发计划 v3.0.1 / 开发任务说明书 v1.0.1

- T00 更新为 100% 和 `DONE`，M0 实际完成日期记录为 2026-07-22。
- 全项目成熟度基线由约 35% 更新为约 36%，剩余基准工作量由 104 人日更新为 102 人日。
- T01 和 T05 因依赖满足更新为 `READY`，当前主线进入 T01。
- 新增 `docs/BASELINE_2026-07-22.md`，记录版本、环境、91/91 全量测试、30/30 Phase 2 测试和真实日志证据。
- 重写 README、真实 SDK 指南、Phase 1/2 报告和 2.0 功能清单，移除非当前发布面的架构描述与未经验证的结论。

本次仅更新事实基线和任务状态，不改变 T00～T22 的范围、依赖和总体排期，因此使用修订版本号。

#### 开发计划 v3.0.0

- 从原 v2.2 阶段说明书重构为可执行的 M0～M7 里程碑计划。
- 重新确认 Runtime、结果判定、Group/Scene、业务逻辑和副作用的职责边界。
- 将 Runtime、Source 和 Scene 三类启停明确分离。
- 将 `aiban-result` 规划为简单顺序和通用 outcome 双模式结果出口。
- 增加模块成熟度、104 人日基准排期和 2026-12-31 风险缓冲目标。
- 把详细任务下沉到独立任务说明书。

迁移说明：原 v2.2 中仍然有效的 SDK、协议、安全和性能约束已经并入 v3.0.0；历史阶段描述不再作为当前任务执行依据。

#### 开发任务说明书 v1.0.0

- 首次建立 T00～T22 共 23 项任务。
- 为每项任务定义目标、范围、依赖、实现要求、测试和验收标准。
- 增加模块进度、C0～C7 迭代周期、逐任务日期和剩余人日。
- 定义进度成熟度算法、每周更新规则和超过 30% 偏差时的重排机制。

## Git 与标签约定

建议提交粒度：

```text
docs(plan): ...
feat(runtime): ...
fix(runtime): ...
feat(result): ...
feat(scene): ...
test(...): ...
docs(...): ...
```

里程碑标签仅在验收完成后创建：

```text
workflow-v2-m0-baseline
workflow-v2-m1-runtime
workflow-v2-m2-result
workflow-v2-m3-scene-registry
workflow-v2-m4-scene-routing
workflow-v2-m5-production-loop
workflow-v2-m6-logic-parity
workflow-v2-rc.1
workflow-v2.0.0
```

当前阶段不得创建 `workflow-v2.0.0` 正式标签。
