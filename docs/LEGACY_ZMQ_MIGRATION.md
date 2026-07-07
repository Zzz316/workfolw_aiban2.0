# 旧架构代码处置清单 (Legacy ZMQ Migration)

> 文档版本：v1.0
> 编制日期：2026-07-02
> 关联：`WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md` 第 1 节、第 12 节
> 基线标签：`legacy-zmq-baseline`

---

## 1. 处置分类

| 标记 | 含义 |
|------|------|
| **废弃** | 不再属于新架构主链路，阶段二期间仅保留回退和对照价值 |
| **复用** | 核心业务逻辑可复用，需重新核对输入契约后迁移 |
| **保留** | 通用基础设施/外部依赖，不随架构调整而改变 |
| **待删除** | 明确无价值的测试产物/临时文件，可直接清理 |

---

## 2. 旧架构主链路（废弃）

以下模块构成了 `Python → ZMQ → Node-RED` 的旧主链路，新架构不再使用：

### 2.1 Python FrameBridge（废弃）

| 文件 | 说明 | 处置 |
|------|------|------|
| `core/frame_bridge/__init__.py` | FrameBridge 包初始化 | 废弃 |
| `core/frame_bridge/bridge.py` | ZMQ DEALER/ROUTER 桥接核心 | 废弃 |
| `core/frame_bridge/transport.py` | ZMQ 传输层（DEALER socket） | 废弃 |
| `core/frame_bridge/outbox.py` | SQLite Durable Outbox（写端） | 废弃 |
| `core/frame_bridge/protocol.py` | 帧协议编解码（含 ACK/重传） | 废弃 |
| `core/frame_bridge/adapter.py` | AiBan SDK 回调适配器 | **部分复用**：SDK 回调复制逻辑可迁移到新 `sdk_adapter.py` |
| `core/frame_bridge/audit.py` | 传输审计日志 | **部分复用**：审计字段设计可参考 |
| `core/frame_bridge/screenshot_service.py` | 截图服务 | **部分复用**：截图逻辑可迁移到新 runner |

### 2.2 Node-RED ZMQ 输入（废弃）

| 文件 | 说明 | 处置 |
|------|------|------|
| `node-red-contrib-aiban-workflow/frame-input-node.js` | ZMQ Subscriber 输入节点 | 废弃 |
| `node-red-contrib-aiban-workflow/frame-input-node.html` | ZMQ 输入节点配置面板 | 废弃 |

### 2.3 SQLite 数据库（废弃）

| 文件/目录 | 说明 | 处置 |
|------|------|------|
| `data/frame_bridge/` | 全部 outbox/inbox SQLite 数据库文件 | 废弃（测试产物，新架构不再使用 SQLite 中转） |
| `config/frame_bridge.env.example` | FrameBridge 环境变量模板 | 废弃 |

### 2.4 ZMQ 相关测试（废弃）

| 文件 | 说明 | 处置 |
|------|------|------|
| `tests/test_frame_bridge.py` | FrameBridge 单元测试 | 废弃 |
| `tests/test_zmq_integration.py` | ZMQ 集成测试 | 废弃 |
| `tests/node_red_inbox_probe.py` | Node-RED Inbox 探针 | 废弃 |
| `tools/send_test_frames.py` | 手动测试帧发送工具 | 废弃 |

---

## 3. 业务逻辑模块（复用，需重新核对）

以下模块包含 1.0 核心业务逻辑，新架构中需要迁移但**输入契约必须重新核对**：

| 文件 | 说明 | 迁移注意事项 |
|------|------|-------------|
| `core/workflow_engine.py` | 工作流引擎（StateMachine / TimerRecord / Sequence / Monitor / Python Runner） | 需移除对旧 metadata 对象的直接引用；输入改为标准化 frame 事件 |
| `core/video_logic.py` | AiBanVideoProcess / SDK 回调注册 | 拆分：SDK 适配部分移到 `python_runtime/sdk_adapter.py`，业务部分保留 |
| `core/video_process.py` | videowork / videoalarm 进程函数 | 拆分：进程管理由 Node-RED 接管，业务逻辑保留 |
| `core/alarm_db.py` | 报警写库 + Socket + API Output | 输入从 `alam_msg` 队列改为 Node-RED msg |
| `scenes/template_flow.py` | 场景模板 | 需更新为新的 workflow JSON schema（待阶段 3） |

**迁移原则**：
- 每次只迁移一个模块
- 迁移前先写输入/输出契约测试
- 禁止把通用业务逻辑放回 Python

---

## 4. 通用基础设施（保留）

| 文件/目录 | 说明 | 处置 |
|------|------|------|
| `core/infra.py` | MyLogger、alam_msg 等基础类 | 保留，alam_msg 可能需适配 |
| `core/__init__.py` | 包初始化 | 保留 |
| `icameraapi/` | AiBan SDK 绑定（含 venv） | 保留（外部依赖） |
| `config/workflow_db.env.example` | 工作流 DB 环境变量 | 保留 |

---

## 5. Node-RED 业务节点（保留，需更新输入契约）

以下节点为 1.0 业务组件，核心逻辑保留，但需移除对 `aiban-frame-input` / Inbox / ZMQ 字段的强依赖：

| 文件 | 说明 | 处置 |
|------|------|------|
| `aiban-label.js/.html` | 标签匹配节点 | 保留，需更新输入 msg 格式 |
| `aiban-result.js/.html` | 结果聚合节点 | 保留，需更新输入 msg 格式 |
| `aiban-result-db.js/.html` | 结果写库节点 | 保留，需更新输入 msg 格式 |
| `sequence-node.js/.html` | 顺序检测节点 | 保留，需更新输入 msg 格式 |
| `state-node.js/.html` | 状态机节点 | 保留 |
| `timer-node.js/.html` | 计时器节点 | 保留 |
| `monitor-node.js/.html` | 监控节点 | 保留 |
| `api-trigger-node.js/.html` | API 触发器节点 | 保留 |
| `api-output-node.js/.html` | API 输出节点 | 保留 |
| `exporter-node.js/.html` | 数据导出节点 | 保留 |
| `socket-client-node.js/.html` | Socket 客户端节点 | 保留 |

---

## 6. Main 入口（废弃，由 Node-RED 替代）

| 文件 | 说明 | 处置 |
|------|------|------|
| `main.py` | 旧架构唯一启动入口（Flask + ZMQ + 多进程） | 废弃，由 `aiban-runtime` Node-RED 节点替代 |
| `test_aiban_sdk_bridge.py` | SDK 桥接测试 | 废弃 |
| `tools/run_phase1_tests.py` | 阶段一测试运行器 | 废弃（新阶段一有独立测试） |

---

## 7. 旧文档（需归档或更新）

| 文件 | 说明 | 处置 |
|------|------|------|
| `docs/AIBAN_TO_NODE_RED_DATA_PATH.md` | 旧数据链路说明 | 归档（供对照） |
| `docs/FRAME_PROTOCOL.md` | 旧帧协议 | 归档，新协议见 `AIBAN_RUNTIME_PROTOCOL.md` |
| `docs/PHASE1_STATUS.md` | 旧阶段一状态 | 归档 |
| `docs/PHASE2_MESSAGE_CONTRACT.md` | 旧阶段二消息契约 | 归档，待阶段二重新定义 |
| `docs/REAL_SDK_TEST.md` | 真实 SDK 测试记录 | 保留（参考） |
| `docs/TEST_REPORT_PHASE_1.md` | 旧阶段一测试报告 | 归档 |
| `docs/TEST_REPORT_PHASE_2.md` | 旧阶段二测试报告 | 归档 |
| `docs/OPERATIONS.md` | 运维文档 | **需大幅更新** |

---

## 8. 临时/测试产物（可清理）

| 文件/目录 | 说明 | 处置 |
|------|------|------|
| `__pycache__/` | Python 缓存 | 待删除（已加入 .gitignore） |
| `core/__pycache__/` | Python 缓存 | 待删除 |
| `core/frame_bridge/__pycache__/` | Python 缓存 | 待删除 |
| `data/frame_bridge/*.db` | 测试 SQLite 数据库（~20 个） | 待删除 |
| `data/frame_bridge/*.db-shm` | SQLite WAL 共享内存 | 待删除 |
| `data/frame_bridge/*.db-wal` | SQLite WAL 日志 | 待删除 |
| `outputs/AiBan到Node-RED数据链路说明.pptx` | 旧架构 PPT | 保留（对外交付物） |

---

## 9. 删除时间表

| 阶段 | 操作 |
|------|------|
| **当前（阶段 2 开发）** | 阶段一已验收；阶段二期间保留旧主链路代码作为回退和对照 |
| **阶段一验收后** | 可评审清理 `tests/test_*zmq*`、`tests/node_red_inbox_probe.py`、`data/frame_bridge/*.db` 等测试产物 |
| **阶段二验收后** | 删除 `core/frame_bridge/`（除 adapter/screenshot_service 中已迁移部分） |
| **阶段四验收后** | 删除本清单中全部标记为"废弃"的代码 |
| **阶段六发布前** | 最终评审，删除 `main.py` 和所有旧架构残留 |

---

## 10. 回退计划

如需回退到旧架构：
1. `git checkout legacy-zmq-baseline` 或 `git checkout v2.0-node-red-runtime`
2. 恢复 `config/frame_bridge.env.example` 配置
3. 按旧 `OPERATIONS.md` 启动 `main.py`
4. Node-RED 使用 `aiban-frame-input` 节点接收 ZMQ 帧

回退窗口：阶段二开发期间继续保留 1.0/旧 ZMQ 回退能力；如需回退，可切换到 `legacy-zmq-baseline` 标签。
