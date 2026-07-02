# AiBan Workflow 2.0 开发计划书（AI 协作版）

> 文档版本：v1.1
> 编制日期：2026-06-29
> 最近更新：2026-07-01
> 工作目录：`D:\workfolw_aiban_2.0`
> 目标仓库：`https://github.com/Zzz316/workfolw_aiban2.0.git`
> 目标：将工作流执行逻辑从 Python 引擎迁移到 Node-RED，使流程在 Node-RED 中配置后可直接运行。

---

## 1. 文档用途

本文档是 Workflow 2.0 的开发总纲，也用于向后续 AI 大模型、开发人员和测试人员传递完整上下文。

任何参与开发的 AI 在修改代码前，都必须：

1. 阅读本文档。
2. 阅读 `WORKFLOW_DOC.md`，了解 1.0 已有功能。
3. 查看当前 Git 分支、工作区状态和最近提交。
4. 不得删除或弱化 1.0 已有业务能力，除非有明确迁移方案和回归测试。
5. 每次只完成一个边界清楚、可以验证的开发任务。
6. 修改后执行对应测试，记录结果，再提交并推送。

---

## 2. 输入资料

### 2.1 Workflow 1.0 功能基线

文件：

```text
D:\workfolw_aiban_2.0\WORKFLOW_DOC.md
```

该文档描述当前 Python 工作流引擎、工作流 JSON、Node-RED 导出、自定义流程、顺序检测、计时、安环监控、数据库、报警、喇叭、API 和周期记录等功能。

### 2.2 Workflow 2.0 参考方案

文件：

```text
C:\Users\s2017088\Desktop\WORKFLOW_V2_PLAN.md
```

该方案提出 Python 向 Node-RED 推送推理事件，由 Node-RED 执行业务工作流。本计划保留该方向，但不采用“HWM 超限自动丢弃”的设计，因为它不能满足不丢帧要求。

### 2.3 AiBan SDK 手册

文件：

```text
C:\Users\s2017088\Desktop\艾班sdk手册\AiBanVideo3.0_API(解密).pdf
```

已知 SDK 信息：

- Python 模块：`libAiBanVideoPy3_9`
- SDK Python 包装版本：AIBANVIDEOPY 3.1.1
- 支持 Python 3.7、3.8、3.9、3.10
- 引擎入口：`aibanVideoGetInstance()`
- `metadata` 只在推理回调执行期间有效
- SDK 回调由内部工作线程调用，回调中不能执行耗时或阻塞操作
- YAML 配置不支持运行时热更新
- 截图保存为异步操作

---

## 3. 当前系统（1.0）

### 3.1 当前执行链

```text
Node-RED 编辑流程
    ↓
导出工作流 JSON
    ↓
Python WorkflowEngine 加载 JSON
    ↓
Python Runner 执行业务状态和动作
```

### 3.2 当前进程结构

```text
main.py
├── videowork 进程：SDK pipeline、推理回调、Python WorkflowEngine
├── videoalarm 进程：报警、数据库、Socket、API 输出
└── Flask 线程：Web API
```

### 3.3 1.0 必须迁移的功能

| 功能 | 1.0 实现 | 2.0 目标 |
|---|---|---|
| 自定义状态机 | Python `StateMachineRunner` | Node-RED 原子节点组合 |
| 工时计时 | Python `TimerRecordRunner` | Node-RED timer-record 流程 |
| 顺序检测 | Python `SequenceRunner` | Node-RED sequence 节点/子流 |
| 安环监控 | Python `MonitorRunner` | Node-RED monitor 节点 |
| Python handler | Python `PythonRunner` | 保留兼容桥或逐步迁移 |
| 报警 | Python alarm action | Node-RED alarm 节点 |
| 截图 | Python metadata 调用 | Node-RED 请求、Python SDK 执行 |
| 数据库存储 | Python DB 操作 | Node-RED save-db/cycle-record |
| 喇叭 | Python Socket | Node-RED speaker 节点 |
| API 输入 | Python HTTP server | Node-RED api-trigger |
| API 输出 | Python requests | Node-RED api-output |
| 周期记录 | Python sequence 扩展 | Node-RED cycle-record |
| 流程热更新 | Python 监听 JSON | Node-RED Deploy |

---

## 4. 2.0 目标与非目标

### 4.1 核心目标

```text
Node-RED 中配置流程
    ↓ Deploy
流程立即由 Node-RED 执行
```

不再经过：

```text
Node-RED 导出 JSON → Python 读取 JSON → Python 执行流程
```

### 4.2 职责边界

Python 只负责：

- AiBan SDK 初始化、启动、停止。
- 从 SDK 回调中提取单帧 metadata。
- 将 SDK 对象转换为普通、可序列化数据。
- 管理截图请求和截图结果。
- 管理视频源暂停与恢复。
- 向 Node-RED 可靠传输帧数据。
- 上报 SDK 和通信健康状态。

Node-RED 负责：

- label/confidence/模型匹配。
- 二阶模型匹配。
- 计数、持续时间、N 帧累计。
- 顺序、状态机、循环和条件判断。
- 报警去重。
- 数据库存储和周期记录。
- 喇叭、API 输入输出等业务动作。
- 工作流配置、部署和运行状态展示。

### 4.3 非目标

- 第一阶段不删除 Python 1.0 工作流引擎。
- 第一阶段不一次性迁移全部业务节点。
- 不承诺在无限断网、无限磁盘空间和永久停机条件下“绝对不丢帧”。
- 不允许通过静默丢帧换取低延迟。

---

## 5. 目标架构

```text
AiBan SDK Pipeline
    │ videoResultFunc
    ▼
Python Frame Adapter
    │ 仅复制和标准化 metadata
    ▼
内存接入队列
    ▼
SQLite WAL Durable Outbox
    ▼
ZeroMQ 可靠发送层
    │ 帧消息 / ACK / 重传 / 心跳
    ▼
Node-RED aiban-frame-input
    ▼
SQLite WAL Durable Inbox
    │ 持久化成功后返回 ACK
    ▼
Node-RED 工作流
    ├── detect / sub-detect
    ├── counter / timer / state / condition
    ├── sequence / monitor / cycle-record
    └── alarm / save-db / speaker / api-output
```

### 5.1 为什么不能直接使用 ZeroMQ PUSH/PULL

单纯 PUSH/PULL 不提供业务级确认。发送成功只表示消息进入 ZeroMQ 队列，不表示 Node-RED 已持久化或处理。

本项目需要：

- 应用层 ACK。
- 发送端持久化。
- 接收端持久化。
- 超时重传。
- 唯一键去重。
- 断点续传。
- 序号缺口检测。

ZeroMQ 可以继续作为底层传输，但不能只依赖其内存队列和 HWM。

---

## 6. AiBan SDK 接口约束

### 6.1 正确初始化顺序

```python
engine = AiBanVideoPy.aibanVideoGetInstance()
engine.loggerSetLevel(...)
engine.loggerSetSaveDirectory(...)
engine.registerVideoResultFunc(on_result)
engine.registerVideoSaveImageFunc(on_save_image)
engine.registerVideoMsgEventFunc(on_event)
rc = engine.checkAllConfig(yaml_path)
rc = engine.buildPipline()
```

所有回调必须在 `buildPipline()` 前注册，否则可能丢失首批帧或首批状态事件。

### 6.2 推理回调

```python
def videoResultFunc(
    err: bool,
    groupid: int,
    sourceid: int,
    metadata: IAibanVideoMetaData
) -> None:
    ...
```

语义：

- `err is True`：本次推理出错，不能使用 metadata。
- `err is False`：本次推理正常。

### 6.3 Metadata 接口

```python
metadata.getAllModelInferBoxes()
metadata.getModelInferBoxs(modelid)
metadata.saveImage(save_roi)
metadata.getSaveImagePath()
metadata.getTimeFlagDatetime()
```

检测框常用接口：

```python
box.getLabelName()
box.getLabelIndex()
box.getConfidence()
box.getPolygon()
box.getMaskRegionContoursPoints()
box.getTrackerId()
box.getInferBoxWithModelID(sub_id)
```

### 6.4 Metadata 生命周期

`metadata` 仅在 `videoResultFunc` 回调期间有效。

禁止：

```python
queue.put(metadata)
```

必须在回调内完成：

```text
SDK metadata
→ 读取所有需要的模型和检测框
→ 转成 dict/list/str/int/float/bool
→ 把纯 Python 数据放入队列
```

### 6.5 回调线程限制

SDK 回调内禁止：

- 发送网络请求。
- 等待 Node-RED ACK。
- 访问数据库。
- 执行业务工作流。
- 上传图片。
- 阻塞式等待队列空间。
- 长时间持有锁。

回调的目标性能：

```text
P95 < 2 ms
P99 < 5 ms
```

实际阈值应在目标设备、目标摄像头数量和实际模型输出量下压测确认。

### 6.6 截图

```python
metadata.saveImage(save_roi=False)
```

截图为异步操作。是否真正保存成功，以 `videoSaveImageFunc` 为准：

```python
def videoSaveImageFunc(groupid, sourceid, filepath, cvmat):
    ...
```

Node-RED 截图请求必须包含 `request_id`，Python 返回截图完成事件时携带同一 ID。

### 6.7 视频源控制

```python
engine.sourceControl(group_id, source_id, False)  # 暂停
engine.sourceControl(group_id, source_id, True)   # 恢复
```

当可靠队列接近容量或磁盘达到安全水位时，系统必须优先暂停对应视频源，不得静默丢帧。

### 6.8 Pipeline 配置和停止

- `checkAllConfig()` 返回值必须与 `aSUCCESS` 比较。
- `buildPipline()`启动内部线程后通常返回。
- 退出进程前必须调用 `stopPipline()`。
- `stopPipline()`可能阻塞，不能在 SDK 回调中调用。
- YAML 修改后必须执行：

```text
stopPipline
→ checkAllConfig
→ buildPipline
```

Node-RED 流程可以热 Deploy，但 SDK YAML 不能伪装成热更新。

---

## 7. 第一阶段：可靠帧通道

第一阶段只建立 AiBan 到 Node-RED 的可靠数据通道，不迁移复杂业务逻辑。

### 7.1 第一阶段交付物

```text
core/frame_bridge/
├── __init__.py
├── adapter.py
├── protocol.py
├── ingress_queue.py
├── durable_outbox.py
├── zmq_transport.py
├── source_backpressure.py
├── screenshot_service.py
├── metrics.py
└── config.py

node-red-contrib-aiban-workflow/
├── package.json
├── nodes/
│   ├── aiban-frame-input.js
│   └── aiban-frame-input.html
└── test/

docs/
├── FRAME_PROTOCOL.md
├── OPERATIONS.md
└── TEST_REPORT_PHASE_1.md
```

目录名称可以根据项目实际情况调整，但职责不能混淆。

### 7.2 帧协议

建议帧消息：

```json
{
  "type": "frame",
  "schema_version": 1,
  "message_id": "session-id:group-1:source-1:10241",
  "session_id": "uuid",
  "stream_id": "group-1/source-1",
  "frame_seq": 10241,
  "captured_at": "2026-06-29T12:00:00.123+08:00",
  "captured_monotonic_ns": 1234567890,
  "group_id": 1,
  "source_id": 1,
  "models": {
    "1": {
      "ok": true,
      "boxes": [
        {
          "label": "person",
          "label_index": 0,
          "confidence": 0.94,
          "polygon": [[10, 20], [100, 20], [100, 200], [10, 200]],
          "tracker_id": 27,
          "mask_contours": [],
          "sub_models": {}
        }
      ]
    }
  },
  "checksum": "sha256-value"
}
```

要求：

- `session_id`：每次 pipeline 启动生成。
- `frame_seq`：每路视频源独立、严格递增。
- `message_id`：全局幂等键。
- `captured_at`：业务时间。
- `captured_monotonic_ns`：本机延迟计算，避免系统时钟回拨。
- `checksum`：校验序列化后的核心载荷。

### 7.3 ACK 协议

```json
{
  "type": "ack",
  "schema_version": 1,
  "session_id": "uuid",
  "stream_id": "group-1/source-1",
  "frame_seq": 10241,
  "message_id": "session-id:group-1:source-1:10241",
  "persisted_at": "2026-06-29T12:00:00.150+08:00"
}
```

ACK 只能在 Node-RED 接收端完成持久化之后发送，不能在刚收到网络数据时提前发送。

### 7.4 发送端状态

Outbox 至少包含：

| 字段 | 说明 |
|---|---|
| `message_id` | 唯一键 |
| `session_id` | pipeline 会话 |
| `stream_id` | 视频流 |
| `frame_seq` | 帧序号 |
| `payload` | 序列化数据 |
| `created_at` | 入队时间 |
| `send_count` | 已发送次数 |
| `last_sent_at` | 最近发送时间 |
| `acked_at` | 确认时间 |

状态：

```text
NEW → PERSISTED → SENT → ACKED
                    └→ RETRY
```

### 7.5 接收端状态

Node-RED inbox 使用 `message_id` 唯一约束：

```text
收到消息
→ checksum 校验
→ inbox INSERT OR IGNORE
→ 提交事务
→ 返回 ACK
→ 按 stream_id/frame_seq 投递到流程
```

重发消息不得重复触发业务。

### 7.6 背压策略

必须配置两级水位：

```text
低水位 < 高水位 < 紧急水位
```

- 低于低水位：正常运行。
- 达到高水位：告警并准备暂停对应 source。
- 达到紧急水位：调用 `sourceControl(..., False)`。
- 回落到低水位并持续稳定一段时间：调用 `sourceControl(..., True)`。

暂停和恢复动作必须防抖，避免频繁启停。

### 7.7 “不丢帧”的工程定义

在以下约束内保证不静默丢帧：

- 本地磁盘可写且未耗尽。
- SDK 允许在队列达到危险水位前暂停视频源。
- Python 进程和机器没有发生无法恢复的物理损坏。
- Node-RED 恢复后能够处理积压。

如果系统无法继续接收，必须：

1. 记录明确错误。
2. 上报告警。
3. 暂停视频源。
4. 保留已持久化数据。

不得继续运行并丢弃旧帧。

### 7.8 “不超时”的工程定义

不把业务超时等同于消息丢失：

- ACK 超时：重传，不删除。
- Node-RED 离线：积压，不删除。
- 网络中断：重连并重放。
- Node-RED 处理慢：触发背压。

正常负载初始指标：

| 指标 | 目标 |
|---|---|
| SDK 回调 P99 | `< 5 ms` |
| 帧端到端延迟 P95 | `< 100 ms` |
| 帧端到端延迟 P99 | `< 300 ms` |
| 正常运行序号缺口 | `0` |
| 静默丢帧 | `0` |
| 重复业务执行 | `0` |

这些指标必须通过现场硬件压测校准。

### 7.9 第一阶段测试

必须覆盖：

1. 单路视频持续运行 24 小时。
2. 现场最大摄像头路数压力测试。
3. 单帧大量检测框。
4. Node-RED 停止 1 分钟、5 分钟、30 分钟后恢复。
5. Python 发送进程重启。
6. Node-RED 进程重启。
7. 网络中断、延迟、抖动。
8. 重复消息。
9. ACK 丢失。
10. 乱序到达。
11. 慢消费者。
12. 磁盘达到高水位。
13. source 暂停和恢复。
14. pipeline 正常停止和重新启动。
15. 授权失败和模型加载失败。

对账公式：

```text
Python 已持久化唯一帧数
= Node-RED 已持久化唯一帧数
 + Python 当前未确认帧数
```

第一阶段完成条件：

- 所有必测场景通过。
- 序号缺口为 0。
- 重传不造成重复流程执行。
- Node-RED 重启后自动恢复。
- source 背压有效。
- 有测试报告和复现命令。

---

## 8. 后续开发阶段

### 阶段 0：仓库与基线

任务：

- 修复或初始化 Git 仓库。
- 关联目标 GitHub remote。
- 创建 `v2.0-node-red-runtime` 分支。
- 找回或迁入 `node-red-contrib-aiban-workflow` 源码。
- 清理旧绝对路径。
- 建立 1.0 功能回归清单。
- 为当前 1.0 创建可回退标签。

已发现问题：

- 2026-06-29 检查时，当前目录不是有效 Git 工作区。
- `node-red/package.json` 指向旧路径：

```text
D:/workfolw_aiban/node-red-contrib-aiban-workflow
```

- 当前工作目录中未发现该自定义节点包源码。

### 阶段 1：可靠帧通道

按本文第 7 节执行。

### 阶段 2：A-B-C 顺序识别最小闭环

#### 8.2.1 阶段目标

阶段 2 不再以一次性开发全部基础原子节点为目标，而是优先实现一个可运行、可观测、可落库、可自动测试的最小业务闭环：

```text
AiBan SDK 识别标签
→ Python FrameBridge 可靠传输
→ Node-RED aiban-frame-input
→ 标签过滤/匹配
→ A-B-C 顺序状态机
→ 生成 OK 或 NG 结果
→ 幂等写入 MySQL
→ 输出全过程处理日志和阶段耗时
```

本阶段的目的，是验证 Node-RED 已经能够真正承担最小业务流程的执行职责，而不只是接收和显示推理帧。

#### 8.2.2 最小节点范围

本阶段只开发或整理闭环必需能力：

1. `aiban-frame-input`：复用阶段 1 已完成的可靠帧入口。
2. `aiban-label-match`：从标准化帧中按 `model_id + label + confidence` 判断 A、B、C 标签是否出现。
3. `aiban-sequence`：执行严格的 A → B → C 顺序状态机。
4. `aiban-result-db`：将一次流程的最终结果幂等写入 MySQL。
5. `aiban-workflow-audit`：异步记录各阶段事件、状态变化和实际处理耗时。
6. 一份可直接导入或随项目部署的最小示例流程：`frame-input → label-match → sequence → result-db`。

允许复用并重构现有 `sequence-node.js`，但不得继续让它只负责“导出 Python 工作流 JSON”；阶段 2 的顺序判断必须在 Node-RED 运行时直接执行。

`camera-filter`、`sub-detect`、`counter`、`timer`、通用 `state/condition/reset` 等不属于本阶段必交付项，除非它们是实现上述最小闭环不可缺少的内部模块。

#### 8.2.3 A-B-C 业务规则

默认示例配置：

```json
{
  "workflow_id": "abc-sequence-demo",
  "group_id": 1,
  "source_id": 1,
  "steps": [
    {"id": "A", "model_id": 1, "label": "A", "confidence": 0.5},
    {"id": "B", "model_id": 1, "label": "B", "confidence": 0.5},
    {"id": "C", "model_id": 1, "label": "C", "confidence": 0.5}
  ],
  "cycle_timeout_ms": 30000
}
```

判定要求：

- 空闲状态识别到 A：创建一个新的 `cycle_id`，状态变为 `WAIT_B`。
- `WAIT_B` 识别到 B：记录 B 完成，状态变为 `WAIT_C`。
- `WAIT_C` 识别到 C：流程结果为 `OK`，完成本周期并落库。
- B 在 A 之前、C 在 A/B 完成之前、步骤跳过或顺序错误：结果为 `NG`，必须记录 `failure_reason` 和实际识别步骤。
- 周期开始后超过 `cycle_timeout_ms` 仍未完成：结果为 `TIMEOUT`，必须落库，不能只写日志。
- 同一帧重复投递不得重复推进步骤；同一标签连续多帧出现只允许产生一次步骤边沿事件。
- 一个周期完成后，新的 A 才能启动下一周期；是否允许“完成帧中的 A 同时开启下一周期”必须显式配置，默认不允许。
- 不匹配 A/B/C 的其他标签不改变状态，但应按可配置级别记录调试日志。
- 判断使用帧事件时间和 `frame_seq`，不能使用数据库写入完成时间作为业务顺序依据。

状态至少按以下键隔离：

```text
workflow_id + session_id + group_id + source_id
```

不同摄像头、不同 SDK session、不同流程之间不得串状态。

#### 8.2.4 标准消息契约

进入顺序节点的消息必须保留：

```text
message_id
session_id
stream_id
frame_seq
group_id
source_id
sdk_received_at_ms
node_received_at_ms
models / labels
```

标签匹配节点新增但不得覆盖原始字段：

```json
{
  "workflow": {
    "workflow_id": "abc-sequence-demo",
    "matched_steps": ["A"],
    "match_started_at_ms": 0,
    "match_finished_at_ms": 0,
    "match_duration_ms": 0.0
  }
}
```

顺序节点输出必须包含：

```text
cycle_id
previous_state
current_state
recognized_step
expected_step
result_status
failure_reason
cycle_started_at
cycle_finished_at
cycle_duration_ms
event_id
```

#### 8.2.5 结果落库

阶段 2 使用专用最小结果写入能力，不等待阶段 4 的通用副作用节点。建议表名：

```text
icamera_data.workflow_abc_result
```

至少保存以下字段：

| 字段 | 说明 |
|---|---|
| `event_id` | 业务幂等键，唯一索引 |
| `cycle_id` | 本次 A-B-C 周期 ID |
| `workflow_id` | 流程 ID |
| `session_id` | SDK 会话 ID |
| `stream_id` | group/source 流标识 |
| `group_id` / `source_id` | 视频源 |
| `start_frame_seq` / `end_frame_seq` | 周期首尾帧 |
| `actual_sequence` | 实际步骤序列，JSON 或字符串 |
| `result_status` | `OK`、`NG` 或 `TIMEOUT` |
| `failure_reason` | 失败或超时原因 |
| `started_at` / `finished_at` | 北京时间，带毫秒 |
| `cycle_duration_ms` | 业务周期耗时 |
| `db_write_duration_ms` | 实际写库耗时 |
| `created_at` | 数据库记录创建时间 |

数据库要求：

- 提供建表 SQL 或自动迁移脚本。
- `event_id` 建立唯一索引，重复消息使用 upsert/no-op，不得重复插入。
- 数据库配置来自环境变量或独立配置文件，不得把密码写入流程 JSON、日志或 Git。
- 写库必须有超时、有限重试和明确错误输出。
- 写库失败时不得把结果伪装成成功；至少写入本地失败队列，支持后续重试。
- 数据库操作不得阻塞帧接收循环；应使用异步队列、worker 或等价机制。

建议 `event_id`：

```text
workflow_id:session_id:stream_id:cycle_id:result_status
```

#### 8.2.6 工作流审计日志与实际耗时

日志风格参考：

```text
D:\workfolw_aiban_2.0\logs\frame_bridge
```

新增目录：

```text
D:\workfolw_aiban_2.0\logs\workflow
```

每次运行至少生成：

```text
workflow-<run_id>.log
workflow-<run_id>.jsonl
workflow-<run_id>-summary.csv
```

日志必须异步写入，不能阻塞 Node-RED 帧输入。所有事件使用北京时间并保留毫秒，使用 `message_id + event_id + cycle_id` 串联。

每个周期至少记录以下事件：

```text
frame_received
label_match_started
label_match_finished
sequence_transition
sequence_completed / sequence_failed / sequence_timeout
db_write_queued
db_write_started
db_write_succeeded / db_write_failed
```

每条日志至少包含：

```text
audit_at
event
workflow_id
message_id
event_id
cycle_id
session_id
stream_id
frame_seq
group_id
source_id
recognized_labels
recognized_step
previous_state
current_state
stage_duration_ms
elapsed_from_frame_ms
result_status
error_code
error_message
```

可读日志应像 `logs/frame_bridge/transmission-*.log` 一样直接显示处理链，例如：

```text
[ABC] #128 g1/s1 cycle=... │ 标签匹配 0.42ms → 顺序判断 0.08ms
      → 写库排队 0.15ms → MySQL 3.60ms │ 累计 4.25ms │ A→B→C OK
```

CSV 每个周期一行，至少汇总：

- A、B、C 各自首次识别时间和帧号。
- 标签匹配耗时。
- 顺序判断耗时。
- 写库排队耗时。
- MySQL 写入耗时。
- 从触发结果到落库完成的累计处理耗时。
- A 到 C 的业务周期耗时。
- 最终状态、失败原因、重试次数。

注意区分：

- `cycle_duration_ms`：A 到 C/失败/超时的业务时间。
- `stage_duration_ms`：某个代码阶段实际执行时间。
- `elapsed_from_frame_ms`：当前阶段完成时相对原始帧进入 SDK/Node-RED 的累计延迟。

#### 8.2.7 状态持久化和 Deploy 策略

- 至少明确 Node-RED 重启和 Deploy 时当前半成品周期如何处理。
- 阶段 2 默认采用“恢复未完成周期”；若暂不能恢复，必须在启动后把中断周期落为 `NG/INTERRUPTED`，不得静默丢失。
- 最近处理的 `message_id/frame_seq` 必须持久化或能从 inbox 重放恢复，避免重启后重复推进。
- 必须提供手动 reset；reset 需记录原因、操作者/来源和被终止的 `cycle_id`。

#### 8.2.8 自动化测试

至少覆盖：

1. A → B → C，结果 `OK` 且只写库一次。
2. B → A → C，结果 `NG`，原因可定位。
3. A → C，识别为跳步 `NG`。
4. A → B 后超时，结果 `TIMEOUT` 并落库。
5. A、B、C 分别连续出现多帧，不重复推进。
6. 同一个 `message_id` 重放，不重复推进、不重复写库。
7. 两个 source 并行执行，状态互不干扰。
8. 两个 session 使用相同 frame_seq，状态互不干扰。
9. MySQL 首次写入失败后有限重试成功。
10. MySQL 持续不可用，进入失败队列并输出错误日志。
11. Node-RED 重启/Deploy 后未完成周期按约定恢复或落为 `INTERRUPTED`。
12. 日志、JSONL、CSV 字段完整，阶段耗时均为非负数。

测试应优先使用模拟标准帧，不依赖真实摄像头；另保留一项真实 AiBan SDK 的现场验收。

#### 8.2.9 完成条件

阶段 2 只有同时满足以下条件才算完成：

- Node-RED 直接执行 A-B-C 顺序逻辑，不经过 Python WorkflowEngine。
- OK、乱序 NG、跳步 NG、TIMEOUT 都能稳定产生最终结果。
- 每个最终结果成功写入 MySQL，重放不会重复写库。
- 日志能从原始 `message_id` 追踪到数据库 `event_id`。
- 可读日志、JSONL、CSV 都能显示各阶段实际耗时。
- 自动化测试全部通过并提供一条复现命令。
- 提供可导入的示例 flow、建表 SQL、配置示例和阶段 2 测试报告。
- 真实 SDK 环境至少完成一次 A → B → C → MySQL → 日志的现场演示。

### 阶段 3：业务模式迁移

迁移顺序：

1. monitor
2. timer_record
3. 扩展 sequence（多步骤、计数、持续时间、可选步骤、循环）
4. custom_flow/state_machine
5. cycle-record
6. Python handler 兼容

迁移期间采用双跑：

```text
同一份标准化帧
├── Python 1.0 引擎：影子运行，只记录结果
└── Node-RED 2.0：候选运行
```

对比：

- 状态变化。
- 步骤完成。
- 超时。
- 报警类型和内容。
- 计时结果。
- 数据库字段。
- 截图请求。

### 阶段 4：副作用节点

迁移：

- alarm
- 通用 save-db（阶段 2 的 A-B-C 专用结果写入在本阶段继续抽象）
- speaker
- socket server/client
- api-trigger
- api-output
- screenshot
- manual speaker test

所有副作用节点必须支持：

- 幂等键。
- 超时配置。
- 有限重试。
- 失败队列。
- 人工补偿。
- 审计日志。

历史帧重放不得造成重复写库、重复报警、重复播报或重复 API 推送。

### 阶段 5：运行管理

实现：

- Node-RED 启动和停止管理。
- Python/Node-RED 健康检查。
- Node-RED 离线缓存。
- 流程版本号。
- 流程备份和回滚。
- 运行状态页面。
- 统一日志格式。
- 统一错误码。
- 配置文件化，取消生产路径硬编码。

### 阶段 6：切换和发布

步骤：

1. 按业务逐条切换至 Node-RED。
2. 保留 Python 1.0 回退开关。
3. 完成现场稳定性观察。
4. 默认关闭 Python WorkflowEngine。
5. 删除“Node-RED 导出 JSON 后由 Python 执行”的主路径。
6. 完成开发、部署、运维和节点使用文档。
7. 合并开发分支。
8. 发布 `v2.0.0`。

---

## 9. 数据与状态设计原则

### 9.1 状态隔离键

Node-RED 节点状态至少按以下维度隔离：

```text
flow_id
+ workflow_id
+ session_id
+ group_id
+ source_id
```

不能只使用 `source_id`，因为不同 group 中可能出现相同 source ID。

### 9.2 事件时间

- 业务持续时间优先使用帧时间或单调时钟。
- 不能只使用 Node-RED 收到消息的时间，否则积压重放会改变业务结果。
- 重放历史帧时，duration/timeout 必须保持与原始帧时间一致。

### 9.3 幂等

以下操作必须有业务幂等键：

- 报警。
- 数据库写入。
- API 输出。
- 喇叭命令。
- 周期主表和步骤子表。
- 截图请求。

建议键格式：

```text
workflow_id:session_id:stream_id:event_type:event_seq
```

### 9.4 流程 Deploy

必须明确三种 Deploy 策略：

- 保留现有状态。
- 清空并重启状态。
- 从持久化检查点恢复。

不得让普通 Deploy 在无提示的情况下造成计时器、步骤状态或周期记录丢失。

---

## 10. 日志和监控

至少采集：

| 指标 | 维度 |
|---|---|
| SDK 接收帧数 | group/source |
| 最近帧序号 | session/stream |
| 帧序号缺口 | session/stream |
| SDK 回调耗时 | group/source |
| Outbox 数量和容量 | stream |
| Inbox 数量和容量 | stream |
| ACK 延迟 | stream |
| 端到端延迟 | stream |
| 重传次数 | stream |
| 重复消息数 | stream |
| checksum 失败数 | stream |
| source 暂停/恢复次数 | group/source |
| Node-RED 在线状态 | instance |
| 磁盘使用率 | path |
| 工作流异常数 | flow/node |
| 标签匹配耗时 | workflow/stream |
| 顺序状态转换耗时 | workflow/stream/state |
| 业务周期耗时 | workflow/stream/result |
| 写库排队和执行耗时 | workflow/table/result |
| 写库失败和重试次数 | workflow/table/error |

日志必须能够使用 `message_id` 串联：

```text
SDK callback
→ Python outbox
→ ZeroMQ transport
→ Node-RED inbox
→ Node-RED workflow
→ alarm/save-db/api-output
```

阶段 2 起，工作流日志还必须能继续串联：

```text
frame_received
→ label_match
→ A/B/C sequence transition
→ final result
→ db queue
→ MySQL result row
```

FrameBridge 传输日志与 workflow 业务日志职责分离，但必须通过同一个
`message_id` 关联。业务周期级事件再使用 `cycle_id` 和 `event_id` 关联，
不得只输出无法检索的自然语言日志。

---

## 11. 安全与配置

- 数据库密码、API secret、Node-RED credentialSecret 不得提交到 Git。
- Git 中只保留 `.example` 配置。
- 生产配置通过环境变量或独立配置文件加载。
- ZeroMQ 如果跨主机部署，必须评估 CurveZMQ 或受控内网认证。
- Node-RED 管理端必须启用身份验证。
- 外部 API 输入必须支持签名或 token。
- 日志中不得打印密码、appsecret、完整认证头。

---

## 12. Git 与更新记录规范

### 12.1 分支

建议：

```text
main
└── v2.0-node-red-runtime
```

高风险功能可创建短期功能分支：

```text
feature/frame-bridge
feature/node-red-frame-input
feature/sequence-runtime
```

### 12.2 Commit 规范

示例：

```text
feat(bridge): add normalized frame protocol
feat(bridge): persist frames in sqlite outbox
feat(node-red): add durable frame input node
fix(bridge): replay unacked frames after reconnect
test(bridge): cover ack loss and duplicate delivery
docs(v2): document transport and recovery
```

### 12.3 每次更新必须记录

```text
日期：
分支：
Commit ID：
修改文件：
实现内容：
验证命令：
测试结果：
已知问题：
下一步：
```

### 12.4 推送要求

每完成一个可验证任务：

1. 检查 `git diff`。
2. 运行测试。
3. 创建单一职责 commit。
4. 推送当前开发分支。
5. 向用户报告 commit ID 和更新内容。

不得将无关修改混入同一提交。不得覆盖用户已有未提交修改。

---

## 13. AI 每次接手任务的执行模板

### 13.1 开始前

```text
1. 阅读 WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md
2. 阅读与当前任务相关的源码和文档
3. git status --short --branch
4. git log -5 --oneline
5. 确认当前阶段和未完成项
6. 检查是否存在用户未提交修改
```

### 13.2 开发时

```text
1. 只修改当前任务所需文件
2. 保持 1.0 回退路径
3. 为协议和状态变化增加测试
4. 不在 SDK 回调中加入阻塞操作
5. 不使用静默丢帧策略
6. 所有副作用操作考虑幂等
```

### 13.3 完成后

```text
1. 运行单元测试
2. 运行相关集成测试
3. 检查日志和错误分支
4. 更新文档/变更记录
5. 提交并推送
6. 报告修改、测试、commit ID 和剩余风险
```

---

## 14. 当前下一步

阶段 1 的可靠帧通道和前三项代码闭环已经完成。当前按以下顺序实施阶段 2：

1. 冻结并测试阶段 2 标准消息契约。
2. 提供 `workflow_abc_result` 建表 SQL 和数据库 `.example` 配置。
3. 实现 `aiban-label-match`，输出 A/B/C 边沿事件和匹配耗时。
4. 将 `aiban-sequence` 改为 Node-RED 运行时直接执行的 A-B-C 状态机。
5. 实现专用、异步、幂等的 `aiban-result-db`。
6. 实现 `aiban-workflow-audit` 可读日志、JSONL 和 CSV 汇总。
7. 组合并提交最小示例 flow。
8. 完成模拟帧自动化测试和故障注入测试。
9. 生成 `docs/TEST_REPORT_PHASE_2.md`。
10. 在真实 AiBan SDK 和 MySQL 环境完成一次端到端演示。

---

## 15. 核心决策摘要

后续 AI 不得在没有明确评审的情况下推翻以下决策：

1. Node-RED 是 2.0 的业务工作流执行引擎。
2. Python 不再执行通用业务工作流，只负责 SDK、标准化和可靠桥接。
3. SDK metadata 不得跨回调生命周期传递。
4. SDK 回调不得等待网络、数据库或 ACK。
5. 不采用“HWM 满后丢弃旧帧”。
6. 使用帧序号、持久化 outbox/inbox、ACK、重传和去重。
7. 过载时优先暂停视频源，不静默丢帧。
8. Node-RED 重放消息时，所有副作用必须幂等。
9. 1.0 引擎在 2.0 完成现场验证前必须保留为回退路径。
10. 每次代码更新必须测试、提交、推送并记录说明。
