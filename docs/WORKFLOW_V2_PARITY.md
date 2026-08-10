# AiBan Workflow 2.0 功能清单

更新日期：2026-08-09

本文件只描述 2.0 原生能力和发布面。

## 1. 运行与场景

| 能力 | 2.0 实现 |
|---|---|
| Runtime 托管 | `aiban-runtime` 直接托管 Python Runner |
| SDK 帧输入 | stdin/stdout JSON Lines 主链路 |
| Source 控制 | Runtime 控制消息 `pause_source` / `resume_source` |
| Scene 控制 | Scene Registry + `aiban-scene-control` |
| Scene 路由 | `aiban-scene-router` 固定端口分发 |
| Scene 边界 | `aiban-scene-entry` 校验 group/scene/workflow |

## 2. 事实层

| 能力 | 2.0 实现 |
|---|---|
| 一阶标签 | `aiban-label` 和公共事实层 `factSnapshot()` |
| 多模型输入 | `payload.models[*].boxes` 统一归一化 |
| 二阶子框 | `box.sub_models/subModels/sub_boxes/children` 归一化为 `sub_labels` |
| 置信度与数量 | 事实层记录 `count` 和 `max_confidence` |
| 坐标与追踪 | 事实层提供 box center，Custom Flow tracker 累积移动距离 |

## 3. 业务逻辑

| 能力 | 2.0 实现 |
|---|---|
| 线性顺序 | `aiban-result` simple-sequence 模式 |
| 高级顺序 | `aiban-sequence-logic` / `AdvancedSequenceRuntime` |
| 无序/外部步骤 | Advanced Sequence 的 `external_event` 和步骤组合 |
| 数量/持续时长 | Advanced Sequence step `target_count` / `duration_ms` |
| 循环/guard/transition | Advanced Sequence loop/guard/transition 配置 |
| 过程监控 | Advanced Sequence `processMonitoring` |
| 周期主子表 | Advanced Sequence `cycleRecord` 输出标准 `save_db` effects |
| Monitor | `aiban-monitor-logic`，支持 present/absent/count_exceeds |
| Timer Record | `aiban-timer-record`，支持 start/end/absence/timeout/recovery |
| Custom Flow | `aiban-custom-flow`，受控 JSON DSL 表达 vars/timers/guards/actions |

## 4. 外部接口和副作用

| 能力 | 2.0 实现 |
|---|---|
| 入站 API 触发 | `aiban-api-trigger` 输出 `workflow.external_event` |
| 出站 API | `aiban-api-output` + SQLite side-effect ledger |
| Socket/喇叭 | `aiban-socket-output` 消费 outcome effects |
| MySQL 结果 | `aiban-result-db` + `MysqlWriteQueue` |
| 幂等 | `result_event_id` / side-effect ledger |

## 5. 发布面约束

2.0 Node-RED 包只发布 `aiban-*` 节点；Runtime 只走 Python Runner 的 stdin/stdout JSON Lines 进程协议；业务逻辑只通过 Scene、outcome/result、Advanced Sequence、Monitor、Timer Record 和 Custom Flow 扩展。

发布门禁 `tools/release_gate.js` 会阻止非 `aiban-*` 节点和不属于当前 Runtime 链路的底层传输依赖进入 2.0 Node-RED 包。
