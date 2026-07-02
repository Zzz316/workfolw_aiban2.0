# AiBan Workflow 2.0 开发计划书

> 文档版本：v2.0（架构重启版）
> 编制日期：2026-07-02
> 当前阶段：退回阶段一重新实施
> 工作目录：`D:\workfolw_aiban_2.0`

---

## 1. 本次调整结论

原方案采用：

```text
Python 常驻进程
→ AiBan SDK 回调
→ SQLite Outbox
→ ZeroMQ
→ Node-RED aiban-frame-input
→ SQLite Inbox
→ 下游业务组件
```

现调整为：

```text
Node-RED aiban-runtime 组件
→ 启动并管理 Python 子进程
→ Python 初始化 AiBan SDK 并执行推理
→ 通过本机标准输入/输出传递控制命令和推理事件
→ aiban-runtime 将结果转换为 Node-RED msg
→ 直接发送给下一个组件
```

Node-RED 成为系统的启动入口、运行主控和业务工作流引擎。Python 不再主动通过
ZeroMQ 向 Node-RED 发送数据，而是作为 Node-RED 组件管理的 AiBan SDK 适配子进程。

本项目从阶段一重新开始。现有阶段一、阶段二的完成状态作废，必须按本计划重新开发、
测试和验收。

---

## 2. 调整目标

### 2.1 核心目标

1. 用户在 Node-RED 中拖入一个 `aiban-runtime` 组件。
2. 组件配置 Python 路径、SDK 路径和 Pipeline YAML。
3. Deploy 后，组件直接启动 Python 子进程并初始化 AiBan。
4. Python 收到 SDK 推理回调后输出标准事件。
5. `aiban-runtime` 把事件封装成 `msg`，通过 Node-RED 连线直接交给下游组件。
6. Node-RED Deploy、停止、重启时，Python 和 AiBan Pipeline 生命周期受控。
7. 后续标签、顺序、计时、报警、数据库等业务全部由 Node-RED 组件和连线表达。

### 2.2 不再采用的主链路

以下模块不再属于新架构主链路：

- Python FrameBridge 主动发送。
- ZeroMQ DEALER/ROUTER。
- Python SQLite Durable Outbox。
- Node-RED SQLite Durable Inbox。
- 帧 ACK、网络重传和 ZMQ 心跳。
- 独立启动 `main.py` 后等待 Node-RED 接收推理帧。

现有代码暂不立即删除，统一标记为 `legacy-zmq-bridge`，用于迁移对照和必要回退。
完成新阶段一验收后，再单独评审删除范围。

### 2.3 本阶段非目标

- 不在阶段一迁移全部 1.0 业务能力。
- 不在阶段一重写标签、顺序、计时、报警等业务节点。
- 不允许把通用业务逻辑重新放回 Python。
- 不允许 Node-RED Function 节点直接拼接不受控的 SDK 启动命令。
- 第一阶段仅支持 Node-RED 与 Python 在同一台设备上运行。

---

## 3. 新总体架构

```text
Node-RED
└── aiban-runtime（配置节点/输入节点）
    ├── 校验配置
    ├── child_process.spawn(Python)
    ├── 写入控制命令（stdin，JSON Lines）
    ├── 读取推理事件（stdout，JSON Lines）
    ├── 读取运行日志（stderr）
    ├── 管理启动、停止、重启和健康状态
    └── node.send(msg)
          ↓
      aiban-label
          ↓
      counter / timer / state / sequence / monitor
          ↓
      alarm / save-db / speaker / api-output
```

### 3.1 Node-RED 职责

- 保存并校验 Python、SDK、YAML 等运行配置。
- 创建、监控和停止 Python 子进程。
- 防止同一 Pipeline 被重复启动。
- 将控制消息写入 Python 标准输入。
- 解析 Python 标准输出中的协议事件。
- 将推理帧转换为标准 Node-RED 消息并发送给下游。
- 显示启动中、运行中、停止、异常、重启中的节点状态。
- 执行标签匹配、顺序、状态、计时和所有业务动作。
- 记录组件、子进程和业务链路日志。

### 3.2 Python 职责

- 加载 AiBan Python SDK。
- 按正确顺序注册回调、校验配置并启动 Pipeline。
- 在 SDK 回调有效期内复制 metadata，转换为纯 Python 数据。
- 输出标准推理事件、SDK 状态事件和截图结果。
- 接收启动、停止、健康检查、截图、暂停和恢复等控制命令。
- 在收到停止命令、stdin 关闭或进程信号时调用 `stopPipline()`。
- 不执行标签判断、顺序判断、报警、写业务库等通用业务逻辑。

### 3.3 进程通信方式

阶段一使用本机进程管道：

- `stdin`：Node-RED → Python 控制命令。
- `stdout`：Python → Node-RED 结构化 JSON Lines 事件。
- `stderr`：Python 运行日志和诊断信息。

协议要求“一行一个完整 JSON 对象”。Python 的 `stdout` 禁止输出普通文本；所有普通日志
必须写入 `stderr`，防止协议流被污染。

阶段一不引入 HTTP、WebSocket、ZeroMQ 或数据库中转。若现场压测证明标准管道无法满足
吞吐，再以测试数据为依据评审 IPC 升级，不能预先恢复旧 ZMQ 架构。

---

## 4. 组件设计

### 4.1 `aiban-runtime` 组件

建议配置项：

| 配置项 | 说明 |
|---|---|
| `name` | 节点名称 |
| `pythonPath` | 指定 Python 解释器，禁止只依赖系统 PATH |
| `runnerPath` | Python AiBan 适配入口 |
| `sdkHome` | AiBan SDK 目录 |
| `pipelineConfig` | Pipeline YAML 路径 |
| `workingDirectory` | Python 子进程工作目录 |
| `startupTimeoutMs` | 启动超时 |
| `shutdownTimeoutMs` | 优雅停止超时 |
| `heartbeatIntervalMs` | 心跳周期 |
| `heartbeatTimeoutMs` | 心跳判定超时 |
| `restartPolicy` | `never`、`on-failure`、`always` |
| `maxRestartCount` | 连续重启上限 |
| `restartBackoffMs` | 重启退避时间 |
| `autoStart` | Deploy 后是否自动启动 |

组件输出建议分为三个端口：

1. 推理帧：供标签和业务组件使用。
2. SDK/运行状态事件：供监控和告警使用。
3. 错误与诊断事件：供 Debug、审计或故障流程使用。

组件输入支持：

```json
{"topic":"aiban/control","payload":{"command":"start"}}
{"topic":"aiban/control","payload":{"command":"stop"}}
{"topic":"aiban/control","payload":{"command":"restart"}}
{"topic":"aiban/control","payload":{"command":"health"}}
{"topic":"aiban/control","payload":{"command":"pause_source","group_id":1,"source_id":1}}
{"topic":"aiban/control","payload":{"command":"resume_source","group_id":1,"source_id":1}}
{"topic":"aiban/control","payload":{"command":"screenshot","group_id":1,"source_id":1,"request_id":"..."}}
```

### 4.2 Python Runner

新增独立入口，建议目录：

```text
python_runtime/
├── __init__.py
├── aiban_runner.py
├── sdk_adapter.py
├── protocol.py
├── command_loop.py
└── lifecycle.py
```

Runner 必须可以独立接受模拟 SDK 测试，不依赖 `main.py`、Flask、旧 WorkflowEngine、
旧报警进程或 ZMQ FrameBridge。

### 4.3 实例与资源约束

- 同一个 Node-RED 实例中，相同 Pipeline 配置默认只允许一个运行实例。
- Node-RED 节点关闭时必须注销监听器、关闭 stdin 并回收子进程。
- Deploy 时如果配置未变化，应避免无意义地重复启动 SDK。
- 配置变化时采用“停止旧进程 → 确认退出 → 启动新进程”。
- 不允许多个 Node-RED 节点同时争用同一 AiBan SDK 单例或相同摄像头资源。
- Windows 下必须验证正常退出和强制结束整个子进程树，禁止遗留孤儿进程。

---

## 5. 消息协议

### 5.1 通用事件结构

```json
{
  "schema_version": 1,
  "type": "frame",
  "runtime_id": "node-red-node-id",
  "session_id": "uuid",
  "event_id": "uuid",
  "event_seq": 10241,
  "emitted_at": "2026-07-02T10:00:00.123+08:00",
  "payload": {}
}
```

### 5.2 推理帧事件

```json
{
  "schema_version": 1,
  "type": "frame",
  "session_id": "uuid",
  "event_id": "uuid",
  "event_seq": 10241,
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
            "polygon": [],
            "mask_contours": [],
            "tracker_id": 27,
            "sub_models": {}
          }
        ]
      }
    }
  }
}
```

Node-RED 输出给下游的消息：

```json
{
  "topic": "aiban/frame",
  "payload": {},
  "aiban": {
    "runtime_id": "node-id",
    "session_id": "uuid",
    "event_id": "uuid",
    "event_seq": 10241,
    "stream_id": "group-1/source-1"
  }
}
```

### 5.3 生命周期事件

必须支持：

- `runtime_starting`
- `runtime_ready`
- `sdk_event`
- `heartbeat`
- `screenshot_result`
- `runtime_stopping`
- `runtime_stopped`
- `runtime_error`

`runtime_ready` 只能在 SDK 配置校验和 Pipeline 启动成功后发送，不能以 Python 进程创建成功
代替 AiBan 已就绪。

### 5.4 控制响应

每个控制命令包含 `request_id`，Python 返回：

```json
{
  "schema_version": 1,
  "type": "command_result",
  "request_id": "uuid",
  "ok": true,
  "command": "screenshot",
  "payload": {}
}
```

Node-RED 必须配置命令超时；迟到响应只能记录，不能错误完成另一个请求。

---

## 6. AiBan SDK 约束

1. 所有回调必须在 `buildPipline()` 前注册。
2. `metadata` 只在推理回调期间有效，不得传出回调或保存原对象。
3. 回调内只完成必要字段复制和轻量入队，禁止直接阻塞写 stdout。
4. Python 内部使用有界事件队列和独立输出线程写 stdout。
5. 队列达到高水位时必须发出明确过载事件，并暂停对应视频源；禁止静默丢帧。
6. `checkAllConfig()` 必须校验返回值。
7. 退出时必须调用 `stopPipline()`。
8. YAML 修改后执行“停止 → 校验 → 重新启动”，不得伪装热更新。
9. 截图为异步操作，必须使用 `request_id` 关联请求和结果。

本地进程管道移除了网络层，但没有移除生产者/消费者速度差异。阶段一仍必须实现有界队列、
水位监控和 source 暂停/恢复，且必须通过压力测试确定容量。

---

## 7. 分阶段开发计划

## 阶段 0：冻结旧架构并重置基线

任务：

1. 保存当前分支和现有测试结果，建立可回退标签。
2. 将 ZMQ FrameBridge、Outbox/Inbox 和 `aiban-frame-input` 标为旧架构。
3. 建立旧代码处置清单：保留、复用、废弃、待删除。
4. 冻结 1.0 功能清单，建立 `docs/WORKFLOW_1_0_PARITY_MATRIX.md`。
5. 确认现场 Python、AiBan SDK、Node.js、Node-RED 和 Windows 版本。

完成条件：

- 新旧架构边界明确。
- 当前代码可回退。
- 后续开发不再向 ZMQ 主链路增加功能。

## 阶段 1：Node-RED 直接启动 Python/AiBan

### 1.1 协议与 Runner

- 定义 JSON Lines 协议及版本兼容规则。
- 实现独立 Python Runner。
- 实现 SDK 初始化、回调标准化、命令循环和优雅退出。
- 提供 Mock SDK，允许无现场硬件运行全部基础测试。
- 保证 stdout 只有协议，stderr 只有日志。

### 1.2 Node-RED 组件

- 实现 `aiban-runtime.js/.html`。
- 使用参数数组调用 `spawn`，不拼接 shell 命令。
- 完成配置校验、启动超时、健康检查、状态显示和日志采集。
- 完成启动、停止、重启、截图、暂停和恢复命令。
- 将 frame 事件通过 `node.send()` 直接交给下游。
- 完成 Deploy、节点删除、Node-RED 退出时的子进程回收。

### 1.3 阶段一测试

必须覆盖：

1. Mock SDK 正常启动并连续输出帧。
2. 下游 Debug/测试节点直接收到标准 `msg`。
3. Python 路径、SDK 路径、YAML 路径错误。
4. `checkAllConfig()` 失败、模型加载失败、授权失败。
5. 启动超时和启动过程中停止。
6. Python 异常退出及有限自动重启。
7. Node-RED Deploy、重启和删除节点。
8. 重复启动和同一 Pipeline 资源冲突。
9. stdout 半包、粘连、空行、非法 JSON 和超大消息。
10. stderr 大量日志不阻塞进程。
11. 下游处理慢造成的背压。
12. 队列高水位触发 source 暂停，回落后恢复。
13. 截图请求、响应、超时和重复 request_id。
14. Windows 孤儿进程检查。
15. 真实 AiBan SDK 单路端到端运行。
16. 现场最大路数和持续 24 小时稳定性测试。

阶段一完成条件：

- Deploy 后无需手工运行 Python。
- `aiban-runtime → Debug` 可持续获得真实推理帧。
- Node-RED 停止后无遗留 Python/AiBan 进程。
- 异常状态在节点和日志中可见。
- 正常负载无静默丢帧、无协议解析错误。
- 自动化测试、现场测试和正式报告全部完成。

## 阶段 2：A-B-C 组件拓扑最小闭环

流程：

```text
aiban-runtime
→ 标签 A
→ 标签 B
→ 标签 C
→ result
→ result-db
```

原则：

- 每个标签是独立组件，只配置自己的匹配条件。
- A、B、C 顺序由 Node-RED 连线表达。
- 改变连线即可改变执行顺序，不维护第二份 `steps` 数组。
- 实现 OK、NG、TIMEOUT、乱序、跳步、幂等和状态隔离。
- 复用当前阶段二代码前必须重新核对其输入契约，移除对旧
  `aiban-frame-input`、Inbox 和 ZMQ 字段的强依赖。

完成条件：

- Mock SDK 和真实 SDK 均完成闭环。
- 仅改变画布连线即可改变识别顺序。
- 最终结果可幂等写入 MySQL。
- 有组件级日志和端到端处理耗时。

## 阶段 3：迁移全部业务逻辑组件

依据 `WORKFLOW_DOC.md` 和功能对等矩阵，逐项实现：

- camera/group/source 过滤。
- 主模型和二阶模型标签匹配。
- counter、duration、N 帧累计。
- timer、state、condition、reset。
- sequence、monitor、cycle-record。
- 1.0 custom_flow/state_machine。
- 受控 Python handler 兼容机制及退出计划。

迁移期间采用同一输入数据双跑，对比 1.0 与 2.0 的状态、步骤、超时和最终结果。

## 阶段 4：迁移副作用组件

实现并验证：

- alarm
- save-db
- speaker
- socket client/server
- api-trigger
- api-output
- screenshot
- manual speaker test

所有副作用必须支持幂等键、超时、有限重试、失败队列、审计和人工补偿。

## 阶段 5：运行管理

- Node-RED、Python、AiBan 的统一健康状态。
- 流程版本、备份、回滚和 Deploy 策略。
- 统一日志、错误码、指标和运行页面。
- 配置文件化和凭据管理。
- 安装包、启动方式和现场运维脚本。

## 阶段 6：切换与发布

发布前必须：

1. 功能对等矩阵全部通过。
2. 现网真实流程完成 1.0/2.0 双跑。
3. 完成稳定性、压力、故障恢复和回退演练。
4. 默认入口切换为 Node-RED。
5. 停用独立 `main.py → ZMQ → Node-RED` 主链路。
6. 评审后删除或归档旧 ZMQ、Outbox、Inbox 代码。
7. 发布 `v2.0.0`。

---

## 8. 可靠性与性能指标

阶段一初始目标：

| 指标 | 目标 |
|---|---|
| SDK 回调 P99 | `< 5 ms` |
| Python 事件生成到 Node-RED 收到 P95 | `< 50 ms` |
| Python 事件生成到 Node-RED 收到 P99 | `< 150 ms` |
| 正常负载协议解析错误 | `0` |
| 正常退出遗留子进程 | `0` |
| 非预期无限重启 | `0` |
| 正常运行静默丢帧 | `0` |

这些指标必须在目标设备、实际摄像头数量和模型输出量下重新校准。

管道不是持久化消息队列。Python 或 Node-RED 异常退出时，尚未被 Node-RED 读取的内存事件
可能丢失。阶段一的可靠性策略是：

- 缩短进程内停留时间。
- 使用序号检测缺口。
- 明确上报异常。
- 过载时暂停视频源。
- 通过监督和快速恢复减少故障窗口。

如果业务确认要求“进程崩溃后逐帧恢复”，应单独增加本机可选持久化缓冲层，但持久化层
必须位于 Node-RED 管理的 Python Runner 内部，不得重新引入 Python 主动连接 Node-RED
的 ZMQ 网络架构。

---

## 9. 日志、监控与审计

至少记录：

- Node-RED 节点 ID、runtime_id、session_id、Python PID。
- SDK 启动、就绪、停止和错误状态。
- 每路 source 最近 event_seq 和序号缺口。
- SDK 回调耗时、Python 排队时间、管道传输时间。
- 内部队列深度、高低水位、暂停和恢复次数。
- 子进程退出码、退出原因、重启次数和退避时间。
- 控制命令 request_id、耗时和结果。
- 下游工作流 event_id、cycle_id 和最终结果。

日志必须能够按以下标识串联：

```text
runtime_id → session_id → event_id → stream_id/event_seq → cycle_id
```

---

## 10. 安全与配置

- Node-RED 使用 `spawn(executable, args)`，禁止 `shell: true`。
- Python、Runner、SDK 和 YAML 路径必须规范化并校验。
- 不允许普通消息任意覆盖 executable 或 runnerPath。
- 生产配置不得包含 Git 中的数据库密码和 API secret。
- Node-RED 管理端必须启用身份验证。
- stderr 和 Node-RED 日志不得输出密码、令牌或完整认证头。
- 子进程使用最小必要权限运行。

---

## 11. 代码与文档交付物

阶段一至少交付：

```text
python_runtime/
├── aiban_runner.py
├── sdk_adapter.py
├── protocol.py
├── command_loop.py
└── lifecycle.py

node-red-contrib-aiban-workflow/
├── aiban-runtime.js
├── aiban-runtime.html
└── test/aiban-runtime.test.js

docs/
├── AIBAN_RUNTIME_PROTOCOL.md
├── AIBAN_RUNTIME_OPERATIONS.md
├── LEGACY_ZMQ_MIGRATION.md
└── TEST_REPORT_PHASE_1_RUNTIME.md
```

同时更新：

- `package.json`
- `README.md`
- Node-RED 示例 flow
- 安装依赖和环境变量示例
- 功能对等矩阵

---

## 12. Git 与实施规则

1. 开发前检查当前分支、未提交修改和最近提交。
2. 不覆盖用户已有修改，不将无关文件混入提交。
3. 每次只完成一个可验证任务。
4. 协议、生命周期和异常分支必须先有测试。
5. 每完成一个任务，记录修改文件、验证命令、测试结果和已知风险。
6. 新阶段一验收前，不删除旧架构代码。
7. 未完成全量功能对等前，保留 1.0 回退能力。

建议提交顺序：

```text
docs(runtime): reset phase 1 architecture
feat(runtime): add python JSONL protocol and mock runner
feat(node-red): add aiban runtime process node
test(runtime): cover lifecycle and malformed protocol
feat(runtime): integrate real AiBan SDK adapter
test(runtime): verify real SDK end-to-end flow
docs(runtime): add phase 1 test report and operations
```

---

## 13. 当前立即执行顺序

1. 评审并冻结本计划。
2. 建立旧 ZMQ 代码迁移清单。
3. 定义 `AIBAN_RUNTIME_PROTOCOL.md`。
4. 使用 Mock SDK 实现 Python Runner。
5. 实现 `aiban-runtime` Node-RED 组件。
6. 完成 `aiban-runtime → Debug` 模拟帧闭环。
7. 接入真实 AiBan SDK。
8. 完成生命周期、异常、背压和 Windows 进程回收测试。
9. 输出新阶段一测试报告。
10. 阶段一验收后，再调整并继续阶段二组件。

---

## 14. 核心决策摘要

1. Node-RED 是系统启动入口和业务工作流执行引擎。
2. Node-RED 组件直接启动并管理 Python/AiBan 子进程。
3. Python 与 Node-RED 阶段一使用本机 stdin/stdout JSON Lines 通信。
4. 推理事件由 `aiban-runtime` 直接 `node.send()` 给下游组件。
5. ZMQ、Outbox、Inbox 和 ACK 不再属于新主链路。
6. Python 只负责 SDK 和协议适配，不执行通用业务工作流。
7. SDK metadata 必须在回调有效期内转换为普通数据。
8. 回调线程不得直接执行阻塞管道写入或业务动作。
9. 过载时优先暂停视频源，不允许静默丢帧。
10. Deploy、停止和异常退出必须正确回收 Python/AiBan 进程。
11. A-B-C 只是阶段二最小闭环，不代表全部迁移完成。
12. 1.0 全部现用功能完成对等迁移和现场验证后，才允许发布 2.0。
