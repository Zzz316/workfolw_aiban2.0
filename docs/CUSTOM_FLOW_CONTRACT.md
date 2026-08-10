# T21 Custom Flow 受控扩展合同

更新日期：2026-08-09

## 1. 目标

`aiban-custom-flow` 用于表达无法直接归入 Sequence、Monitor 或 Timer Record 的复杂业务逻辑。2.0 版本不执行任意脚本或字符串表达式，所有条件和动作必须使用受控 JSON DSL。

## 2. 状态模型

运行状态按以下维度隔离：

```text
workflow_id + session_id + group_id + source_id
```

每个活动周期保存：

- `cycleId`
- `stateId`
- `vars`
- `timers`
- `actualSteps`
- `effects`
- `lastEventSeq`

重复或倒序 `event_seq` 会被忽略。

## 3. Vars

支持三类变量：

| 类型 | 说明 |
|---|---|
| `counter` | 数值计数，支持 `inc`、`dec`、`set`、`reset` |
| `bool` | 布尔门禁，支持 `set`、`reset` |
| `tracker` | 保存最后一次业务标识或标签值 |

## 4. Timers

timer 通过 `start_timer` 启动，通过 `stop_timer` 停止。配置 `timeout_ms` 后，可在状态的 `on_timer_expire` 中产生 `TIMEOUT` 或其他标准 outcome。

## 5. Guard

guard 必须是 JSON 对象，禁止字符串表达式。

支持：

- `{ "var": "hit_count", "op": ">=", "value": 2 }`
- `{ "label": "A" }`
- `{ "label": "A", "present": false }`
- `{ "timer": "process_timer", "op": "running" }`
- `{ "timer": "process_timer", "op": "elapsed_gte", "value": 5000 }`
- `{ "all": [ ... ] }`
- `{ "any": [ ... ] }`
- `{ "not": { ... } }`

比较运算符仅支持 `==`、`!=`、`>`、`>=`、`<`、`<=`。

## 6. Actions

支持：

- `{ "inc": "hit_count" }`
- `{ "dec": "hit_count" }`
- `{ "set": { "var": "approved", "value": true } }`
- `{ "track": { "var": "last_label", "value": "A" } }`
- `{ "reset": ["hit_count", "process_timer"] }`
- `{ "goto": "next_state" }`
- `{ "start_timer": "process_timer" }`
- `{ "stop_timer": "process_timer" }`
- `{ "effect": { "type": "alarm", "alarm_name": "..." } }`
- `{ "outcome": { "status": "OK", "code": "CUSTOM_FLOW_COMPLETED" } }`

`outcome` 会生成标准 `msg.workflow.outcome/result`，可直接接入 `aiban-result`。

## 7. 恢复与中断

- scene disable、scene switch 或 Deploy 可通过 `aiban-interrupt` 将活动周期收口为 `INTERRUPTED`。
- 默认 Deploy/restart 会把未完成周期收口为 `CUSTOM_FLOW_DEPLOY_RECOVERY`。
- 如节点启用 `resumeAfterRestart`，则保留活动状态继续运行。

## 8. 验证证据

自动化覆盖见 `test/t21-custom-flow.test.js`：

- 变量、guard 和状态转换输出标准 OK。
- timer 超时输出 TIMEOUT。
- JSON guard 组合语义。
- 字符串 guard 拒绝执行。
- source/session 状态隔离。
- scene 中断和 Deploy 恢复。
- 自定义流程可用受控 DSL 表达，不依赖旧 Python handler 框架。
