# AiBan Workflow 2.0

> AiBan 智能视频分析平台 —— 工作流引擎 2.0  
> 将业务编排从 Python 引擎迁移到 Node-RED，实现配置即运行。

---

## 架构概览

```text
AiBan SDK Pipeline (C++)
    │ videoResultFunc 回调
    ▼
Python Frame Bridge (帧标准化 + 可靠传输)
    │ ZeroMQ DEALER/ROUTER
    ▼
Node-RED aiban-frame-input (接收入口)
    │ 持久化 → ACK → 投递
    ▼
Node-RED 工作流节点
    ├── detect / sub-detect     (模型匹配)
    ├── counter / timer         (计数 / 计时)
    ├── state / condition       (状态机 / 条件)
    ├── sequence / monitor      (顺序检测 / 安环)
    └── alarm / save-db / api   (报警 / 写库 / 输出)
```

### 进程模型

```text
main.py (主进程)
├── Process: videowork   — SDK pipeline + FrameBridge (ZMQ DEALER)
├── Process: videoalarm  — 报警、数据库写、喇叭 Socket
└── Thread:  Flask       — Web API (icameraapi + bridge 健康端点)
```

---

## 第一阶段：可靠帧通道（已完成）

建立了 AiBan SDK 到 Node-RED 的端到端可靠数据通道：

- **帧标准化** — SDK metadata 在回调生命周期内转为纯 Python dict，含 checksum
- **持久化** — Python SQLite WAL outbox + Node.js SQLite WAL inbox，`message_id` 去重
- **可靠传输** — ZeroMQ DEALER/ROUTER + 应用层 ACK + 超时重传
- **背压控制** — 高/低水位 + `sourceControl` 暂停/恢复 + 磁盘紧急水位
- **截图服务** — 异步截图请求/响应，FIFO 匹配，TTL 超时
- **可观测性** — 帧链路审计日志（人类可读 + CSV）、健康端点、运行统计

详见 [`docs/FRAME_PROTOCOL.md`](docs/FRAME_PROTOCOL.md) 和 [`docs/OPERATIONS.md`](docs/OPERATIONS.md)。

---

## 目录结构

```
workfolw_aiban_2.0/
├── main.py                         # 系统统一入口
├── requirements-v2.txt             # Python 依赖
├── test_aiban_sdk_bridge.py        # SDK 桥接诊断工具
│
├── core/                           # 核心引擎
│   ├── frame_bridge/               # 2.0 可靠帧桥接
│   │   ├── bridge.py               #   FrameBridge 主控（入队/落盘/背压）
│   │   ├── adapter.py              #   SDK metadata → 标准化帧
│   │   ├── protocol.py             #   帧协议 / checksum / envelope / ACK
│   │   ├── outbox.py               #   SQLite WAL 持久化发送队列
│   │   ├── transport.py            #   ZeroMQ DEALER 双向传输
│   │   ├── screenshot_service.py   #   异步截图请求/响应管理
│   │   └── audit.py                #   传输审计日志（JSONL + CSV）
│   ├── workflow_engine.py          # 1.0 工作流引擎（保留回退）
│   ├── video_logic.py              # 视频推理逻辑 + FrameBridge 集成
│   ├── video_process.py            # 子进程入口
│   ├── alarm_db.py                 # 报警数据库操作
│   └── infra.py                    # 基础设施（日志 / 报警消息）
│
├── node-red-contrib-aiban-workflow/ # Node-RED 自定义节点包
│   ├── frame-input-node.js/.html   #   帧输入节点（ZMQ ROUTER + inbox）
│   ├── sequence-node.js/.html      #   顺序检测节点
│   ├── timer-node.js/.html         #   计时器节点
│   ├── state-node.js/.html         #   状态机节点
│   ├── monitor-node.js/.html       #   安环监控节点
│   ├── api-trigger-node.js/.html   #   API 触发节点
│   ├── api-output-node.js/.html    #   API 输出节点
│   ├── socket-client-node.js/.html #   Socket 客户端节点
│   ├── exporter-node.js/.html      #   工作流导出节点
│   ├── lib/                        #   共享库（frame-inbox, frame-protocol）
│   └── test/                       #   Node.js 测试
│
├── node-red/                       # Node-RED 运行时
│   ├── flows.json                  #   当前部署流程
│   ├── settings.js                 #   运行时配置
│   └── package.json
│
├── config/
│   └── frame_bridge.env.example    # 环境变量模板
│
├── docs/                           # 文档
│   ├── FRAME_PROTOCOL.md           #   帧协议规范
│   ├── OPERATIONS.md               #   运维手册
│   ├── PHASE1_STATUS.md            #   第一阶段状态
│   ├── TEST_REPORT_PHASE_1.md      #   第一阶段测试报告
│   ├── AIBAN_TO_NODE_RED_DATA_PATH.md  # 数据路径详解
│   └── REAL_SDK_TEST.md            #   真实 SDK 测试指南
│
├── tests/                          # Python 测试
│   ├── test_frame_bridge.py        #   帧桥接单元测试（16 cases）
│   └── test_zmq_integration.py     #   Python↔Node 集成测试
│
├── workflows/                      # 工作流 JSON 定义
├── tools/                          # 工具脚本
├── icameraapi/                     # Flask Web API（含 venv）
├── scenes/                         # Python 场景模板
└── data/frame_bridge/              # 运行时数据（outbox.db / inbox.db / stats.json）
```

---

## 快速开始

### 1. 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Python | ≥ 3.9 | 支持 3.7–3.10 |
| Node.js | ≥ 22.5 | Node-RED 及 zeromq 原生模块 |
| pyzmq | 26.4.0 | `pip install -r requirements-v2.txt` |
| Node-RED | ≥ 4.0 | 自定义节点依赖 zeromq npm 包 |
| AiBan SDK | libAiBanVideoPy3_9 | 默认路径 `D:/product/AiBanWorkSpace` |

### 2. 安装依赖

```powershell
# Python
pip install -r requirements-v2.txt

# Node-RED 自定义节点
cd node-red-contrib-aiban-workflow
npm install

# Node-RED 运行时
cd ../node-red
npm install
```

### 3. 环境变量

参考 [`config/frame_bridge.env.example`](config/frame_bridge.env.example)，关键开关：

```bash
AIBAN_V2_BRIDGE_ENABLED=1    # 启用 2.0 帧桥接
AIBAN_V1_ENGINE_ENABLED=1    # 保留 1.0 引擎影子运行
AIBAN_FRAME_ENDPOINT=tcp://127.0.0.1:5557
```

### 4. 启动

```powershell
# 终端 1：启动 Node-RED
cd node-red
npx node-red --settings settings.js

# 终端 2：启动 Python
python main.py
```

验证：终端出现 `[ACK] #1 ... 端到端 x.xxms` 即表示通信正常。

---

## API 端点

Flask 运行在主进程，除 icameraapi 原有接口外，新增：

### `GET /aiban/bridge/stats`

FrameBridge 运行统计（JSON）：

```json
{
  "status": "200",
  "data": {
    "session_id": "uuid",
    "uptime_seconds": 1234.5,
    "ingress": {"pending": 3, "paused_sources": []},
    "outbox": {"total": 50000, "pending": 3, "acked": 49997},
    "transport": {"endpoint": "tcp://127.0.0.1:5557", "acks_received": 49997},
    "disk": {"percent_used": 45.2, "emergency": false},
    "screenshot": {"pending": 0, "in_flight": 0, "completed": 12, "timed_out": 0}
  }
}
```

### `GET /aiban/bridge/health`

快速健康检查：

```json
{"status": "200", "healthy": true, "age_seconds": 0.5}
```

### `POST /aiban/speaker/test`

手动触发喇叭测试：

```json
{"sourceid": 1, "group_id": 1, "speak_type": "on"}
```

---

## 测试

```powershell
# 一键运行第一阶段全部自动化测试
python tools/run_phase1_tests.py

# Python 单元测试（18 cases）
python -m unittest tests.test_frame_bridge -v

# Python↔Node 集成测试（含 ACK 丢失重发）
python -m unittest tests.test_zmq_integration -v

# Node.js 单元测试（4 cases）
cd node-red-contrib-aiban-workflow
npm test
```

---

## 关键设计决策

1. **Node-RED 是 2.0 的业务执行引擎** — Python 不再运行通用业务工作流，只负责 SDK 对接和可靠桥接
2. **SDK metadata 不得跨回调生命周期** — 在 `videoResultFunc` 内完成所有数据提取和转换
3. **不静默丢帧** — 过载时优先暂停视频源（`sourceControl`），不依赖 ZMQ HWM 溢出
4. **ACK 只在落盘后发送** — Node-RED inbox 持久化成功后才返回 ACK
5. **所有副作用幂等** — 通过 `message_id` 唯一键保证重放不重复执行业务
6. **1.0 引擎保留为回退路径** — 在 2.0 现场验证完成前不删除

详见 [`WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md`](WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md) 第 15 节。

---

## 开发阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| 阶段 0 | 仓库与基线 | ✅ |
| **阶段 1** | **可靠帧通道** | ✅ **已完成** |
| 阶段 2 | Node-RED 基础原子节点 | 🔜 进行中 |
| 阶段 3 | 业务模式迁移（双跑对比） | 📋 |
| 阶段 4 | 副作用节点（报警/写库/喇叭/API） | 📋 |
| 阶段 5 | 运行管理（健康检查/备份/日志） | 📋 |
| 阶段 6 | 切换与发布 v2.0.0 | 📋 |

---

## 相关文档

| 文档 | 说明 |
|---|---|
| [`WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md`](WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md) | 开发总纲（AI 协作版） |
| [`WORKFLOW_DOC.md`](WORKFLOW_DOC.md) | 1.0 引擎功能文档 |
| [`docs/FRAME_PROTOCOL.md`](docs/FRAME_PROTOCOL.md) | 帧协议规范 |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | 运维手册 |
| [`docs/TEST_REPORT_PHASE_1.md`](docs/TEST_REPORT_PHASE_1.md) | 第一阶段测试报告 |
| [`docs/AIBAN_TO_NODE_RED_DATA_PATH.md`](docs/AIBAN_TO_NODE_RED_DATA_PATH.md) | 数据路径与延迟详解 |
