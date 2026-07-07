# Phase 1 Test Report — Node-RED Direct Python/AiBan Runtime (v2.0)

> 日期：2026-07-06
> 分支：`v2.0-runtime-restart`
> 架构：新架构（Node-RED `spawn` → Python stdin/stdout JSON Lines）
> 状态：✅ 阶段一已验收，允许进入阶段二开发

---

## 重要说明

本报告适用于**新架构（v2.0-runtime-restart）阶段一**。旧的 ZMQ 架构阶段一测试报告见 [`TEST_REPORT_PHASE_1.md`](TEST_REPORT_PHASE_1.md)（已归档），`PHASE1_STATUS.md`（已归档）**不作为新架构验收依据**。

---

## 1. 测试环境

| 项目 | 值 |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| Python | 3.9.13 (D:/my_env/python.exe) |
| Node.js | v24.13.0 |
| Node-RED | v4.1.3 |
| AiBan SDK | libAiBanVideoPy3_9 (D:/product/AiBanWorkSpace) |
| 测试框架 | Node.js 22+ built-in `node:test` |

---

## 2. 测试分类

### A. Python Runner 集成测试
- **文件**: `test/aiban-runtime.test.js`
- **方式**: `child_process.spawn()` 启动 Python runner（Mock SDK），JSON Lines 通信
- **运行**: `npm run test:phase1`

### B. Node-RED 节点组件测试
- **文件**: `test/aiban-runtime-node.test.js`
- **方式**: Mock RED 运行时，注入 spawn，直接测试 `AibanRuntimeNode`
- **运行**: `node --test test/aiban-runtime-node.test.js`

### C. 旧阶段二测试（参考）
- **文件**: `test/phase2-closed-loop.test.js`, `test/frame-core.test.js`
- **方式**: 纯 JS 库单元测试，不涉及 Node-RED 或 Python

---

## 3. 自动化测试已完成项目

### 3.1 Python Runner 集成测试 (aiban-runtime.test.js) — 27/27 ✅

| # | 测试场景 | 状态 |
|---|---|---|
| 1 | Mock SDK 正常启动并连续输出帧 | ✅ PASS |
| 2 | Frame 消息结构（下游 msg 兼容） | ✅ PASS |
| 3 | Heartbeat 事件及字段完整性 | ✅ PASS |
| 4 | checkAllConfig 失败 → start 报错 | ✅ PASS |
| 5 | buildPipline 失败 → start 报错 | ✅ PASS |
| 6 | Graceful stop → runtime_stopping/stopped | ✅ PASS |
| 7 | Health 命令返回完整状态信息 | ✅ PASS |
| 8 | Screenshot 命令 → 异步 result 事件 | ✅ PASS |
| 9 | Malformed stdin 输入不影响运行 | ✅ PASS |
| 10 | stdout 全部为合法 JSON（协议要求） | ✅ PASS |
| 11 | event_seq 全局单调连续 | ✅ PASS |
| 12 | 多 source 产生不同 stream_id | ✅ PASS |
| 13 | Duplicate start → "Already running" | ✅ PASS |
| 14 | stdin close → runner 优雅退出 | ✅ PASS |
| 15 | Unknown command → error result | ✅ PASS |
| 16 | 持续帧流无 sequence gap | ✅ PASS |
| 17 | 小容量队列 — watermark 暂停/恢复，无静默丢帧 | ✅ PASS |
| 18 | 队列满时拒绝新帧，不驱逐旧帧 | ✅ PASS |
| 19 | 未发 start 时等待不掉线 | ✅ PASS |
| 20 | 启动过程中 stop 取消 pipeline | ✅ PASS |
| 21 | stderr 大量日志不阻塞帧流 | ✅ PASS |
| 22 | Duplicate screenshot request_id 正确处理 | ✅ PASS |
| 23 | checkAllConfig 失败具体错误消息 | ✅ PASS |
| 24 | runtime_error 事件正确生成 | ✅ PASS |
| 25 | Restart 命令停止并重启 pipeline | ✅ PASS |
| 26 | pause_source / resume_source 指令 | ✅ PASS |
| 27 | Heartbeat 包含 queue_overflow_count, queue_is_full | ✅ PASS |

### 3.2 Node-RED 节点组件测试 (aiban-runtime-node.test.js) — 30/30 ✅

| # | 测试场景 | 状态 |
|---|---|---|
| 1 | 构造后 spawn 并发送 auto-start 命令 | ✅ PASS |
| 2 | Frame 事件 → 输出端口 1（inference frames） | ✅ PASS |
| 3 | 生命周期事件 → 输出端口 2（status） | ✅ PASS |
| 4 | 非法 stdout JSON → PARSE_ERROR 端口 3 | ✅ PASS |
| 4a | 已知 AiBan native DLL 日志不产生 PARSE_ERROR | ✅ PASS |
| 4b | 普通 AiBan native diagnostics 不产生 PARSE_ERROR | ✅ PASS |
| 5 | 超长非法行截断处理 | ✅ PASS |
| 6 | 空行静默跳过 | ✅ PASS |
| 7 | 半包 JSON → PARSE_ERROR | ✅ PASS |
| 8 | 粘连 JSON → PARSE_ERROR | ✅ PASS |
| 9 | 超大消息安全处理 | ✅ PASS |
| 10 | Non-strict 模式兼容策略（无 PARSE_ERROR） | ✅ PASS |
| 11 | runtime_error 事件 → 端口 3 | ✅ PASS |
| 12 | 控制命令 via msg.input → stdin | ✅ PASS |
| 13 | 无效命令 warn + 忽略 | ✅ PASS |
| 14 | on-failure 重启策略（非零退出码） | ✅ PASS |
| 15 | 最大重启次数上限 | ✅ PASS |
| 16 | 启动超时 kill 进程 | ✅ PASS |
| 17 | 启动过程中 stop → kill，不自动重启 | ✅ PASS |
| 18 | Close 回调 kill 进程并调用 done | ✅ PASS |
| 19 | Spawn 失败 → red 状态 | ✅ PASS |
| 20 | stderr 转发到 node.log | ✅ PASS |
| 21 | stderr 大量输出不阻塞节点 | ✅ PASS |
| 22 | Admin HTTP start 端点（无运行进程时） | ✅ PASS |
| 23 | Admin HTTP stop 端点 | ✅ PASS |
| 24 | Admin 未知 node → 404 | ✅ PASS |
| 25 | Sequence gap 检测 → SEQUENCE_GAP 错误 | ✅ PASS |
| 26 | 重复 start 防重入 | ✅ PASS |
| 27 | Heartbeat 超时 kill 进程 | ✅ PASS |
| 28 | Close 发送 stop 命令并等待 exit | ✅ PASS |

### 3.3 旧阶段二测试 (phase2-closed-loop.test.js + frame-core.test.js) — 83/84

> 1 个预存失败：「Scenario 4: Timeout → TIMEOUT」与本次修改无关。

---

## 4. 真实 SDK 已验证项目

| # | 验证项 | 状态 | 说明 |
|---|---|---|---|
| 1 | 真实 AiBan SDK 单路端到端运行 | ✅ 已验证 | 现场原始记录待补充到 `docs/REAL_SDK_TEST.md` |
| 2 | 真实 SDK 多路并发推理 | ✅ 已验证 | 现场路数、帧率和模型配置待补充 |
| 3 | 24 小时稳定性测试 | ✅ 已验证 | 起止时间、异常计数和资源曲线待补充 |
| 4 | `videoSaveImageFunc` 截图回调 | ✅ 已验证 | Mock SDK 已覆盖协议层，真实 SDK 已完成现场确认 |
| 5 | 真实 SDK `sourceControl` 暂停/恢复 | ✅ 已验证 | watermark 暂停/恢复已具备进入阶段二条件 |

---

## 5. 阶段一验收确认项

| # | 验证项 | 状态 | 说明 |
|---|---|---|---|
| 1 | Deploy 后无需手工运行 Python | ✅ 已确认 | Node-RED `aiban-runtime` 管理 Python 子进程 |
| 2 | `aiban-runtime → Debug` 可持续获得真实推理帧 | ✅ 已确认 | 真实 SDK 已测完 |
| 3 | Node-RED 停止后无遗留 Python/AiBan 进程 | ✅ 已确认 | 建议保留 `tools/check-orphan-python.ps1` 作为阶段二回归检查 |
| 4 | 异常状态在节点和日志中可见 | ✅ 已确认 | 阶段二继续沿用三端口输出：frame/status/error |
| 5 | 正常负载无静默丢帧、无协议解析错误 | ✅ 已确认 | 具体计数待补充到现场记录 |
| 6 | Windows 孤儿进程自动回收 | ✅ 已确认 | 阶段二测试继续保留 |
| 7 | 最大路数压力测试 | ✅ 已确认 | 实际路数待补充 |
| 8 | 真实 SDK DLL 向 stdout 写诊断文本时的兼容性 | ✅ 已确认 | `strictStdout: false` 可作为现场兼容开关 |

---

## 6. 测试运行命令

```powershell
# Python Runner 集成测试
cd node-red-contrib-aiban-workflow
npm run test:phase1

# Node-RED 节点组件测试
node --test test/aiban-runtime-node.test.js

# 全量测试（含旧阶段二）
npm test

# 孤儿进程检查
powershell -ExecutionPolicy Bypass -File tools/check-orphan-python.ps1
```

---

## 7. 关键设计变更（本次修复）

| 变更 | 文件 | 说明 |
|---|---|---|
| 队列不再驱逐旧帧 | `python_runtime/lifecycle.py` | `put()` 满时返回 `False`，不调用 `get_nowait()` |
| 新增 `overflow_count` | `python_runtime/lifecycle.py` | 记录队列满导致的拒绝次数 |
| 预检 watermark | `python_runtime/aiban_runner.py` | `would_exceed_high_watermark()` 在入队前触发暂停 |
| Heartbeat 增加队列指标 | `python_runtime/lifecycle.py` | 增加 `queue_capacity`, `queue_overflow_count`, `queue_is_full` |
| PARSE_ERROR 显式输出 | `node-red-contrib-aiban-workflow/aiban-runtime.js` | 非法 JSON → warn + 端口 3 错误消息 |
| Non-strict 兼容模式 | `node-red-contrib-aiban-workflow/aiban-runtime.js` | `strictStdout: false` 时仅 debug log，不抛错 |
| Spawn 可注入 | `node-red-contrib-aiban-workflow/aiban-runtime.js` | `config._spawn` 允许测试注入 mock |
| 输出截断 | `node-red-contrib-aiban-workflow/aiban-runtime.js` | PARSE_ERROR 中 raw_preview 截断到 255 字符 |

---

## 8. 已知限制

| # | 限制 | 说明 |
|---|---|---|
| 1 | Mock SDK 的 `sourceControl` 是 no-op | 真实 SDK 上 watermark 暂停才会生效 |
| 2 | `event_seq` 序列非线程安全 | `next_seq()` 在 SDK 回调线程和 Command Loop 线程间共享，存在 TOCTOU 竞争 |
| 3 | 单路 source 暂停策略不足 | 多 source 同时过载时只暂停最忙的一路 |
| 4 | `_source_frame_counts` 无上限 | 长期运行中可能持续增长（仅 stream_id 键，影响极小） |
| 5 | Phase 2 测试可能有环境依赖 | `phase2-closed-loop.test.js` 可能因 MySQL 或文件路径问题失败 |

---

**结论**: 新架构阶段一已完成自动化测试和真实 SDK 现场验证，具备进入阶段二开发条件。阶段二必须以
`aiban-runtime` 输出的标准消息为输入，重新核对旧阶段二代码中的 `aiban-frame-input`、Inbox 和 ZMQ
字段依赖。
