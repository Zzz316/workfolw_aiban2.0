# 1.0 功能对等矩阵 (Workflow 1.0 Parity Matrix)

> 文档版本：v1.0
> 编制日期：2026-07-02
> 数据来源：`WORKFLOW_DOC.md`、现场运行配置
> 用途：跟踪 1.0 全部功能在新架构中的迁移状态

---

## 状态标记

| 标记 | 含义 |
|------|------|
| ⬜ 待迁移 | 尚未开始 |
| 🔧 迁移中 | 正在开发 |
| ✅ 已迁移 | 已通过测试 |
| ❌ 不做 | 经评审确认不迁移 |
| ⚠️ 需重新设计 | 架构变化导致需重新设计 |

---

## 1. 进程模型

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| 主进程启动 | `main.py` | `aiban-runtime` Node-RED 节点 | ⬜ | Node-RED 是启动入口 |
| videowork 子进程 | `video_process.py` | Python 子进程（由 aiban-runtime spawn） | ⬜ | 不再使用 multiprocessing.Process |
| videoalarm 子进程 | `video_process.py` + `alarm_db.py` | Node-RED alarm 节点 | ⬜ | 报警逻辑迁移到 Node-RED |
| Flask API 线程 | `main.py` 内 daemon 线程 | Node-RED http-in 节点 | ⬜ | HTTP 端点由 Node-RED 原生支持 |
| 进程间通信（Pipe/Queue） | `multiprocessing.Pipe/Queue` | stdin/stdout JSON Lines | ⬜ | 无内部队列需求 |
| 工作流热重载 | workflow-watcher 线程（5s） | Node-RED Deploy 机制 | ⬜ | Node-RED 原生支持 |

---

## 2. SDK 集成

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| AiBan 视频实例 | `aibanVideoGetInstance()` | `sdk_adapter.py` | ⬜ | |
| 推理结果回调 | `registerVideoResultFunc(cb)` | SDK adapter 回调 | ⬜ | 回调内复制 metadata → 入队 |
| SDK 事件回调 | `registerVideoMsgEventFunc(cb)` | SDK adapter 事件回调 | ⬜ | |
| 配置校验 | `checkAllConfig(yaml_path)` | SDK adapter 校验 | ⬜ | 必须校验返回值 |
| Pipeline 启动 | `buildPipline()` | SDK adapter 启动 | ⬜ | |
| Pipeline 停止 | `stopPipline()` | SDK adapter 停止 | ⬜ | 退出时必须调用 |
| 视频源控制 | `sourceControl(group_id, source_id, b_run)` | 控制命令（pause/resume） | ⬜ | 过载时暂停 |
| metadata 有效期 | 仅在回调内有效 | 回调内复制为普通数据 | ⬜ | 禁止传出回调 |
| 获取模型推理框 | `getModelInferBoxs(model_id)` | 标准 frame 事件 payload | ⬜ | |
| 二阶模型 | `getInferBoxWithModelID(sub_id)` | frame payload sub_models | ⬜ | |
| 截图保存 | `metadata.saveImage(flag)` | screenshot 控制命令 | ⬜ | 异步操作 |
| 获取截图路径 | `metadata.getSaveImagePath()` | screenshot_result 事件 | ⬜ | |

---

## 3. 工作流模式

### 3.1 Custom Flow（自定义状态机）

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| 变量系统（counter/bool/tracker） | `StateMachineRunner` | Node-RED 节点组合 | ⚠️ | 需重新设计为节点拓扑 |
| 计时器系统 | `StateMachineRunner` timers | Node-RED timer 节点 | ⚠️ | |
| 状态定义（scan/on_found/on_absent） | `StateMachineRunner` | Node-RED 节点组合 | ⚠️ | |
| 状态转换（transitions + when） | `StateMachineRunner` | Node-RED 连线 + switch 节点 | ⚠️ | |
| Tracker（移动追踪） | `StateMachineRunner` tracker var | 待设计 | ⚠️ | 需评估是否可纯 Node-RED 实现 |
| 计时器超时检查 | `on_timer_expire` | Node-RED trigger 节点 | ⚠️ | |
| 报警 cooldown | `alarm.cooldown` | Node-RED 节点属性 | ⬜ | |

### 3.2 Timer Record（计时工时）

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| Start/End 标签检测 | `TimerRecordRunner` | Node-RED 节点组合 | ⬜ | |
| 计时器守卫 | `require_timer_running` | Node-RED 节点属性 | ⬜ | |
| 离岗追踪 | `absence_tracking` | Node-RED 节点组合 | ⬜ | |
| 工时写库 | `save_db` action | Node-RED result-db 节点 | ⬜ | |

### 3.3 Sequence（步骤顺序检测）

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| 有序步骤检测 | `ordered: true` | Node-RED 连线顺序 | ✅ | 阶段二已实现 A-B-C 闭环 |
| 无序步骤检测 | `ordered: false` | Node-RED 连线 | ⬜ | |
| 步骤 duration | `duration` 字段 | Node-RED timer 节点 | ⬜ | |
| 步骤 count（N 框） | `count` 字段 | Node-RED counter 节点 | ⬜ | |
| on_complete 动作 | `on_complete` | result 节点 | ✅ | |
| on_incomplete 动作 | `on_incomplete` | result 节点 | ⬜ | |
| on_skip 动作 | `on_skip` | 待实现 | ⬜ | |
| on_wrong_count | `on_wrong_count` | 待实现 | ⬜ | |
| on_timeout | `on_timeout` | 待实现 | ⬜ | |
| alarm_each_missing | `on_incomplete` 专用 | 待实现 | ⬜ | |
| save_db_each_missing | `on_incomplete` 专用 | 待实现 | ⬜ | |
| 超时计时器 | sequence timer | Node-RED trigger 节点 | ⬜ | |
| external 步骤（API 触发） | `external: true` | api-trigger 节点 | ⬜ | |
| step_code（工序代号） | `step_code` 字段 | label 节点属性 | ⬜ | |
| 生产周期写库（cycle_record） | 主子表自动写库 | result-db 节点 | ⚠️ | 阶段二已部分实现 |
| 人员在场检测（presence_tracking） | 离岗检测 | 待实现 | ⬜ | |
| 循环模式（loop_mode） | 循环段 + guard | 待设计 | ⚠️ | 复杂状态机逻辑 |
| Guard 验证 | guard_step_ids | 待设计 | ⚠️ | |
| 过渡步骤 | transition_step_ids | 待设计 | ⚠️ | |
| B报警模式（v1.2.4） | transition_alarm_name | 待设计 | ⚠️ | |

### 3.4 Monitor（安环持续监控）

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| on_present 持续检测 | `MonitorRunner` | Node-RED counter + trigger | ⬜ | |
| on_absent 持续检测 | `MonitorRunner` | Node-RED counter + trigger | ⬜ | |
| 帧数阈值 | `frames` 字段 | Node-RED 节点属性 | ⬜ | |
| 报警动作 | actions alarm | alarm 节点 | ⬜ | |

### 3.5 Python Handler

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| 纯 Python 业务代码 | `PythonRunner` | 受控 Python handler 机制 | ⚠️ | 阶段三设计兼容方案和退出计划 |

---

## 4. 通用动作

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| alarm（报警） | `alarm` action | alarm 节点 | ⬜ | |
| save_db（写库） | `save_db` action | result-db 节点 | ✅ | 阶段二已实现基本写库 |
| log（日志） | `log` action | Node-RED debug/catch 节点 | ⬜ | |
| set/reset 变量 | var actions | Node-RED change/function 节点 | ⬜ | |
| inc 计数器 | counter var | Node-RED counter 节点 | ⬜ | |
| start_timer/stop_timer | timer actions | Node-RED trigger 节点 | ⬜ | |
| 截图保存 | save_image | screenshot 节点 | ⬜ | |
| 占位符替换 | `{status}` `{step_id}` 等 | Node-RED template/function 节点 | ⬜ | |

---

## 5. 副作用组件

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| MySQL 报警写库 | `alarm_db.py` | result-db 节点 | ⬜ | |
| Socket 语音播报 | `alarm_db.py` socket send | socket-client 节点 | ⬜ | |
| API Output（报警推送到外部） | `alarm_db.py` api_outputs | api-output 节点 | ⬜ | |
| API Trigger（外部推进步骤） | `workflow_engine.py` api_triggers | api-trigger 节点 | ⬜ | |
| Flask API 服务 | `main.py` 内 ThreadingHTTPServer | Node-RED http-in 节点 | ⬜ | |
| 手动喇叭测试 | Flask endpoint + socket-client 按钮 | socket-client 节点 | ⬜ | |

---

## 6. 配置与数据

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| 工作流 JSON 配置 | `workflows/*.json` | Node-RED flow + 节点配置 | ⚠️ | 需设计 JSON→Flow 迁移方案 |
| DB 连接配置 | `db` 顶层字段 | Node-RED 配置节点 | ⬜ | |
| Socket 服务端配置 | `socket_server` | socket-client 节点配置 | ⬜ | |
| Socket 客户端配置 | `socket_clients[]` | socket-client 节点配置 | ⬜ | |
| API Server 配置 | `api_server` | Node-RED settings | ⬜ | |
| API Trigger 配置 | `api_triggers[]` | api-trigger 节点配置 | ⬜ | |
| API Output 配置 | `api_outputs[]` | api-output 节点配置 | ⬜ | |
| 摄像头/Group/Source 过滤 | `group_id` / `model_id` | aiban-runtime 输出端口 | ⬜ | |
| config.ini | `D:/product/AiBanWorkSpace/config.ini` | aiban-runtime 配置项 | ⬜ | |
| main-flow.yaml | `D:/product/AiBanWorkSpace/abvideo/main-flow.yaml` | pipelineConfig 配置项 | ⬜ | |
| Workflow 热重载 | watcher 线程 | Node-RED Deploy | ⬜ | |

---

## 7. 日志与可观测性

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| 主日志（按天切割） | `MyLogger` + TimedRotatingFileHandler | Node-RED 日志 + stderr | ⬜ | |
| API Trigger 日志 | `api_trigger_logger` | Node-RED http-in 日志 | ⬜ | |
| SDK 事件日志 | `_video_msg_event_callback` | stderr 日志 | ⬜ | |
| 传输审计日志 | `audit.py` | aiban-runtime 内部审计 | ⬜ | |
| 链路追踪 | 无 | runtime_id → session_id → event_id → cycle_id | ⬜ | 新架构新增能力 |
| 序号缺口检测 | 无 | event_seq 监控 | ⬜ | 新架构新增能力 |
| 队列深度/水位 | 无 | 内部队列监控 | ⬜ | 新架构新增能力 |

---

## 8. 可靠性与运维

| 1.0 功能 | 1.0 实现 | 2.0 实现 | 状态 | 备注 |
|----------|---------|---------|------|------|
| 子进程异常退出重启 | 无（依赖外部监控） | restartPolicy 配置 | ⬜ | 新架构新增 |
| 进程优雅退出 | Pipe 信号 + stopPipline | stdin stop 命令 + SIGTERM | ⬜ | |
| Windows 孤儿进程清理 | 无显式管理 | 子进程树回收 | ⬜ | 新架构新增 |
| 配置变更重启 | 需手动重启 main.py | Node-RED Deploy 触发 | ⬜ | |
| 重复启动防护 | 无 | 同 Pipeline 单实例约束 | ⬜ | 新架构新增 |
| ACK/重传 | protocol.py ZMQ ACK | 无（管道不需要 ACK） | ❌ | 管道无网络层 |
| Durable Outbox/Inbox | SQLite Outbox/Inbox | 可选持久化缓冲层 | ❌ | 阶段一不需要 |

---

## 9. 迁移统计

| 类别 | 总数 | 待迁移 | 迁移中 | 已迁移 | 不做 | 需重新设计 |
|------|------|--------|--------|--------|------|-----------|
| 进程模型 | 6 | 6 | 0 | 0 | 0 | 0 |
| SDK 集成 | 12 | 11 | 0 | 0 | 0 | 1 |
| Custom Flow | 7 | 0 | 0 | 0 | 0 | 7 |
| Timer Record | 4 | 4 | 0 | 0 | 0 | 0 |
| Sequence | 17 | 9 | 0 | 2 | 0 | 6 |
| Monitor | 4 | 4 | 0 | 0 | 0 | 0 |
| Python Handler | 1 | 0 | 0 | 0 | 0 | 1 |
| 通用动作 | 8 | 6 | 0 | 1 | 0 | 1 |
| 副作用组件 | 6 | 6 | 0 | 0 | 0 | 0 |
| 配置与数据 | 12 | 11 | 0 | 0 | 0 | 1 |
| 日志与可观测性 | 7 | 5 | 0 | 0 | 0 | 2 |
| 可靠性与运维 | 6 | 4 | 0 | 0 | 2 | 0 |
| **合计** | **90** | **66** | **0** | **3** | **2** | **19** |

---

## 10. 更新记录

| 日期 | 变更 | 作者 |
|------|------|------|
| 2026-07-02 | 初始版本，冻结 1.0 功能清单 | Phase 0 |
