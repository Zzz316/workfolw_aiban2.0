# T19/T20 业务逻辑消息合同

## 公共入口与出口

三个逻辑节点都必须放在 `aiban-scene-entry` 之后。输入至少包含：

```json
{
  "aiban": {
    "session_id": "...",
    "group_id": 1,
    "source_id": 1,
    "event_seq": 10,
    "label_matches": [{ "label_id": "A", "matched": true }]
  },
  "workflow": {
    "workflow_id": "group/1/scene/demo",
    "scene_id": "demo"
  }
}
```

终态统一写入 `msg.workflow.outcome` 和 `msg.workflow.result`，再连接 `aiban-result(mode=outcome)`。业务规则节点不直接写 MySQL 或调用网络；它们在 `outcome.effects` 中描述副作用意图，由结果/副作用层执行。

## Advanced Sequence

步骤字段：

| 字段 | 含义 |
|---|---|
| `id` / `label_id` | 步骤和标签标识 |
| `duration_ms` | 标签必须连续存在的时间；中途消失重新计时 |
| `target_count` | 出现边沿目标次数，不按连续帧重复计数 |
| `step_code` | 业务工序编码，写入 `details.step_records` |
| `type: external` | 外部/API 步骤，匹配 `workflow.external_event` |
| `transition_step_id` | 计数完成后必须出现的过渡步骤 |
| `guard_step_ids` | 等待过渡时出现则清空当前计数 |

终态 code：`ON_INCOMPLETE`、`ON_SKIP`、`ON_WRONG_COUNT`、`ON_TIMEOUT`、`PRESENCE_ABSENT`、`DEPLOY_RECOVERY`。

缺步明细在 `outcome.details.missing_steps`；逐项报警/写库意图在 `outcome.effects`。

## Monitor

规则支持 `condition=present|absent`、`frame_threshold`、`duration_ms`、`cooldown_ms`。持久状态先按 Node-RED 节点 ID 命名空间隔离，再按 workflow + session + group + source 分键，因此同类型多节点和不同 source 的阈值、恢复与 cooldown 不会互相消费。

达到阈值输出 NG outcome，code 为 `MONITOR_PRESENT` 或 `MONITOR_ABSENT`。scene disable 或 Deploy 会清理未完成阈值，并在有活动状态时输出 INTERRUPTED。

## Timer Record

`startLabel` 创建计时周期；未开始时的 `endLabel` 输出 `TIMER_NOT_RUNNING` guard 诊断，不创建结果。结束后 outcome.details 包含：

- `work_duration_ms`
- `absence_duration_ms`
- `start_label`
- `end_label`

`outcome.effects[0]` 为 `record_type=timer_record` 的 `save_db` 意图。超时输出 `TIMER_TIMEOUT`；scene disable 输出 `TIMER_INTERRUPTED`。Deploy 默认输出 `TIMER_DEPLOY_RECOVERY`，也可显式配置 `resumeAfterRestart=true` 继续持久状态。
