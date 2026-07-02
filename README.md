# AiBan Workflow 2.0

> AiBan 智能视频分析平台 —— 工作流引擎 2.0（架构重启版）
> 将业务编排从 Python 引擎迁移到 Node-RED，Node-RED 直接管理 Python/AiBan 子进程。
> 当前阶段：**Phase 0（冻结旧架构，重置基线）**

---

## ⚠️ 架构变更通知（2026-07-02）

本项目的核心架构已发生重大变更：

**旧架构（已冻结）：**
```text
Python 常驻进程 → AiBan SDK 回调 → SQLite Outbox → ZeroMQ → Node-RED frame-input → SQLite Inbox → 下游
```

**新架构（v2.0-runtime-restart）：**
```text
Node-RED aiban-runtime
  → child_process.spawn(Python)
  → Python 初始化 AiBan SDK 并执行推理
  → 本机 stdin/stdout JSON Lines 通信
  → aiban-runtime 将结果转为 Node-RED msg
  → 直接发送给下游业务组件
```

Node-RED 成为系统的启动入口、运行主控和业务工作流引擎。Python 不再主动通过 ZeroMQ 向 Node-RED 发送数据。

详见 [`WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md`](WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md)（v2.0 架构重启版）。

---

## 新架构概览

```text
Node-RED
└── aiban-runtime（配置节点/输入节点）
    ├── 校验配置
    ├── child_process.spawn(Python)
    ├── 写入控制命令（stdin，JSON Lines）
    ├── 读取推理事件（stdout，JSON Lines）
    ├── 读取运行日志（stderr）
    ├── 管理启动、停止、重启和健康状态
    └── node.send(msg)
          ↓
      aiban-label（标签匹配）
          ↓
      counter / timer / state / sequence / monitor（业务节点）
          ↓
      alarm / result-db / speaker / api-output（副作用节点）
```

### Python Runner 职责

- 加载 AiBan Python SDK
- 按正确顺序注册回调、校验配置并启动 Pipeline
- 在 SDK 回调有效期内复制 metadata，转换为纯 Python 数据
- 输出标准推理事件、SDK 状态事件和截图结果（stdout，JSON Lines）
- 接收启动、停止、健康检查、截图、暂停和恢复等控制命令（stdin，JSON Lines）
- 不执行标签判断、顺序判断、报警、写业务库等通用业务逻辑

---

## 目录结构

```
workfolw_aiban_2.0/
├── README.md
├── WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md  # 开发总纲（架构重启版）
├── WORKFLOW_DOC.md                     # 1.0 引擎功能文档（参考）
│
├── python_runtime/                     # [NEW] Python AiBan Runner（待创建）
│   ├── aiban_runner.py                 #   Runner 主入口
│   ├── sdk_adapter.py                  #   AiBan SDK 适配器
│   ├── protocol.py                     #   JSON Lines 协议编解码
│   ├── command_loop.py                 #   stdin 控制命令循环
│   └── lifecycle.py                    #   启动/停止/健康检查
│
├── core/                               # 核心引擎
│   ├── frame_bridge/                   # [LEGACY] ZMQ 帧桥接（已冻结）
│   ├── workflow_engine.py              # 1.0 工作流引擎（保留回退）
│   ├── video_logic.py                  # 视频推理逻辑
│   ├── video_process.py                # 子进程入口
│   ├── alarm_db.py                     # 报警数据库操作
│   └── infra.py                        # 基础设施
│
├── node-red-contrib-aiban-workflow/    # Node-RED 自定义节点包
│   ├── aiban-runtime.js/.html          # [NEW] Runtime 管理节点（待创建）
│   ├── aiban-label.js/.html            # 标签匹配节点
│   ├── aiban-result.js/.html           # 结果聚合节点
│   ├── aiban-result-db.js/.html        # 结果入库节点
│   ├── sequence-node.js/.html          # 顺序检测节点
│   ├── timer-node.js/.html             # 计时器节点
│   ├── state-node.js/.html             # 状态机节点
│   ├── monitor-node.js/.html           # 安环监控节点
│   ├── api-trigger-node.js/.html       # API 触发节点
│   ├── api-output-node.js/.html        # API 输出节点
│   ├── socket-client-node.js/.html     # Socket 客户端节点
│   ├── exporter-node.js/.html          # 工作流导出节点
│   ├── frame-input-node.js/.html       # [LEGACY] ZMQ 帧输入节点
│   ├── lib/                            # 共享库
│   ├── test/                           # Node.js 测试
│   └── examples/                       # 示例流程
│
├── node-red/                           # Node-RED 运行时
├── docs/                               # 文档
│   ├── LEGACY_ZMQ_MIGRATION.md         #   旧架构代码处置清单
│   ├── WORKFLOW_1_0_PARITY_MATRIX.md   #   1.0 功能对等矩阵
│   ├── ENVIRONMENT.md                  #   现场环境记录
│   ├── FRAME_PROTOCOL.md               #   旧帧协议（归档）
│   ├── PHASE1_STATUS.md                #   旧阶段一状态（归档）
│   ├── TEST_REPORT_PHASE_1.md          #   旧阶段一测试报告（归档）
│   ├── PHASE2_MESSAGE_CONTRACT.md      #   旧阶段二消息契约（归档）
│   └── TEST_REPORT_PHASE_2.md          #   旧阶段二测试报告（归档）
│
├── config/
├── tests/                              # Python 测试（旧架构，已冻结）
├── icameraapi/                         # Flask Web API + AiBan SDK 绑定
├── tools/                              # 工具脚本
├── workflows/                          # 工作流 JSON 定义
└── data/                               # 运行时数据
```

---

## 开发阶段（架构重启版）

| 阶段 | 内容 | 状态 |
|------|------|------|
| **阶段 0** | **冻结旧架构并重置基线** | 🔧 **进行中** |
| 阶段 1 | Node-RED 直接启动 Python/AiBan | 📋 |
| 阶段 2 | A-B-C 组件拓扑最小闭环 | 📋 |
| 阶段 3 | 迁移全部业务逻辑组件 | 📋 |
| 阶段 4 | 迁移副作用组件 | 📋 |
| 阶段 5 | 运行管理 | 📋 |
| 阶段 6 | 切换与发布 v2.0.0 | 📋 |

旧阶段一（ZMQ 帧通道 ✅）和旧阶段二（A-B-C ZMQ 闭环 ✅）已完成但不再作为新架构基线。
旧代码已标记为 `legacy-zmq-baseline` 标签，处置方案见 [`docs/LEGACY_ZMQ_MIGRATION.md`](docs/LEGACY_ZMQ_MIGRATION.md)。

---

## 快速开始

### 环境要求

| 组件 | 版本 | 说明 |
|------|------|------|
| Windows | 11 Pro 10.0.26200 | x64 |
| Python | 3.9.13 | AiBan SDK 绑定 |
| Node.js | v24.13.0 | Node-RED 运行时 |
| Node-RED | v4.1.3 | 业务工作流引擎 |
| AiBan SDK | libAiBanVideoPy3_9 | 默认路径 `D:/product/AiBanWorkSpace/` |

详见 [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md)。

### 安装依赖

```powershell
# Node-RED 自定义节点
cd node-red-contrib-aiban-workflow
npm install

# Node-RED 运行时
cd ../node-red
npm install
```

### 启动（待阶段一完成后更新）

新架构启动方式（待实现）：

```powershell
# 仅需启动 Node-RED（aiban-runtime 节点会自动管理 Python 子进程）
cd node-red
npx node-red --settings settings.js
```

旧架构启动方式（已冻结，仅用于回退）：

```powershell
# 终端 1：Node-RED
cd node-red && npx node-red --settings settings.js

# 终端 2：Python
python main.py
```

---

## 测试

```powershell
# 旧架构测试（保留，用于回退验证）
python -m unittest tests.test_frame_bridge -v
cd node-red-contrib-aiban-workflow && npm test

# 新架构测试（待创建）
cd node-red-contrib-aiban-workflow && npm run test:runtime
```

---

## 关键设计决策（架构重启版）

1. **Node-RED 是系统启动入口和业务工作流执行引擎**
2. **Node-RED 组件直接启动并管理 Python/AiBan 子进程**（`child_process.spawn`）
3. **Python 与 Node-RED 阶段一使用本机 stdin/stdout JSON Lines 通信**
4. **推理事件由 `aiban-runtime` 直接 `node.send()` 给下游组件**
5. **ZMQ、Outbox、Inbox 和 ACK 不再属于新主链路**（标记为 `legacy-zmq-baseline`）
6. **Python 只负责 SDK 和协议适配，不执行通用业务工作流**
7. **SDK metadata 必须在回调有效期内转换为普通数据**
8. **回调线程不得直接执行阻塞管道写入或业务动作**
9. **过载时优先暂停视频源，不允许静默丢帧**
10. **Deploy、停止和异常退出必须正确回收 Python/AiBan 进程**
11. **1.0 全部现用功能完成对等迁移和现场验证后，才允许发布 2.0**
12. **新阶段一验收前，不删除旧架构代码**

---

## 相关文档

| 文档 | 说明 |
|------|------|
| [`WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md`](WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md) | 开发总纲（架构重启版） |
| [`WORKFLOW_DOC.md`](WORKFLOW_DOC.md) | 1.0 引擎功能文档 |
| [`docs/LEGACY_ZMQ_MIGRATION.md`](docs/LEGACY_ZMQ_MIGRATION.md) | 旧架构代码处置清单 |
| [`docs/WORKFLOW_1_0_PARITY_MATRIX.md`](docs/WORKFLOW_1_0_PARITY_MATRIX.md) | 1.0 功能对等矩阵 |
| [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) | 现场环境记录 |
