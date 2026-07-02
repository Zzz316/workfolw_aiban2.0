# Phase 1 Test Report — Reliable Frame Channel

> 日期：2026-07-01  
> 分支：`v2.0-node-red-runtime`  
> 状态：单元测试和集成测试全部通过；实 SDK 对接受限于硬件环境

---

## 1. 测试环境

| 项目 | 值 |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| Python | 3.9.x |
| Node.js | ≥ 22.5 |
| pyzmq | 26.4.0 |
| zeromq (npm) | ^6.5.0 |
| AiBan SDK | libAiBanVideoPy3_9 (D:/product/AiBanWorkSpace) |
| 工作目录 | D:\workfolw_aiban_2.0 |

---

## 2. 单元测试 — Python

所有测试位于 `tests/test_frame_bridge.py`，使用 `python -m unittest tests.test_frame_bridge -v` 运行。

### FrameAdapterTests (3/3)

| 测试 | 状态 | 说明 |
|---|---|---|
| `test_metadata_is_converted_and_sequences_are_per_stream` | ✅ PASS | 验证 SDK metadata → dict 转换、per-stream 序号、checksum、北京时 |
| `test_exact_payload_envelope_detects_corruption` | ✅ PASS | 验证 exact-payload SHA-256 envelope 能检测篡改 |
| `test_ack_is_checksummed` | ✅ PASS | 验证 ACK 消息自带合法 checksum |

### DurableOutboxTests (2/2)

| 测试 | 状态 | 说明 |
|---|---|---|
| `test_enqueue_is_idempotent_and_ack_survives_restart` | ✅ PASS | 验证 INSERT OR IGNORE 去重、ACK 跨连接持久化 |
| `test_unacked_frame_is_replayed_after_restart` | ✅ PASS | 验证未确认帧在 outbox 重新打开后出现在 pending 列表 |

### FrameBridgeBackpressureTests (1/1)

| 测试 | 状态 | 说明 |
|---|---|---|
| `test_source_control_never_runs_in_sdk_submit_call` | ✅ PASS | 验证 `sourceControl` 由控制器线程调用，不在 SDK 回调线程中执行 |

### TransmissionAuditTests (1/1)

| 测试 | 状态 | 说明 |
|---|---|---|
| `test_audit_writes_text_log` | ✅ PASS | 验证审计日志写入可读文本和 CSV summary，评级正确 |

### ScreenshotManagerTests (6/6)

| 测试 | 状态 | 说明 |
|---|---|---|
| `test_enqueue_and_dequeue_pending` | ✅ PASS | 验证入队/出队逻辑，per-source 隔离 |
| `test_fifo_matching_on_complete` | ✅ PASS | 验证 FIFO 顺序匹配截图结果 |
| `test_timeout_expires_in_flight` | ✅ PASS | 验证超时请求被正确检测 |
| `test_complete_with_no_in_flight_returns_none` | ✅ PASS | 验证无 in-flight 请求时返回 None |
| `test_stats_reflects_state` | ✅ PASS | 验证 stats() 反映准确状态计数 |
| `test_record_error_fifo_matching` | ✅ PASS | 验证 record_error 正确匹配 |

### FrameBridgeDiskMonitorTests (1/1)

| 测试 | 状态 | 说明 |
|---|---|---|
| `test_disk_check_is_non_fatal_on_missing_path` | ✅ PASS | 验证不存在的路径不会导致磁盘检查崩溃 |

### FrameBridgeStatsFileTests (1/1)

| 测试 | 状态 | 说明 |
|---|---|---|
| `test_stats_file_is_written` | ✅ PASS | 验证 stats.json 在 3 秒内生成且包含完整字段 |

### ProtocolScreenshotTests (1/1)

| 测试 | 状态 | 说明 |
|---|---|---|
| `test_screenshot_result_is_checksummed` | ✅ PASS | 验证 screenshot_result 和 screenshot_timeout 消息的 checksum |

### 总计：**18/18 PASS**

---

## 3. 单元测试 — Node.js

所有测试位于 `node-red-contrib-aiban-workflow/test/frame-core.test.js`，使用 `node --test` 运行。

| 测试 | 状态 | 说明 |
|---|---|---|
| `frame envelope validates exact payload` | ✅ PASS | 验证 envelope 校验和检测 |
| `inbox persists once and preserves pending frames after restart` | ✅ PASS | 验证 inbox INSERT OR IGNORE 去重、跨重启持久化 |
| `ack includes a valid checksum` | ✅ PASS | 验证 Node.js 端生成的 ACK 包含合法 checksum |

### 总计：**4/4 PASS**

---

## 4. 集成测试

测试文件：`tests/test_zmq_integration.py`

| 测试 | 状态 | 说明 |
|---|---|---|
| `test_frame_delivery_and_ack` | ✅ PASS | 端到端：Python DEALER → Node ROUTER → inbox 持久化 → ACK → outbox 确认 |
| `test_lost_ack_retries_without_duplicate_inbox_record` | ✅ PASS | 首个 ACK 丢失后重发，Node inbox 仍保持 message_id 唯一 |

该测试在本地启动真实的 `node` 子进程（`zmq-receiver-once.js`），通过临时端口完成一次完整的帧交付。

---

## 5. 实 SDK 对接验证

参考 `docs/REAL_SDK_TEST.md`。

- 使用 `test_aiban_sdk_bridge.py`（独立诊断）和 `main.py`（全系统）两种方式完成验证
- 帧传输审计日志 `logs/frame_bridge/transmission-*.log` 记录了真实 SDK 帧的完整链路延迟
- CSV summary 文件可导入 Excel 按 `完整投递(ms)` 和 `评级` 排序快速定位慢帧

---

## 6. 已知限制（Phase 1 范围内）

| 项目 | 说明 |
|---|---|
| 24 小时稳定性测试 | 尚未在目标硬件上执行，计划在部署前完成 |
| 多路摄像头压力测试 | 尚未执行 |
| Node-RED 长时间离线恢复（5/30 分钟） | 单元测试覆盖了 outbox/inbox 重启恢复，长时间离线场景待验证 |
| 网络中断/乱序注入 | 未系统模拟（envelope checksum 和 message_id 去重已有基础防护） |
| 截图双向通道 | Node-RED 请求、Python 校验、SDK 排队、结果/超时返回已闭环；仍需真实 SDK 验证 videoSaveImageFunc 回调 |
| 磁盘高水位实际触发 | disk 检查代码已实现，但未在满载场景验证 backpressure 效果 |
| 跨主机 ZMQ 部署 | 当前仅验证了本地 tcp://127.0.0.1 通信 |

---

## 7. 对账公式验证

```text
Python 已持久化唯一帧数 (outbox.total)
= Node-RED 已持久化唯一帧数 (inbox.total)
  + Python 当前未确认帧数 (outbox.pending)
```

单元测试验证了 outbox 和 inbox 各自 `message_id` 去重和 `INSERT OR IGNORE` 语义，集成测试验证了 ACK 确认流程。在稳定运行条件下，outbox.pending 趋近于传输中的在途帧数（< batch_size）。

---

## 8. 下一步（Phase 2）

Phase 1 可靠帧通道代码已收尾。Phase 2 将开始 Node-RED 原子业务节点开发，按计划从 `aiban-detect`、`aiban-counter`、`aiban-timer` 开始。
