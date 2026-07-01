# Phase 1 Status — Reliable AiBan to Node-RED Frame Channel

Date: 2026-07-01  
Status: **代码收尾完成，核心功能已实现并通过测试**

---

## Completed

### Python Frame Bridge (`core/frame_bridge/`)

| 模块 | 文件 | 说明 |
|---|---|---|
| FrameAdapter | `adapter.py` | SDK metadata → 纯 Python dict，帧序号、checksum、北京时 |
| FrameBridge | `bridge.py` | 非阻塞入队、写线程、背压控制器、磁盘监控、stats 文件 |
| Protocol | `protocol.py` | 帧协议、envelope、ACK、screenshot_result/timeout 消息 |
| DurableOutbox | `outbox.py` | SQLite WAL 持久化，INSERT OR IGNORE 去重，ACK 状态管理 |
| ZmqDealerTransport | `transport.py` | ZMQ DEALER 发送、ACK 接收、双向控制消息、延迟分解 |
| ScreenshotManager | `screenshot_service.py` | 异步截图请求/响应管理，FIFO 匹配，超时处理 |
| TransmissionAuditLogger | `audit.py` | 人类可读 + CSV 汇总审计日志 |

### Node-RED Custom Node (`node-red-contrib-aiban-workflow/`)

| 模块 | 文件 | 说明 |
|---|---|---|
| aiban-frame-input | `frame-input-node.js/.html` | ZMQ ROUTER 接收、inbox 持久化、ACK after persist、延迟显示 |
| FrameInbox | `lib/frame-inbox.js` | SQLite WAL inbox，message_id 去重 |
| FrameProtocol | `lib/frame-protocol.js` | exact-payload checksum 校验、ACK 生成 |

### Tests

- Python: **16 tests pass** (`tests/test_frame_bridge.py`)
- Node.js: **3 tests pass** (`test/frame-core.test.js`)
- Integration: **1 test pass** (`tests/test_zmq_integration.py`)

### Docs

- `docs/FRAME_PROTOCOL.md` — 帧协议规范
- `docs/OPERATIONS.md` — 运维手册
- `docs/AIBAN_TO_NODE_RED_DATA_PATH.md` — 数据路径详解
- `docs/REAL_SDK_TEST.md` — 真实 SDK 测试指南
- `docs/TEST_REPORT_PHASE_1.md` — 正式测试报告

### API Endpoints (Flask)

- `GET /aiban/bridge/stats` — FrameBridge 运行统计
- `GET /aiban/bridge/health` — 快速健康检查

---

## Deferred to On-Site Validation

以下项目代码已就绪，但需要在目标硬件上验证：

- 24 小时稳定性测试
- 多路摄像头压力测试
- Node-RED 长时间离线（5/30 分钟）恢复
- 截图双向通道的 videoSaveImageFunc 回调验证
- 磁盘高水位背压实际触发测试

---

## Next Phase

Phase 2: Node-RED 基础原子节点（aiban-detect, aiban-counter, aiban-timer...）
