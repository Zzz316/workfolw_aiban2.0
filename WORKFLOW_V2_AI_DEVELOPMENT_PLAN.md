# AiBan Workflow 2.0 开发计划书（AI 协作版）

> 文档版本：v1.0  
> 编制日期：2026-06-29  
> 工作目录：`D:\workfolw_aiban_2.0`  
> 目标仓库：`https://github.com/dedezzz0114-tech/workfolw_aiban2.0.git`  
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

### 阶段 2：Node-RED 基础原子节点

建议顺序：

1. `aiban-frame-input`
2. `aiban-camera-filter`
3. `aiban-detect`
4. `aiban-sub-detect`
5. `aiban-counter`
6. `aiban-timer`
7. `aiban-state`
8. `aiban-condition`
9. `aiban-reset`
10. `aiban-debug`

每个节点必须：

- 单一职责。
- 按 flow/group/source 隔离状态。
- 支持 reset。
- 在编辑器中显示关键状态。
- 有单元测试。
- 说明重启和 Deploy 时的状态策略。

### 阶段 3：业务模式迁移

迁移顺序：

1. monitor
2. timer_record
3. sequence
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
- save-db
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

日志必须能够使用 `message_id` 串联：

```text
SDK callback
→ Python outbox
→ ZeroMQ transport
→ Node-RED inbox
→ Node-RED workflow
→ alarm/save-db/api-output
```

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

按以下顺序开始：

1. 确认目标 GitHub 仓库是否可访问。
2. 将当前目录恢复为有效 Git 工作区，或重新克隆仓库后迁入当前代码。
3. 找回 `node-red-contrib-aiban-workflow` 自定义节点源码。
4. 修复 Node-RED 的旧绝对路径。
5. 创建 `v2.0-node-red-runtime` 分支。
6. 编写正式的 `FRAME_PROTOCOL.md`。
7. 建立不经过 SDK 的模拟帧发生器和 Node-RED 接收压测。
8. 实现 Python metadata adapter。
9. 实现 durable outbox、ACK、重传和背压。
10. 完成第一阶段测试报告后，再开始业务节点迁移。

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

