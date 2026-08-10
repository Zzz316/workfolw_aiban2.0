# AiBan Runtime Protocol v1.4

> 文档版本：v1.4<br>
> 编制日期：2026-07-02<br>
> 更新日期：2026-07-24<br>
> 协议版本：`schema_version: 1`

---

## 1. 协议概述

本文档定义 Node-RED `aiban-runtime` 节点与 Python AiBan Runner 子进程之间的
通信协议。通信通过本机标准输入/输出管道进行：

| 通道 | 方向 | 内容 |
|------|------|------|
| `stdin` | Node-RED → Python | 控制命令（JSON Lines） |
| `stdout` | Python → Node-RED | 结构化事件（JSON Lines） |
| `stderr` | Python → Node-RED | 运行日志和诊断信息（自由文本） |

### 核心规则

1. **一行一个完整 JSON 对象**。每行以 `\n`（LF）结尾，不含 `\r`。
2. `stdout` **禁止输出普通文本**。所有普通日志必须写入 `stderr`。
3. `stderr` 内容被视为诊断信息，不参与协议解析。
4. 所有事件和控制命令必须包含 `schema_version` 字段（当前为 `1`）。
5. 发送方不假设接收方一次 `readline()` 一定能读到完整一行。

### 1.1 Node-RED 运行时状态模型

JSONL 事件协议和 Node-RED 控制面状态是两个层次。`aiban-runtime` 使用独立的 `RuntimeController` 保存真实控制状态：

| 字段 | 含义 |
|---|---|
| `auto_start` | 部署后是否自动发起启动；只是配置策略 |
| `desired_state` | 控制面期望状态：`READY` 或 `STOPPED` |
| `actual_state` | 事件确认的实际状态 |
| `pid` | 当前 Python Runner 进程 ID；进程退出后才清空 |
| `session_id` | 最近一次 `runtime_ready` 确认的 Runner 会话 |
| `last_error` | 最近一次生命周期错误的代码和消息 |
| `last_state_at` | 最近一次状态资料变化时间 |
| `restart_count` | 当前连续恢复计数；成功 READY 后清零 |

`actual_state` 取值和进入条件如下：

| 状态 | 进入条件 |
|---|---|
| `STOPPED` | 初始状态，或已收到停止/进程退出确认 |
| `STARTING` | 已接受启动并开始创建/初始化 Runner；spawn 成功不能直接进入 READY |
| `READY` | 仅在收到 `runtime_ready` 后进入 |
| `STOPPING` | 已接受停止或收到 `runtime_stopping` |
| `ERROR` | spawn 失败、启动/停止超时、心跳丢失或意外退出 |
| `RECOVERING` | 根据重启策略等待重新拉起进程 |

关键约束：

1. 手动 start 不修改 `auto_start`，因此 `auto_start=false` 时仍可手动启动。
2. 重复 start/stop 是幂等请求。
3. 在 `STOPPING` 期间收到 start，只更新 `desired_state=READY` 并等待旧进程退出，不能伪造 READY。
4. PID 只能由 spawn/exit 事件更新；`runtime_ready` 只能确认 SDK/Pipeline 已就绪。
5. 编辑器状态颜色是 `actual_state` 的投影，不是状态事实来源。

### 1.2 统一控制入口

以下入口统一调用 Node-RED 节点实例的 `controlRuntime()`，不能绕过进程管理直接伪造状态：

| 入口 | 调用方式 |
|---|---|
| 编辑器按钮 | 先 GET 状态，再 POST `start/stop/restart` |
| 管理 HTTP | `GET /aiban-runtime/:id/status`；`POST /aiban-runtime/:id/:action` |
| Node-RED 输入 | `msg.topic="aiban/control"`，`msg.payload.command` 为 `start/stop/restart/status` |

生命周期操作返回统一结果：

```json
{
  "operation_id": "uuid-or-request-id",
  "action": "start",
  "accepted": true,
  "accepted_status": "accepted",
  "idempotent": false,
  "queued": false,
  "auto_start": false,
  "desired_state": "READY",
  "actual_state": "STARTING",
  "pid": 12345,
  "session_id": null,
  "restart_count": 0,
  "last_error": null,
  "state_changed_at": "2026-07-22T10:00:00.000Z",
  "ready_metadata": null,
  "ready_metadata_summary": null,
  "message": "Start request accepted; wait for runtime_ready before treating it as READY"
}
```

语义约束：

- HTTP `202` 表示生命周期操作已接收但仍处于 `STARTING/STOPPING/RECOVERING`，不表示 READY。
- HTTP `200` 表示状态读取成功，或目标状态已满足/请求为幂等操作。
- `accepted_status` 为 `accepted`、`queued`、`idempotent` 或 `failed`。
- `STARTING/STOPPING/RECOVERING` 时编辑器禁用重复操作；其他入口的重复请求返回幂等或排队结果。
- 外部 `restart` 由 Node-RED 停止旧进程并在退出后重新 spawn；不得把 Python 进程内 `restart` 作为生产控制路径。
- `health`、`pause_source`、`resume_source` 和 `screenshot` 仍是发送给当前 Python Runner 的进程内命令。
- 收到 `runtime_ready` 后，Node-RED 状态接口会缓存当前 session 的 `ready_metadata`；下一次启动请求会清空旧 metadata，直到新 session 再次 READY。

`ready_metadata` 是最近一次 `runtime_ready.payload` 的受控拷贝，并补充事件定位字段：

```json
{
  "session_id": "uuid",
  "event_id": "uuid",
  "event_seq": 1,
  "emitted_at": "2026-07-24T10:00:00.000+08:00",
  "received_at": "2026-07-24T10:00:00.030+08:00",
  "groups": [/* normalized groups */],
  "sources_per_group": {"1": [101]},
  "models_loaded": ["1"],
  "models": [/* normalized models */],
  "pipeline_config": {
    "schema_version": "pipeline-config/v1",
    "config_path": "D:/product/AiBanWorkSpace/abvideo/main-flow.yaml",
    "config_path_normalized": "D:\\product\\AiBanWorkSpace\\abvideo\\main-flow.yaml",
    "disabled_groups": []
  }
}
```

`ready_metadata_summary` 是给编辑器、轮询和 heartbeat 使用的轻量摘要：

```json
{
  "schema_version": "pipeline-config/v1",
  "session_id": "uuid",
  "event_seq": 1,
  "group_count": 2,
  "enabled_group_count": 1,
  "disabled_group_count": 1,
  "disabled_groups": [2],
  "source_count": 3,
  "model_count": 2,
  "models_loaded": ["1", "12"]
}
```

---

## 2. 通用事件结构（stdout）

```json
{
  "schema_version": 1,
  "type": "<event_type>",
  "session_id": "uuid-string",
  "event_id": "uuid-string",
  "event_seq": 0,
  "emitted_at": "2026-07-02T10:00:00.123+08:00",
  "payload": {}
}
```

### 通用字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `schema_version` | int | 是 | 协议版本，当前为 `1` |
| `type` | string | 是 | 事件类型，见第 3 节 |
| `session_id` | string | 是 | 协议会话标识（UUID v4）；新进程或兼容型进程内 Pipeline restart 都会创建新会话 |
| `event_id` | string | 是 | 事件唯一标识（UUID v4） |
| `event_seq` | int | 是 | 当前 `session_id` 内单调递增的序号，从 `0` 开始，用于检测丢事件 |
| `emitted_at` | string | 是 | 事件生成时刻（ISO 8601，含时区） |
| `payload` | object | 是 | 事件类型相关的负载数据 |

---

## 3. 事件类型

### 3.1 推理帧事件（`type: "frame"`）

SDK 推理回调产生的检测结果，是协议中频率最高的事件。

```json
{
  "schema_version": 1,
  "type": "frame",
  "session_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "event_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "event_seq": 10241,
  "emitted_at": "2026-07-02T10:00:00.123+08:00",
  "payload": {
    "group_id": 1,
    "source_id": 1,
    "stream_id": "group-1/source-1",
    "captured_at": "2026-07-02T10:00:00.100+08:00",
    "models": {
      "1": {
        "ok": true,
        "boxes": [
          {
            "label": "A",
            "label_index": 0,
            "confidence": 0.95,
            "polygon": [[0,0],[100,0],[100,100],[0,100]],
            "mask_contours": [],
            "tracker_id": 27,
            "sub_models": {
              "12": {
                "ok": true,
                "boxes": [
                  {
                    "label": "sub-A",
                    "label_index": 0,
                    "confidence": 0.88,
                    "polygon": [[10,10],[50,10],[50,50],[10,50]],
                    "mask_contours": [],
                    "tracker_id": -1,
                    "sub_models": {}
                  }
                ]
              }
            }
          }
        ]
      }
    }
  }
}
```

#### payload 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `group_id` | int | 是 | 摄像头群组 ID |
| `source_id` | int | 是 | 摄像头源 ID |
| `stream_id` | string | 是 | 流标识，格式 `group-{group_id}/source-{source_id}` |
| `captured_at` | string | 是 | 帧捕获时刻（ISO 8601，含时区） |
| `models` | object | 是 | 模型推理结果，key 为 `model_id` |

#### models.{model_id} 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | bool | 该模型推理是否成功 |
| `boxes` | array | 检测框列表 |

#### box 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `label` | string | 标签名称 |
| `label_index` | int | 标签索引（0-based） |
| `confidence` | float | 置信度 [0.0, 1.0] |
| `polygon` | array | 多边形顶点 `[[x,y], ...]` |
| `mask_contours` | array | 掩码轮廓（可空） |
| `tracker_id` | int | 追踪 ID，`-1` 表示未追踪 |
| `sub_models` | object | 二阶子模型结果，结构同 `models` |

---

### 3.2 生命周期事件

#### `runtime_starting`

Runner 进程已启动，正在初始化 SDK。

```json
{
  "schema_version": 1, "type": "runtime_starting",
  "session_id": "...", "event_id": "...", "event_seq": 0, "emitted_at": "...",
  "payload": {
    "python_version": "3.9.13",
    "runner_version": "1.0.0",
    "sdk_home": "D:/product/AiBanWorkSpace",
    "pipeline_config": "D:/product/AiBanWorkSpace/abvideo/main-flow.yaml"
  }
}
```

#### `runtime_ready`

SDK 配置校验成功、Pipeline 已启动，可以接收推理帧。
真实 SDK 模式下，Runner 必须先从 `pipeline_config` 解析 group/source/model metadata，再执行 `checkAllConfig()` 与 `buildPipline()`。
**此事件只能在 Pipeline metadata 解析成功、`checkAllConfig()` 通过且 `buildPipline()` 成功后发送。**

```json
{
  "schema_version": 1, "type": "runtime_ready",
  "session_id": "...", "event_id": "...", "event_seq": 1, "emitted_at": "...",
  "payload": {
    "groups": [
      {
        "group_id": 1,
        "group_id_str": "1",
        "name": "entrance",
        "enabled": true,
        "sources": [
          {
            "source_id": 101,
            "source_id_str": "101",
            "name": "Entrance A",
            "enabled": true,
            "config_path": "camera-101.yaml",
            "config_path_normalized": "D:\\AiBan\\abvideo\\camera-101.yaml"
          }
        ],
        "infers": [{"model_id": 1, "model_id_str": "1", "enabled": true}],
        "model_ids": [1],
        "model_id_strs": ["1"]
      }
    ],
    "sources_per_group": {"1": [101]},
    "models_loaded": ["1"],
    "models": [
      {
        "model_id": 1,
        "model_id_str": "1",
        "name": "",
        "enabled": true,
        "model_path": "models\\ppe.onnx",
        "model_path_normalized": "D:\\AiBan\\abvideo\\models\\ppe.onnx"
      }
    ],
    "pipeline_config": {
      "schema_version": "pipeline-config/v1",
      "config_path": "D:/product/AiBanWorkSpace/abvideo/main-flow.yaml",
      "config_path_normalized": "D:\\product\\AiBanWorkSpace\\abvideo\\main-flow.yaml",
      "disabled_groups": [2]
    }
  }
}
```

| payload 字段 | 类型 | 说明 |
|---|---|---|
| `groups` | array | 规范化 group 列表；不再使用临时 `groups: [1]` |
| `groups[].group_id` / `source_id` / `model_id` | int | Runner 已规范化后的数字 ID |
| `groups[].*_id_str` | string | 为 JSON/UI/日志保留的字符串 ID |
| `groups[].enabled` | bool | `groupenable` / 等价字段的解析结果；禁用 group 仍会出现在 metadata 中 |
| `sources_per_group` | object | 由解析结果派生，key 为 `group_id_str`，value 为 source ID 数组 |
| `models_loaded` | array | 由 `ModelArrary.Models` 派生的 model ID 字符串数组 |
| `models` | array | 规范化 model metadata，路径同时保留原值和规范化值 |
| `pipeline_config` | object | 解析器摘要、规范化主配置路径和 `disabled_groups` |

如果真实模式下配置解析失败，Runner 不得发送 `runtime_ready`；对应 `start` 命令返回 `command_result.ok=false`，`error` 以 `PIPELINE_CONFIG_*` 错误码开头，例如 `PIPELINE_CONFIG_NOT_FOUND`、`PIPELINE_CONFIG_MISSING_SOURCE_CONFIG` 或 `PIPELINE_CONFIG_UNKNOWN_MODEL_REF`。Mock 模式使用同一字段结构生成 mock metadata。

#### `heartbeat`

定期发送，确认子进程存活且 SDK 正常运行。

```json
{
  "schema_version": 1, "type": "heartbeat",
  "session_id": "...", "event_id": "...", "event_seq": 100, "emitted_at": "...",
  "payload": {
    "uptime_seconds": 3600.5,
    "frames_emitted": 10240,
    "queue_depth": 3,
    "paused_sources": []
  }
}
```

| payload 字段 | 类型 | 说明 |
|------|------|------|
| `uptime_seconds` | float | 进程运行时长 |
| `frames_emitted` | int | 已发送推理帧总数 |
| `queue_depth` | int | 内部输出队列当前深度 |
| `paused_sources` | array | 因过载被暂停的 source（如 `["group-1/source-3"]`） |

#### `runtime_stopping`

收到停止命令，正在执行优雅退出。

```json
{
  "schema_version": 1, "type": "runtime_stopping",
  "session_id": "...", "event_id": "...", "event_seq": 20000, "emitted_at": "...",
  "payload": {"reason": "command", "frames_emitted": 19990}
}
```

#### `runtime_stopped`

Pipeline 已在 `stopPipline()` 之后完全停止。最终 stop 会在命令结果写出后结束 Runner；兼容型进程内 restart 会保留 Runner，并用新 `session_id` 再次启动 Pipeline。

```json
{
  "schema_version": 1, "type": "runtime_stopped",
  "session_id": "...", "event_id": "...", "event_seq": 20001, "emitted_at": "...",
  "payload": {"exit_code": 0, "reason": "normal", "frames_emitted": 19990}
}
```

#### `runtime_error`

运行期错误（非致命）。

```json
{
  "schema_version": 1, "type": "runtime_error",
  "session_id": "...", "event_id": "...", "event_seq": 500, "emitted_at": "...",
  "payload": {
    "error_code": "QUEUE_HIGH_WATERMARK",
    "message": "Output queue reached high watermark",
    "details": {"queue_depth": 512, "threshold": 500}
  }
}
```

---

### 3.3 `sdk_event`

SDK 自身产生的事件（来自 `registerVideoMsgEventFunc` 回调）。

```json
{
  "schema_version": 1, "type": "sdk_event",
  "session_id": "...", "event_id": "...", "event_seq": 50, "emitted_at": "...",
  "payload": {
    "level": "info",
    "message": "Model loaded: model_1",
    "sdk_timestamp": "2026-07-02T10:00:01.000+08:00"
  }
}
```

---

### 3.4 `screenshot_result`

截图命令的异步响应。

```json
{
  "schema_version": 1, "type": "screenshot_result",
  "session_id": "...", "event_id": "...", "event_seq": 300, "emitted_at": "...",
  "payload": {
    "request_id": "req-uuid-from-command",
    "ok": true,
    "group_id": 1,
    "source_id": 1,
    "image_path": "D:/product/AiBanWorkSpace/capture/group1_source1_20260702_100000.jpg",
    "error": null
  }
}
```

---

### 3.5 `command_result`

控制命令的同步确认。每个命令都会收到一个 `command_result`。

```json
{
  "schema_version": 1, "type": "command_result",
  "session_id": "...", "event_id": "...", "event_seq": 10, "emitted_at": "...",
  "payload": {
    "request_id": "req-uuid",
    "ok": true,
    "command": "screenshot",
    "result": {},
    "error": null
  }
}
```

| payload 字段 | 类型 | 说明 |
|------|------|------|
| `request_id` | string | 对应请求的 `request_id` |
| `ok` | bool | 命令是否成功执行 |
| `command` | string | 原命令名称 |
| `result` | object | 命令返回数据（可空） |
| `error` | string\|null | 失败原因 |

---

## 4. 控制命令（stdin）

所有控制命令由 Node-RED 通过 `stdin` 发送给 Python。一行一个 JSON 对象。

### 4.1 `start` — 启动 Pipeline

```json
{
  "schema_version": 1,
  "command": "start",
  "request_id": "uuid",
  "params": {}
}
```

仅在收到 `runtime_starting` 后有效。Python 执行 SDK 初始化和 `buildPipline()`。

### 4.2 `stop` — 停止 Pipeline 并结束 Runner

```json
{
  "schema_version": 1,
  "command": "stop",
  "request_id": "uuid",
  "params": {"force": false}
}
```

| params 字段 | 类型 | 说明 |
|------|------|------|
| `force` | bool | `true` 表示即使 `stopPipline()` 抛错也继续 Runner 清理；操作系统级强制终止由 Node-RED 超时路径负责 |

Runner 会先调用 SDK `stopPipline()`，发出 `runtime_stopping` 和 `runtime_stopped`，写出 `command_result`，最后退出进程。stdin EOF、进程信号和 Node-RED 关闭同样先执行 Pipeline 清理。

### 4.3 `restart` — 重启 Pipeline

```json
{
  "schema_version": 1,
  "command": "restart",
  "request_id": "uuid",
  "params": {}
}
```

该命令是 Python Runner 的进程内兼容命令：只停止 Pipeline，不设置 Runner 的最终退出事件；停止完成后创建新的 `session_id`、把 `event_seq` 重置为 `0`，再启动 Pipeline。生产环境的编辑器、HTTP 和 Node-RED 输入 restart 使用 1.2 节所述的进程级重启，不直接发送此命令。

生产进程级 restart 必须等待旧 PID 的 `exit` 事件后才能 spawn 新进程。发送 `SIGKILL` 只代表已请求终止，不能作为旧进程已经退出的依据。超时强制终止日志必须包含 `operation_id`、PID、原因和信号。

### 4.4 `health` — 健康检查

```json
{
  "schema_version": 1,
  "command": "health",
  "request_id": "uuid",
  "params": {}
}
```

Python 立即回复 `command_result`，并在下一次心跳中包含状态信息。

### 4.5 `pause_source` / `resume_source` — 视频源控制

```json
{
  "schema_version": 1,
  "command": "pause_source",
  "request_id": "uuid",
  "params": {"group_id": 1, "source_id": 1}
}
```

```json
{
  "schema_version": 1,
  "command": "resume_source",
  "request_id": "uuid",
  "params": {"group_id": 1, "source_id": 1}
}
```

用于过载时暂停/恢复指定视频源。

### 4.6 `screenshot` — 截图请求

```json
{
  "schema_version": 1,
  "command": "screenshot",
  "request_id": "uuid",
  "params": {"group_id": 1, "source_id": 1}
}
```

异步操作，结果通过 `screenshot_result` 事件返回。

---

## 5. Node-RED 输出消息格式

`aiban-runtime` 节点将事件转换为标准 Node-RED `msg`，通过不同输出端口发出：

### 5.1 输出端口 1：推理帧

```javascript
msg = {
  topic: "aiban/frame",
  payload: { /* frame payload（models/boxes） */ },
  aiban: {
    runtime_id: "node-id",
    session_id: "uuid",
    event_id: "uuid",
    event_seq: 10241,
    stream_id: "group-1/source-1",
    captured_at: "2026-07-02T10:00:00.100+08:00"
  }
}
```

### 5.2 输出端口 2：状态事件

```javascript
msg = {
  topic: "aiban/status",
  payload: { /* lifecycle/sdk_event/heartbeat payload */ },
  aiban: {
    runtime_id: "node-id",
    session_id: "uuid",
    event_id: "uuid",
    event_seq: 1,
    status_type: "runtime_ready"  // 事件 type
  }
}
```

heartbeat 状态消息可以在 `msg.aiban.ready_metadata_summary` 中携带轻量 group/source/model 摘要；不得在每次 heartbeat 中重复完整 `ready_metadata.groups` 静态配置。

### 5.3 输出端口 3：错误/诊断

```javascript
msg = {
  topic: "aiban/error",
  payload: { /* error payload */ },
  aiban: {
    runtime_id: "node-id",
    session_id: "uuid",
    event_id: "uuid",
    event_seq: 500,
    error_code: "QUEUE_HIGH_WATERMARK"
  }
}
```

---

## 6. 版本兼容规则

1. `schema_version` 为整数，不向后兼容时递增。
2. 接收方遇到不支持的 `schema_version` 时，必须发送 `runtime_error` 并拒绝处理。
3. 接收方遇到未知 `type` 事件时，记录警告并丢弃该事件（不崩溃）。
4. 新增可选字段不改变 `schema_version`。
5. 删除/重命名必填字段或改变字段语义时，必须递增 `schema_version`。

---

## 7. 异常处理

### 7.1 stdout 解析规则

| 情况 | 处理方式 |
|------|---------|
| 空行 | 跳过 |
| 合法 JSON | 解析并路由 |
| 非法 JSON（截断/非 JSON 文本） | `runtime_error` + 丢弃该行 |
| 半包/粘包 | 按 `\n` 分割，逐行解析 |
| 超大消息（> 1 MB） | `runtime_error` + 丢弃 |

### 7.2 序号缺口检测

`event_seq` 严格单调递增。Node-RED 端检测到缺口时：

1. 记录 `runtime_error`（`error_code: "SEQUENCE_GAP"`）
2. 上报缺口范围（`expected` / `actual`）
3. 继续处理后续事件（不阻塞）

### 7.3 管道关闭

- Python `stdout` 关闭 → Node-RED 视为子进程异常退出
- Node-RED `stdin` 关闭 → Python 视为停止信号，执行优雅退出

### 7.4 命令超时

Node-RED 为每个命令设置超时（默认 30 秒）。超时后：
1. 记录 `command_timeout` 错误
2. 释放该 `request_id` 的等待
3. 迟到响应不能错误完成另一个请求（按 `request_id` 匹配）

---

## 8. 背压与流控

Python 内部维护**有界输出队列**：

| 水位 | 阈值 | 动作 |
|------|------|------|
| 正常 | < 80% 容量 | 正常运行 |
| 高水位 | ≥ 80% 容量 | 发送 `runtime_error`（`QUEUE_HIGH_WATERMARK`），暂停最慢 source |
| 低水位 | ≤ 50% 容量 | 恢复已暂停的 source，发送 `runtime_error`（`QUEUE_NORMAL`） |
| 溢出 | 队列满 | 丢弃最旧帧，发送 `runtime_error`（`QUEUE_OVERFLOW`） |

暂停策略：按队列中待处理帧数最多的 source 逐个暂停，直到水位回落到正常范围。

---

## 9. 超时与重启配置

| 配置项 | 默认值 | 说明 |
|------|--------|------|
| `startup_timeout_ms` | 30000 | 等待 `runtime_ready` 的最大时间 |
| `shutdown_timeout_ms` | 10000 | 优雅退出等待时间 |
| `heartbeat_interval_ms` | 5000 | 心跳发送周期 |
| `heartbeat_timeout_ms` | 15000 | 心跳判定超时（3 个周期无心跳视为异常） |
| `command_timeout_ms` | 30000 | 控制命令响应超时 |
| `max_restart_count` | 3 | 连续重启上限 |
| `restart_backoff_ms` | 5000 | 重启退避时间（指数增长，最大 60s） |

---

## 10. 示例交互序列

### 正常启动与帧传输

```text
[Node-RED spawn Python]
[Python stdout] {"type":"runtime_starting","event_seq":0,...}
[Node-RED stdin] {"command":"start","request_id":"r1",...}
[Python stdout] {"type":"command_result","payload":{"request_id":"r1","ok":true,"command":"start"},...}
[Python stdout] {"type":"runtime_ready","event_seq":1,...}
[Python stdout] {"type":"frame","event_seq":2,"payload":{...}}
[Python stdout] {"type":"frame","event_seq":3,"payload":{...}}
[Python stdout] {"type":"heartbeat","event_seq":100,...}
[Python stdout] {"type":"frame","event_seq":101,"payload":{...}}
...
[Node-RED stdin] {"command":"stop","request_id":"r2",...}
[Python stdout] {"type":"command_result","payload":{"request_id":"r2","ok":true,"command":"stop"},...}
[Python stdout] {"type":"runtime_stopping","event_seq":20000,...}
[Python stdout] {"type":"runtime_stopped","event_seq":20001,...}
[Python process exits with code 0]
```

### 截图流程

```text
[Node-RED stdin] {"command":"screenshot","request_id":"sc1","params":{"group_id":1,"source_id":1}}
[Python stdout] {"type":"command_result","payload":{"request_id":"sc1","ok":true,"command":"screenshot"},...}
[Python stdout] {"type":"screenshot_result","payload":{"request_id":"sc1","ok":true,"image_path":"..."},...}
```

### 异常启动（配置错误）

```text
[Node-RED spawn Python]
[Python stdout] {"type":"runtime_starting","event_seq":0,...}
[Node-RED stdin] {"command":"start","request_id":"r1",...}
[Python stdout] {"type":"runtime_error","payload":{"error_code":"CONFIG_CHECK_FAILED","message":"checkAllConfig returned false"},...}
[Python stdout] {"type":"command_result","payload":{"request_id":"r1","ok":false,"command":"start","error":"Config check failed"},...}
[Python process exits with code 1]
```
