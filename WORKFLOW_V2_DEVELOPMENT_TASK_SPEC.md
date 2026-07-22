# AiBan Workflow 2.0 开发任务说明书

> 文档版本：v1.0.0<br>
> 更新日期：2026-07-22<br>
> 上位计划：[`WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md`](WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md)<br>
> 使用方式：每次只领取一个主任务；开始前核对依赖，结束时按验收标准提交证据。

---

## 1. 任务执行规则

### 1.1 状态定义

| 状态 | 含义 |
|---|---|
| `TODO` | 依赖未完成或尚未开始 |
| `READY` | 依赖满足，可以领取 |
| `DOING` | 已开始，必须有负责人和工作分支 |
| `VERIFY` | 代码完成，等待自动化或现场验收 |
| `DONE` | 代码、测试、文档和证据全部完成 |
| `BLOCKED` | 存在明确外部阻塞，必须记录原因和解除条件 |

### 1.2 优先级

- `P0`：阻塞后续架构或存在运行可靠性风险，必须优先完成。
- `P1`：形成多场景和生产闭环所必需。
- `P2`：扩展业务能力或改善运维体验。

### 1.3 工作量标记

- `S`：单一模块的小改动，通常 0.5～1.5 个开发日。
- `M`：跨 2～4 个模块，通常 2～4 个开发日。
- `L`：包含新协议、多个组件和集成测试，必须拆分提交。

工作量只用于排序，不作为跳过验收的依据。

### 1.4 统一完成定义

任务只有同时满足以下条件才能标记 `DONE`：

1. 实现范围与任务说明一致，没有夹带无关重构。
2. 新旧相关自动化测试全部通过。
3. 错误和超时路径有明确测试。
4. 示例 flow 或配置能够展示新能力。
5. 协议、运维或用户行为发生变化时，对应文档已经更新。
6. `git status --short` 中没有由测试产生的垃圾文件。
7. 提交说明列出修改文件、验证命令、结果和已知限制。

### 1.5 基础验证命令

```powershell
cd node-red-contrib-aiban-workflow
npm.cmd test

npm.cmd run test:phase1
npm.cmd run test:phase2

cd ..
powershell -ExecutionPolicy Bypass -File tools/check-orphan-python.ps1
```

真实 SDK 和 MySQL 测试必须使用单独的现场步骤，不能由 Mock 测试代替。

---

## 2. 排期口径与进度算法

### 2.1 基准资源假设

本任务表的日期基于以下假设：

- 1 名主开发全职投入，AI 辅助分析、编码和测试。
- 每周 5 个开发日，从 2026-07-23 开始。
- 产品确认、现场 SDK、摄像头、MySQL 和外部接口能够按任务窗口提供。
- 日期未扣除法定节假日、请假和外部等待时间。
- “剩余人日”已经考虑现有代码的可复用程度，不是从零开发的总人日。
- 基准串行计划为 104 人日，功能和发布任务计划完成日为 2026-12-15。
- 另保留约 15% 风险缓冲，管理目标完成日为 2026-12-31。

如果投入 2 名开发并提供独立测试/现场支持，T01～T04 与 T05～T08、T09～T10 与 T11～T12 可以并行，预计可将总日历周期缩短到约 16 周；不得通过并行跳过共同协议门禁。

### 2.2 进度计算口径

模块和任务进度按验收成熟度估算：

| 进度 | 判定口径 |
|---:|---|
| 0% | 尚无设计或代码 |
| 10% | 已有方向、旧代码或原型，但不能进入主链路 |
| 25% | 核心设计或局部代码存在 |
| 50% | 主功能可运行，异常路径和契约未完整 |
| 70% | 自动化测试基本完整 |
| 85% | 真实 SDK/数据库/现场环境已验证 |
| 100% | 代码、自动化、现场、文档和验收全部完成 |

百分比是工程成熟度估算，不是代码行完成率。已有组件即使能运行，只要真实环境、异常恢复或文档未验收，就不能按 100% 计算。

### 2.3 进度更新规则

- 每周五或每个任务结束时更新一次，不按日制造虚假精度。
- 更新内容必须包含任务状态、完成度、实际投入、剩余人日、阻塞项、预计结束日和验证证据。
- 没有测试、现场记录、提交或文档证据时，完成度不得增加。
- 实际投入超过计划 30%、阻塞超过 2 个开发日或里程碑预测延迟时，必须重排后续日期。
- 需求新增必须创建新任务或明确替换原任务，不能直接消耗风险缓冲。
- 风险缓冲只用于缺陷、现场环境和集成偏差，不用于新增功能。

### 2.4 当前总体判断

- 项目整体成熟度：约 **35%（±5%）**。
- 单 Runtime + 单线性顺序场景：约 **70%**。
- 多 group、多 scene 平台能力：约 **10%**。
- 1.0 全业务功能对等迁移：约 **20%**。
- 生产发布成熟度：约 **15%**。

---

## 3. 模块开发周期与当前进度

| 模块 | 对应任务 | 当前进度 | 当前证据 | 主要缺口 | 剩余人日 | 基准周期 | 计划结束 |
|---|---|---:|---|---|---:|---|---|
| M0 基线与文档 | T00 | 40% | 新计划/任务书完成；91 项测试已执行 | README、真实 SDK 文档、对等矩阵仍滞后 | 2 | 07-23～07-24 | 07-24 |
| M1 Runtime 生命周期 | T01～T04 | 70% | spawn、stdin/stdout、启停、心跳和大量测试已存在 | 状态模型、统一入口、restart、真实 Windows 回收 | 11 | 07-27～08-10 | 08-10 |
| M2 结果协议与分层 | T05～T08 | 55% | 线性 FlowRuntime、OK/NG/TIMEOUT、审计和截图已存在 | outcome 契约、双模式结果、复杂逻辑入口 | 13 | 08-11～08-27 | 08-27 |
| M3 Group 元数据 | T09～T10 | 10% | 已有 pipelineConfig 和临时 ready 字段 | YAML 权威解析、真实 group/source/model | 5 | 08-28～09-03 | 09-03 |
| M3 Scene Registry/前端 | T11～T13 | 20% | scene-manager localStorage Demo 已存在 | 后端存储、API、权限、真实启停和冲突处理 | 12 | 09-04～09-21 | 09-21 |
| M4 Scene 路由/子流程 | T14～T15 | 5% | 只有规划和当前单链 flow | control/router/entry、隔离、首场景迁移 | 9 | 09-22～10-02 | 10-02 |
| M5 真实生产闭环 | T16～T18 | 30% | Runtime 和 result-db 有自动化基础 | 真实场景、MySQL、外部副作用、24h 和恢复 | 12 | 10-05～10-20 | 10-20 |
| M6 Sequence 完整能力 | T19 | 25% | 线性有序步骤已完成 | 缺步/数量/API/循环/guard 等 | 10 | 10-21～11-03 | 11-03 |
| M6 Monitor/Timer | T20 | 15% | 仓库有旧节点和 1.0 参考实现 | 新 outcome、scene 隔离、恢复和现场验证 | 10 | 11-04～11-17 | 11-17 |
| M6 Custom Flow | T21 | 5% | 只有旧引擎和设计参考 | 安全扩展模型、变量/timer/guard、真实迁移 | 10 | 11-18～12-01 | 12-01 |
| M7 运维与发布 | T22 | 15% | 有部分日志、测试报告和运维文档 | 看板、双跑、备份、回退、发布验收 | 10 | 12-02～12-15 | 12-15 |

模块进度每完成一个任务或现场验收后更新一次；只修改百分比但没有证据链接或测试结果视为无效更新。

---

## 4. 迭代周期编排

| 周期 | 日期 | 任务 | 周期目标 | 周期出口 |
|---|---|---|---|---|
| C0 基线周 | 07-23～07-24 | T00 | 统一代码、测试和文档事实 | 基线报告可作为后续验收起点 |
| C1 运行时稳定化 | 07-27～08-10 | T01～T04 | 启停、状态、restart 和回收可信 | 所有入口能证明 READY/STOPPED，无孤儿进程 |
| C2 结果分层 | 08-11～08-27 | T05～T08 | 固化 outcome/result 并兼容简单链 | 简单与复杂逻辑共用标准结果出口 |
| C3 Group/Scene 配置 | 08-28～09-21 | T09～T13 | 真实 group 元数据和 Scene Registry 上线 | 前端刷新/重启不丢场景，支持真实启停 |
| C4 路由与首场景 | 09-22～10-02 | T14～T15 | 建立 scene router/entry 并迁移插接场景 | 两 scene 可切换/并行且状态隔离 |
| C5 生产闭环 | 10-05～10-20 | T16～T18 | 真实 SDK、MySQL、副作用和稳定性验收 | 首个场景达到生产闭环标准 |
| C6.1 Sequence 扩展 | 10-21～11-03 | T19 | 补齐现场 Sequence 能力 | Sequence 子矩阵验收完成 |
| C6.2 Monitor/Timer | 11-04～11-17 | T20 | 迁移持续监控和工时计时 | 两类逻辑有真实示例和恢复测试 |
| C6.3 Custom Flow | 11-18～12-01 | T21 | 建立受控复杂逻辑扩展 | 至少一个真实 Custom Flow 对比通过 |
| C7 发布 | 12-02～12-15 | T22 | 运维、双跑、回退和发布门禁 | 具备 v2.0.0 发布候选条件 |
| 风险缓冲 | 12-16～12-31 | 缺陷/现场阻塞 | 吸收现场、节假日和集成偏差 | 不用于新增需求 |

---

## 5. 详细任务进度与排期表

| ID | 任务 | P | 当前完成度 | 状态 | 剩余人日 | 计划日期 | 依赖 | 现有基础/进度说明 |
|---|---|---:|---:|---|---:|---|---|---|
| T00 | 冻结当前基线并校正文档状态 | P0 | 40% | DOING | 2 | 07-23～07-24 | 无 | 新计划和任务书已完成；旧状态文档待校正 |
| T01 | 建立 RuntimeController 与真实状态模型 | P0 | 20% | TODO | 3 | 07-27～07-29 | T00 | 当前有分散状态字段，尚无独立控制器 |
| T02 | 统一按钮、HTTP 和消息控制入口 | P0 | 35% | TODO | 3 | 07-30～08-03 | T01 | 按钮和 HTTP 已存在，但无统一状态查询/反馈 |
| T03 | 修复 restart 与进程回收 | P0 | 35% | TODO | 2 | 08-04～08-05 | T01 | stop/重启测试已有，restart 持续存活断言缺失 |
| T04 | 生命周期故障矩阵与 Windows 验收 | P0 | 30% | TODO | 3 | 08-06～08-10 | T02、T03 | 自动化覆盖较多，现场回收矩阵和运维证据不足 |
| T05 | 冻结 workflow outcome/result 契约 | P0 | 20% | TODO | 2 | 08-11～08-12 | T00 | 已有 abc_result，但无通用 outcome 契约 |
| T06 | 提取线性顺序引擎公共边界 | P0 | 50% | TODO | 3 | 08-13～08-17 | T05 | FlowRuntime 已在 lib 中，但仍与 result 行为绑定 |
| T07 | aiban-result 双模式结果出口 | P0 | 35% | TODO | 5 | 08-18～08-24 | T06 | 简单顺序模式已存在，outcome 模式未实现 |
| T08 | 结果兼容、复杂逻辑和迁移测试 | P0 | 30% | TODO | 3 | 08-25～08-27 | T07 | 线性测试完善，复杂逻辑/双模式测试缺失 |
| T09 | 解析真实 Pipeline group 元数据 | P1 | 5% | TODO | 3 | 08-28～09-01 | T04 | 当前只有配置路径，无权威解析器 |
| T10 | runtime_ready 输出真实 group/source/model | P1 | 10% | TODO | 2 | 09-02～09-03 | T09 | ready 字段存在但 group 数据写死 |
| T11 | Scene Registry 存储层 | P1 | 5% | TODO | 4 | 09-04～09-09 | T05 | 只有前端 localStorage 数据结构 |
| T12 | Scene Registry API 和权限 | P1 | 0% | TODO | 4 | 09-10～09-15 | T11 | 尚无正式接口和权限模型 |
| T13 | scene-manager 接入正式 API | P1 | 25% | TODO | 4 | 09-16～09-21 | T10、T12 | 静态页面、CRUD Demo 和跳转已存在 |
| T14 | scene-control 与 scene-router | P1 | 0% | TODO | 5 | 09-22～09-28 | T10、T12 | 仅有规划，无节点实现 |
| T15 | scene-entry 与首场景迁移 | P1 | 10% | TODO | 4 | 09-29～10-02 | T08、T14 | 单链 flow 已有，尚未拆成 scene 子流程 |
| T16 | 真实 SDK 首场景闭环验证 | P1 | 15% | TODO | 3 | 10-05～10-07 | T15 | Runtime 有真实 SDK 基础，scene 闭环证据未固化 |
| T17 | MySQL 幂等与首个副作用闭环 | P1 | 30% | TODO | 4 | 10-08～10-13 | T16 | result-db 和队列测试已有，真实 MySQL 未验收 |
| T18 | 稳定性、故障恢复和阶段报告 | P1 | 10% | TODO | 5 | 10-14～10-20 | T17 | 有局部错误测试，无 24h/全链路恢复报告 |
| T19 | 补齐 Sequence 业务能力 | P2 | 25% | TODO | 10 | 10-21～11-03 | T08、T15 | 有序线性步骤已实现，其余能力待拆分 |
| T20 | 迁移 Monitor 与 Timer Record | P2 | 15% | TODO | 10 | 11-04～11-17 | T08、T15 | 旧节点和 1.0 实现可参考，未接新契约 |
| T21 | Custom Flow 受控扩展 | P2 | 5% | TODO | 10 | 11-18～12-01 | T20 | 只有旧引擎参考，需重新设计安全边界 |
| T22 | 运行管理、双跑、回退和发布 | P1 | 15% | TODO | 10 | 12-02～12-15 | T18、T19～T21 | 有部分日志/文档，未形成发布闭环 |

计划日期是基准窗口。任务进入 `BLOCKED`、实际人日偏差超过 30% 或依赖延迟超过 2 个开发日时，必须更新本表和里程碑日期。

---

## 6. M0：基线任务

### T00 冻结当前基线并校正文档状态

**目标**

建立一个与当前代码一致的事实基线，避免后续继续引用旧 ZMQ、旧测试数量或未验证结论。

**工作范围**

- 记录当前分支、提交、未提交文件和 Node/Python/AiBan SDK 环境。
- 执行当前全量自动化测试并保存摘要。
- 确认“本地单一逻辑跑通”使用的是 Mock SDK 还是真实 SDK。
- 更新以下文档的状态和入口：
  - `README.md`
  - `docs/REAL_SDK_TEST.md`
  - `docs/WORKFLOW_1_0_PARITY_MATRIX.md`
  - `docs/TEST_REPORT_V2_PHASE_1.md`
  - `docs/TEST_REPORT_V2_PHASE_2.md`
- 新增或更新一份带日期的基线记录，禁止把未执行的现场测试写成已通过。

**不在范围内**

- 不修改 Runtime 或业务逻辑代码。
- 不清理旧代码文件。

**验收标准**

- 文档中不再把已删除的 `aiban-frame-input` 作为当前启动方式。
- 测试数量和当前实际执行结果一致。
- Phase 1、Phase 2、Phase 3 的完成与未完成项没有互相矛盾。
- 真实 SDK、真实 MySQL、长稳测试均有明确的“已验证/未验证”状态和证据位置。

**验证**

```powershell
cd node-red-contrib-aiban-workflow
npm.cmd test
```

**交付物**

- 更新后的状态文档。
- 一份基线测试摘要。

---

## 7. M1：Runtime 生命周期稳定化

### T01 建立 RuntimeController 与真实状态模型

**目标**

把散落在 `aiban-runtime.js` 中的进程、SDK 和重启状态收敛为可测试的控制器。

**建议修改范围**

- 新增 `node-red-contrib-aiban-workflow/lib/runtime-controller.js`。
- 调整 `aiban-runtime.js`，由节点适配层调用控制器。
- 必要时新增只读状态类型或状态序列化辅助模块。

**实现要求**

- 定义 `STOPPED`、`STARTING`、`READY`、`STOPPING`、`ERROR`、`RECOVERING`。
- 分离 `autoStart`、`desiredState`、`actualState`。
- 记录 PID、session_id、最后错误、最后状态时间、restart_count。
- 所有状态变化必须由明确事件驱动，不允许按钮直接伪造 `READY`。
- 重复 start/stop 必须幂等。

**验收标准**

- 控制器可以在无 Node-RED 编辑器环境下单元测试。
- 进程创建成功但未收到 `runtime_ready` 时状态仍为 `STARTING`。
- `runtime_ready` 后才进入 `READY`。
- stop 超时、spawn 失败、意外退出分别进入明确状态。
- `autoStart=false` 不影响手动 start。

**测试重点**

- 合法状态转换。
- 非法或重复转换。
- start during stopping。
- stop during starting。
- spawn error 和 startup timeout。

**依赖**：T00。

---

### T02 统一按钮、HTTP 和消息控制入口

**目标**

让 Node-RED 编辑器按钮、管理 HTTP 接口和 `msg.topic=aiban/control` 使用同一个 RuntimeController。

**建议修改范围**

- `aiban-runtime.js`
- `aiban-runtime.html`
- `test/aiban-runtime-node.test.js`
- `docs/AIBAN_RUNTIME_PROTOCOL.md`

**实现要求**

- start 在进程不存在时创建 Python Runner。
- stop 走统一优雅停止路径。
- restart 走统一控制器，不从消息输入绕过进程管理。
- 增加只读状态接口，例如 `GET /aiban-runtime/:id/status`。
- 控制请求返回 `operation_id`、接收状态和当前 `actual_state`。
- 编辑器按钮根据实际状态显示“启动、停止、处理中、失败”，不能使用 `autoStart` 作为运行指示。
- `STARTING/STOPPING` 期间禁用重复点击或返回幂等操作结果。
- 成功或失败必须有用户可见通知。

**验收标准**

- 三种入口对同一操作产生一致状态序列。
- HTTP 200/202 只表示接口语义中定义的结果，不把“已接收”描述成“已 READY”。
- 停止后的消息 start 可以重新创建进程。
- 页面刷新后能够从状态接口恢复正确按钮状态。

**测试重点**

- HTTP start/stop/status。
- 消息 start/stop/restart。
- 快速双击和 start-stop-start。
- 未知节点、权限不足和无效 action。

**依赖**：T01。

---

### T03 修复 restart 与进程回收

**目标**

修复 Python restart 设置退出事件后仍退出的问题，并保证 Node.js 负责的进程重启不会遗留资源。

**建议修改范围**

- `python_runtime/aiban_runner.py`
- `python_runtime/lifecycle.py`
- `python_runtime/sdk_adapter.py`
- `aiban-runtime.js`
- `test/aiban-runtime.test.js`

**实现要求**

- 将“停止 Pipeline”和“结束 Runner 进程”拆成两个内部动作。
- Python in-process restart 不得设置最终 `_shutdown_event`。
- 生产 Runtime restart 优先由 Node RuntimeController 执行完整的停止进程、等待退出、重新 spawn、等待 READY。
- restart 后创建新的 session_id；同进程 Pipeline restart 如保留，必须明确是否复用 session_id。
- 正常 stop 必须先调用 `stopPipline()`。
- 超时强制结束时记录操作 ID、PID 和原因。
- Windows 下验证不会残留子进程。

**验收标准**

- restart 后至少收到第二次 `runtime_ready`。
- restart 后继续稳定产生新帧，而不是短暂 ready 后进程退出。
- 旧进程已退出，新进程只有一个。
- stop、Deploy、节点删除和 Node-RED 退出均无孤儿 Python 进程。

**测试补强**

- 现有 restart 测试必须断言 ready 次数大于等于 2。
- 必须断言 restart 后的帧发生在第二次 ready 之后。
- 必须断言测试观察窗口结束时 Runner 仍存活。

**依赖**：T01。

---

### T04 生命周期故障矩阵与 Windows 验收

**目标**

用自动化和现场步骤证明 Runtime 生命周期达到可运维状态。

**故障矩阵**

- Python 路径错误。
- Runner 路径错误。
- SDK import 失败。
- YAML 校验失败。
- `buildPipline()` 失败。
- startup timeout。
- heartbeat timeout。
- stop 超时。
- Python 意外退出。
- restart 达到最大次数。
- Deploy、删除节点、退出 Node-RED。

**验收标准**

- 每种故障都有期望状态、错误码和恢复动作。
- `restartPolicy=never/on-failure/always` 行为有独立测试。
- `tools/check-orphan-python.ps1` 检查结果为 0 个相关孤儿进程。
- 更新 `docs/OPERATIONS.md` 中的启停、状态和故障恢复说明。

**依赖**：T02、T03。

---

## 8. M2：结果协议与组件分层

### T05 冻结 workflow outcome/result 契约

**目标**

定义逻辑层向结果层提交终态的唯一协议，并明确兼容旧 `abc_result` 的方式。

**建议修改范围**

- `docs/PHASE2_MESSAGE_CONTRACT.md`
- 新增 JSON Schema 或契约测试夹具。
- 必要时新增 `lib/workflow-contract.js`。

**协议要求**

- 业务终态只允许 `OK`、`NG`、`TIMEOUT`、`INTERRUPTED`。
- 系统故障使用 `aiban/error`，不得伪装为业务 NG。
- outcome 必须包含 `workflow_id`、`scene_id`、`cycle_id`、`status`、`finished_at`。
- NG/TIMEOUT 必须支持 `code`、`reason`、`expected_step`、`actual_steps`。
- 标准 result 必须包含 `result_event_id` 并定义确定性生成规则。
- 明确截图失败是否阻止结果输出：默认不阻止，但必须记录截图错误。
- 明确重复 outcome 的去重规则。

**验收标准**

- 契约同时覆盖线性顺序、timer 超时、手动中断和复杂逻辑。
- 每个字段有类型、必填性、来源和兼容说明。
- 契约测试能够拒绝非法 status、缺失身份字段和无效时间。

**依赖**：T00。

---

### T06 提取线性顺序引擎的公共边界

**目标**

让现有 `TopologyCompiler + FlowRuntime` 成为独立的顺序逻辑能力，不再与截图、审计输出和 Node-RED 节点生命周期紧耦合。

**建议修改范围**

- `lib/flow-runtime.js`，或拆分为：
  - `lib/topology-compiler.js`
  - `lib/sequence-runtime.js`
- `aiban-result.js`
- `test/phase2-closed-loop.test.js`

**实现要求**

- 顺序引擎输入为规范化识别事实和状态存储接口。
- 顺序引擎输出 transition 或标准 outcome，不直接截图、写日志文件或发送 Node-RED 消息。
- 保留现有线性拓扑、frame_count、结束标签、去重和超时行为。
- TopologyCompiler 明确只负责简单线性模式，不扩展为任意图解释器。

**验收标准**

- 现有 Phase 2 顺序测试保持通过。
- 顺序引擎可在不加载 Node-RED 节点的情况下独立测试。
- 业务终态符合 T05 outcome 契约。

**依赖**：T05。

---

### T07 将 aiban-result 改为双模式结果出口

**目标**

把 `aiban-result` 收敛为统一结果边界，同时保留当前低配置的简单顺序用法。

**模式 A：simple-sequence**

- 自动编译上游线性 `aiban-label` 链。
- 调用 T06 顺序引擎产生 outcome。
- 保持当前 flow 不改线也能运行。

**模式 B：outcome**

- 接收上游 `msg.workflow.outcome`。
- 不反向解析复杂拓扑。
- 校验并输出标准 result。

**结果出口公共职责**

- 生成或校验 `result_event_id`。
- 终态去重。
- 按需截图。
- 审计和周期摘要。
- 统一 Node-RED 状态显示。
- 输出给 result-db、alarm、socket、api-output。

**不再承担**

- 任意分支、循环、timer 和第三方节点的拓扑推断。

**验收标准**

- 旧 A-B-C flow 行为和结果字段不退化。
- outcome 模式可以接收手工构造的 OK、NG、TIMEOUT、INTERRUPTED。
- 截图超时不丢失最终结果。
- 重复 outcome 只产生一次终态输出。

**依赖**：T06。

---

### T08 结果兼容、复杂逻辑和迁移测试

**目标**

证明结果分层既没有破坏简单流程，也能支持非线性逻辑。

**测试场景**

- 原 A→B→C→end。
- A→C 跳步 NG。
- 超时 TIMEOUT。
- Deploy 恢复 INTERRUPTED。
- switch/function 构造 outcome。
- timer 构造 TIMEOUT outcome。
- 两个并行逻辑只提交一个终态。
- 截图成功、失败和超时。
- result_event_id 重放。
- 旧 `abc_result.event_id` 兼容读取。

**交付物**

- 新旧模式示例 flow。
- 迁移说明：现有场景是否需要改线、改哪些配置。
- 更新 Phase 2 测试报告。

**依赖**：T07。

---

## 9. M3：Group 元数据与 Scene Registry

### T09 解析真实 Pipeline group 元数据

**目标**

从 `main-flow.yaml` 生成唯一、可验证的 group/source/infer/model 元数据。

**建议实现**

- Python 侧新增 `python_runtime/pipeline_config.py` 作为权威解析器。
- Node-RED 使用 Runner 输出的元数据，不再维护第二份独立 group 解析结果。
- 使用脱敏测试夹具覆盖现场 YAML 结构。

**实现要求**

- 解析 GroupArrary、Sources、Infers、ModelArrary 或现场实际等价字段。
- 规范化 group_id、source_id、model_id 类型。
- 检测重复 ID、缺失 source config、未知 model 引用和禁用 group。
- Windows 路径保持原值同时提供规范化结果。
- 解析失败必须阻止 READY，并给出配置错误码。

**验收标准**

- 不再出现 `groups: [1]` 临时数据。
- 多 group、多 source 和禁用 group 有自动化测试。
- 现场 YAML 可解析，但测试仓库不包含敏感配置。

**依赖**：T04。

---

### T10 runtime_ready 输出真实 group/source/model

**目标**

把 T09 的结果纳入正式 Runner 协议和 Node-RED 状态输出。

**实现要求**

- `runtime_ready.payload.groups` 输出完整规范化 group 列表。
- `sources_per_group` 和 `models_loaded` 从解析结果派生。
- heartbeat 可以输出 group/source 运行摘要，但不得每次重复大体积静态配置。
- aiban-runtime 缓存最近一次 ready 元数据，供状态接口和前端读取。

**验收标准**

- Mock 和真实配置使用同一字段结构。
- Node-RED 状态接口能够返回当前 session 的 group 元数据。
- 更新 `docs/AIBAN_RUNTIME_PROTOCOL.md`。

**依赖**：T09。

---

### T11 实现 Scene Registry 存储层

**目标**

用后端持久化替代正式流程中的 localStorage。

**建议实现**

- 新增 `lib/scene-registry-store.js`。
- 第一版使用本机 SQLite，数据库位于 Node-RED userDir 下的 `data/scene/`。
- store 与 HTTP、Node-RED 节点解耦，便于单元测试。

**数据要求**

- Scene 字段：group_id、scene_id、name、mode、workflow_id、node_red_tab_id、enabled、revision。
- 记录 created_at、updated_at、created_by、updated_by。
- 唯一键为 `(group_id, scene_id)`。
- 使用 revision 做乐观并发控制。
- 记录选择状态和变更审计，不能只覆盖最终值。

**验收标准**

- 服务重启后数据保留。
- 重复 scene 被拒绝或按明确 upsert 语义处理。
- 旧 revision 更新返回冲突。
- 非法 mode、未知 group、空 scene_id 被拒绝。

**依赖**：T05。

---

### T12 实现 Scene Registry API 和权限边界

**目标**

为 scene-manager 和 Node-RED 运行时提供正式控制接口。

**最小 API**

- 获取 runtime/group 元数据。
- 查询 group 下的 scene。
- 创建、编辑、删除 scene。
- enable/disable scene。
- 选择 exclusive 当前 scene。
- 查询当前 scene 和变更历史。
- 绑定或更新 node_red_tab_id。

**实现要求**

- 所有写操作记录 operator、revision 和 request_id。
- 删除有运行状态的 scene 前必须禁用并处理未完成周期。
- API 返回稳定错误码：NOT_FOUND、CONFLICT、INVALID_GROUP、INVALID_SCENE、FORBIDDEN。
- 权限区分只读、场景编辑、场景启停和 Runtime 运维。

**验收标准**

- CRUD、冲突、权限和非法输入有自动化测试。
- API 重启后读到相同数据。
- API 只修改 Scene Registry，不直接调用 SDK start/stop。

**依赖**：T11。

---

### T13 scene-manager 接入正式 API

**目标**

把静态 Demo 改为真实 Scene Registry 客户端。

**建议修改范围**

- `frontend-demo/scene-manager/index.html`
- 如复杂度增加，拆分为独立 CSS/JS 文件。

**实现要求**

- group 清单来自 Runtime/Registry API。
- 场景创建、编辑、删除、启用、停用和选择调用正式 API。
- 显示 revision 冲突、网络失败和权限失败。
- 显示 group enabled、scene enabled 和当前 active scene，三者不能混用。
- “进入编排”只打开绑定的 Node-RED tab。
- localStorage Demo 模式如保留，必须有明显的“演示模式”提示，不能伪装为服务端已保存。

**验收标准**

- 浏览器刷新和服务重启后数据不丢失。
- 点击场景启停不会停止 Runtime。
- 禁用 scene 后 UI 和 API 状态一致。
- 未绑定 tab 时给出明确引导。

**依赖**：T10、T12。

---

## 10. M4：Scene Router 与首场景

### T14 实现 scene-control 与 scene-router

**目标**

根据 Scene Registry 的 group/scene 状态，把每帧路由到正确场景。

**建议新增**

- `aiban-scene-control.js/.html`
- `aiban-scene-router.js/.html`
- `lib/scene-routing.js`
- `test/scene-router.test.js`

**路由模型**

- Router 配置保存可部署的 route 列表，每个 route 映射到固定输出端口。
- Registry 决定 route 当前是否生效，不动态修改 Node-RED 连线。
- 新建 scene 后仍需在 Node-RED 绑定 route/tab 并 Deploy。
- 最后一个输出端口固定为 diagnostics。

**实现要求**

- exclusive：一个 group 同时最多一个前台 scene。
- parallel：显式启用的后台 scene 可以同时接收帧。
- 消息补充 scene_id、workflow_id、route_id、routed_at。
- 未知 group、无 active scene、scene disabled、route 未绑定分别产生诊断码。
- Router 不复制业务状态，不调用 SDK start/stop。

**验收标准**

- 多 group 状态隔离。
- scene 切换后新帧只进入新 exclusive scene。
- parallel scene 可与 exclusive scene 同时收到独立消息副本。
- 无路由帧不会静默丢失。

**依赖**：T10、T12。

---

### T15 建立 scene-entry 并迁移首个场景 flow

**目标**

把当前主画布上的插接顺序逻辑迁移为独立场景子流程。

**建议新增或调整**

- `aiban-scene-entry.js/.html`，或采用有明确契约的 link-in 入口。
- `node-red/flows.json`
- `examples/group-scene-flow.json`
- TopologyCompiler 对 simple-sequence 入口类型的支持。

**目标画布**

```text
主流程：aiban-runtime → aiban-scene-router → diagnostics

group/1/scene/plug-sequence：
scene-entry
  → label 插接1
  → label 插接2
  → label 插接3
  → label end
  → result
  → result-db
```

**实现要求**

- scene-entry 校验 group_id、scene_id、workflow_id。
- scene 停用或切换时，定义未完成周期如何产生 INTERRUPTED。
- 状态数据库、审计和 result_event_id 使用 scene/workflow 标识。
- 主流程不再直接包含具体业务标签链。

**验收标准**

- 首场景行为与迁移前一致。
- 切换 scene 不需要重启 Python/AiBan。
- 不同 scene 的 cycle 和 timeout 不串扰。
- 示例 flow 可直接导入并使用 Mock SDK 验证。

**依赖**：T08、T14。

---

## 11. M5：首个真实生产闭环

### T16 真实 SDK 首场景闭环验证

**目标**

使用真实 AiBan SDK 和真实 Pipeline 配置验证首个 scene 的完整数据链路。

**现场步骤要求**

- 记录设备、OS、Node、Python、SDK 和模型版本。
- 记录脱敏后的 YAML 摘要和 group/source/model 映射。
- 验证启动、ready、真实帧、标签、顺序 OK、跳步 NG、TIMEOUT、截图和停止。
- 验证 source pause/resume 不影响其他 source。
- 验证 scene enable/disable/select 不停止 SDK。

**验收标准**

- 真实帧字段与 Mock 契约一致。
- 连续多次周期结果稳定，没有跨 source/scene 状态污染。
- 正常停止无孤儿进程。
- 结果和日志可以通过 session_id、event_seq、cycle_id 串联。

**交付物**

- 真实 SDK 测试报告和必要的脱敏日志摘要。

**依赖**：T15。

---

### T17 MySQL 幂等与首个副作用闭环

**目标**

证明真实结果能够可靠写库，并至少完成一个外部副作用通道。

**实现要求**

- MySQL schema 对 `result_event_id` 建立 UNIQUE 约束。
- 重复 result 只产生一条业务记录。
- 数据库暂时不可用时按队列和重试策略处理，并产生可观察错误。
- 截图路径、workflow_id、scene_id、cycle_id 和 result_status 可查询。
- 至少选择 Socket 播报或 API Output 完成一次真实联调。
- 副作用节点只消费标准 result，不解析 label 内部状态。

**验收标准**

- 重放同一 result_event_id 不重复入库或重复外部通知。
- 数据库断开、恢复和队列溢出有测试。
- OK/NG/TIMEOUT 的入库映射有明确规则。

**依赖**：T16。

---

### T18 稳定性、故障恢复和阶段报告

**目标**

完成首个生产闭环的稳定性和故障恢复验收。

**测试内容**

- 24 小时持续运行。
- Node-RED Deploy。
- Python 异常退出与自动重启。
- SDK 启动失败和恢复。
- MySQL 断开和恢复。
- scene 快速切换。
- 多 source 并发。
- 高水位 pause/resume。
- screenshot 超时。

**验收指标**

- 正常退出孤儿进程为 0。
- 正常负载静默丢帧为 0。
- 非预期无限重启为 0。
- 重复 terminal 导致重复副作用为 0。
- scene 切换后旧 scene 新建周期为 0。
- 性能数据达到或解释上位计划中的目标。

**交付物**

- 更新 Phase 2/3 测试报告。
- 更新 `docs/OPERATIONS.md`。
- 风险和遗留问题清单。

**依赖**：T17。

---

## 12. M6：业务逻辑迁移

### T19 补齐 Sequence 业务能力

**目标**

在公共 outcome/result 契约上补齐现场正在使用的 Sequence 能力。

**候选能力，必须按现场优先级拆子任务**

- on_complete、on_incomplete、on_skip、on_wrong_count、on_timeout。
- alarm_each_missing、save_db_each_missing。
- step duration、目标数量、step_code。
- external/API 步骤。
- presence tracking。
- loop mode、guard 和 transition step。

**验收原则**

- 每个子能力有独立消息契约、测试和示例。
- 不扩展 `aiban-result` 去实现这些规则；规则属于 Sequence 逻辑层。
- 结果统一通过 outcome 提交。

**依赖**：T08、T15。

---

### T20 迁移 Monitor 与 Timer Record

**Monitor 范围**

- 持续存在/缺失。
- 帧数或持续时间阈值。
- cooldown。
- 多 source 隔离。

**Timer Record 范围**

- start/end 标签。
- timer guard。
- absence tracking。
- 工时结果和写库。

**验收原则**

- 两类逻辑使用统一 scene-entry 和 outcome。
- Deploy、scene disable 和超时能正确清理 timer。
- 计时状态可恢复或明确产生 INTERRUPTED。

**依赖**：T08、T15。

---

### T21 设计并迁移 Custom Flow 扩展能力

**目标**

提供可测试、受约束的复杂业务扩展方式，逐步替代任意 Python Handler 和大段 Function 脚本。

**设计范围**

- counter/bool/tracker 变量。
- timer 和状态转换。
- guard 表达式。
- 受控自定义处理器接口。
- 超时、异常和资源上限。

**约束**

- 表达式或脚本不能任意访问文件、网络和进程。
- 自定义处理器必须有输入输出 schema、超时和错误隔离。
- 复杂逻辑最终仍提交标准 outcome。

**验收标准**

- 至少迁移一个真实 1.0 Custom Flow。
- 与 1.0 结果进行对比测试。
- 明确无法迁移或决定淘汰的能力。

**依赖**：T20。

---

## 13. M7：运行管理与发布

### T22 运行管理、双跑、回退与发布验收

**目标**

完成从可运行项目到可发布系统的最后门禁。

**工作范围**

- Runtime、group、source、scene、cycle 和结果运行看板。
- 配置备份、恢复和版本记录。
- 日志归档、容量和告警策略。
- 1.0/2.0 同输入双跑与结果对比。
- 进程、数据库、前端和 Node-RED 的启动顺序与服务化。
- 回退到 1.0 的演练。
- 安装、升级和卸载说明。

**发布门槛**

- `docs/WORKFLOW_1_0_PARITY_MATRIX.md` 每一项都有最终结论。
- 当前现场使用能力已迁移或有批准的替代方案。
- 24 小时稳定性、异常恢复和回退演练通过。
- 生产密码和配置不进入 Git。
- 现场验收报告签字完成后才能发布 v2.0.0。

**依赖**：T18，以及现场要求的 T19～T21 子任务。

---

## 14. 单任务领取模板

开始任务时复制以下内容到任务记录或提交说明：

```text
任务 ID：
任务名称：
负责人：
开始时间：
工作分支：
依赖状态：
计划修改文件：
本次不做范围：
验证命令：
现场依赖：
```

完成任务时追加：

```text
实际修改文件：
自动化测试结果：
现场测试结果：
协议/文档更新：
已知限制：
回退方式：
提交 ID：
```

---

## 15. 当前首批任务包

首批只领取以下任务，不提前开发 Scene Router：

```text
T00 基线与文档
  → T01 RuntimeController
  → T02 统一控制入口
  → T03 restart/进程回收
  → T04 生命周期验收

T00
  → T05 outcome/result 契约
```

T04 和 T05 都完成后，再启动 T06 及后续任务。这样可以避免在运行时状态和结果协议尚未稳定时，把不确定性扩散到多 scene 架构。
