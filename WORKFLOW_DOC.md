# AiBan 工作流引擎 — 代码框架说明

> 本文档作为与 AI 协作时的代码框架基准，描述整个系统的运行结构、模块职责、工作流 JSON 规范及 Node-RED 导出关系。

---

## 一、整体进程模型

`main.py` 是唯一启动入口，启动后产生三个并发单元：

```
主进程（main.py）
├── Process: videowork   ← 视频推理 + 工作流引擎
├── Process: videoalarm  ← 报警写库 + socket 发送
└── Thread:  Flask       ← Web API（icameraapi，daemon 线程）
```

进程间通信：
- `video_pipe / alarm_pipe`：`Pipe()`，主进程发送 `True` 信号通知子进程停止
- `alarm_queue`：`Queue()`，`videowork` 向 `videoalarm` 投递 `alam_msg` 报警对象
- `tool_io_queue`：`Queue()`，预留工具 IO 通道，当前未使用

硬编码路径（部署时按实际修改，修改后需重新打包）：

```python
# main.py 第 135-136 行
'D:/product/AiBanWorkSpace/config.ini'
'D:/product/AiBanWorkSpace/abvideo/main-flow.yaml'
```

---

## 二、核心模块职责

### core/infra.py

- `MyLogger`：基于 `QueueHandler + QueueListener + TimedRotatingFileHandler` 的异步日志，按天切割，保留 30 天
- `global_sys_logger`：全局日志实例，日志写到 `log/abvideologs/vido_main.log`
- `api_trigger_logger`：API 触发器专用日志实例，日志写到 `log/apitriggerlogs/api_trigger.log`，只记录入站 HTTP 请求（method/path/headers/body）与匹配分发结果，不与主日志混写
- `alam_msg`：报警消息数据类，字段含义：

| 字段 | 说明 |
|------|------|
| `groupid` | 摄像头群组 ID |
| `sourceid` | 摄像头源 ID |
| `who` | 报警类型（如 `"ng"`、`"ok"`）；`"manual_test"` 表示手动触发测试，跳过 DB 写库和 API 输出 |
| `led` | LED 状态（当前引擎传 `None`） |
| `speak` | 扬声器状态：`1` = speak_on，`0` = speak_off，`None` = 不触发 socket |
| `msg1` | 区域名称（region name） |
| `msg2` | 报警内容文字 |
| `msg3` | 图片路径（原始路径，含 `D:/product` 前缀） |
| `table` | 写入的数据库表名，为 `None` 时用默认表 |

### core/video_process.py

提供两个进程函数供 `main.py` 启动：

- `videowork(p, msgqueue, toolqueue, userconfig, piplieconfig)`：创建 `AibanVideoProcess`，运行视频推理，阻塞在 `Pipe.recv()` 等待停止信号；退出时调用 `AibanVideoProcess.stop()` 停止 SDK pipeline 和 workflow-watcher 线程
- `videoalarm(p, msgqueue, toolqueue)`：创建 `AibanVideoAlarm`，消费 `alarm_queue`，阻塞等待停止信号
- `_load_socket_cfg()`：启动时扫描 `workflows/*.json`，合并 `socket_server`（取第一个）、`socket_clients` 和 `api_outputs`（均全部合并），传给 `AibanVideoAlarm`

### core/video_logic.py — AibanVideoProcess

视频推理进程的核心类：

1. 创建 `WorkflowEngine`，注入三个回调：
   - `alarm_fn = self._engine_alarm`：把引擎报警封装成 `alam_msg`，投入 `alarm_queue`
   - `save_db_fn = self._engine_save_db`：JSON 未配置 `db` 块时的兜底（打日志，不写库）
   - `region_fn = self.region_name`：懒加载区域名称，来自 `icameraapi.icamera.tool.regionname`
2. 调用 `engine.load_dir(workflows/)` 加载所有工作流
3. 启动 **workflow-watcher** 线程：每 5 秒检测 `workflows/` 目录文件变动，变更则自动热重载（不需要重启进程）
4. 注册 `aibanvideometadataresult_callback` 到 `AiBanVideoPy`，每帧推理结果触发后调用 `engine.on_frame(camera_key, groupid, sourceid, metadata)`
5. 注册 `_video_msg_event_callback` 到 `AiBanVideoPy`，把 SDK 事件统一写入 `global_sys_logger`
6. 收到进程停止信号或异常退出时调用 `stop()`：设置 workflow-watcher 停止标志、调用 SDK `stopPipline()`，并等待 watcher 线程结束

视频推理 SDK 接口（来自 `libAiBanVideoPy3_9`，路径 `D:/product/AiBanWorkSpace/`）：

| 方法 | 说明 |
|------|------|
| `aibanVideoGetInstance()` | 获取视频实例 |
| `registerVideoResultFunc(cb)` | 注册每帧推理结果回调，签名 `(err, groupid, sourceid, metadata)` |
| `registerVideoMsgEventFunc(cb)` | 注册 SDK 事件回调，当前接入 `_video_msg_event_callback` 写系统日志 |
| `registerVideoSaveImageFunc(cb)` | 注册保存图片回调（当前未使用） |
| `checkAllConfig(yaml_path)` | 加载 pipeline 配置 |
| `buildPipline()` | 启动推理 pipeline（阻塞） |
| `stopPipline()` | 停止推理 pipeline，`videowork` 退出时主动调用 |
| `sourceControl(group_id, source_id, b_run)` | 控制单路视频源启停（当前未使用） |
| `metadata.getAllModelInferBoxes()` | 一次性获取所有模型输出结果，返回 `{model_id: (err, [box])}`（当前未使用） |
| `metadata.getModelInferBoxs(model_id)` | 取指定模型的推理框列表，返回 `(err, [box])` |
| `box.getLabelName()` | 框的标签名 |
| `box.getConfidence()` | 框的置信度 |
| `box.getPolygon()` | 框的多边形点列表 |
| `box.getInferBoxWithModelID(sub_id)` | 在父框内取二阶模型子框，返回 `(err, [box])` |
| `metadata.saveImage(flag)` | 保存当前帧截图 |
| `metadata.getSaveImagePath()` | 获取已保存截图的路径 |
| `metadata.getTimeFlagDatetime()` | 获取当前帧时间标识（当前未使用） |

### core/alarm_db.py — AibanVideoAlarm

报警进程的核心类：

- 消费 `alarm_queue`，从 `alam_msg` 提取字段写入 MySQL `icam_alarm_data` 表（12 列固定结构）
- 报警固定写为 `alarm_status = 'NG'`（工作流引擎的 `save_db` 动作才能写 OK 状态）
- 支持 socket 发送：从 `alam_msg.speak` 判断发送 `speak_on` / `speak_off` 指令，每次发送均写入 `vido_main.log`，标签为 `[语音播报]`（正常报警）或 `[手动触发]`（手动测试）
- `alam_msg.who == "manual_test"` 时识别为手动触发测试：跳过 DB 写库和 API 输出，仅发送喇叭指令并记录日志
- 支持 API 输出：报警时按 `api_outputs` 配置（`group_id`/`sourceid` 匹配）在后台线程发起签名 POST，`ngcode=msg2`、`ngarea=msg1`，格式同 `api.py`，失败只打日志不中断主循环
- DB 使用懒连接 + 断线重连（最多重试 2 次）
- socket 服务器在 `_server_address` 不为空时独立线程启动，接受外部客户端连接

### 手动触发喇叭测试

系统提供了手动触发喇叭的测试通道，用于现场调试扬声器设备：

**Flask API 端点** `POST /aiban/speaker/test`（端口 9090）：

| 参数 | 必填 | 说明 |
|------|------|------|
| `sourceid` | 是 | 摄像头 ID，用于查找对应 socket 客户端配置 |
| `group_id` | 否 | 群组 ID，默认 1 |
| `speak_type` | 否 | `"on"`（默认，发送 speak_on）或 `"off"`（发送 speak_off） |

请求示例：
```bash
curl -X POST http://127.0.0.1:9090/aiban/speaker/test \
  -H "Content-Type: application/json" \
  -d '{"sourceid": 1, "speak_type": "on"}'
```

**Node-RED 触发**：`socket-client` 节点编辑界面提供两个手动测试按钮——「🧪 测试播报 (Speak ON)」和「测试关闭 (Speak OFF)」，点击后通过 Node-RED 代理（`POST /aiban/speaker/test`）转发到 Flask。成功/失败有颜色反馈，提示查看 `vido_main.log`。

**日志输出**：手动触发会产生以下日志（`vido_main.log`）：
```
[手动触发] 收到喇叭测试请求: sourceid=1 groupid=1 speak=1(on)
[手动触发] 测试消息已入队 sourceid=1 speak=1
[手动触发] sourceid=1 播报开启 alarm=喇叭手动测试播报 target=192.168.5.10:12345 cmd=AT+TTS1=...
[手动触发] sourceid=1 语音指令已发送
```

### core/workflow_engine.py — WorkflowEngine

工作流引擎入口，负责：

1. `load_dir(dir)` / `load(file)`：加载 JSON，解析 `db`、`socket_server`、`socket_clients`、`workflows` 字段，为每个 workflow 创建 `(wf_def, db_cfg)` 元组；同时收集顶层 `api_server` 和 `api_triggers`
2. `on_frame(camera_key, groupid, sourceid, metadata)`：每帧分发给该摄像头下所有 runner
3. `on_event(camera_key, groupid, sourceid, event)`：把外部 API 事件分发给实现了 `on_event` 的 runner（当前为 `SequenceRunner`）
4. `handle_api_request(method, path, headers, raw_body)`：HTTP 入口，匹配 trigger、校验认证、提取字段后调用 `on_event`，返回响应
5. `get_api_server_config()`：返回当前生效的 API 服务监听配置，`video_logic.py` 据此启停 `ThreadingHTTPServer`
6. `_init_runners(camera_key)`：第一次遇到某 camera_key 时按 mode 创建对应 runner

内置 Runner 和对应 mode：

| mode 值 | Runner 类 | 说明 |
|---------|-----------|------|
| `custom_flow` | `StateMachineRunner` | 用户自定义状态机流程 |
| `state_machine` | `StateMachineRunner` | 旧值兼容，行为同 `custom_flow` |
| `timer_record` | `TimerRecordRunner` | 计时工时 |
| `sequence` | `SequenceRunner` | 步骤顺序检测 |
| `monitor` | `MonitorRunner` | 安环持续监控 |
| `python` | `PythonRunner` | **接入纯 Python 业务代码**（每摄像头一个 handler 实例，见第四节·模式五） |

---

## 三、工作流 JSON 结构

工作流文件位于 `workflows/`，按 group 分文件：

```
workflows/
├── group_1.json    ← group_id=1 的所有工作流
├── group_2.json    ← group_id=2 的所有工作流
└── group_N.json
```

规则：
- 每个 JSON 文件对应一个 group，命名规范 `group_{N}.json`
- 启动时引擎加载 `workflows/*.json` 所有文件；workflow-watcher 每 5 秒检测变动，自动热重载
- 同一文件可含多个 workflow 对象（`workflows` 数组）

### 顶层结构

```json
{
  "db": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "root",
    "password": "root",
    "charset": "GB2312",
    "alarm_table": "icamera_data.icam_alarm_data"
  },
  "socket_server": {
    "host": "172.16.27.196",
    "port": 10000,
    "encoding": "gbk"
  },
  "socket_clients": [
    {
      "sourceid": 1,
      "host": "192.168.1.100",
      "port": 2000,
      "encoding": "gbk",
      "commands": {
        "speak_on":  { "hex": "000500070000400301E4E4" },
        "speak_off": { "tts": "AT+TTS1=1,0,1,1,50\r\n请注意..." }
      }
    }
  ],
  "api_server": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 18080,
    "max_body_bytes": 1048576
  },
  "api_triggers": [
    {
      "id": "printer_complete",
      "name": "打印完成回调",
      "enabled": true,
      "group_id": 1,
      "sourceid": 1,
      "method": "POST",
      "path": "/aiban/api-trigger/printer_complete",
      "auth": { "type": "none" },
      "request": {
        "content_type": "json",
        "payload_mappings": {
          "printJobId":     "body.printJobId",
          "printerName":    "body.printerName",
          "printTimestamp": "body.printTimestamp"
        }
      },
      "event": {
        "type": "step_hit",
        "target_step_id": "printer_complete",
        "ttl_seconds": 5,
        "count": 1
      },
      "response": {
        "status": 200,
        "body": { "status": "200", "errmsg": "" }
      }
    }
  ],
  "api_outputs": [
    {
      "group_id": 1,
      "sourceid": 1,
      "appid": "202502170000000001",
      "appsecret": "32f35d31e868f680240de2cf7894c18e",
      "url": "http://172.17.24.181:6090/core/api/openapi/msg/send-channel-open"
    }
  ],
  "workflows": [ { ... }, { ... } ]
}
```

顶层字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `db` | 否 | MySQL 连接配置，配置后引擎内 `save_db` 直接写库；省略则 `save_db` 走兜底（打日志丢弃） |
| `db.alarm_table` | 否 | `alarm` 动作写入的默认表名 |
| `socket_server` | 否 | TCP 服务器，整个项目只需配置一次（`_load_socket_cfg` 取第一个出现的） |
| `socket_clients` | 否 | 按 sourceid 绑定扬声器配置，`_load_socket_cfg` 合并所有 group 文件的条目 |
| `api_server` | 否 | 入站 API 触发服务监听配置，仅当存在 `api_triggers` 时启用，详见第十节 |
| `api_triggers` | 否 | 外部系统（MES/PLC 等）通过 HTTP 推进 sequence 步骤的触发器列表，详见第十节 |
| `api_outputs` | 否 | 报警附加输出：报警发生时把结果通过 HTTP API 推送给外部系统（格式同 `api.py`），详见 9.6 |

`socket_clients` 单条字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `sourceid` | 是 | 摄像头 sourceid，与 `alam_msg.sourceid` 对应 |
| `host` | 是 | 扬声器 IP |
| `port` | 是 | 扬声器端口 |
| `encoding` | 否 | 覆盖全局 `socket_server.encoding`，默认继承 |
| `commands.speak_on` | 否 | `alam_msg.speak == 1` 时发送 |
| `commands.speak_off` | 否 | `alam_msg.speak == 0` 时发送 |

command 支持 `hex`（十六进制字节流）和 `tts`（文本按 encoding 编码），可同时存在，依次发送。

`api_outputs` 单条字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `appid` | 是 | 接口 appid，同时用作请求体的 `channelCode` |
| `appsecret` | 是 | 用于生成 `appsign = md5(appid + timestamp + appsecret)`，默认 `32f35d31e868f680240de2cf7894c18e` |
| `url` | 是 | 推送目标地址 |
| `group_id` | 否 | 只对该 group 的报警推送；省略视为通配 |
| `sourceid` | 否 | 填了则只对该摄像头的报警推送；留空则对该 group 所有报警推送 |

> `ngcode` / `ngarea` 不在配置里：运行时由 `alarm_db.py` 自动填充 —— `ngcode` 取报警内容（`alam_msg.msg2`），`ngarea` 取区域（`alam_msg.msg1`）。请求体格式同 `api.py`：`{ "channelCode": appid, "args": { "address": ngarea, "code": ngcode } }`，在后台线程发送，不阻塞报警消费循环。

### 每个 workflow 对象必填字段

| 字段 | 说明 |
|------|------|
| `name` | 名称，仅用于日志 |
| `mode` | 工作流模式，见下方四种模式 |
| `group_id` | 只处理此 groupid 的推理帧 |
| `model_id` | **默认**一阶模型 ID（对应 `metadata.getModelInferBoxs(model_id)`），可被下方各 rule/step/scan 单独覆盖 |

---

## 四、四种工作流模式

### 模式一：custom_flow（用户自定义流程）

对应 `StateMachineRunner`，旧值 `state_machine` 同样有效。

适用：无法用 timer_record / sequence 直接表达的复杂逻辑，通过状态、条件、变量、计时器手动组合流程。

#### 结构

```json
{
  "name": "自定义检测",
  "mode": "custom_flow",
  "group_id": 1,
  "model_id": 1,
  "vars": { ... },
  "timers": { ... },
  "states": [ ... ]
}
```

#### vars 变量声明

```json
"vars": {
  "hit_count": { "type": "counter" },
  "done":      { "type": "bool", "default": false },
  "move":      { "type": "tracker" }
}
```

| type | 操作 actions | 在 when 表达式中 |
|------|-------------|----------------|
| `counter` | `inc`, `reset` | `hit_count.get() >= 3` |
| `bool` | `set`, `reset` | `done.get()` / `not done.get()` |
| `tracker` | `track`（在 on_found 中），`reset` | `move.get().total_movement > 500` |

tracker 可用属性：

| 属性 | 说明 |
|------|------|
| `.total_movement` | 累计移动像素距离 |
| `.was_tracking` | 上一帧是否在追踪 |
| `.detected_this_frame` | 本帧是否检测到 |
| `.start_pt` | 起始坐标 `(x, y)` |
| `.last_pt` | 最新坐标 `(x, y)` |

#### timers 计时器声明

```json
"timers": {
  "process_timer": { "timeout": 5.0 }
}
```

- `timeout`：超时秒数，超时触发 `on_timer_expire`；省略表示只用作计时，无自动超时
- 计时器自动加入 vars，可在 actions / when 中直接用名字引用

#### states 状态定义

```json
"states": [
  {
    "id": "idle",
    "scan": [
      {
        "label": "start",
        "confidence": 0.8,
        "on_found": [ { "inc": "hit_count" }, { "start_timer": "process_timer" } ],
        "on_absent": []
      }
    ],
    "on_timer_expire": {
      "timer": "process_timer",
      "checks": [
        {
          "when": "not done.get()",
          "alarm": { "msg": "超时未完成", "type": "ng", "save_image": true, "cooldown": 2 }
        }
      ],
      "actions": [ { "reset": ["process_timer", "hit_count", "done"] } ]
    },
    "transitions": [
      {
        "when": "hit_count.get() >= 3",
        "goto": "running",
        "log": "进入 running 状态"
      }
    ]
  }
]
```

执行顺序（每帧）：
1. `scan`：遍历推理框，命中 label 执行 `on_found`，未命中执行 `on_absent`
2. 计时器超时检查：触发 `on_timer_expire.checks`（逐条判断 when，不互斥），再执行 `on_timer_expire.actions`
3. `transitions`：从上到下匹配，执行第一个满足 `when` 的规则后跳转，**每帧只匹配一条**

注意：`transitions` 里的 `alarm` 在 `actions` 和 `log` 执行**之后**触发，然后再 `goto`。

---

### 模式二：timer_record（计时工时）

对应 `TimerRecordRunner`。

识别 start label → 开始计时；识别 end label → 停止并存库。

#### 结构

```json
{
  "name": "工时统计",
  "mode": "timer_record",
  "group_id": 1,
  "model_id": 1,
  "timers": { "work_timer": {} },
  "absence_tracking": { ... },
  "rules": [
    {
      "id": "detect_start",
      "on_label": { "name": "start", "confidence": 0.8 },
      "actions": [ { "start_timer": "work_timer" }, { "log": "计时开始" } ]
    },
    {
      "id": "detect_end",
      "on_label": { "name": "end", "confidence": 0.8 },
      "require_timer_running": "work_timer",
      "actions": [
        { "stop_timer": "work_timer" },
        { "save_db": { "table": "work_hours", "fields": {
            "camera_id":  "$camera_id",
            "duration":   "$work_timer.elapsed",
            "start_time": "$work_timer.start_time",
            "end_time":   "$now"
        }}},
        { "reset": "work_timer" }
      ]
    }
  ]
}
```

- `require_timer_running`：守卫，只有指定计时器在运行中时此 rule 才触发，防误触
- 同一 rule **每帧最多触发一次**（匹配到第一个满足条件的 box 即 break）

#### 离岗追踪（absence_tracking）

```json
"absence_tracking": {
  "enabled": true,
  "person_label": "person",
  "confidence": 0.5,
  "require_timer_running": "work_timer",
  "accum_var": "absence_timer"
}
```

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | 是 | — | `true` 启用 |
| `person_label` | 否 | `"person"` | 人员标签名 |
| `confidence` | 否 | `0.5` | 人员检测置信度 |
| `require_timer_running` | 否 | — | 守卫计时器，工位计时运行期间才追踪 |
| `accum_var` | 否 | `"absence_timer"` | 离岗累积计时器变量名，`save_db` 中用 `$absence_timer.elapsed` 读取 |

行为：人员消失 → 开始累积离岗时长；重新出现 → 暂停；守卫计时器停止 → 自动停止并重置。

---

### 模式三：sequence（步骤顺序检测）

对应 `SequenceRunner`。

按声明顺序检测 label，全部完成为 OK；跳步或超时为 NG。

#### 结构

```json
{
  "name": "操作步骤检测",
  "mode": "sequence",
  "group_id": 1,
  "model_id": 1,
  "timers": { "step_timeout": { "timeout": 30.0 } },
  "sequence": {
    "ordered": true,
    "timeout_timer": "step_timeout",
    "steps": [
      { "id": "s1", "label": "step1", "confidence": 0.8 },
      { "id": "s2", "label": "step2", "confidence": 0.8, "duration": 1.5 },
      { "id": "s3", "label": "screw", "confidence": 0.8, "count": 8, "alarm_name": "螺丝漏锁" },
      { "id": "s4", "label": "end",   "confidence": 0.8, "trigger": false, "end": true }
    ],
    "on_complete":    [ ... ],
    "on_incomplete":  [ ... ],
    "on_skip":        [ ... ],
    "on_wrong_count": [ ... ],
    "on_timeout":     [ ... ]
  }
}
```

步骤字段说明：

| 字段 | 说明 |
|------|------|
| `id` | 步骤唯一标识 |
| `label` | 检测的推理标签名 |
| `confidence` | 置信度阈值 |
| `duration` | 步骤需连续出现的秒数，中途消失重置计时 |
| `count` | 步骤需检测到 N 个框，数量不对在流程结束时触发 `on_wrong_count` |
| `alarm_name` | 步骤级报警名称，占位符 `{step_alarm_name}` 使用此值，未设置则退回使用 label |
| `trigger` | `false` 表示此步骤不作为新流程的开始触发器，通常用于 end 步骤 |
| `end` | `true` 表示检测到此步骤时立即结束本轮流程，触发缺失步骤检查 |
| `model_id` | 覆盖顶层 `model_id`，本 step 用指定一阶模型取 boxes |
| `sub_models` | 二阶子模型过滤，结构见五.2 节 |
| `external` | `true` 表示该步骤由外部 API trigger 命中，不走视觉框匹配；Node-RED 中勾选"API 触发"生成。默认不作为流程起点（`trigger` 默认导出为 `false`） |
| `step_code` | 工序代号，写入子表 `step_execution_log.step_config_id`，需与静态表 `icam_camera_step_config` 对齐（如 `D1`/`D2`）。仅 `cycle_record` 开启时生效，缺省退回 step `id` |

#### 生产周期主子表写库（cycle_record）

工位看板大屏由数据库事件驱动（后端 SSE 监听子表 `MAX(id)` 变化推送前端）。开启 `cycle_record` 后，sequence 模式把"一件产品的分步装配周期"落成两张表：

```json
{
  "mode": "sequence",
  "group_id": 1,
  "model_id": 1,
  "cycle_record": {
    "enabled": true,
    "master_table": "icamera_data.production_cycle_record",
    "detail_table": "icamera_data.step_execution_log"
  },
  "sequence": { "steps": [ { "id": "step1", "label": "插接1", "step_code": "D1" }, ... ] }
}
```

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | 否 | `false` | `true` 开启周期写库；关闭时行为与普通 sequence 完全一致（钩子 no-op） |
| `master_table` | 否 | `icamera_data.production_cycle_record` | 生产周期总表（主表） |
| `detail_table` | 否 | `icamera_data.step_execution_log` | 工序执行流水表（子表） |

写库生命周期（由引擎驱动，无需在 actions 里手写）：

| 时机 | 操作 | 关键字段 |
|------|------|---------|
| 流程开始（首个 trigger 步骤出现） | INSERT 主表，记录返回的自增 `cycle_id` | `result_status=0`（生产中）、`start_time`、`create_date` |
| 每个步骤完成 | INSERT 子表一行；并 UPDATE 上一条子表行补齐 `end_time`/`duration` | `cycle_id`、`step_config_id=step_code`、`start_time=该步首见时刻`、`step_result=1` |
| 流程结束 | 补齐最后一条子表行；UPDATE 主表 | `result_status`（OK→1 / NG→2）、`end_time` |

- **主表 `result_status`**：`0`=生产中，`1`=OK，`2`=NG（缺步骤 / 计数错 / 超时均判 NG）。左上角良率饼图抓此字段。
- **子表 `step_result`**：当前实现固定写 `1`（OK），底部指示灯、右下角历史表抓子表。
- **`step_config_id` 对齐契约**：写步骤代号（`D1`/`D2`），**不写中文**；系统内部接口去 `icam_camera_step_config` 翻译为工序名泵给前端。
- **每步耗时**：进入下一步前用 UPDATE 把上一子表行的 `end_time` 与 `duration`（秒，两位小数）补齐，使历史报表时长精准。
- **每摄像头隔离**：`cycle_id` 与 `_open_child_id` 都是 runner 实例级状态，多摄像头/多周期不串。

#### 人员在场检测（presence_tracking）

流程激活状态下，每帧检测指定人员标签是否在场。人员离岗后开始计时，超过设定持续时间后触发报警；若人员在报警前回归，计时自动重置。

```json
{
  "mode": "sequence",
  "group_id": 1,
  "model_id": 1,
  "presence_tracking": {
    "enabled": true,
    "person_label": "person",
    "confidence": 0.5,
    "alarm_name": "人员离岗",
    "absence_duration": 30
  },
  "sequence": { "steps": [ ... ] }
}
```

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | 是 | — | `true` 启用 |
| `person_label` | 否 | `"person"` | 人员标签名 |
| `confidence` | 否 | `0.5` | 人员检测置信度 |
| `alarm_name` | 否 | `"人员离岗"` | 离岗报警名称 |
| `absence_duration` | 否 | `30` | 离岗持续时间阈值（秒），人员离开超过此值触发报警 |

行为：人员消失 → 记录离岗开始时刻；持续离岗超过 `absence_duration` 秒 → 触发报警（带10秒冷却）；人员重新出现（未到报警时间）→ 重置计时。

#### 循环模式（loop_mode）

将多个步骤编排为有序的"段"，每个段指定一个主要步骤和该步骤需要完成"出现→消失"的次数。所有段按顺序执行，最后一段完成后重置到第一段，形成完整周期。**循环模式独立运行，不依赖流程激活状态，持续监控。**

```json
{
  "mode": "sequence",
  "group_id": 1,
  "model_id": 1,
  "loop_mode": {
    "enabled": true,
    "segments": [
      { "step_id": "stepA", "loop_count": 3 },
      { "step_id": "stepB", "loop_count": 1, "alt_step_ids": ["stepC"] }
    ],
    "out_of_order_alarm_name": "动作顺序错误",
    "out_of_order_cooldown": 10
  },
  "sequence": {
    "ordered": false,
    "steps": [
      { "id": "stepA", "label": "动作A", "confidence": 0.8 },
      { "id": "stepB", "label": "动作B", "confidence": 0.8 },
      { "id": "stepC", "label": "动作C", "confidence": 0.8 }
    ]
  }
}
```

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | 是 | — | `true` 启用 |
| `segments` | 是 | — | 有序段列表，至少 1 个 |
| `segments[].step_id` | 是 | — | 该段的主要步骤ID，必须在 `steps` 中存在 |
| `segments[].loop_count` | 否 | `1` | 该段需要"出现→消失"的次数 |
| `segments[].alt_step_ids` | 否 | — | 备选步骤ID列表。段内任一匹配步骤（主要+备选）出现→消失均会计数，任选其一即可完成该段 |
| `segments[].transition_step_ids` | 否 | — | **过渡步骤ID列表**（手写逗号分隔，与备选步骤格式一致）。配置后，段达到循环次数时不推进，进入 guard 验证阶段。行为取决于 `transition_alarm_name`：<br>• **填写了过渡报警名**（v1.2.4）：过渡步骤(B)出现→**触发报警**（带冷却），保持在 guard；主步骤(A)再出现→**不报警**；验证步骤(C)出现→清空计数<br>• **未填写过渡报警名**：过渡步骤(B)出现→**不报警**，静默进入过渡后监控态；之后主步骤(A)再出现不报警，验证步骤(C)出现则清空计数并重置 |
| `segments[].transition_alarm_name` | 否 | — | **过渡报警名**（v1.2.4 新增）。非空时启动"B报警模式"：过渡步骤出现触发此报警，同时主步骤(A)重复出现不报警。为空时保持旧行为（B静默过渡） |
| `segments[].guard_step_ids` | 否 | — | **验证步骤ID列表**（手写逗号分隔）。不配置过渡步骤时：若验证步骤出现→重置本段重新计数；若本段步骤再次出现→触发重复报警。配置过渡步骤后：过渡步骤先出现（行为取决于 `transition_alarm_name`）→ 验证步骤出现→清空A计数并重置 |
| `segments[].repeat_alarm_name` | 否 | `"步骤重复出现"` | guard 验证阶段中本段步骤意外重复出现时的报警名称。注意：配置了 `transition_alarm_name` 时，A 再出现**不触发**此报警；过渡后监控态中 A 再出现也**不报警**；仅当未配置过渡步骤且未配置 `transition_alarm_name` 时，guard 阶段的 A 上升沿才触发此报警 |
| `segments[].repeat_alarm_cooldown` | 否 | 继承 `out_of_order_cooldown` | 重复报警冷却秒数 |
| `out_of_order_alarm_name` | 否 | `"动作顺序错误"` | 检测到后序段步骤提前出现时的报警名称 |
| `out_of_order_cooldown` | 否 | `10` | 越序报警冷却秒数 |

**计数语义（边沿触发）**：
- 循环次数 = 物体"出现→消失"的次数。每次目标从画面中消失计 1 次。
- 目标持续存在不计次，仅当目标从"在场"变为"离场"时才累加。
- 若段配置了 `alt_step_ids`，则该段所有匹配步骤**全部离场**时计 1 次（任一在场则等待）。

**段推进规则**：
- 当前段的匹配步骤完成 `loop_count` 次"出现→消失"后：
  - 若配置了 `guard_step_ids` 或 `transition_step_ids` → 进入 **guard 验证阶段**（不推进段，见下方）
  - 若无 `guard_step_ids` 且无 `transition_step_ids` → 自动进入下一段（无下一段则回到第一段完成周期）
- 最后一段完成后，重置到第一段，同时累计一次完整周期。
- 段推进/guard 重置时，当前段的消失计数清零。

**越序报警**：
- 当前段 N 正在执行时，若检测到段 N+1 或之后任一段的步骤出现，触发越序报警。
- **仅当本段已激活**（至少检测到过一次本段步骤）后才触发越序报警；段未激活时后序段步骤出现不报警。
- 当前段自身的 `alt_step_ids` 中的步骤不视为越序。
- guard 验证阶段中跳过越序检测（由 guard 逻辑接管）。
- 报警信息包含：当前段编号、越序段编号、越序步骤ID。
- 报警带冷却时间，避免同一异常反复报警。

**Guard 验证模式**（v1.2.3 新增，v1.2.4 扩展）：
- 段达到 `loop_count` 后，若有 `guard_step_ids` 或 `transition_step_ids`，不推进到下一段，而是进入验证阶段。
- 三种步骤角色：
  - **主步骤（A）**：段的主步骤（含 `alt_step_ids`），在 guard 正常阶段再次出现（上升沿）→ 取决于是否配置 `transition_alarm_name`：配置时→不报警；未配置时→触发重复报警。在过渡后监控态中再次出现 → 不报警。
  - **过渡步骤（B）**（`transition_step_ids`）：行为取决于 `transition_alarm_name`：<br>**v1.2.4 B报警模式**（填写了过渡报警名）：出现→触发报警（带冷却），**不进入**过渡后监控态，保持 guard 持续监控；<br>**旧行为**（未填写过渡报警名）：出现后不报警、不重置，静默进入"过渡后监控态"。
  - **验证/重置步骤（C）**（`guard_step_ids`）：出现后清空本段计数并退出 guard。
- 状态机（v1.2.4 扩展）：
  1. **正常 guard（B报警模式）**：仅当 `transition_alarm_name` 非空时生效。B 出现→报警（带冷却）；C 出现→重置；A 出现→**不报警**
  2. **正常 guard（旧行为）**：仅当 `transition_alarm_name` 为空时生效。B 出现→进入过渡后监控（无报警）；C 出现→重置；A 出现→报警
  3. **过渡后监控**：C 出现→清空计数并重置；A 出现→不报警
  4. 不配置 `transition_step_ids` 时，行为回退到旧版：C 出现→重置；A 出现→报警
- 验证阶段持续运行直到 guard 步骤出现重置或本段步骤重复报警。
- 验证阶段中跳过正常的边沿计数和越序检测。

**行为示例**（段A loop_count=3，段B loop_count=1, alt_step_ids=["C"]）：
- 正常周期（走B）：A×3 → B出现→B消失 → 周期完成 → 回到段A
- 正常周期（走C）：A×3 → C出现→C消失 → 周期完成 → 回到段A
- 越序报警：A计数期间（A已激活后），B 或 C 提前出现 → 触发报警
- 段B期间，B 和 C 同时出现 → 都离场后计 1 次

**行为示例**（段A loop_count=3，guard_step_ids=["B","C"]）：
- 正常周期：A×3 → 进入guard验证 → B出现 → 重置段A（count=0），重新开始
- 重复报警：A×3 → 进入guard验证 → A再次出现 → 触发 repeat_alarm_name 报警
- 越序抑制：A尚未激活（count=0）时B出现 → 不报警

**行为示例**（段A loop_count=3，transition_step_ids=["B"], guard_step_ids=["C"]）：
- 过渡+重置：A×3 → 进入guard验证 → B出现(不报警) → 进入过渡后监控 → C出现 → 清空A计数，重新开始
- 过渡后A再出现：A×3 → 进入guard验证 → B出现(不报警) → A再次出现 → 不报警，等待C清空
- 直接重置：A×3 → 进入guard验证 → C直接出现(未经过渡) → 重置段A

**行为示例**（段A loop_count=3，transition_step_ids=["B"], transition_alarm_name="B出现报警", guard_step_ids=["C"]）— v1.2.4 新增：
- B报警模式：A×3 → 进入guard验证 → B出现 → 触发报警"B出现报警"（带冷却），保持在guard → C出现 → 清空A计数，重新开始
- A不报警：A×3 → 进入guard验证(B报警模式) → A再次出现 → **不报警**，仅记录日志
- B持续报警：A×3 → 进入guard验证(B报警模式) → B持续在场 → 每冷却周期触发一次报警，直到C出现清空

**配置示例**：
- `a-a-a-b/c`：`segments: [{step_id:"A",loop_count:3}, {step_id:"B",loop_count:1,alt_step_ids:["C"]}]`
- `a-a-a-`：`segments: [{step_id:"A",loop_count:3}]`
- `a-a-a-b-b-b-c-c-c`：`segments: [{step_id:"A",loop_count:3}, {step_id:"B",loop_count:3}, {step_id:"C",loop_count:3}]`
- `a-a-a 验证 b/c`：`segments: [{step_id:"A",loop_count:3,guard_step_ids:["B","C"],repeat_alarm_name:"A重复出现"}]`
- `a-a-a 过渡B 验证C`：`segments: [{step_id:"A",loop_count:3,transition_step_ids:["B"],guard_step_ids:["C"]}]`（B出现不报警，C出现清空计数）
- `a-a-a B报警 验证C`：`segments: [{step_id:"A",loop_count:3,transition_step_ids:["B"],transition_alarm_name:"B出现报警",guard_step_ids:["C"]}]`（v1.2.4：B出现报警，A不报警，C清空计数）

**注意事项**：
- 循环模式持续监控，不依赖 sequence 的流程激活状态（`_reset()` 不清除循环状态）
- 步骤不需要设置 `end`，建议 `ordered: false`
- 所有段中引用的步骤必须在 `steps` 中配置
- 循环段中的步骤同样支持 `external`（API触发）、`model_id` 覆盖、`sub_models` 二阶过滤
- 越序报警仅在当前段已激活（至少检测到过一次本段步骤）后触发，避免冷启动误报
- guard 验证步骤和备选步骤不同：备选步骤在段内与主步骤**同时**被监控（OR 计数），验证步骤在段**完成后**才被监控（用于判断是否重置）

ordered / unordered 行为：

- `ordered: true`：严格按顺序；检测到跳步（未完成前面的就出现后面的 label）→ 触发 `on_skip` 并重置
- `ordered: false`：不限顺序，步骤全部出现后完成；配合 `end` 步骤可提前结束
- 超时计时器从**任意 trigger=true 的步骤第一次被检测到时**开始
- 重置后需等画面中再出现 trigger=true 的步骤才开始新一轮，防止同帧重复触发
- 两种模式都用 `self._completed` 集合判定结束时是否「缺少步骤」（`_missing_steps` 比对 `steps[].id` 是否都在集合内）。有序模式每完成一步在 `_check_step` 里同步登记到该集合，因此全部顺序走完后 `on_complete` 会判定为 OK；若日志出现「步骤完成」却最终报「缺少步骤」，即为该登记缺失的 bug

`on_skip` 占位符：

| 占位符 | 实际值 |
|--------|--------|
| `{skipped_step}` | 被跳过的步骤 id（仅在 `log` 动作中替换，`alarm.msg` 中不替换） |

结束时占位符（`on_complete` / `on_incomplete` / `on_wrong_count`）：

| 占位符 | 实际值 |
|--------|--------|
| `{status}` | `OK` 或 `NG` |
| `{missing_steps}` | 缺失步骤 label 列表，逗号分隔 |
| `{duration}` | 本轮流程持续秒数，保留两位小数 |
| `{step_id}` | 当前步骤 id |
| `{step_label}` | 当前步骤 label |
| `{step_alarm_name}` | 当前步骤 `alarm_name`，未配置则退回 label |
| `{expected_count}` | count 步骤期望数量（`on_wrong_count` 专用） |
| `{actual_count}` | count 步骤实际数量（`on_wrong_count` 专用） |

`on_incomplete` 专用动作：

| 动作 | 说明 |
|------|------|
| `alarm_each_missing` | 对每个缺失步骤分别触发一次报警，msg 使用步骤的 `alarm_name` |
| `save_db_each_missing` | 对每个缺失步骤分别执行一次 `save_db`，字段中可用步骤占位符 |

注意：`on_incomplete` 未配置时，引擎自动回退到 `on_skip` 作为兜底。

---

### 模式四：monitor（安环持续监控）

对应 `MonitorRunner`。

每条规则独立计帧，适合安全帽、玩手机、抽烟等持续出现或缺失检测场景。

#### 结构

```json
{
  "name": "安环监控",
  "mode": "monitor",
  "group_id": 1,
  "model_id": 1,
  "rules": [
    {
      "id": "phone_check",
      "label": "玩手机",
      "confidence": 0.7,
      "type": "on_present",
      "frames": 15,
      "actions": [
        { "alarm": { "msg": "检测到玩手机", "type": "ng", "save_image": true, "cooldown": 30 } }
      ]
    },
    {
      "id": "helmet_check",
      "label": "安全帽",
      "confidence": 0.6,
      "type": "on_absent",
      "frames": 20,
      "actions": [
        { "alarm": { "msg": "未佩戴安全帽", "type": "ng", "save_image": true, "cooldown": 30 } }
      ]
    }
  ]
}
```

rules 字段：

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | 是 | — | 规则唯一标识 |
| `label` | 是 | — | 监控的标签名 |
| `confidence` | 否 | `0.5` | 置信度阈值 |
| `type` | 否 | `on_present` | `on_present`：持续出现触发；`on_absent`：持续缺失触发 |
| `frames` | 否 | `10` | 触发所需帧数 |
| `actions` | 是 | — | 达到帧数后执行的动作列表 |

行为：持续满足条件满 N 帧 → 触发 actions → 计数重置；中途不满足条件立即清零。

---

### 模式五：python（接入 Python 业务代码）

对应 `PythonRunner`。

适用：现场已经有大段纯 py 业务代码（典型如 `ning_bo.py` 风格的"几百个 `self.xxx / xxxing / noxxxing` 帧计数器 + if-else"），想接入工作流引擎而不改写原代码。把原代码搬进一个 handler 类即可被引擎调度。

#### JSON 结构

```json
{
  "name": "ningbo_main",
  "mode": "python",
  "group_id": 1,
  "handler": "scenes.ningbo_flow:NingboFlow",
  "params": {
    "alarm_cooldown": 5,
    "model_id": 1,
    "required_frames": 10
  },
  "db": {
    "host": "127.0.0.1", "port": 3306,
    "user": "root", "password": "",
    "charset": "utf8mb4",
    "alarm_table": "icamera_data.icam_alarm_data"
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `handler` | 是 | Python 类路径，格式 `module:ClassName` 或 `module.ClassName`，引擎 `importlib.import_module` 加载 |
| `params` | 否 | 业务参数字典，handler 内通过 `ctx.params` 读取，避免硬编码 |
| `group_id` | 否 | 引擎已自动按此过滤帧，handler 内 `on_frame` 不必再判 |
| `db` | 否 | 同其它 mode，handler 调 `ctx.save_db` 时使用 |

#### Handler 契约

```python
from core.workflow_engine import PythonNodeContext

class NingboFlow:
    def __init__(self, ctx: PythonNodeContext):
        self.ctx = ctx
        # 原 py 代码 __init__ 里的 self.xxx 全部搬到这里
        ...

    def on_frame(self, groupid, sourceid, metadata):
        # 原 _process_camera_data 整段粘到这里
        # 报警 → self.ctx.alarm(...)
        # 写库 → self.ctx.save_db(...)
        ...
```

**每摄像头一个实例**：`self.xxx` 状态天然按 camera 隔离，handler 内不必再按 sourceid 分支。

#### `ctx` 提供的能力

| 接口 | 说明 |
|------|------|
| `ctx.params` | dict，JSON 里 `params` 字段，业务参数读这里 |
| `ctx.camera_key` | str，`camera_<sourceid>` |
| `ctx.group_id` | int，JSON 里 `group_id`（已自动过滤帧） |
| `ctx.sourceid` | int，当前帧摄像头 id（每帧由引擎刷新） |
| `ctx.metadata` | obj，当前帧 metadata（每帧由引擎刷新） |
| `ctx.region_name()` | str，懒加载区域名称 |
| `ctx.get_boxes(model_id)` | list，便捷取一阶推理框，等价于 `metadata.getModelInferBoxs(model_id)` 的 box 列表 |
| `ctx.save_image()` | str?，主动落盘当前帧并返回路径 |
| `ctx.alarm(msg, alarm_type, cooldown, save_image)` | 发送报警；走引擎统一的去重 + saveImage + alarm_table |
| `ctx.save_db(table, fields)` | 写库；走顶层 `db` 配置，`fields` 支持第六节的所有 `$` 占位符 |

#### 边界（重要）

- **进程级服务不要写进 handler**：MQTT 客户端、TCP server、`subprocess.Popen`、Modbus 设备连接、`Timer(1, ...)` 这类副作用每摄像头会重复触发一次。把它们留在 `core/video_logic.py` 的主进程初始化。
- **`on_frame` 必须快速返回**：不要 sleep、不要阻塞 IO、不要做 N 秒级网络调用。
- **不要在 handler 里直连 pymysql**：用 `ctx.save_db(...)`，否则丧失统一的连接 / 占位符语义。
- **不要在 handler 里自定义报警队列**：用 `ctx.alarm(...)`，最终走与其它 mode 一致的 `alam_msg` 通道。

#### 一个最小可跑的样板

参见 [scenes/template_flow.py](scenes/template_flow.py)，复制后改类名即可承载一整段 py 业务。

#### 热重载注意

JSON 文件改动会被 workflow-watcher 5 秒内自动重载（重新实例化 handler）；**handler 的 .py 源码改动不会触发热重载**，需要重启视频进程。开发期建议把所有可调参数放在 JSON 的 `params` 里。

---

## 五、多一阶模型与二阶模型

### 5.1 多一阶模型

一个 workflow 内可以混用多个一阶模型：

- workflow 顶层 `model_id` 作为**默认值**（缺省 1）
- 每条 `rule` / `step` / `scan` 上可写自己的 `model_id` 覆盖默认值
- 同一帧内同一 `model_id` 的 boxes 只查询一次（引擎内部按 frame 缓存 `getModelInferBoxs`）

示例：monitor 模式同一 workflow 跑两个一阶模型。

```json
{
  "mode": "monitor",
  "group_id": 1,
  "model_id": 1,
  "rules": [
    { "id": "phone_check", "label": "玩手机", "confidence": 0.7, "type": "on_present", "frames": 15 },
    { "id": "color_check", "label": "白色反", "confidence": 0.6, "type": "on_present", "frames": 10,
      "model_id": 2 }
  ]
}
```

sequence 模式 step 同样可覆盖：

```json
{
  "mode": "sequence",
  "group_id": 1,
  "model_id": 1,
  "sequence": {
    "ordered": false,
    "steps": [
      { "id": "s1", "label": "插接1", "duration": 2 },
      { "id": "s2", "label": "白色反", "duration": 2, "model_id": 2 }
    ]
  }
}
```

支持覆盖的字段位置：

| 模式 | 覆盖位置 |
|------|---------|
| `custom_flow` | 各 `states[*].scan[*].model_id` |
| `timer_record` | 各 `rules[*].model_id` |
| `sequence` | 各 `sequence.steps[*].model_id` |
| `monitor` | 各 `rules[*].model_id` |

> ⚠️ `timer_record` 的 `absence_tracking` 始终使用顶层 `model_id` 取一阶 boxes，不支持单独覆盖。

### 5.2 二阶模型（子框推理）

在一阶检测框内嵌套调用二阶模型，通过 `box.getInferBoxWithModelID(sub_id)` 接入。**先匹配一阶 label，命中后才在父框内取子框**。

支持两种写法：

#### 新写法：`sub_models` 数组（推荐，所有模式通用）

```json
{
  "label": "person", "confidence": 0.5,
  "sub_models": [
    { "model_id": 7, "labels": [
        { "name": "phone", "confidence": 0.5 },
        { "name": "tablet", "confidence": 0.5 }
    ]},
    { "model_id": 8, "labels": [
        { "name": "hand", "confidence": 0.4 }
    ]}
  ]
}
```

**语义（AND-of-OR）**：
- 同一 `sub_models[*].labels[]` 内多 label 为 **any-of**（命中任意一个即算这个 sub_model 通过）
- 多个 `sub_models` 之间为 **AND**（必须每个 sub_model 都各自命中至少一个 label）
- `sub_models` 仅作"父框是否通过"判定，匹配后由父规则的 actions / on_found 触发动作

#### 旧写法：`sub_model_id` + `sub_label` / `sub_scan`（保留兼容）

custom_flow — scan 规则的 `sub_scan`：

```json
{
  "label": "桌面",
  "confidence": 0.9,
  "sub_model_id": 7,
  "sub_scan": [
    { "label": "start", "confidence": 0.9, "on_found": [ { "inc": "start_count" } ] },
    { "label": "end",   "confidence": 0.9, "on_found": [ { "inc": "end_count" } ] }
  ]
}
```

timer_record — on_label：

```json
{
  "on_label": {
    "name": "桌面",
    "confidence": 0.9,
    "sub_model_id": 7,
    "sub_label": { "name": "start", "confidence": 0.9 }
  }
}
```

monitor — rules：

```json
{
  "id": "check",
  "label": "桌面",
  "confidence": 0.9,
  "sub_model_id": 7,
  "sub_label": { "name": "start", "confidence": 0.9 },
  "type": "on_present",
  "frames": 3,
  "actions": [ { "alarm": { "msg": "检测到开始动作" } } ]
}
```

#### 字段速查

| 字段 | 适用模式 | 说明 |
|------|----------|------|
| `sub_models` | 所有模式（新） | 数组：`[{model_id, labels:[{name, confidence}]}]`。AND-of-OR 语义 |
| `sub_model_id` | 所有模式（旧） | 单个二阶模型 ID |
| `sub_scan` | custom_flow（旧） | 子框扫描规则数组，**支持** `on_found` / `on_absent` 触发子动作 |
| `sub_label` | timer_record / monitor（旧） | 子框必须匹配的单个标签 `{ "name": "...", "confidence": 0.0 }` |

> ⚠️ **`sub_scan` 子动作**：StateMachineRunner 的 `sub_scan` 里每个子规则可携带 `on_found` / `on_absent` 触发动作，这是旧路径专有能力。新 `sub_models` 路径不支持子级 actions——若要保留子动作，请继续用旧 `sub_scan` 写法。两种写法**不要混用**（同 scan 同时配置时只走旧 sub_scan 分支）。

> ⚠️ **多子模型 vs 旧单子模型**：旧 `sub_model_id` 一个规则只能挂一个二阶模型；要挂多个二阶子模型必须用新 `sub_models` 数组。

---

## 六、Actions 参考

| 动作 | 语法 |
|------|------|
| 计数器加一 | `{ "inc": "var_name" }` |
| 设置 bool | `{ "set": { "var_name": true } }` |
| 重置（单个或列表） | `{ "reset": "var_name" }` / `{ "reset": ["a", "b"] }` |
| 重置全部 | `{ "reset_all": null }` |
| 启动计时器 | `{ "start_timer": "timer_name" }` |
| 停止计时器 | `{ "stop_timer": "timer_name" }` |
| 位置追踪（on_found 中） | `{ "track": "tracker_var_name" }` |
| 报警 | `{ "alarm": { "msg": "...", "type": "ng", "save_image": true, "cooldown": 10 } }` |
| 存库 | `{ "save_db": { "table": "...", "fields": { ... } } }` |
| 对缺失步骤逐条报警 | `{ "alarm_each_missing": { "type": "ng", "save_image": true, "cooldown": 10 } }` |
| 对缺失步骤逐条存库 | `{ "save_db_each_missing": { "table": "...", "fields": { ... } } }` |
| 打日志 | `{ "log": "文字" }` |

### alarm 参数

| 字段 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `msg` | 是 | — | 报警消息文字，支持占位符 |
| `type` | 否 | `"ng"` | 报警类型，写入 `alam_msg.who` |
| `save_image` | 否 | `false` | 是否保存截图，路径写入 `alam_msg.msg3` |
| `cooldown` | 否 | `0` | 同一 msg 的去重冷却秒数，0 表示不去重 |
| `speak` | 否 | — | 喇叭控制：`1`=发送 `speak_on`，`0`=发送 `speak_off`，不填/`null`=不触发喇叭 |

报警不经过 `alarm_db.py` 的固定 12 列 SQL；`alarm_db.py` 是报警写库，`alarm` 动作最终调用 `AibanVideoAlarm._save_db`。

### 扬声器联动（speak 参数）

当 alarm 动作配置了 `"speak": 1` 时，`alam_msg.speak` 会被设为 `1`。报警进程 `alam_process()` 据此查找该摄像头对应的 `socket_clients` 配置，发送 `speak_on` 指令（HEX 或 TTS）。同理 `"speak": 0` 发送 `speak_off`。

每次发送都会写入 `vido_main.log`，带 `[语音播报]` 标签：
```
[语音播报] sourceid=1 播报开启 alarm=玩手机告警 target=192.168.5.10:12345 cmd=000500070000400301E4E4
[语音播报] sourceid=1 语音指令已发送
```

### save_db 参数

| 字段 | 必填 | 说明 |
|------|------|------|
| `table` | 是 | 目标表名 |
| `fields` | 是 | 字段字典，值支持 `$` 占位符 |

`save_db` 直接走 `workflow_engine._db_insert`，由 JSON 中的 `db` 块提供连接参数，与 `alarm_db.py` 的连接**完全独立**。

#### save_db `$` 占位符

| 占位符 | 实际值 |
|--------|--------|
| `$datetime` | `datetime.datetime.now()` 对象 |
| `$date` | `YYYY-MM-DD` |
| `$time` | `HH:MM:SS` |
| `$time_division` | `HH:MM` |
| `$time_month` | `MM` |
| `$week` | ISO 周数（整数） |
| `$now` | `time.time()` 浮点时间戳 |
| `$sourceid` | 摄像头 sourceid 数值 |
| `$camera_id` | 摄像头 key，格式 `camera_{sourceid}` |
| `$region` | 区域名称（来自 `regionname()` 懒加载） |
| `$image_path` | 保存截图后的路径（剥离 `D:/product` 前缀） |
| `$timer_name.elapsed` | 计时器经过秒数 |
| `$timer_name.start_time` | 计时器开始时间戳 |
| `$var_name` | 变量的 `.get()` 值 |
| `$event.xxx` | 最近一次 API trigger 事件映射出的字段，例如 `$event.printJobId`、`$event.printerName` |

---

## 七、when 条件表达式语法

`StateMachineRunner` 的 `transitions.when` 和 `on_timer_expire.checks.when` 支持 Python 表达式语法子集：

```
counter:   hit_count.get() >= 3
bool:      done.get()  /  not done.get()
tracker:   move.get().total_movement > 500
           move.get().was_tracking and not move.get().detected_this_frame
组合:      hit_count.get() >= 3 and not done.get()
```

使用 `eval()` 执行，`__builtins__` 被清空，只能访问已声明的变量名。

---

## 八、Node-RED 导出链路

Node-RED 插件位于 `node-red-contrib-aiban-workflow/`,包含七个节点。工作流通过 Node-RED 画布配置后,经 exporter 节点生成 JSON 写入 `workflows/`,workflow-watcher 5 秒内自动热重载。

### 节点对应关系

| 节点 | 文件 | 产生的 JSON |
|------|------|-------------|
| sequence | `sequence-node.js` | `mode: "sequence"` workflow 对象 |
| timer | `timer-node.js` | `mode: "timer_record"` workflow 对象 |
| state | `state-node.js` | `mode: "custom_flow"` workflow 对象 |
| monitor | `monitor-node.js` | `mode: "monitor"` workflow 对象 |
| api trigger | `api-trigger-node.js` | 带 `_is_api_trigger: true` 标记的入站 API 触发器配置，最终写入顶层 `api_triggers[]` |
| api output | `api-output-node.js` | 带 `_is_api_output: true` 标记的出站 API 输出配置，最终写入顶层 `api_outputs[]` |
| socket - client | `socket-client-node.js` | 带 `_is_socket_client: true` 标记的 socket 客户端配置 |
| exporter | `exporter-node.js` | 接收上游所有节点的 payload,按 group_id 分组写入 `group_{N}.json` |

### exporter 节点逻辑

1. 接收数组 payload（所有上游节点输出的 `msg.payload`）
2. 按 `group_id` 分组，区分 workflow 对象（有 `mode`）、api_trigger 对象（有 `_is_api_trigger`）、api_output 对象（有 `_is_api_output`）和 socket_client 对象（有 `_is_socket_client` 或 `sourceid` 且无 `mode`）
3. 每个 group 写一个 `group_{N}.json`，包含 `db`、`socket_server`（若配置了 socketHost）、`socket_clients`、`api_server`、`api_triggers`、`api_outputs`、`workflows`

exporter 节点 UI 配置字段（输出到 JSON 的 `db`、`socket_server` 和 `api_server`）：

| 配置项 | JSON 字段 |
|--------|-----------|
| dbHost / dbPort / dbUser / dbPassword | `db.host/.port/.user/.password` |
| dbCharset | `db.charset` |
| dbTable | `db.alarm_table` |
| socketHost（非空时才注入） | `socket_server.host` |
| socketPort | `socket_server.port` |
| socketEncoding | `socket_server.encoding` |
| apiServerHost（非空且存在 api trigger 时才注入） | `api_server.host` |
| apiServerPort | `api_server.port` |
| apiServerMaxBody | `api_server.max_body_bytes` |

### sequence 节点固定输出的动作

Node-RED sequence 节点导出的 `on_complete` / `on_skip` / `on_wrong_count` / `on_timeout` / `on_incomplete` 由 `sequence-node.js` 代码生成，不在 UI 里配置：

| 事件 | 固定动作 |
|------|---------|
| `on_complete` | `log` 打印步骤完成文字；若勾选 saveResult 则追加 `save_db` 写结果表（status=OK） |
| `on_incomplete` | `alarm_each_missing`（使用步骤 alarm_name，save_image=true） |
| `on_skip` | `alarm`（msg: `"漏步骤:{skipped_step}"`，save_image=true） |
| `on_wrong_count` | `alarm`（msg: `"{step_alarm_name} (数量错误，期望:{expected_count} 实际:{actual_count})"`，save_image=true） |
| `on_timeout` | `alarm`（msg: `"步骤超时"`，save_image=true） |

冷却时间由节点配置的 `cooldown`（默认 10 秒）统一控制。

### sequence 节点的生产周期入库

sequence 节点勾选"生产周期入库"（`enableCycle`）后，导出的 workflow 对象追加 `cycle_record` 块（`master_table` / `detail_table` 可在节点里改，缺省即两张标准表）。每个步骤行新增"步骤代号"输入框（`step_code`），导出到 `steps[*].step_code`，作为子表 `step_config_id`。引擎据此在流程开始/每步完成/流程结束三个时机写主子表，详见三·"生产周期主子表写库（cycle_record）"。

### sequence 节点的人员在场检测

sequence 节点勾选"启用人员在场检测"（`enablePresence`）后，导出的 workflow 对象追加 `presence_tracking` 块。配置项包括人员标签下拉框（从模型标签中选择）、置信度、离岗持续时间（秒）、离岗报警名称。引擎在流程激活状态下持续监测人员标签，离岗超过设定秒数后触发报警；人员在报警前回归则计时归零。

### sequence 节点的循环模式

sequence 节点勾选"启用循环模式"（`enableLoopMode`）后，导出的 workflow 对象追加 `loop_mode` 块。配置项为有序的**循环段列表**（`segments`），每段指定步骤ID和出现→消失次数、备选步骤、过渡步骤（含可选的过渡报警名）、验证步骤及重复报警名；以及全局越序报警名和冷却时间。过渡步骤和验证步骤均为**手写输入**（逗号分隔步骤ID），与备选步骤格式一致。

引擎按段顺序执行：当前段步骤完成指定消失次数后，若有过渡步骤或验证步骤则进入 guard 验证阶段。过渡步骤(B)的行为取决于是否填写过渡报警名——填写则B出现触发报警（v1.2.4 新增），不填则B出现静默进入监控态；验证步骤(C)出现→清空计数重置；若无过渡/验证步骤则推进到下一段或完成周期。当前段**已激活**后若检测到后序段步骤提前出现，则触发越序报警（段未激活时不报警）。

### 多一阶 / 多二阶子模型的 UI 支持

四种 mode 节点对多模型配置的 UI 支持情况：

| 节点 | 同组别多一阶（per-rule/step `model_id`） | 多二阶子模型（`sub_models` 数组，AND-of-OR） |
|------|----------------------------------------|----------------------------------------------|
| `monitor` | ✓ 每条规则有"模型"下拉，可独立覆盖 | ✓ 勾选"二阶子框"后展开列表，可按"添加子模型"加多行 |
| `sequence` | ✓ 每个 step 有"目标"模型下拉，可独立覆盖 | ✓ 勾选"二阶子框"后展开列表，可按"添加子模型"加多行 |
| `timer` | ✓ Start / End 各自有"模型覆盖"下拉 | ✓ Start / End 各自的"二阶子框"面板支持多行 |
| `state` | — 通过 `model_id` JSON 字段手写在 scan / 状态里 | — 直接在 states JSON 中写 `sub_models` 数组 |

UI 行为约定：
- 二阶子模型列表中**同一 `model_id` 的多行 = OR**（命中其中一个 label 即通过），引擎在 `_normalize_sub_models` 内自动按 `model_id` 聚合
- 不同 `model_id` 的多行 = AND（每个 sub_model 必须各自命中至少一个 label）
- 勾选"二阶子框"且选中"标签"后，若该标签在 `group_inf_map` 中存在二阶映射，UI 会自动追加一条预填的子模型行（仅当列表为空时）
- 旧节点画布带 `sub_model_id` + `sub_label`（或 timer 的 `subStartId/subEndId` 等老字段）保存后，重新打开会自动迁移到新的多行列表显示；保存时统一输出 `sub_models` 数组

### timer 节点固定输出的动作

detect_end 的 actions 固定为：`stop_timer` → `log` → `save_db`（写 work_hours 表，含 duration / start_time / end_time）；若勾选 saveAlarmResult 则追加 `save_db` 写结果表（status=OK）；最后 `reset`。

若启用 `enableAbsence`，自动在 payload 中注入 `absence_tracking` 块，并在 `save_db.fields` 中追加 `absence_time: "$absence_timer.elapsed"`。

### monitor 节点固定输出的动作

每条规则的 actions 由 `monitor-node.js` 代码生成,不在 UI 里配置:

| 事件 | 固定动作 |
|------|---------|
| 达到 `frames` 阈值 | `alarm`(msg = 该规则 `NG报错名`,save_image=true,cooldown 取节点统一冷却) |
| 勾选「结果入库」 | 追加 `save_db` 写结果表(status=NG,占位符 `$image_path` / `$region` / `$sourceid` 等) |

UI 多规则列表里每行可配置:`规则ID` / `模型(可空走默认)` / `标签` / `置信度` / `类型(on_present 或 on_absent)` / `帧数` / `NG报错名` / `二阶子框`。勾选"二阶子框"展开多行列表,可"添加子模型"配置多个二阶模型(同 model_id 多行=OR,不同 model_id=AND);选了一阶标签且 `group_inf_map` 中存在映射时,UI 会自动追加一条预填的子模型行(仅当列表为空)。

---

## 九、外部 API 触发（api trigger）

`workflow-api-trigger` 用于把外部系统的 HTTP 回调转换成 sequence 步骤命中事件。典型场景：MES 在打印机完成打印任务后调用 AI 提供的接口，AI 收到 `printJobId / printerName / printTimestamp` 后，把 sequence 中的 `printer_complete` 步骤视为已完成，后续步骤继续按视觉识别推进。

### 9.1 运行时入口

API 服务运行在 `videowork` 子进程内，由 `core/video_logic.py` 根据 JSON 顶层 `api_server` 启动：

```json
"api_server": {
  "enabled": true,
  "host": "0.0.0.0",
  "port": 18080,
  "max_body_bytes": 1048576
}
```

收到请求后调用 `WorkflowEngine.handle_api_request(...)`，匹配 `api_triggers[]` 中的 method/path，再通过 `WorkflowEngine.on_event(camera_key, groupid, sourceid, event)` 分发给对应摄像头 runner。

### 9.2 每摄像头隔离

API trigger 是按摄像头工作的，不是按 group 共享状态：

- `sourceid` 决定事件投递到哪个 `camera_{sourceid}` runner。
- 每个摄像头有独立 `SequenceRunner` 实例和独立 `_external_hits`。
- 一条 API 请求必须能确定 `sourceid`：要么 trigger 配置里固定 `sourceid`，要么通过 `request.sourceid_path` 从请求体/查询参数中提取。
- 提取优先级：配置了 `sourceid_path` 且能取到非空值时，用请求里的值覆盖固定 `sourceid`；取不到则回退固定 `sourceid`；两者都没有则返回 400 `sourceid required`。提取到的值会经 `int()` 转换，非数字返回 400 `invalid sourceid`（字符串数字如 `"1"` 可正常转换）。

如果外部接口文档中没有摄像头字段（如下方打印机接口），通常做法是在 Node-RED 的 api trigger 节点里固定绑定某台摄像头；多台摄像头则配置多条 trigger，或让 MES 在 body 里额外传 `sourceid`（节点「动态 sourceid 路径」默认已预填 `body.sourceid`）。

### 9.3 api_triggers 字段

```json
"api_triggers": [
  {
    "id": "printer_complete",
    "name": "打印完成回调",
    "enabled": true,
    "group_id": 1,
    "sourceid": 1,
    "method": "POST",
    "path": "/aiban/api-trigger/printer_complete",
    "auth": {
      "type": "bearer_sha256",
      "header": "Authorization",
      "prefix": "Bearer ",
      "token_sha256": "..."
    },
    "request": {
      "content_type": "json",
      "payload_mappings": {
        "printJobId": "body.printJobId",
        "printerName": "body.printerName",
        "printTimestamp": "body.printTimestamp"
      }
    },
    "event": {
      "type": "step_hit",
      "target_step_id": "printer_complete",
      "ttl_seconds": 5,
      "count": 1
    },
    "response": {
      "status": 200,
      "body": { "status": "200", "errmsg": "" }
    }
  }
]
```

| 字段 | 说明 |
|------|------|
| `id` | API 触发器唯一标识 |
| `group_id` | 目标摄像头所在 group。**必须与目标 workflow 的 `group_id` 一致**，否则事件会被 sequence runner 静默丢弃（`on_event` 首行即按 group_id 过滤）。Node-RED 导出由 exporter 自动写入，请确认节点里选对了"群组" |
| `sourceid` | 固定绑定的摄像头 ID；与 `sourceid_path` 二选一 |
| `method` / `path` | 外部系统调用的 HTTP 方法和路径，**运行时按精确字符串匹配**（大小写/末尾斜杠都要一致） |
| `auth.type` | `none` 或 `bearer_sha256`；Node-RED 只导出 token hash |
| `request.payload_mappings` | 把请求字段映射到 `$event.xxx`，只支持安全 dot-path，不支持 eval |
| `request.sourceid_path` | 多摄像头共用接口时，从请求中取 sourceid，如 `body.sourceid`。Node-RED api trigger 节点的「动态 sourceid 路径」**默认即为 `body.sourceid`**（新建节点时预填），请求 body 带 `sourceid` 字段即可按摄像头区分投递；不需要动态 sourceid 时改用「绑定摄像头」并清空此项 |
| `request.target_step_id_path` | 可选，从请求中动态决定目标 step id |
| `event.target_step_id` | sequence 中要被外部事件命中的 step id。**必须等于目标 workflow `sequence.steps[].id` 中的某一项**，否则引擎记 `目标步骤...不存在` 警告且事件不会推进任何流程。注意 Node-RED 节点默认会把"目标步骤ID"自动填成触发器ID，需手动改成真实步骤 id |
| `event.ttl_seconds` | 事件有效期。请求先到、下一帧视频结果后到时，仍能推进步骤 |
| `event.count` | 用于 count 步骤的外部数量值 |
| `response` | 返回给外部系统的 HTTP 状态和 JSON body |

### 9.4 打印机完成接口示例

接口文档摘要：

| 项 | 值 |
|----|----|
| 接口名称 | 打印完成信号触发 AI 识别接口（同步） |
| 调用方 | MES |
| URL | 调试时由 AI 系统提供 |
| 方法 | POST |
| Content-Type | JSON |
| Header | `Authorization` |
| Body | `printJobId`、`printerName`、`printTimestamp` |
| 返回 | `bguid`、`status`、`errmsg` |

Node-RED 推荐配置：

| 配置项 | 示例值 |
|--------|--------|
| 触发器ID | `printer_complete` |
| 绑定摄像头 | `Camera 1`（若接口 body 不传 sourceid） |
| 方法 | `POST` |
| 路径 | `/aiban/api-trigger/printer_complete` |
| 认证 | Bearer Token 或无，按现场对接约定 |
| 目标步骤ID | `printer_complete` |
| TTL | `5` |
| 字段映射 | `printJobId ← body.printJobId`；`printerName ← body.printerName`；`printTimestamp ← body.printTimestamp` |
| 响应体 | `{ "bguid": "", "status": "200", "errmsg": "" }` |

sequence 中要有同名步骤，Node-RED 中勾选该步骤的"API 触发"后会导出：

```json
{
  "id": "printer_complete",
  "label": "printer_complete",
  "confidence": 0,
  "external": true,
  "trigger": false
}
```

该步骤不依赖视觉标签；API 请求到达后会被当作一次外部命中。后续步骤继续使用摄像头视觉识别。

外部调用示例：

```bash
curl -X POST "http://AI_HOST:18080/aiban/api-trigger/printer_complete" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "printJobId": "PRT_20260517_001",
    "printerName": "Printer_A_Line1",
    "printTimestamp": "2026-05-17T13:25:30.123+08:00"
  }'
```

如果同一路径要服务多台摄像头，需要让 MES 额外传：

```json
{
  "sourceid": 1,
  "printJobId": "PRT_20260517_001",
  "printerName": "Printer_A_Line1",
  "printTimestamp": "2026-05-17T13:25:30.123+08:00"
}
```

并把 api trigger 的 `动态 sourceid 路径` 配成 `body.sourceid`。

### 9.6 API 输出结果（api output）

`workflow-api-output` 用于把**报警结果**通过 HTTP API 主动推送给外部系统（数据格式同 `api.py`）。与 api trigger（入站）相反，这是**出站**输出，且不是工作流里的动作，而是**报警的附加输出**——每当任意工作流触发 `alarm`，报警进程在写库 / 扬声器之后，自动对匹配的 `api_outputs` 配置发起一次签名 POST。

运行时入口在报警进程 `core/alarm_db.py` 的 `alam_process`：消费 `alarm_queue` 时，按 `group_id` / `sourceid` 匹配 `api_outputs`，在后台 daemon 线程里调用 `_post_api_output`（避免 HTTP 超时阻塞报警消费）。

请求格式（照搬 `api.py`）：

```
headers: version=2, appid, timestamp=str(datetime.now()),
         appsign=md5(appid+timestamp+appsecret), content-type=application/json
body:    { "channelCode": appid, "args": { "address": ngarea, "code": ngcode } }
```

取值规则：

| 字段 | 来源 |
|------|------|
| `ngcode`（→ `args.code`） | 报警内容 `alam_msg.msg2`（= `alarm` 动作的 `msg`） |
| `ngarea`（→ `args.address`） | 区域名称 `alam_msg.msg1`（= `region_fn()` 结果） |

绑定规则：

- `group_id` 一致才推送（省略视为通配）。
- 填了 `sourceid`：只对该摄像头的报警推送。
- 留空 `sourceid`：对该 group 下所有摄像头的报警推送。

Node-RED 配置：在 api-output 节点里选群组、（可选）绑定摄像头，填 `appid` / `url`（`appsecret` 默认已填 `api.py` 现有值，可改）；`ngcode` / `ngarea` 无需配置，运行时自动填充。节点编辑界面提供「发送测试」按钮（走 admin 路由 `/aiban/test-api-output`）验证 url/appid/appsecret 是否可用。

> 依赖 `requests`（`api.py` 同款）。HTTP 失败只写日志（`global_sys_logger.warning`），不影响报警写库与扬声器联动。

---

## 十、日志与调试

| 日志位置 | 说明 |
|----------|------|
| `log/abvideologs/vido_main.log` | 全局系统日志（引擎、进程启停、报警、DB）|
| `log/apitriggerlogs/api_trigger.log` | API 触发器入站请求专用日志：每次外部 HTTP 调用的 method/path/headers/body、匹配/字段映射/分发结果、HTTP 状态码。由视频进程的 `api_trigger_logger` 写入 |
| `log/apitriggerlogs/api_trigger_node.log` | Node-RED `api-trigger` 节点导出配置时写的调试日志（节点 payload 快照），与上面的入站请求日志分离 |
| `log/flasklogs/app.log` | Flask API 日志 |

> 说明：`log/apitriggerlogs/api_trigger.log` 由 **Python 视频进程**写入，记录的是引擎实际收到的入站 API 数据；要看外部系统真正发了什么，看这个文件。Node-RED 节点不再写该文件（改写 `api_trigger_node.log`），两者互不污染。

日志格式：`YYYYMMDD HH:MM:SS-LEVEL: message`，按天切割，保留 30 天。

工作流引擎关键日志前缀：

| 前缀 | 含义 |
|------|------|
| `[camera_N]` | 来自哪个摄像头的 runner |
| `[ALARM]` | 报警占位（`db_cfg` 未配置时使用） |
| `[DB]` | 存库操作 |
| `[语音播报]` | 报警触发喇叭播报：播报开启/关闭、目标地址、指令内容 |
| `[手动触发]` | Node-RED / API 手动触发喇叭测试：请求接收、指令发送、结果反馈 |
| `[API Trigger] 收到请求 / 请求头 / 请求体` | 入站 HTTP 请求原始数据（写入 `api_trigger.log`） |
| `[API Trigger] 未找到匹配的触发器` | method+path 未命中任何 trigger（404）；检查路径是否精确一致 |
| `[API Trigger] 目标步骤...不存在` | trigger 的 `target_step_id` 在该 group 工作流里查无此步骤，事件不会推进流程 |
| `[API Trigger] group_id 非法` | trigger 的 `group_id` 缺失/非数字，已按 0 处理（多半导致与 workflow group 不匹配被丢弃） |
| `API trigger server listening on ...` | 入站 API 触发服务已启动 |
| `sequence 收到外部步骤事件` | API trigger 已投递到对应摄像头 sequence runner（真正进入流程的标志） |

---

## 十一、快速查阅

### 新增一套业务逻辑

1. 确认 `group_id`，打开对应 `workflows/group_{N}.json`（不存在则新建）
2. 在 `workflows` 数组里追加一个 workflow 对象，选择 mode：
   - 自由状态机 → `custom_flow`
   - 计时存库 → `timer_record`
   - 步骤顺序 → `sequence`
   - 安环持续监控 → `monitor`
   - 已有 Python 业务代码要接入 → `python`（写一个 handler 类，见四·模式五）
3. 保存文件，5 秒内 workflow-watcher 自动热重载，无需重启

### 常见场景速查

| 需求 | 做法 |
|------|------|
| 检测到某 label 连续出现 N 帧才触发 | `counter + inc + when: hit_count.get() >= N` |
| label 消失后才判断 | `on_absent` 里 inc，或 `tracker.was_tracking and not tracker.detected_this_frame` |
| 计时超时报警 | `timers` 里声明 timeout，`on_timer_expire` 里写 alarm |
| 记录工时到 DB | `timer_record` 模式，end 的 actions 里 `save_db` |
| 步骤严格按顺序 | `sequence` + `ordered: true` |
| 步骤不限顺序只要都出现 | `sequence` + `ordered: false` |
| 某步骤需连续出现 N 秒 | steps 里加 `"duration": N` |
| 某步骤需检测到 N 个框 | steps 里加 `"count": N` |
| 识别到某 label 立即结束流程 | steps 里加 `"end": true, "trigger": false` |
| end 时发现有步骤缺失 | `on_incomplete` 配置 `alarm_each_missing` 或 `save_db_each_missing` |
| 安环持续出现 N 帧 | `monitor` + `type: on_present` + `frames: N` |
| 安环持续缺失 N 帧 | `monitor` + `type: on_absent` + `frames: N` |
| 报警去重 | `alarm` 里加 `"cooldown": 秒数` |
| 报警结果推送外部 API（同 api.py） | 加 `workflow-api-output` 节点 → 顶层 `api_outputs`（见 9.6），ngcode/ngarea 自动取报警内容/区域 |
| 写 OK 结果到 DB | 在 `on_complete` 里用 `save_db` 写结果表，`alarm_status` 字段填 `"OK"` |
| 工位看板大屏数据（主子表+周期状态+每步启停时间） | `sequence` + `cycle_record.enabled=true`，每个 step 配 `step_code`（见三·cycle_record） |
| 同一摄像头跑多套逻辑 | 同一 JSON 文件 `workflows` 数组里加多个对象，`model_id` 按需区分 |
| 同一 workflow 内混用多个一阶模型 | 顶层 `model_id` 作默认；rule/step/scan 上写 `model_id` 覆盖（见五.1 节） |
| 多个二阶子模型 AND | 用新 `sub_models` 数组写法（见五.2 节） |
| 接入既有 py 业务代码（不重写） | 使用 `python` mode + handler 类（见四·模式五），模板：`scenes/template_flow.py` |
| 热更新工作流 | 直接修改保存 `workflows/*.json`，5 秒内自动重载（handler 源码改动需重启进程） |
| 动作循环重复验证 | 循环段配 `guard_step_ids` + `repeat_alarm_name`；达到循环次数后验证步骤出现→重置，本段步骤再出现→报警。v1.2.4 新增 B 报警模式：配 `transition_step_ids` + `transition_alarm_name`，B出现→报警，A出现→不报警 |
