# AiBan Workflow 2.0 开发计划

> 文档版本：v3.0.5<br>
> 更新日期：2026-07-22<br>
> 当前分支：`v2.0-runtime-restart`<br>
> 当前状态：M0、M1（T01～T04）已完成；按用户要求暂停，下一任务为 T05<br>
> 配套任务书：[`WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md`](WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md)

---

## 1. 计划目的

本计划用于统一 AiBan Workflow 2.0 后续开发顺序、架构边界和验收门槛。

本轮重规划不再按“已有哪个节点就继续补哪个节点”的方式推进，而是先稳定公共运行底座，再固化结果协议和场景路由，最后逐类迁移业务逻辑。每个阶段必须形成可测试、可回退、可现场验证的闭环，不能只以代码存在作为完成标准。

具体开发任务、修改范围、依赖关系、测试要求和交付物以配套任务书为准。

---

## 2. 当前基线

### 2.1 已经具备的能力

- Node-RED 通过 `aiban-runtime` 启动和管理 Python Runner。
- Python Runner 通过 stdin/stdout JSON Lines 与 Node-RED 通信。
- Python 侧已封装 AiBan SDK 配置校验、Pipeline 启停、帧回调、截图和 source 暂停/恢复。
- `aiban-label` 可以从 `models[*].boxes[*]` 中完成标签和置信度匹配。
- `aiban-result` 可以对线性标签链执行顺序判定，产生 `OK`、`NG`、`TIMEOUT`、`INTERRUPTED`。
- 当前闭环支持状态持久化、重启恢复、审计、按需截图和结果幂等键。
- RuntimeController 已独立实现六态模型，分离 `autoStart`、`desiredState` 和 `actualState`。
- 编辑器按钮、管理 HTTP 和 Node-RED 消息输入已统一调用 `controlRuntime()`，并提供真实状态查询。
- Python Pipeline 停止与 Runner 最终退出已经分离；生产 restart 会等待旧 PID 退出后再拉起唯一的新进程。
- Runtime 故障矩阵、三种 restartPolicy、Windows 真子进程替换/删除回收和前后孤儿扫描已验收。
- 当前 Node.js 全量测试为 125 项，2026-07-22 本地执行结果为 125/125 通过。
- 外部 `frontend-demo/scene-manager` 已形成静态页面和 localStorage 演示稿。

### 2.2 当前真实完成度

当前系统处于“单 runtime、单线性场景、单结果出口”的可运行样板阶段，不等同于通用工作流平台完成。

按“代码、自动化测试、真实环境验证、文档和验收”综合计算，当前整体工程成熟度估算为 **43%（±5%）**。其中单 Runtime + 单线性顺序场景约 85%，多 group/multi-scene 平台能力约 10%，1.0 全业务功能对等约 20%，生产发布成熟度约 15%。百分比不是代码行完成率，详细依据见配套任务书的模块进度表。

尚未完成的关键项：

- 真实编辑器按钮操作仍需在现场 Node-RED 页面完成一次人工验收。
- 真实编辑器页面和真实 AiBan SDK 故障注入仍需在 T16 现场闭环中复核；当前 T04 已通过 Windows 真 Python 子进程验收。
- `runtime_ready.payload.groups` 尚未从真实 `main-flow.yaml` 解析，当前仍有临时写死数据。
- Scene Registry 只有前端 Demo，没有后端持久化和正式 API。
- 尚无 `group_id + scene_id` 运行时路由。
- `aiban-result` 同时承担顺序状态机和结果出口，且拓扑编译只支持线性 `aiban-label` 链。
- 真实 SDK 的完整顺序闭环、真实 MySQL 幂等写入和长稳测试尚未形成正式验收记录。

### 2.3 当前工作区说明

截至本计划重写时，工作区包含尚未提交的计划和前端 Demo 调整。后续任务不得覆盖无关的本地改动；每个任务开始前必须先检查 `git status --short`。

---

## 3. 本轮核心目标

### 3.1 目标

1. 建立可信的 AiBan 运行时状态机和统一控制入口。
2. 把“识别事实、业务逻辑、最终结果、副作用”分成清晰层次。
3. 保留简单顺序场景的低配置体验，同时允许复杂逻辑显式产生结果。
4. 从真实 YAML 建立 group 元数据，并按 `group_id + scene_id` 路由到独立场景子流程。
5. 建立正式 Scene Registry API，使外部前端能够创建、编辑、启停和进入场景。
6. 完成首个真实场景从 SDK 到结果、截图、数据库和外部输出的生产闭环。
7. 在此基础上分批迁移 1.0 的 Sequence、Timer Record、Monitor 和 Custom Flow 能力。

### 3.2 本轮非目标

- 不重新引入 Python 主动连接 Node-RED 的 ZeroMQ 主链路。
- 不让外部前端直接修改 Node-RED 节点连线。
- 不让场景启停直接停止整个 AiBan SDK Pipeline。
- 不在 group/scene 骨架稳定前一次性迁移全部 1.0 逻辑。
- 不以 Function 节点堆叠大量不可测试脚本作为长期实现。
- 不在真实 SDK、MySQL 和故障恢复未验收前宣布 2.0 可发布。

---

## 4. 核心架构决策

### 4.1 单 Pipeline、双平面

系统分为数据平面和控制平面。

```text
数据平面
AiBan SDK
  → Python Runner
  → aiban-runtime
  → group/scene router
  → scene entry
  → label/fact nodes
  → logic nodes
  → result endpoint
  → db/alarm/socket/api-output

控制平面
scene-manager
  → Scene Registry API
  → scene control
  → group 当前场景 / scene enabled 状态
  → router 生效

运维控制
runtime start/stop/restart
source pause/resume
health/status
```

一个 Pipeline 只允许一个 `aiban-runtime` 实例成为资源所有者。多个 scene 共享帧数据，但必须拥有独立的业务状态和结果周期。

### 4.2 四层职责

| 层次 | 职责 | 不负责 |
|---|---|---|
| 事实层 | 从推理帧提取标签、置信度、数量、区域、tracker 等事实 | 判断完整业务结果 |
| 逻辑层 | 顺序、计时、状态、AND/OR、外部步骤、业务守卫 | 数据库、播报等副作用 |
| 结果层 | 统一终态、周期、幂等键、截图、审计和标准结果消息 | 反向猜测任意复杂拓扑 |
| 副作用层 | MySQL、报警、Socket、API Output、日志 | 修改业务状态机 |

### 4.3 状态隔离键

运行状态必须至少按以下维度隔离：

```text
runtime_id
  → session_id
  → group_id
  → source_id
  → scene_id
  → workflow_id
  → cycle_id
```

推荐使用 `workflow_id = group/<group_id>/scene/<scene_id>`，使现有状态存储键自然包含 scene 维度。

---

## 5. 结果判定重构方案

### 5.1 保留显式结果边界

系统必须保留一个可见的结果出口。没有结果出口时，各种逻辑节点需要重复实现终态格式、截图、审计、幂等和副作用协议，长期会产生不兼容结果。

结果出口不等于所有业务逻辑都必须写在结果组件内部。

### 5.2 两种工作模式

#### 简单顺序模式

用于当前已经跑通的场景：

```text
aiban-label A → aiban-label B → aiban-label C → aiban-result
```

特性：

- 根据连线自动确定顺序。
- 继续支持 `frame_count`、结束标签、超时、重复帧去重。
- 保持现有流程兼容，业务人员不需要额外配置状态机。

#### 通用结果模式

用于 timer、state、switch、API、并行分支或自定义规则：

```text
label/fact nodes
  → sequence/timer/state/switch/custom logic
  → msg.workflow.outcome
  → aiban-result
```

上游逻辑显式产生：

```json
{
  "workflow": {
    "workflow_id": "group/1/scene/plug-sequence",
    "scene_id": "plug-sequence",
    "cycle_id": "uuid",
    "outcome": {
      "status": "OK",
      "code": "SEQUENCE_COMPLETED",
      "reason": null,
      "expected_step": null,
      "actual_steps": ["A", "B", "C"],
      "finished_at": "2026-07-22T10:00:00.000+08:00"
    }
  }
}
```

`aiban-result` 在通用模式下只负责校验和补全结果、生成 `result_event_id`、请求截图、写审计并输出标准结果。

### 5.3 实现方向

现有 `TopologyCompiler + FlowRuntime` 先保留为兼容实现，随后提取为独立的顺序逻辑模块或 `aiban-sequence` 节点。`aiban-result` 最终收敛为通用结果出口。

不得尝试让一个结果节点通过反向遍历自动理解任意 Node-RED 分支、循环和第三方节点；复杂逻辑必须通过显式 outcome 协议接入。

---

## 6. 启停与控制模型

### 6.1 三类控制必须分开

| 控制类型 | 作用范围 | 实现 | 典型使用者 |
|---|---|---|---|
| Runtime 启停 | 整个 Python/AiBan Pipeline | spawn、`buildPipline()`、`stopPipline()` | 运维/管理员 |
| Source 暂停/恢复 | 单个 group/source 视频源 | `sourceControl(group, source, run)` | 过载保护/运维 |
| Scene 启停/选择 | 单个业务场景逻辑 | Scene Registry + Router | 业务前端/操作员 |

Scene 停用只阻止帧进入该场景，不得停止整个 SDK Pipeline。Group 禁用是否调用 source pause 必须由独立策略明确配置，不能隐式发生。

### 6.2 Runtime 状态机

```text
STOPPED
  → STARTING
  → READY
  → STOPPING
  → STOPPED

STARTING/READY/STOPPING
  → ERROR
  → RECOVERING（满足重启策略时）
```

必须区分：

- `auto_start`：Deploy 或 Node-RED 重启后的配置策略。
- `desired_state`：用户当前希望运行还是停止。
- `actual_state`：根据 Python 进程和 SDK 生命周期事件确认的真实状态。

编辑器按钮必须显示 `actual_state`，不能使用 `auto_start` 代替运行状态。

### 6.3 控制接口原则

- 编辑器按钮、HTTP 管理接口和消息输入必须调用同一套 Node.js 控制器。
- `start` 在 Python 进程不存在时必须创建进程；进程存在但 Pipeline 未启动时才发送 SDK start 命令。
- `stop` 必须等待 `runtime_stopped` 或进程退出，并在超时后执行受控强制结束。
- `restart` 必须完成一个完整的 `STOPPED → STARTING → READY` 周期。
- HTTP 接口应返回操作 ID 或当前状态；不能仅凭请求已接收就声称启动成功。
- 必须提供只读状态接口，至少返回 `actual_state`、`desired_state`、PID、session_id、最后错误和最近状态时间。

---

## 7. Group 与 Scene 模型

### 7.1 Group 数据来源

`main-flow.yaml` 是物理 Pipeline、group、source、infer 和 model 的配置源。Python 或共享解析模块必须在启动校验后输出真实 group 元数据，禁止长期维护第二份手工 group 清单。

### 7.2 Scene Registry

Scene Registry 至少保存：

```json
{
  "group_id": 1,
  "scene_id": "plug-sequence",
  "name": "插接顺序检测",
  "mode": "exclusive",
  "workflow_id": "group/1/scene/plug-sequence",
  "node_red_tab_id": "tab-group1-plug-sequence",
  "enabled": true,
  "revision": 1
}
```

正式版本必须由后端持久化并提供并发更新保护。localStorage 仅保留为 Demo 或离线原型。

### 7.3 Router 规则

- 先按 `group_id` 校验物理运行域。
- 再读取该 group 的 scene 激活状态。
- `exclusive` 模式只允许一个前台 scene 接收帧。
- `parallel` 模式允许多个显式启用的后台 scene 接收帧。
- 未知 group、禁用 scene、未配置默认 scene 和无路由目标必须输出诊断事件，禁止静默吞帧。
- 每个 scene 使用独立 `workflow_id`、状态、超时和审计目录。

---

## 8. 开发里程碑

### M0：基线冻结与证据补齐

目标：把“代码已存在”和“现场已验证”分开记录，形成可信起点。

交付：

- 固化当前 91 项测试结果。
- 更新 Phase 1/2 状态和过时文档入口。
- 记录本地单一逻辑使用的是 Mock SDK 还是真实 SDK。
- 记录真实 SDK、截图和 MySQL 的实际验证结果；未验证项保持未完成。

退出条件：文档、测试和当前代码状态一致。

### M1：Runtime 生命周期稳定化

目标：让所有启停入口具有一致行为和可信反馈。

交付：

- 独立 RuntimeController 和明确状态机。
- 修复 start/stop/restart 路径。
- 状态查询接口和编辑器按钮反馈。
- Windows 子进程回收、快速连点、启动失败、停止超时和异常重启测试。

退出条件：每次操作均能以事件和状态接口证明最终状态，正常退出无孤儿进程。

### M2：结果协议与组件分层

目标：既保留线性顺序配置便利，又解除 `aiban-result` 对复杂逻辑的限制。

交付：

- 冻结 `msg.workflow.outcome` 和标准 result 契约。
- `aiban-result` 支持简单顺序模式和通用结果模式。
- 顺序引擎与结果输出职责分离。
- 现有 A-B-C flow 无行为回退。
- timer/state/switch 产生 outcome 的集成样例。

退出条件：简单场景保持低配置，复杂场景无需修改结果组件即可接入。

### M3：Group 元数据与 Scene Registry

目标：建立多 group、多 scene 的正式配置和控制入口。

交付：

- 解析真实 `main-flow.yaml` group/source/model 元数据。
- 正式 Scene Registry 存储和 CRUD/enable/select API。
- scene-manager 从 API 读取和写入数据。
- 前端具备场景启用、停用、选择和进入 Node-RED 子流程能力。

退出条件：前端刷新或服务重启后场景数据仍存在，所有变更有版本和审计信息。

### M4：Scene Router 与首个场景子流程

目标：让 runtime 帧按 group/scene 进入独立业务子流程。

交付：

- `aiban-scene-control` 和 `aiban-scene-router`。
- 统一 `aiban-scene-entry` 或等价入口。
- 当前插接顺序检测迁移为 `group/1/scene/plug-sequence`。
- exclusive、parallel、disabled、unknown、unrouted 自动化测试。

退出条件：两个 scene 可以在不重启 SDK 的情况下切换或并行运行，状态互不污染。

### M5：生产副作用闭环

目标：完成一个真实现场场景的端到端生产验证。

交付：

- 真实 SDK 帧进入场景并产生结果。
- NG/超时按需截图。
- MySQL 使用 `result_event_id` 幂等写入。
- 报警、Socket 或 API Output 至少完成一种真实联调。
- 形成异常、恢复和重复结果测试记录。

退出条件：现场结果可追溯、可重放验证、重复消息不重复产生副作用。

### M6：业务逻辑能力迁移

按现场使用优先级逐项迁移：

1. Sequence 补齐跳步、缺步、错误数量、外部步骤和循环守卫。
2. Monitor 持续存在/缺失和 cooldown。
3. Timer Record 开始/结束、离岗和工时记录。
4. Custom Flow 变量、timer、guard 和受控扩展机制。

每一种逻辑必须作为独立增量验收，不等待所有逻辑同时完成。

### M7：运行管理与发布

交付运行看板、日志检索、配置备份恢复、24 小时稳定性测试、故障恢复演练、1.0/2.0 双跑和回退方案。

退出条件：所有现用 1.0 能力在功能对等矩阵中有明确的“已迁移、替代或不迁移”结论，并完成现场签字验收。

---

## 9. 阶段依赖与执行顺序

### 9.1 基准排期

排期按 1 名主开发、每周 5 个开发日、2026-07-23 启动计算，未扣除法定节假日和外部环境等待。

| 里程碑 | 任务 | 剩余人日 | 计划周期 | 计划结束 | 当前模块进度 | 完成后全项目目标 |
|---|---|---:|---|---|---:|---:|
| M0 基线冻结 | T00 | 0 | 07-23～07-24 | 07-24 | 100% | 36% |
| M1 Runtime 稳定化 | T01～T04 | 0 | 计划 07-27～08-10；实际 07-22 | 07-22 | 100% | 43% |
| M2 结果分层 | T05～T08 | 13 | 08-11～08-27 | 08-27 | 55% | 51% |
| M3 Group/Scene Registry | T09～T13 | 17 | 08-28～09-21 | 09-21 | 15% | 62% |
| M4 Scene Router + 首场景 | T14～T15 | 9 | 09-22～10-02 | 10-02 | 5% | 68% |
| M5 生产闭环 | T16～T18 | 12 | 10-05～10-20 | 10-20 | 30% | 76% |
| M6 逻辑迁移 | T19～T21 | 30 | 10-21～12-01 | 12-01 | 15% | 94% |
| M7 发布 | T22 | 10 | 12-02～12-15 | 12-15 | 15% | 100% |

T00～T04 已于 2026-07-22 提前完成。剩余工作基准合计 91 人日，功能和发布任务目标完成日仍为 2026-12-15；另预留约 15% 风险缓冲，管理目标完成日为 2026-12-31。详细到任务的日期、进度和依据见 [`WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md`](WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md)。

### 9.2 依赖主链

```text
M0 基线冻结
  → M1 Runtime 稳定化
  → M2 结果分层
  → M3 Group/Scene Registry
  → M4 Scene Router + 首场景
  → M5 生产闭环
  → M6 逻辑迁移
  → M7 发布
```

### 9.3 并行规则

允许的并行工作：

- M1 后半段可以并行编写 M2 协议草案，但不得提前修改生产结果格式。
- M3 后端 API 与 scene-manager UI 可以在 Registry 契约冻结后并行。
- M5 的 MySQL 环境准备可以与 M4 并行，但正式验证必须使用 M4 的 scene/workflow 标识。
- M6 各类逻辑在公共 outcome 契约稳定后可以独立开发。

---

## 10. 统一验收门槛

每个任务必须同时满足：

1. 功能代码、自动化测试、配置示例和文档同时更新。
2. 原有测试保持通过，不允许用删除断言掩盖行为变化。
3. 新增状态或协议字段必须说明默认值、必填性和兼容策略。
4. 错误路径必须有明确输出，不得只写日志或静默返回。
5. 有外部副作用的操作必须具备幂等键或去重策略。
6. Deploy、节点删除、Node-RED 退出和异常退出必须验证资源回收。
7. 现场验证必须记录环境、配置、时间、操作步骤、原始结果和结论。
8. 单个任务必须可独立回退，不把多个架构变化塞入一次提交。

---

## 11. 可靠性与性能目标

| 指标 | 初始目标 |
|---|---|
| SDK 回调 P99 | `< 5 ms` |
| Python 事件生成到 Node-RED 收到 P95 | `< 50 ms` |
| Python 事件生成到 Node-RED 收到 P99 | `< 150 ms` |
| 正常负载协议解析错误 | `0` |
| 正常退出遗留子进程 | `0` |
| 非预期无限重启 | `0` |
| 正常运行静默丢帧 | `0` |
| scene 切换后旧 scene 新建周期 | `0` |
| 重复 terminal 导致重复副作用 | `0` |

性能指标必须在目标设备、真实摄像头数量和模型输出量下重新校准。

管道不是持久化消息队列。若业务明确要求进程崩溃后逐帧恢复，应单独设计 Node-RED 管理下的本机可选持久化层，不得恢复旧 ZMQ 主链路。

---

## 12. 日志与可观测性

日志和事件必须能够按以下链路串联：

```text
runtime_id
  → operation_id/request_id
  → session_id
  → stream_id/event_seq
  → scene_id/workflow_id
  → cycle_id
  → result_event_id
```

至少记录：

- Runtime desired/actual state、Python PID、退出码、重启次数和最后错误。
- SDK 配置校验、启动、停止、source pause/resume。
- 队列深度、水位、帧序号缺口和传输耗时。
- Scene 创建、修改、启停、选择、操作者和 revision。
- Router 命中、未路由、禁用和未知场景诊断。
- 工作流周期转换、最终结果、截图和副作用执行结果。

---

## 13. 安全与配置约束

- Node.js 启动 Python 必须使用 `spawn(executable, args)`，禁止 `shell: true`。
- Python、Runner、SDK 和 YAML 路径必须规范化并校验。
- 普通帧消息不得覆盖 executable、runnerPath 或数据库凭据。
- 生产密码、令牌和数据库认证不得提交到 Git。
- Node-RED 管理端和 Scene Registry API 必须启用身份验证和权限控制。
- Runtime 启停权限、Scene 操作权限和只读查看权限必须分开。
- 日志不得输出密码、令牌或完整认证头。

---

## 14. 文档与交付物

本计划执行期间至少维护：

- `WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md`：架构路线、里程碑、门禁。
- `WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md`：任务范围、步骤和验收。
- `docs/DEVELOPMENT_CHANGELOG.md`：开发计划和任务书的版本变更记录。
- `docs/AIBAN_RUNTIME_PROTOCOL.md`：Runner 生命周期与控制协议。
- `docs/PHASE2_MESSAGE_CONTRACT.md`：frame、workflow、outcome、result 契约。
- `docs/WORKFLOW_1_0_PARITY_MATRIX.md`：功能迁移事实状态。
- `docs/OPERATIONS.md`：启动、停止、恢复、排障和回退。
- 各阶段测试报告：记录自动化和现场验证证据。

---

## 15. 当前立即执行顺序

1. `T00` 已完成，基线证据见 [`docs/BASELINE_2026-07-22.md`](docs/BASELINE_2026-07-22.md)。
2. `T01`～`T04` 已完成，M1 Runtime 生命周期稳定化验收结束。
3. 当前按用户要求暂停；恢复后从 `T05` 开始冻结 outcome/result 契约并执行 T05～T08。
4. 执行 `T09`～`T15`，完成 group/scene 配置、前端和路由骨架。
5. 执行 `T16`～`T18`，完成首个真实生产闭环。
6. 依据现场优先级从 `T19` 开始逐类迁移 1.0 逻辑。

任务编号、依赖和验收命令见 [`WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md`](WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md)。
