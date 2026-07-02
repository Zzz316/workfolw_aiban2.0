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
Node-RED 工作流节点 (Phase 2 运行时执行)
    ├── label-match             (标签匹配: model_id + label + confidence)
    ├── abc-sequence            (A→B→C 顺序状态机, SQLite 持久化)
    ├── result-db               (异步幂等 MySQL 入库)
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

## 第一阶段：可靠帧通道（已完成 ✅）

建立了 AiBan SDK 到 Node-RED 的端到端可靠数据通道：

- **帧标准化** — SDK metadata 在回调生命周期内转为纯 Python dict，含 checksum
- **持久化** — Python SQLite WAL outbox + Node.js SQLite WAL inbox，`message_id` 去重
- **可靠传输** — ZeroMQ DEALER/ROUTER + 应用层 ACK + 超时重传
- **背压控制** — 高/低水位 + `sourceControl` 暂停/恢复 + 磁盘紧急水位
- **截图服务** — 异步截图请求/响应，FIFO 匹配，TTL 超时
- **可观测性** — 帧链路审计日志（人类可读 + CSV）、健康端点、运行统计

详见 [`docs/FRAME_PROTOCOL.md`](docs/FRAME_PROTOCOL.md)。

---

## 第二阶段：A-B-C 顺序识别闭环（已完成 ✅）

实现了 Node-RED 运行时直接执行业务逻辑的最小闭环：

```text
[aiban-frame-input] → [aiban-label-match] → [aiban-abc-sequence] → [aiban-result-db]
       ↑                      ↑                      ↑                    ↑
   Phase 1              标签匹配              A→B→C 状态机          异步 MySQL
  (可靠帧通道)        model_id+label        SQLite 持久化          幂等写入
                     +confidence          重启可恢复              重试+兜底
```

- **aiban-label-match** — 按 model_id + label + confidence 过滤帧，输出匹配步骤
- **aiban-abc-sequence** — 严格 A→B→C 顺序状态机，状态 SQLite 持久化，超时检测，重启恢复
- **aiban-result-db** — 异步 MySQL 写入队列，`event_id` 唯一键幂等，失败兜底本地 JSONL
- **workflow-audit** — 审计日志（人类可读 + JSONL + CSV），北京时间和毫秒精度
- **自动化测试** — 14 个场景覆盖 OK/NG/TIMEOUT/去重/隔离/恢复/审计完整性

详见 [`docs/PHASE2_MESSAGE_CONTRACT.md`](docs/PHASE2_MESSAGE_CONTRACT.md) 和 [`docs/TEST_REPORT_PHASE_2.md`](docs/TEST_REPORT_PHASE_2.md)。

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
│   ├── aiban-label-match.js/.html  #   [Phase 2] 标签匹配节点
│   ├── aiban-abc-sequence.js/.html #   [Phase 2] A→B→C 状态机节点
│   ├── aiban-result-db.js/.html    #   [Phase 2] 结果入库节点
│   ├── sequence-node.js/.html      #   顺序检测节点（1.0 导出）
│   ├── timer-node.js/.html         #   计时器节点（1.0 导出）
│   ├── state-node.js/.html         #   状态机节点（1.0 导出）
│   ├── monitor-node.js/.html       #   安环监控节点（1.0 导出）
│   ├── api-trigger-node.js/.html   #   API 触发节点（1.0 导出）
│   ├── api-output-node.js/.html    #   API 输出节点（1.0 导出）
│   ├── socket-client-node.js/.html #   Socket 客户端节点（1.0 导出）
│   ├── exporter-node.js/.html      #   工作流导出节点
│   ├── lib/                        #   共享库
│   │   ├── frame-inbox.js          #     SQLite 帧接收入库
│   │   ├── frame-protocol.js       #     帧协议/checksum/ACK
│   │   ├── workflow-audit.js       #     [Phase 2] 审计日志
│   │   ├── workflow-state-store.js #     [Phase 2] 状态持久化
│   │   ├── sequence-engine.js      #     [Phase 2] 序列引擎
│   │   └── mysql-write-queue.js    #     [Phase 2] MySQL 写入队列
│   ├── sql/                        #   [Phase 2] 数据库 DDL
│   │   └── schema.sql              #     workflow_abc_result 建表
│   ├── examples/                   #   [Phase 2] 示例流程
│   │   └── abc-sequence-flow.json  #     可导入的 A-B-C 流程
│   └── test/                       #   Node.js 测试
│       ├── frame-core.test.js      #     Phase 1 帧协议测试
│       └── phase2-closed-loop.test.js  # Phase 2 闭环测试 (14 cases)
│
├── node-red/                       # Node-RED 运行时
│   ├── flows.json                  #   当前部署流程
│   ├── settings.js                 #   运行时配置
│   └── package.json
│
├── config/
│   ├── frame_bridge.env.example    # Phase 1 环境变量模板
│   └── workflow_db.env.example     # [Phase 2] MySQL 配置模板
│
├── docs/                           # 文档
│   ├── FRAME_PROTOCOL.md           #   帧协议规范
│   ├── PHASE1_STATUS.md            #   第一阶段状态
│   ├── TEST_REPORT_PHASE_1.md      #   第一阶段测试报告
│   ├── PHASE2_MESSAGE_CONTRACT.md  #   [Phase 2] 标准消息契约
│   └── TEST_REPORT_PHASE_2.md      #   [Phase 2] 第二阶段测试报告
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
# === Phase 1: 帧通道测试 ===
# Python 单元测试（18 cases）
python -m unittest tests.test_frame_bridge -v

# Python↔Node 集成测试（含 ACK 丢失重发）
python -m unittest tests.test_zmq_integration -v

# Node.js 帧协议测试（4 cases）
cd node-red-contrib-aiban-workflow
npm run test:phase1

# === Phase 2: A-B-C 闭环测试 ===
# Node.js 闭环测试（14 cases）
cd node-red-contrib-aiban-workflow
npm run test:phase2

# === 全部测试 ===
cd node-red-contrib-aiban-workflow
npm test                           # 18 cases total (4 Phase 1 + 14 Phase 2)
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
| **阶段 2** | **A-B-C 顺序识别最小闭环** | ✅ **已完成** |
| 阶段 3 | 业务模式迁移（双跑对比） | 🔜 进行中 |
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
| [`docs/PHASE1_STATUS.md`](docs/PHASE1_STATUS.md) | 第一阶段状态 |
| [`docs/TEST_REPORT_PHASE_1.md`](docs/TEST_REPORT_PHASE_1.md) | 第一阶段测试报告 |
| [`docs/PHASE2_MESSAGE_CONTRACT.md`](docs/PHASE2_MESSAGE_CONTRACT.md) | [Phase 2] 标准消息契约 |
| [`docs/TEST_REPORT_PHASE_2.md`](docs/TEST_REPORT_PHASE_2.md) | [Phase 2] 第二阶段测试报告 |
