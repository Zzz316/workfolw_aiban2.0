# AiBan Workflow 2.0 开发计划书

> 文档版本：v2.2
> 编制日期：2026-07-02
> 最后更新：2026-07-08
> 当前阶段：阶段二收尾，准备进入阶段三（以 `aiban-runtime` 为主流程入口，按 YAML group 拆分场景子流程）
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

本项目曾从阶段一重新开始。当前新阶段一已经完成自动化测试和真实 SDK 现场验证，阶段二
以 `aiban-runtime` 输出的标准 Node-RED 消息为输入，重新实现 A-B-C 组件拓扑最小闭环。

2026-07-08 方向修正：

- `aiban-runtime` 不再只作为某条业务链路的普通上游节点，而是作为 Node-RED 主流程入口。
- `D:\product\AiBanWorkSpace\abvideo\main-flow.yaml` 中的 `GroupArrary` 是现场物理分组配置源，每个 group 对应一组摄像头、推理配置和业务运行域。
- Node-RED 后续业务逻辑按 `group_id + scene_id` 拆成可跳转、可切换、可复用的子流程。
- 外部按钮、API 或页面操作不直接启动/停止 Python，也不直接修改 SDK pipeline；它们只选择某个 group 下当前激活的场景子流程。
- A-B-C 阶段二闭环保留为“场景子流程”的第一个可运行样板，而不是最终主流程形态。

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
8. 主流程按 AiBan YAML 的 `group_id` 做一级分流，按外部按钮/API 选择的 `scene_id` 做二级分流。
9. 每个场景子流程独立维护 `workflow_id`、状态、审计日志和副作用输出，避免不同 group/scene 之间互相污染。

### 2.2 不再采用的主链路

以下模块不再属于新架构主链路：

- Python FrameBridge 主动发送。
- ZeroMQ DEALER/ROUTER。
- Python SQLite Durable Outbox。
- Node-RED SQLite Durable Inbox。
- 帧 ACK、网络重传和 ZMQ 心跳。
- 独立启动 `main.py` 后等待 Node-RED 接收推理帧。

现有代码暂不立即删除，统一标记为 `legacy-zmq-bridge`，用于迁移对照和必要回退。
新阶段一验收已完成。阶段二开发期间已正式移除 `aiban-frame-input`（`frame-input-node.js/.html`）
及 `package.json` 对应注册，旧 ZMQ 入口不再可用。其余旧 ZMQ/Outbox/Inbox 代码的删除范围
按 `docs/LEGACY_ZMQ_MIGRATION.md` 的时间表分阶段评审。

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
└── 主流程：aiban-runtime（唯一 AiBan 运行入口）
    ├── 校验配置
    ├── 解析 main-flow.yaml 的 GroupArrary / ModelArrary
    ├── child_process.spawn(Python)
    ├── 写入控制命令（stdin，JSON Lines）
    ├── 读取推理事件（stdout，JSON Lines）
    ├── 读取运行日志（stderr）
    ├── 管理启动、停止、重启和健康状态
    └── 输出标准 frame/status/error msg
          ↓
      group/scene router（主流程分发）
          ├── group_id = 1, scene_id = plug-sequence
          │     ↓
          │   子流程：aiban-label → aiban-result → result-db / alarm / api-output
          ├── group_id = 1, scene_id = safety-monitor
          │     ↓
          │   子流程：monitor / timer / state / socket / alarm
          └── group_id = N, scene_id = ...
                ↓
              子流程：对应场景业务编排
```

### 3.0 配置源边界

`main-flow.yaml` 是 AiBan 物理运行配置源，Node-RED 是业务逻辑编排配置源。两者分工如下：

| 配置源 | 负责内容 | 不负责内容 |
|---|---|---|
| `main-flow.yaml` | `GroupArrary`、`Sources`、`Infers`、`ModelArrary`、SDK pipeline 启动配置 | 业务顺序、计时、报警、入库、按钮场景切换 |
| Node-RED 主流程 | 启动 runtime、解析 group/model 元数据、接收外部场景选择、路由 frame | 直接操作 SDK metadata 原对象 |
| Node-RED 子流程 | 某个 `group_id + scene_id` 下的标签、顺序、状态机、副作用和审计 | 启动第二个 AiBan pipeline |

当前现场 YAML 示例：

```yaml
GroupArrary:
- groupid: 1
  groupname: group1
  groupenable: true
  Sources:
  - config: D:/product/AiBanWorkSpace/abvideo/1.yaml
  Infers:
  - modeid: 0

ModelArrary:
  Models:
  - modelid: 0
    modelpath: D:/product/AiBanWorkSpace/data/model/huayang-2.aiban
```

因此，后续业务配置的主键应统一为：

```text
runtime_id → session_id → group_id → source_id → scene_id → workflow_id → cycle_id
```

### 3.1 Node-RED 职责

- 保存并校验 Python、SDK、YAML 等运行配置。
- 创建、监控和停止 Python 子进程。
- 防止同一 Pipeline 被重复启动。
- 将控制消息写入 Python 标准输入。
- 解析 Python 标准输出中的协议事件。
- 将推理帧转换为标准 Node-RED 消息并发送给下游。
- 从 `pipelineConfig` 指向的 `main-flow.yaml` 提取 group/source/model 元数据，并在运行状态、编辑器辅助接口和路由节点中复用。
- 接收外部按钮/API 发来的场景选择消息，维护每个 group 当前激活的 `scene_id`。
- 按 `group_id + source_id + scene_id` 将 frame 分发到对应场景子流程。
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

### 3.4 group/scene 路由模型

主流程只做运行态治理和消息分发，不承载具体业务判断。路由规则：

1. 每帧必须带 `payload.group_id`、`payload.source_id` 和 `payload.stream_id`。
2. `aiban-runtime` 或主流程初始化阶段从 `main-flow.yaml` 建立 group 清单，只允许对启用的 group 分发业务帧。
3. 外部按钮/API 发送场景选择消息，写入 Node-RED flow/global context：

```json
{
  "topic": "aiban/scene/select",
  "payload": {
    "group_id": 1,
    "scene_id": "plug-sequence",
    "mode": "exclusive"
  }
}
```

4. `exclusive` 模式下，同一 group 同一时间只激活一个业务场景。
5. `parallel` 模式保留给安环监控、后台巡检等长期并行场景；第一版优先实现 `exclusive`。
6. 未配置场景时，允许落到 `group:{id}/default` 子流程，或进入明确的“未路由”诊断输出。

路由后的消息必须补齐：

```json
{
  "aiban": {
    "group_id": 1,
    "source_id": 1,
    "scene_id": "plug-sequence"
  },
  "workflow": {
    "workflow_id": "group1/plug-sequence"
  }
}
```

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
| `enableGroupMetadata` | 是否从 `main-flow.yaml` 提取 group/source/model 元数据，默认开启 |
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

`aiban-runtime` 必须把 YAML 元数据作为运行态能力的一部分输出或提供查询：

- `runtime_ready.payload.groups` 不得继续写死为 `[1]`，必须从 `GroupArrary` 提取。
- 每个 group 至少包含 `group_id`、`group_name`、`enabled`、`sources`、`infers`。
- `models` 继续从 `ModelArrary.Models[]` 和模型标签 JSON 中提取，供 label 节点编辑器选择。
- YAML 解析失败时不影响错误上报，必须给出明确 `runtime_error` 或编辑器接口 warning。

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

### 4.3 `aiban-label` 组件

每个 `aiban-label` 实例只配置**一个**标签的识别条件。多个实例通过画布连线串联
表达识别顺序，由下游 `aiban-result` 自动发现拓扑并管理状态机。

| 配置项 | 说明 |
|---|---|
| `name` | 节点名称 |
| `label_id` | 唯一标识此标签步骤（如 A, B, C），用于拓扑排序和审计日志 |
| `model_id` | 要匹配的 SDK 模型 ID |
| `label` | 标签名称，与 SDK 检测框的 label 字段精确匹配 |
| `confidence` | 最低置信度阈值（0-1），默认 0.5 |
| `frame_count` | **累计识别帧数**，默认 1（即匹配即命中） |

**`frame_count` 行为**：
- 节点为每个 stream（`group_id/source_id`）维护独立的累计匹配计数器
- 只有累计匹配帧数 >= `frame_count` 时，才在 `msg.aiban.label_matches[]` 中输出 `matched: true`
- 未达阈值时输出 `matched: false`，状态栏显示计数进度（如 `A: label … 2/3`）
- 达到阈值后计数器归零，为下一周期做准备
- 帧未匹配到该 label 时**不重置**计数器（累计模式，非连续模式）

**输出**：每帧追一条匹配记录到 `msg.aiban.label_matches[]`：

```json
{
  "node_id": "<Node-RED node id>",
  "label_id": "A",
  "model_id": "1",
  "label": "A",
  "confidence_min": 0.5,
  "matched": true,
  "confidence": 0.94,
  "box_index": 0,
  "boxes_scanned": 3,
  "match_duration_ms": 0.03,
  "frame_count": 3,
  "frame_count_current": 3
}
```

### 4.4 实例与资源约束

- 同一个 Node-RED 实例中，相同 Pipeline 配置默认只允许一个运行实例。
- Node-RED 节点关闭时必须注销监听器、关闭 stdin 并回收子进程。
- Deploy 时如果配置未变化，应避免无意义地重复启动 SDK。
- 配置变化时采用“停止旧进程 → 确认退出 → 启动新进程”。
- 不允许多个 Node-RED 节点同时争用同一 AiBan SDK 单例或相同摄像头资源。
- Windows 下必须验证正常退出和强制结束整个子进程树，禁止遗留孤儿进程。

### 4.5 `aiban-scene-control` / `aiban-scene-router`

阶段三新增主流程辅助组件，先实现最小可用能力，后续再做编辑器体验优化。

`aiban-scene-control` 职责：

- 接收外部按钮、HTTP API、Dashboard 或手动 inject 的场景切换消息。
- 校验 `group_id`、`scene_id`、`mode`。
- 将当前激活场景写入 flow/global context。
- 输出场景切换审计消息，便于现场追溯谁在什么时候切换了哪个 group。

输入契约：

```json
{
  "topic": "aiban/scene/select",
  "payload": {
    "group_id": 1,
    "scene_id": "plug-sequence",
    "mode": "exclusive",
    "operator": "button-1"
  }
}
```

`aiban-scene-router` 职责：

- 接收 `aiban-runtime` 第一输出口的 frame。
- 读取 frame 的 `group_id/source_id`。
- 读取当前 group 激活的 `scene_id`。
- 将 frame 路由到对应输出口、link out 或子流程入口。
- 对未启用 group、未配置 scene、未知 scene 给出诊断输出，禁止静默吞帧。

第一版路由形态建议：

```text
aiban-runtime
  → aiban-scene-router
      → link out: group1/plug-sequence
      → link out: group1/safety-monitor
      → link out: group2/default
      → debug/error: unrouted
```

### 4.6 场景子流程入口约定

每个场景子流程应有统一入口，入口后的业务节点仍可复用阶段二已完成组件：

```text
link in / aiban-scene-entry
→ aiban-label / workflow-sequence / timer / state / monitor
→ aiban-result
→ result-db / alarm / socket / api-output
```

子流程命名建议：

```text
group1/default
group1/plug-sequence
group1/safety-monitor
group2/default
```

`aiban-result` 的拓扑编译需要支持子流程入口：

- 入口类型除 `aiban-runtime`、`inject` 外，新增支持 `link in` 或 `aiban-scene-entry`。
- 截图请求优先使用 `msg.aiban.runtime_id` 查找 runtime；找不到时允许降级为无截图结果。
- 状态隔离键从 `(workflow_id, session_id, group_id, source_id)` 扩展为逻辑上包含 `scene_id`，推荐通过 `workflow_id = group/scene` 实现。

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
    "group_id": 1,
    "source_id": 1,
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

`runtime_ready.payload` 必须包含从 `main-flow.yaml` 提取的 group 元数据：

```json
{
  "groups": [
    {
      "group_id": 1,
      "group_name": "group1",
      "enabled": true,
      "sources": [
        {"source_index": 1, "config": "D:/product/AiBanWorkSpace/abvideo/1.yaml"}
      ],
      "infers": [
        {"model_id": 0, "use_roi_image": false}
      ]
    }
  ],
  "sources_per_group": {"1": [1]},
  "models_loaded": ["0"]
}
```

当前 `python_runtime/aiban_runner.py` 中 `groups: [1]` 仍是临时值，阶段三必须修正为真实 YAML 解析结果。

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

状态：**已完成**。阶段一已交付 `python_runtime/`、`aiban-runtime` 节点、Mock SDK 自动化测试、
真实 SDK 现场验证和阶段一测试报告。后续阶段不得重新引入 Python 主动连接 Node-RED 的 ZMQ
主链路。

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

状态：**收尾**。阶段二已完成以下核心交付：

- `aiban-label.js/.html`：独立标签组件，支持 model_id + label + confidence + **frame_count**
- `aiban-result.js/.html`：拓扑驱动状态机（自动发现连线拓扑、OK/NG/TIMEOUT/INTERRUPTED 判定）
- `aiban-result-db.js/.html`：通过 `result_event_id` 幂等写入 MySQL
- `lib/flow-runtime.js`：`TopologyCompiler`（拓扑编译）+ `FlowRuntime`（状态机引擎）
- `lib/workflow-state-store.js`：SQLite 状态持久化（跨 Node-RED 重启恢复）
- `lib/workflow-audit.js`：审计日志（text + JSONL + CSV）
- `examples/abc-sequence-flow.json`：入口为 `aiban-runtime` 的完整示例 flow
- `test/phase2-closed-loop.test.js`：27 个测试全部通过

2026-07-07 更新：

1. **`aiban-label` 新增 `frame_count`**：累计识别帧数阈值，默认 1（向后兼容）。达到阈值后才输出
   `matched: true`，用于过滤偶发误识别。
2. **正式移除 `aiban-frame-input`**：删除 `frame-input-node.js/.html`，更新 `package.json`、
   `flow-runtime.js`（入口类型识别）、`aiban-label.html`、`aiban-result.html`（help text）、
   `aiban-result.js`（注释）中的相关引用。
3. **新增测试**：`TopologyCompiler frameCount` 校验 + `Scenario 15: frame_count threshold`
   端到端行为验证。

流程：

```text
aiban-runtime
→ 标签 A
→ 标签 B
→ 标签 C
→ result
→ result-db
```

阶段二启动前必须先完成以下文档和契约更新：

1. 更新 `docs/PHASE2_MESSAGE_CONTRACT.md`，以 `aiban-runtime` 输出的 `msg.payload` 和
   `msg.aiban` 为唯一输入契约。
2. 更新 `node-red-contrib-aiban-workflow/examples/abc-sequence-flow.json`，将入口节点从
   `aiban-frame-input` 替换为 `aiban-runtime`。
3. 补齐 `aiban-label → aiban-result → aiban-result-db` 的字段保留规则、幂等键和错误输出约定。
4. 明确旧阶段二测试中可复用的状态机/写库测试，以及必须废弃的 ZMQ/Inbox 断言。
5. 在功能对等矩阵中把阶段二相关能力标为“迁移中”，待 Mock SDK 与真实 SDK 闭环通过后再标为完成。

原则：

- 每个标签是独立组件，只配置自己的匹配条件。
- A、B、C 顺序由 Node-RED 连线表达。
- 改变连线即可改变执行顺序，不维护第二份 `steps` 数组。
- 实现 OK、NG、TIMEOUT、乱序、跳步、幂等和状态隔离。
- 复用当前阶段二代码前必须重新核对其输入契约，移除对旧
  `aiban-frame-input`、Inbox 和 ZMQ 字段的强依赖。

完成条件：

- ✅ Mock SDK 闭环全自动化测试通过（27 tests）。
- ⬜ 真实 SDK 闭环验证。
- ✅ 仅改变画布连线即可改变识别顺序（`TopologyCompiler` 自动发现）。
- ✅ 最终结果可幂等写入 MySQL（`result_event_id` UNIQUE）。
- ✅ 有组件级日志和端到端处理耗时（`WorkflowAuditLogger` text/JSONL/CSV）。
- ✅ `frame_count` 阈值过滤，状态栏显示计数进度。
- ✅ `aiban-frame-input` 正式移除，`aiban-runtime` 为唯一入口。
- ⬜ 阶段二测试报告记录 Mock SDK、真实 SDK、MySQL 写库和异常路径结果。

## 阶段 3：主流程与 group/scene 子流程重构

状态：**待启动**。这是 2026-07-08 方向修正后的下一阶段。

目标：将 `aiban-runtime` 固定为主流程入口，把 `main-flow.yaml` 中的 group 作为一级运行域，把按钮/API 选择的 scene 作为二级业务入口。阶段二 A-B-C 闭环迁移为第一个场景子流程样板。

任务：

1. 在 `aiban-runtime` 或共享库中解析 `main-flow.yaml` 的 `GroupArrary`、`Sources`、`Infers`、`ModelArrary`。
2. 修正 `runtime_ready.payload.groups`，移除 `groups: [1]` 临时写死逻辑。
3. 新增或实现等价的 `aiban-scene-control`，接收外部按钮/API 场景切换消息。
4. 新增或实现等价的 `aiban-scene-router`，按 `group_id + scene_id` 分发 frame。
5. 调整 `aiban-result` 的 `TopologyCompiler`，支持 `link in` / `aiban-scene-entry` 作为子流程入口。
6. 将当前 A-B-C 示例拆成 `group1/plug-sequence` 子流程，主流程只保留 runtime、状态、路由和诊断。
7. 为未路由 frame、未知 group、未知 scene、禁用 group 建立明确错误输出和审计日志。
8. 增加自动化测试：YAML group 解析、场景切换、exclusive 路由、未路由诊断、子流程拓扑发现。
9. 更新 `node-red/flows.json` 与 `examples/abc-sequence-flow.json`，展示主流程 + 子流程的新画布结构。

完成条件：

- `main-flow.yaml` 中启用的 group 能在 `runtime_ready` 和编辑器辅助接口中真实显示。
- 外部按钮/API 可以切换 `group_id=1` 的当前 `scene_id`。
- `aiban-runtime` 发出的 frame 根据 `group_id + scene_id` 进入对应子流程。
- A-B-C 逻辑在 `group1/plug-sequence` 子流程内保持阶段二行为不退化。
- 未配置或不可路由的 frame 不静默丢弃，必须进入诊断输出。
- 自动化测试覆盖主流程路由和子流程入口拓扑编译。

## 阶段 4：迁移全部业务逻辑组件

依据 `WORKFLOW_DOC.md` 和功能对等矩阵，在阶段三路由骨架上逐项实现：

- camera/group/source 过滤。
- 主模型和二阶模型标签匹配。
- counter、duration、N 帧累计。
- timer、state、condition、reset。
- sequence、monitor、cycle-record。
- 1.0 custom_flow/state_machine。
- 多 group、多 scene 的状态隔离与默认场景。
- 受控 Python handler 兼容机制及退出计划。

迁移期间采用同一输入数据双跑，对比 1.0 与 2.0 的状态、步骤、超时和最终结果。

## 阶段 5：迁移副作用组件

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

## 阶段 6：运行管理

- Node-RED、Python、AiBan 的统一健康状态。
- group/scene 当前激活状态、切换记录和运行看板。
- 流程版本、备份、回滚和 Deploy 策略。
- 统一日志、错误码、指标和运行页面。
- 配置文件化和凭据管理。
- 安装包、启动方式和现场运维脚本。

## 阶段 7：切换与发布

发布前必须：

1. 功能对等矩阵全部通过。
2. 现网真实流程完成 1.0/2.0 双跑。
3. 完成稳定性、压力、故障恢复和回退演练。
4. 默认入口切换为 Node-RED。
5. 现场 group/scene 子流程完成验收。
6. 停用独立 `main.py → ZMQ → Node-RED` 主链路。
7. 评审后删除或归档旧 ZMQ、Outbox、Inbox 代码。
8. 发布 `v2.0.0`。

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

阶段二至少交付：

```text
docs/
├── PHASE2_MESSAGE_CONTRACT.md          # 新阶段二 runtime 输入契约
└── TEST_REPORT_V2_PHASE_2.md           # 新阶段二测试报告

node-red-contrib-aiban-workflow/
├── aiban-label.js/.html                # 独立标签组件 (model_id + label + confidence + frame_count)
├── aiban-result.js/.html               # A-B-C 拓扑状态机 (TopologyCompiler + FlowRuntime)
├── aiban-result-db.js/.html            # result_event_id 幂等写库 (MysqlWriteQueue)
├── lib/flow-runtime.js                 # 拓扑编译 + 状态机引擎
├── lib/workflow-state-store.js         # SQLite 状态持久化
├── lib/workflow-audit.js               # 审计日志 (text + JSONL + CSV)
├── examples/abc-sequence-flow.json     # 入口为 aiban-runtime 的完整示例
├── test/phase2-closed-loop.test.js     # 27 测试 (含 frame_count 场景)
└── test/aiban-runtime*.test.js         # 54 测试 (Phase 1 runtime + node)

已移除：
├── frame-input-node.js/.html           # 旧 ZMQ 入口 (已删除)
```

同时更新：

- `README.md` 当前阶段与启动说明。
- `docs/WORKFLOW_1_0_PARITY_MATRIX.md` 阶段二相关状态。
- `docs/LEGACY_ZMQ_MIGRATION.md` 阶段一验收后的旧代码处置策略。
- MySQL schema 或唯一键说明，确保 `result_event_id` 幂等。

阶段三至少交付：

```text
node-red-contrib-aiban-workflow/
├── lib/pipeline-yaml.js                 # main-flow.yaml group/model 解析（或等价共享模块）
├── aiban-scene-control.js/.html          # 场景选择入口（按钮/API 可驱动）
├── aiban-scene-router.js/.html           # group_id + scene_id 路由
├── test/pipeline-yaml.test.js            # YAML group/model 解析测试
├── test/scene-router.test.js             # 场景路由测试
└── examples/group-scene-flow.json        # 主流程 + 子流程示例

node-red/
└── flows.json                            # 当前开发流调整为主流程/子流程结构
```

同时更新：

- `docs/AIBAN_RUNTIME_PROTOCOL.md`：补充 `runtime_ready.payload.groups` 结构。
- `docs/PHASE2_MESSAGE_CONTRACT.md`：补充 `scene_id`、`workflow_id = group/scene` 和子流程入口约定。
- `README.md`：更新当前推荐画布结构和场景按钮切换方式。
- `WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md`：记录阶段三验收结果。

---

## 12. Git 与实施规则

1. 开发前检查当前分支、未提交修改和最近提交。
2. 不覆盖用户已有修改，不将无关文件混入提交。
3. 每次只完成一个可验证任务。
4. 协议、生命周期和异常分支必须先有测试。
5. 每完成一个任务，记录修改文件、验证命令、测试结果和已知风险。
6. 阶段二验收前不删除旧架构主链路代码；可先清理阶段一验收后明确无用的测试产物。
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

已完成的项（✅）：

1. ✅ 冻结 `docs/PHASE2_MESSAGE_CONTRACT.md` 作为阶段二输入/输出契约。
2. ✅ 更新 A-B-C 示例 flow，入口切换到 `aiban-runtime` 第一输出端口。
3. ✅ 复核 `aiban-label` 输入读取逻辑，改为扫描 `msg.payload.models[*].boxes[*]`。
4. ✅ 复核 `aiban-result` 拓扑发现、状态隔离、TIMEOUT/NG/跳步逻辑。
5. ✅ 复核 `aiban-result-db` 幂等键，统一使用 `abc_result.result_event_id`。
6. ✅ 迁移 `phase2-closed-loop.test.js`（27 tests），移除旧 ZMQ/Inbox 断言。
7. ✅ 使用 Mock SDK 完成 `runtime → label A/B/C → result → result-db` 闭环。
8. ✅ `aiban-label` 新增 `frame_count` 累计识别帧数阈值。
9. ✅ 正式移除 `aiban-frame-input`（`frame-input-node.js/.html` 删除）。
10. ✅ 更新 `flow-runtime.js` TopologyCompiler，移除 frame-input 入口类型、新增 frameCount 传递。

待完成的项（⬜）：

11. ⬜ 使用真实 SDK 完成 A-B-C 闭环和 MySQL 写库验证。
12. ⬜ 更新 `docs/TEST_REPORT_V2_PHASE_2.md`（记录真实 SDK 和异常路径结果）。
13. ⬜ 解析 `main-flow.yaml` 的 `GroupArrary`，修正 `runtime_ready.payload.groups`，移除 `groups: [1]` 临时写死。
14. ⬜ 设计并实现 `aiban-scene-control` / `aiban-scene-router` 的最小可用版本。
15. ⬜ 调整 `aiban-result` 拓扑发现，支持 `link in` / `aiban-scene-entry` 子流程入口。
16. ⬜ 将当前 A-B-C 示例流拆成 `主流程 runtime/router + group1/plug-sequence 子流程`。
17. ⬜ 补充 group/scene 路由自动化测试和示例 flow。
18. ⬜ 阶段二/三验收后，评审删除 `core/frame_bridge/` 其余文件和 `lib/frame-inbox.js` 的范围。

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
12. `main-flow.yaml` 的 `GroupArrary` 是现场物理分组配置源，Node-RED 业务流程必须尊重 `group_id` 边界。
13. 主流程只负责 runtime 生命周期、group 元数据、场景选择和 frame 路由；具体业务逻辑必须放入 group/scene 子流程。
14. 外部按钮/API 只改变 `scene_id`，不得直接绕过 runtime 管理去启动/停止 SDK pipeline。
15. A-B-C 拓扑闭环应沉淀为第一个场景子流程样板，而不是长期放在主流程里。
16. 1.0 全部现用功能完成对等迁移和现场验证后，才允许发布 2.0。
