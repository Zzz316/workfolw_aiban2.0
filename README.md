# AiBan Workflow 2.0

> AiBan 智能视频分析平台工作流引擎 2.0。<br>
> Node-RED 是运行入口和业务编排引擎，Python Runner 只负责 AiBan SDK 与进程协议适配。<br>
> 当前阶段：T19～T22 开发与自动化已完成；T16～T18 的真实 SDK、MySQL/API、24 小时现场验收和现场签字仍阻塞正式发布。

## 当前状态

截至 2026-08-09：

- Node-RED 可以直接启动 Python Runner 和 AiBan Pipeline。
- stdin/stdout JSON Lines 帧通道、心跳、错误、截图和 source 控制已实现。
- `aiban-label → 业务逻辑层 → aiban-result → aiban-result-db/API` 结果闭环已实现。
- `workflow.outcome/result` 契约和双模式结果出口已完成。
- Pipeline group/source/model 元数据已从真实 YAML 解析并由 Runtime 状态接口暴露。
- Scene Registry SQLite 存储、revision 并发保护、审计、CRUD/enable/select API 和权限边界已完成。
- Scene Manager 已默认接入真实 Registry API；只有显式 `?demo=1` 才使用带明显标识的 localStorage Demo。
- `aiban-scene-router` 使用固定输出端口分发 exclusive/parallel 场景，并对未知组、无活动场景和未绑定路由显式诊断。
- `aiban-scene-entry` 已建立 group/scene/workflow 身份边界；场景停用或切换会把未完成周期收口为 `INTERRUPTED`。
- 主流程已拆为 Runtime → Router，插接顺序逻辑迁移到 `group/1/scene/plug-sequence` 独立 Tab。
- T17 已实现标准结果表、`result_event_id` UNIQUE、幂等队列/重试/失败重放和带本地 ledger 的 API Output；真实 MySQL/API 联调待现场执行。
- T18 已提供 24 小时稳定性 harness 和指标判定；2 秒双 source 冒烟通过，正式 24 小时及完整故障矩阵待现场执行。
- T19 Advanced Sequence 已覆盖缺步、数量、时长、外部步骤、presence、loop/guard/transition；T20 Monitor/Timer Record 已接入统一 scene/outcome 与持久状态。
- T21 Custom Flow 已通过 `aiban-custom-flow` 接入受控 JSON DSL，覆盖变量、timer、guard、tracker、状态转换、恢复/中断和标准 outcome。
- 2.0 已补齐原业务能力等价项：多模型/二阶子框事实归一化、sequence process monitoring、cycle record、API trigger、API output 和 socket/喇叭输出。
- T22 发布门禁工具 `tools/release_gate.js` 已完成；当前会明确阻塞 T16～T18 和现场签字未完成时的正式发布。
- Node.js 全量自动化测试 `218/218` 通过；指定 Python 环境 `D:\my_env\python.exe` 的 unittest `11/11` 通过。
- Runtime 状态已统一为 `STOPPED/STARTING/READY/STOPPING/ERROR/RECOVERING`，编辑器、HTTP 和消息入口共用真实状态控制。
- Python 兼容型 restart 在新 session 中持续运行；生产 restart 等待旧 PID 退出后只拉起一个替换进程。
- Windows 真 Python 子进程 restart、节点删除回收及测试前后 0 孤儿进程已通过 T04 验收。
- 2026-07-22 本地日志记录了真实 `group-1/source-1` 模型帧进入 Node-RED。
- T16 真实 Pipeline YAML 已成功解析，但 `libAiBanVideoPy3_9` 原生 DLL 初始化失败，Runner 未到 `runtime_ready`；真实 OK/NG/截图仍待环境修复后重验。
- 真实 MySQL 成功写入、真实 API 副作用和 24 小时稳定性仍需按正式测试矩阵验收。
- T13 浏览器验收已覆盖真实 API 加载、创建、刷新持久、启用、revision 冲突、未绑定 Tab 指引和 Demo 标识，页面控制台无错误。

项目整体工程成熟度估算约为 86%（±5%）。这里的完成度同时考虑代码、自动化、真实环境、文档和验收，不是代码行比例。

详细进度见：

- [开发计划](WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md)
- [开发任务说明书](WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md)
- [开发文档变更记录](docs/DEVELOPMENT_CHANGELOG.md)
- [T16～T20 实现与验收状态报告](docs/TEST_REPORT_T16_T20_2026-08-01.md)
- [T19/T20 业务逻辑消息合同](docs/ADVANCED_LOGIC_CONTRACTS.md)
- [T21 Custom Flow 合同](docs/CUSTOM_FLOW_CONTRACT.md)
- [T22 发布门禁](docs/RELEASE_GATE_V2.md)
- [2026-07-22 基线记录](docs/BASELINE_2026-07-22.md)

## 当前架构

```text
Node-RED aiban-runtime
  → child_process.spawn(Python Runner)
  → Python 加载 AiBan SDK、校验配置并启动 Pipeline
  → runtime_ready 输出真实 group/source/model metadata
  → SDK 回调内复制 metadata
  → stdout JSON Lines frame/status/error
  → aiban-runtime 输出标准 Node-RED msg
  → aiban-scene-router 固定端口路由
  → aiban-scene-entry 身份校验
  → 场景 Tab 内的 aiban-label / 逻辑节点
  → aiban-result（OK/NG/TIMEOUT/INTERRUPTED）
  → result-db / alarm / socket / api-output

Scene 控制平面
  → Scene Registry API
  → SQLite Scene / selection / audit
  → scene-manager / aiban-scene-control
  → aiban-scene-router 消费 Registry 状态
```

2.0 仓库发布面只包含当前 Node-RED Runtime、Python Runner、Scene、逻辑规则和外部副作用节点。

## 架构边界

### Python Runner

- 加载 AiBan Python SDK。
- 注册帧和 SDK 事件回调。
- 执行 `checkAllConfig()`、`buildPipline()`、`stopPipline()`。
- 在 metadata 有效期内复制模型、检测框和时间字段。
- 管理有界输出队列、高低水位和 source pause/resume。
- 通过 stdin 接收控制命令，通过 stdout 输出结构化事件。
- 不执行顺序、计时、报警、写业务库等通用业务逻辑。

### Node-RED

- 管理 Python/AiBan 进程生命周期。
- 把 frame/status/error 转为标准消息。
- 执行标签、顺序、计时、状态和结果逻辑。
- 按 `group_id + scene_id` 路由到独立场景子流程。
- 管理结果、审计、截图和外部副作用。

## 三类启停

| 控制 | 范围 | 说明 |
|---|---|---|
| Runtime start/stop/restart | 整个 Python/AiBan Pipeline | 运维控制 |
| Source pause/resume | 单 group/source | `sourceControl()`，用于过载和运维 |
| Scene enable/disable/select | 单业务场景 | 只控制业务路由，不停止 SDK |

RuntimeController、按钮真实状态查询、Runtime/Source 控制入口、Scene Registry 控制接口、Router 状态消费、restart 持续存活和 Windows 故障/回收矩阵已完成。Scene 控制不会调用 Runtime 或 SDK start/stop。

## 目录概览

```text
workfolw_aiban_2.0/
├── README.md
├── WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md
├── WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md
├── python_runtime/                     # 新 Python Runner
├── node-red-contrib-aiban-workflow/    # Node-RED 自定义节点包
│   ├── aiban-runtime.js/.html
│   ├── aiban-scene-control.js/.html
│   ├── aiban-scene-router.js/.html
│   ├── aiban-scene-entry.js/.html
│   ├── aiban-label.js/.html
│   ├── aiban-result.js/.html
│   ├── aiban-result-db.js/.html
│   ├── aiban-api-trigger.js/.html
│   ├── aiban-api-output.js/.html
│   ├── aiban-socket-output.js/.html
│   ├── aiban-sequence-logic.js/.html
│   ├── aiban-monitor-logic.js/.html
│   ├── aiban-timer-record.js/.html
│   ├── aiban-custom-flow.js/.html
│   ├── lib/
│   ├── test/
│   └── examples/
├── node-red/                           # Node-RED userDir、flows 和 settings
├── frontend-demo/scene-manager/        # 场景管理原型
├── docs/
└── tools/
```

## 环境

当前基线环境：

| 组件 | 版本/路径 |
|---|---|
| Windows | Windows 11 x64 |
| Node.js | v24.13.0 |
| npm | 11.6.2 |
| Python | 3.9.13 |
| Node-RED | 4.1.3 |
| AiBan SDK | `D:/product/AiBanWorkSpace`，Python 3.9 绑定 |
| Pipeline YAML | `D:/product/AiBanWorkSpace/abvideo/main-flow.yaml` |

详细环境见 [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)。

## 安装

```powershell
cd node-red-contrib-aiban-workflow
npm.cmd install

cd ..\node-red
npm.cmd install
```

## 启动

2.0 主链路只需要启动 Node-RED：

```powershell
cd node-red
npx.cmd node-red --settings settings.js
```

`aiban-runtime` 节点负责 Python Runner。开发环境可以在节点中启用 `useMock`；真实现场必须关闭 `useMock` 并配置 Python、SDK 和 Pipeline YAML。

真实 SDK 操作步骤见 [docs/REAL_SDK_TEST.md](docs/REAL_SDK_TEST.md)。

## 自动化测试

```powershell
cd node-red-contrib-aiban-workflow

# 当前全量：218/218（含 2.0 功能覆盖和隔离专项）
npm.cmd test

# Python Runner 生命周期专项
npm.cmd run test:phase1

# 线性顺序状态机专项：2026-07-22 基线为 30/30
npm.cmd run test:phase2

cd ..
D:\my_env\python.exe -m unittest discover tests
powershell -ExecutionPolicy Bypass -File tools/check-orphan-python.ps1
```

Mock 测试不能代替真实 SDK、真实 MySQL 和现场稳定性验证。

## 开发里程碑

| 里程碑 | 内容 | 当前状态 |
|---|---|---|
| M0 | 基线冻结与文档校正 | 已完成，标签 `workflow-v2-m0-baseline` |
| M1 | Runtime 生命周期稳定化 | 已完成，T01～T04 100%，标签 `workflow-v2-m1-runtime` |
| M2 | outcome/result 协议与组件分层 | 已完成，T05～T08 100% |
| M3 | 真实 group 元数据与 Scene Registry | 已完成，T09～T13 100% |
| M4 | Scene Router 与首场景子流程 | 已完成，T14～T15 100% |
| M5 | 真实 SDK、MySQL/API 与长稳 | 开发/工具已推进；T16 DLL 阻塞，T17/T18 现场待验收 |
| M6 | Advanced Sequence、Monitor、Timer、Custom Flow | T19～T21 开发与自动化完成；现场映射待复核 |
| M7 | 运维、双跑、回退和发布 | T22 门禁工具完成；正式发布被 T16～T18/签字阻塞 |

任务 ID、日期、剩余人日、依赖和验收标准见 [开发任务说明书](WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md)。

## 关键文档

| 文档 | 用途 |
|---|---|
| [WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md](WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md) | 当前架构和 M0～M7 计划 |
| [WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md](WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md) | T00～T22 任务、排期和进度 |
| [docs/AIBAN_RUNTIME_PROTOCOL.md](docs/AIBAN_RUNTIME_PROTOCOL.md) | Runner 控制和事件协议 |
| [docs/PHASE2_MESSAGE_CONTRACT.md](docs/PHASE2_MESSAGE_CONTRACT.md) | frame、workflow 和 result 契约 |
| [docs/SCENE_REGISTRY_API.md](docs/SCENE_REGISTRY_API.md) | T11/T12 Scene Registry 存储、API、权限和并发合同 |
| [docs/SCENE_ROUTING.md](docs/SCENE_ROUTING.md) | T13～T15 前端、固定端口路由、入口和中断合同 |
| [docs/TEST_REPORT_V2_SCENE_REGISTRY.md](docs/TEST_REPORT_V2_SCENE_REGISTRY.md) | T11～T15 自动化与浏览器验收记录 |
| [docs/WORKFLOW_V2_PARITY.md](docs/WORKFLOW_V2_PARITY.md) | 2.0 原生功能清单 |
| [docs/REAL_SDK_TEST.md](docs/REAL_SDK_TEST.md) | 真实 SDK 测试步骤 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 运维和故障恢复 |
| [docs/RUNTIME_LIFECYCLE_MATRIX.md](docs/RUNTIME_LIFECYCLE_MATRIX.md) | T04 故障矩阵与 Windows 验收证据 |

## 发布限制

当前不得创建正式 `workflow-v2.0.0` 标签。只有 T16～T18 真实环境验收、24 小时稳定性和现场签字通过后，才允许发布 2.0.0。
