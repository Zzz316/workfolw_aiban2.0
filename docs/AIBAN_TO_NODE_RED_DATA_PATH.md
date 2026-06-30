# AiBan → Python → Node-RED 数据链路说明

> 适用版本：Workflow 2.0 第一阶段  
> 默认地址：`tcp://127.0.0.1:5557`  
> 目标：Node-RED 直接接收每帧推理数据，同时做到可追踪、不静默丢包、低延迟。

## 1. 数据如何流动

```text
AiBan SDK内部推理线程
  │ videoResultFunc(err, groupid, sourceid, metadata)
  ▼
Python FrameAdapter
  │ 回调期间读取metadata，转换为纯Python dict/list
  │ 生成session_id、stream_id、frame_seq、message_id、接收时间、checksum
  ▼
Python内存接入队列（SDK回调不等待磁盘和网络）
  ▼
SQLite WAL Durable Outbox
  │ 本地事务提交后成为可恢复数据
  ▼
ZeroMQ DEALER
  │ 发送精确JSON载荷和SHA-256校验值
  ▼
Node-RED aiban-frame-input（ZeroMQ ROUTER）
  │ 校验checksum和协议版本
  ▼
SQLite WAL Durable Inbox
  │ message_id唯一约束，落盘成功后才发送ACK
  ▼
Node-RED msg.payload → detect / timer / sequence / alarm等流程节点
```

AiBan的 `metadata` 只在SDK回调期间有效，因此Python必须在回调内读取模型和检测框，不能把原始SDK对象直接放进队列。标准帧中包含模型ID、label、confidence、polygon、tracker_id及帧时间。

## 2. 一帧如何被唯一识别

```text
message_id = session_id + stream_id + frame_seq
stream_id  = group-{group_id}/source-{source_id}
```

- `session_id`：每次Python pipeline启动生成一个UUID。
- `frame_seq`：每路摄像头独立从1递增。
- `message_id`：outbox和inbox的唯一键，用于ACK、重传、去重和日志对账。

Node-RED收到重复的 `message_id` 时仍返回ACK，但不会再次输出到工作流，因此网络重传不会造成重复报警或重复写库。

## 3. 为什么不会静默丢包

1. SDK回调完成标准化后进入无固定上限的短时内存接入队列。
2. 独立线程把帧写入Python SQLite WAL outbox。
3. 未收到有效ACK的记录始终保持 `pending`，断线或Node-RED重启后自动重发。
4. Node-RED先写SQLite WAL inbox，事务成功后才返回ACK。
5. Python收到带相同 `message_id` 且checksum正确的ACK后，才把帧标记为已确认。
6. 队列或outbox达到高水位时，控制线程调用AiBan `sourceControl(..., False)` 暂停对应视频源；恢复到低水位后再启动。
7. 系统不使用“ZeroMQ HWM满后丢弃旧消息”的策略。

工程边界：如果磁盘永久写满、硬件损坏或进程在SDK回调进入Python之前崩溃，无法提供数学意义上的绝对零丢失；系统的原则是遇到容量风险时明确报警并暂停视频源，而不是继续运行并静默丢数据。

## 4. 如何降低延迟

- SDK回调只做必要的metadata复制和内存入队，不执行网络、数据库或ACK等待。
- SQLite启用WAL，写入和读取可以并行。
- ZeroMQ保持长连接，不为每帧重新建立TCP连接。
- 发送端支持批量扫描pending记录，但单帧收到后可立即发送。
- ACK只包含帧标识和Node端耗时，不回传完整推理数据。
- 背压控制在独立线程执行，避免阻塞SDK推理线程。

系统记录以下时间：

| 字段 | 含义 |
|---|---|
| `sdk_convert_ms` | SDK metadata转纯Python数据耗时 |
| `queue_wait_ms` | 进入接入队列到outbox提交完成 |
| `outbox_persist_ms` | Python outbox事务耗时 |
| `wire_ms` | ZeroMQ发送到Node-RED收到 |
| `node_inbox_persist_ms` | Node协议校验和inbox事务耗时 |
| `node_receive_diff_ms` | SDK接收到Node-RED接收的总时间差 |
| `ack_rtt_ms` | Python发送到收到Node持久化ACK |
| `delivery_ms` | Python outbox创建到ACK确认的总耗时 |

## 5. 本地详细传输日志

运行：

```powershell
python test_aiban_sdk_bridge.py --print-every 1
```

每次运行自动生成：

```text
logs/frame_bridge/transmission-YYYYMMDD-HHMMSS-PID.jsonl
logs/frame_bridge/transmission-YYYYMMDD-HHMMSS-PID.log
```

JSONL适合程序分析；文本日志适合人工查看。每个 `message_id` 通常依次出现：

```text
sdk_received
outbox_persisted
transport_sent
node_ack_received
```

若同一 `message_id` 出现多个 `transport_sent`，表示发生重传；最终出现 `node_ack_received` 表示Node-RED已经可靠落盘。通过相同 `message_id`、`frame_seq` 和标签，可对比Python终端、Node-RED Debug和本地传输日志。

## 6. 当前业务数据库

业务报警、周期记录和后续 `save-db` 节点使用MySQL：

```text
127.0.0.1:3306
user=root
database=icamera_data
```

SQLite outbox/inbox只用于可靠传输，不替代业务MySQL。
