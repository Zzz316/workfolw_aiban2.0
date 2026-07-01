# AiBan Workflow 2.0 — Phase 1 运维手册

> 版本：v1.0  
> 日期：2026-07-01  
> 适用范围：第一阶段可靠帧通道

---

## 1. 系统概述

第一阶段建立了 AiBan SDK → Python FrameBridge → ZeroMQ → Node-RED 的可靠数据通道。Python 负责 SDK 推理帧的标准化和持久化发送，Node-RED 负责接收、去重、ACK 和业务编排。

### 进程结构

```text
main.py (主进程)
├── Process: videowork   — AiBan SDK pipeline + FrameBridge (ZMQ DEALER)
├── Process: videoalarm  — 报警、数据库、喇叭
└── Thread:  Flask       — Web API (icameraapi + bridge stats)
```

---

## 2. 前置条件

| 组件 | 版本要求 | 说明 |
|---|---|---|
| Python | ≥ 3.9 | SDK 支持 3.7-3.10 |
| Node.js | ≥ 22.5 | Node-RED 和 zeromq 原生模块 |
| pyzmq | 26.4.0 | `pip install pyzmq==26.4.0` |
| zeromq (npm) | ^6.5.0 | Node-RED 自定义节点依赖 |
| node-red | ≥ 4.0 | 部署 aiban-frame-input 流程 |
| AiBan SDK | libAiBanVideoPy3_9 | 位于 `AIBAN_SDK_HOME` 目录 |

---

## 3. 环境变量

完整配置参见 `config/frame_bridge.env.example`。

### 桥接开关

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AIBAN_V2_BRIDGE_ENABLED` | `0` | 设为 `1` 启用 frame bridge |
| `AIBAN_V1_ENGINE_ENABLED` | `1` | 设为 `0` 关闭 1.0 引擎影子运行 |

### 传输配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AIBAN_FRAME_ENDPOINT` | `tcp://127.0.0.1:5557` | ZMQ 端点，Node-RED 需绑定同一地址 |
| `AIBAN_FRAME_OUTBOX` | `data/frame_bridge/outbox.db` | Python 发送端持久化队列路径 |
| `AIBAN_FRAME_HIGH_WATERMARK` | `5000` | 入队 + outbox pending 高水位 |
| `AIBAN_FRAME_LOW_WATERMARK` | `1000` | 恢复水位 |
| `AIBAN_FRAME_RETRY_SECONDS` | `1.0` | 未确认帧重试间隔 |
| `AIBAN_FRAME_BATCH_SIZE` | `100` | 每轮最多发送帧数 |
| `AIBAN_FRAME_LOG_EVERY` | `1` | 每 N 帧打印一次 ACK 耗时 |
| `AIBAN_FRAME_CONSOLE_LATENCY` | `1` | 设为 `0` 关闭终端延迟输出 |

### 磁盘与截图

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AIBAN_FRAME_DISK_EMERGENCY_PERCENT` | `95` | 磁盘使用率超过此值暂停所有视频源 |
| `AIBAN_FRAME_SCREENSHOT_TIMEOUT` | `30.0` | 截图请求超时秒数 |
| `AIBAN_FRAME_STATS_FILE` | `data/frame_bridge/stats.json` | 统计文件路径（Flask 读取） |

### 业务数据库

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MYSQL_HOST` | `127.0.0.1` | 业务 MySQL（非传输用 SQLite） |
| `MYSQL_PORT` | `3306` | |
| `MYSQL_USER` | `root` | |
| `MYSQL_PASSWD` | `root` | 生产部署务必修改 |
| `MYSQL_DB` | `icamera_data` | |

---

## 4. 启动步骤

### 4.1 启动 Node-RED

```powershell
cd D:\workfolw_aiban_2.0\node-red
npx node-red --settings settings.js
```

确认 `aiban-frame-input` 节点已部署，状态为绿色圆点 `listening tcp://127.0.0.1:5557`。

**重要**：修改自定义节点代码后必须重启 Node-RED 进程（Deploy 不会重新加载已加载的 JS 模块）。

### 4.2 启动 Python

```powershell
cd D:\workfolw_aiban_2.0
python main.py
```

或指定参数：

```powershell
python main.py `
  --sdk-home D:/product/AiBanWorkSpace `
  --pipeline-config D:/product/AiBanWorkSpace/abvideo/main-flow.yaml `
  --latency-log-every 10
```

关闭桥接（仅运行 1.0 引擎）：

```powershell
python main.py --no-v2-bridge
```

### 4.3 验证通信

启动后观察 Python 终端输出：

```text
[ACK] #1     group-1/source-1 │ Py处理   1.23ms → 网络往返   2.34ms → Node落盘   0.56ms │ 端到端   4.13ms │ 14:32:15
```

Node-RED debug 面板应显示帧消息，包含 `msg.payload.label_summary` 等字段。

---

## 5. 停止步骤

1. 在 Python 终端按 `Ctrl+C`
2. 等待子进程优雅退出（最多 5 秒）
3. 在 Node-RED 终端按 `Ctrl+C` 或 Deploy 一个空流程

---

## 6. 健康监控

### 6.1 统计端点

Flask 运行在主进程，默认端口由 `icameraapi` 配置决定。

```http
GET /aiban/bridge/stats
```

返回示例：

```json
{
  "status": "200",
  "errmsg": "",
  "data": {
    "session_id": "uuid",
    "uptime_seconds": 1234.5,
    "ingress": {"pending": 3, "paused_sources": []},
    "outbox": {"total": 50000, "pending": 3, "acked": 49997},
    "transport": {"endpoint": "tcp://127.0.0.1:5557", "acks_received": 49997},
    "disk": {"path": "data/frame_bridge", "percent_used": 45.2, "emergency": false, ...},
    "screenshot": {"pending": 0, "in_flight": 0, "completed": 12, "timed_out": 0, "errors": 0},
    "updated_at": "2026-07-01T14:30:00.123+08:00"
  }
}
```

### 6.2 健康检查

```http
GET /aiban/bridge/health
```

返回：

```json
{"status": "200", "healthy": true, "age_seconds": 0.5}
```

若 stats 文件超过 30 秒未更新，返回 `healthy: false`。

### 6.3 关键指标

| 指标 | 含义 | 告警条件 |
|---|---|---|
| `ingress.pending` | 内存队列中待落盘帧数 | > high_watermark |
| `outbox.pending` | 已落盘未确认帧数 | > high_watermark |
| `outbox.acked / outbox.total` | 确认率 | < 99% |
| `disk.emergency` | 磁盘紧急状态 | true |
| `disk.percent_used` | 磁盘使用率 | > 90% |
| `screenshot.in_flight` | 等待 SDK 回调的截图数 | > 10 |
| `screenshot.timed_out` | 截图超时累计 | > 0 |

---

## 7. 日志文件

| 路径 | 内容 | 轮转策略 |
|---|---|---|
| `log/flasklogs/app.log` | Flask HTTP 请求日志 | 每天午夜，保留 30 天 |
| `log/abvideologs/` | AiBan SDK 系统日志 | SDK 内置 |
| `log/apitriggerlogs/` | API trigger 请求日志 | 每天午夜 |
| `logs/frame_bridge/transmission-*.log` | 帧传输审计日志（人类可读） | 每次运行一个文件 |
| `logs/frame_bridge/transmission-*-summary.csv` | 帧传输汇总（Excel 可打开） | 每次运行一个文件 |

---

## 8. 数据库文件

| 路径 | 用途 | 管理 |
|---|---|---|
| `data/frame_bridge/outbox.db` | Python 发送端持久化队列 | `DurableOutbox.prune_acked()` 清理已确认帧 |
| `data/frame_bridge/inbox.db` | Node-RED 接收端去重索引 | Node.js `FrameInbox` 管理 |
| `data/frame_bridge/stats.json` | 运行统计（桥接 JSON） | 自动覆盖，约 1KB |

两个 SQLite 文件均使用 WAL 日志模式，伴有 `-wal` 和 `-shm` 文件，属正常现象。

---

## 9. 故障排查

### 9.1 "pyzmq is required"

**现象**：启动时报 `pyzmq is required when the frame bridge is enabled`

**解决**：
```powershell
pip install pyzmq==26.4.0
```
如果使用虚拟环境，确认激活了正确的环境后再安装。

### 9.2 Node-RED 连接被拒绝

**现象**：Python 日志中无明显错误，但无 ACK 输出；`outbox.pending` 持续增长

**检查**：
1. Node-RED 是否已启动
2. `aiban-frame-input` 节点是否已 Deploy
3. `AIBAN_FRAME_ENDPOINT` 与 Node-RED 节点配置的 endpoint 是否一致
4. 防火墙是否允许 5557 端口本地通信

### 9.3 ACK 超时 / 帧积压

**现象**：`outbox.pending` 持续增长

**可能原因**：
- Node-RED inbox 写入失败（检查磁盘空间）
- Node-RED 处理速度跟不上（检查 `logs/frame_bridge/` 中的延迟数据）
- 网络延迟过高（检查 ZMQ 端点配置）

### 9.4 磁盘紧急状态

**现象**：日志中出现 `disk emergency` 且所有 source 被暂停

**解决**：
1. 检查 `data/frame_bridge/` 目录大小
2. 如确认帧已不再需要，可手动删除 `outbox.db`（需先停服）
3. 扩大磁盘或清理其他文件

### 9.5 截图超时

**现象**：`screenshot.timed_out > 0`

**可能原因**：
- SDK 内部处理慢
- YAML 中未配置截图保存路径
- 磁盘空间不足

### 9.6 stats 文件未生成

**现象**：`GET /aiban/bridge/stats` 返回 503

**检查**：
1. `AIBAN_V2_BRIDGE_ENABLED=1` 是否设置
2. `AIBAN_FRAME_STATS_FILE` 路径是否可写
3. Python 日志中是否有 bridge 启动成功的提示

---

## 10. 恢复流程

### Python 进程重启

1. `Ctrl+C` 停止 main.py
2. 确认子进程已退出
3. 重新执行 `python main.py`
4. Bridge 自动重放未确认帧（outbox 中 `acked_at IS NULL` 的记录）

### Node-RED 重启

1. 停止 Node-RED
2. 重启 Node-RED
3. Deploy 包含 `aiban-frame-input` 的流程
4. `emitPending()` 自动发送 inbox 中未投递的帧

### 磁盘满恢复

1. 停止 Python 和 Node-RED
2. 清理磁盘空间
3. 检查 SQLite 文件完整性
4. 重新启动
