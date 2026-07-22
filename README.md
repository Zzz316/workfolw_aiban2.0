# AiBan Workflow 2.0

> AiBan 智能视频分析平台工作流引擎 2.0。<br>
> Node-RED 是运行入口和业务编排引擎，Python Runner 只负责 AiBan SDK 与进程协议适配。<br>
> 当前阶段：M0 已完成，M1 Runtime 生命周期稳定化正在执行；T01～T03 已交付。

## 当前状态

截至 2026-07-22：

- Node-RED 可以直接启动 Python Runner 和 AiBan Pipeline。
- stdin/stdout JSON Lines 帧通道、心跳、错误、截图和 source 控制已实现。
- `aiban-label → aiban-result → aiban-result-db` 线性顺序闭环已实现。
- 全量自动化测试 `118/118` 通过；Phase 2 专项测试 `30/30` 通过。
- Runtime 状态已统一为 `STOPPED/STARTING/READY/STOPPING/ERROR/RECOVERING`，编辑器、HTTP 和消息入口共用真实状态控制。
- Python 兼容型 restart 在新 session 中持续运行；生产 restart 等待旧 PID 退出后只拉起一个替换进程。
- 2026-07-22 本地日志记录了真实 `group-1/source-1` 模型帧进入 Node-RED。
- 真实 SDK 端到端 OK/NG、真实 MySQL 成功写入、24 小时稳定性仍需按正式测试矩阵验收。
- Scene Manager 当前是 localStorage Demo，正式 Registry API 和 scene router 尚未实现。

项目整体工程成熟度估算约为 42%（±5%）。这里的完成度同时考虑代码、自动化、真实环境、文档和验收，不是代码行比例。

详细进度见：

- [开发计划](WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md)
- [开发任务说明书](WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md)
- [开发文档变更记录](docs/DEVELOPMENT_CHANGELOG.md)
- [2026-07-22 基线记录](docs/BASELINE_2026-07-22.md)

## 当前架构

```text
Node-RED aiban-runtime
  → child_process.spawn(Python Runner)
  → Python 加载 AiBan SDK、校验配置并启动 Pipeline
  → SDK 回调内复制 metadata
  → stdout JSON Lines frame/status/error
  → aiban-runtime 输出标准 Node-RED msg
  → aiban-label
  → 简单顺序逻辑 / 后续通用逻辑节点
  → aiban-result
  → result-db / alarm / socket / api-output
```

旧的 `main.py → SQLite Outbox → ZeroMQ → frame-input → SQLite Inbox` 链路已经冻结，不再是 2.0 主链路。旧代码仅用于迁移对照和必要回退。

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
- 后续按 `group_id + scene_id` 路由到独立场景子流程。
- 管理结果、审计、截图和外部副作用。

## 三类启停

| 控制 | 范围 | 说明 |
|---|---|---|
| Runtime start/stop/restart | 整个 Python/AiBan Pipeline | 运维控制 |
| Source pause/resume | 单 group/source | `sourceControl()`，用于过载和运维 |
| Scene enable/disable/select | 单业务场景 | 只控制业务路由，不停止 SDK |

RuntimeController、按钮真实状态查询、三类控制入口和 restart 持续存活已完成；真实 Windows 故障/回收全矩阵在 T04 验收。

## 目录概览

```text
workfolw_aiban_2.0/
├── README.md
├── WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md
├── WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md
├── WORKFLOW_DOC.md                     # 1.0 参考文档
├── python_runtime/                     # 新 Python Runner
├── node-red-contrib-aiban-workflow/    # Node-RED 自定义节点包
│   ├── aiban-runtime.js/.html
│   ├── aiban-label.js/.html
│   ├── aiban-result.js/.html
│   ├── aiban-result-db.js/.html
│   ├── lib/
│   ├── test/
│   └── examples/
├── node-red/                           # Node-RED userDir、flows 和 settings
├── frontend-demo/scene-manager/        # 场景管理原型
├── docs/
├── core/                               # 1.0/旧架构兼容代码
├── workflows/                          # 1.0 JSON 工作流参考
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

# 全量：M0 基线 91/91；T01 107/107；T02 116/116；T03 完成后 118/118
npm.cmd test

# Python Runner 生命周期专项
npm.cmd run test:phase1

# 线性顺序状态机专项：2026-07-22 基线为 30/30
npm.cmd run test:phase2

cd ..
powershell -ExecutionPolicy Bypass -File tools/check-orphan-python.ps1
```

Mock 测试不能代替真实 SDK、真实 MySQL 和现场稳定性验证。

## 开发里程碑

| 里程碑 | 内容 | 当前状态 |
|---|---|---|
| M0 | 基线冻结与文档校正 | 已完成，标签 `workflow-v2-m0-baseline` |
| M1 | Runtime 生命周期稳定化 | 进行中，T01～T03 已完成，模块约 94% |
| M2 | outcome/result 协议与组件分层 | 待开发，已有线性结果基础 |
| M3 | 真实 group 元数据与 Scene Registry | 待开发，已有前端 Demo |
| M4 | Scene Router 与首场景子流程 | 待开发 |
| M5 | 真实 SDK/MySQL 生产闭环 | 部分链路有运行证据，未正式验收 |
| M6 | Sequence/Monitor/Timer/Custom Flow 迁移 | 待逐项迁移 |
| M7 | 运维、双跑、回退和发布 | 待开发 |

任务 ID、日期、剩余人日、依赖和验收标准见 [开发任务说明书](WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md)。

## 关键文档

| 文档 | 用途 |
|---|---|
| [WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md](WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md) | 当前架构和 M0～M7 计划 |
| [WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md](WORKFLOW_V2_DEVELOPMENT_TASK_SPEC.md) | T00～T22 任务、排期和进度 |
| [docs/AIBAN_RUNTIME_PROTOCOL.md](docs/AIBAN_RUNTIME_PROTOCOL.md) | Runner 控制和事件协议 |
| [docs/PHASE2_MESSAGE_CONTRACT.md](docs/PHASE2_MESSAGE_CONTRACT.md) | frame、workflow 和 result 契约 |
| [docs/WORKFLOW_1_0_PARITY_MATRIX.md](docs/WORKFLOW_1_0_PARITY_MATRIX.md) | 1.0 功能迁移事实矩阵 |
| [docs/REAL_SDK_TEST.md](docs/REAL_SDK_TEST.md) | 真实 SDK 测试步骤 |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 运维和故障恢复 |
| [docs/LEGACY_ZMQ_MIGRATION.md](docs/LEGACY_ZMQ_MIGRATION.md) | 旧 ZMQ 代码处置策略 |

## 发布限制

当前不得创建正式 `workflow-v2.0.0` 标签。只有 M7 完成、现用 1.0 能力有明确迁移结论、真实环境和回退演练通过后，才允许发布 2.0.0。
