# Workflow 2.0 Phase 2 测试报告

> 报告版本：v2.1.0<br>
> 基线日期：2026-07-24<br>
> 测试范围：顺序状态机、标准 outcome/result、双模式结果出口、结果审计、审计日志和副作用基础能力

## 1. 测试结论

Phase 2 的 Mock 自动化闭环已通过，现有线性顺序状态机能够完成步骤推进并产生 OK、NG、TIMEOUT、INTERRUPTED 等终态。标准 `workflow.outcome/result` 契约、`aiban-result` 双模式出口和 `aiban-result-db` 结果入口已完成自动化验收。真实 SDK 环境已有帧、标签匹配和 NG 结果证据，但尚未形成真实 OK、截图和 MySQL 成功落库的正式验收记录。

- T08 相关专项测试：47 / 47 通过，0 失败。
- 全量 Node.js 测试：142 / 142 通过，0 失败。
- 当前判定：M2 结果分层自动化验收通过，生产实测闭环待 T16～T18 完成。

## 2. 自动化覆盖范围

### 2.1 顺序与会话

- 按 `aiban-label` 节点链自动生成步骤顺序；
- 单步命中、步骤推进和最终完成；
- NG、超时、中断等终态；
- 帧数统计、耗时和步骤轨迹；
- `source_id`、`session_id` 等运行隔离；
- 重复消息、跨源消息和旧会话消息的防串扰基础行为。

### 2.2 结果与副作用

- `aiban-result` 对当前线性顺序结果的汇总；
- `workflow.outcome/result` 标准字段生成与校验；
- `result_event_id` 确定性生成、校验和重复终态去重；
- `abc_result` 结果审计镜像字段保留；
- `aiban-result-db` 消费标准 outcome/result，并读取 `abc_result.event_id` 审计别名；
- 审计事件及事件序号；
- 数据库写入请求和幂等基础测试；
- 异常、副作用失败与主判定结果的基础隔离。

### 2.3 双模式与 outcome 接入

- `simple-sequence` 模式保持原 A→B→C→end 链路；
- `outcome` 模式接收 function/switch 构造的 NG outcome；
- timer 构造 TIMEOUT outcome；
- 两个并行逻辑重复提交同一 `result_event_id` 时只输出一次终态；
- 截图失败不阻止终态输出；
- 标准 outcome 不携带 `abc_result` 时，result-db 自动回填审计镜像字段；
- `abc_result.event_id` 可作为审计别名读取。

### 2.4 回归场景

- 正常顺序完成；
- 跳步、提前结束和错误标签；
- 超时与流程中断；
- 数据库写入失败；
- 多帧、重复帧和会话切换。

## 3. 真实运行证据

### 3.1 2026-07-22 实时帧

真实 SDK 帧已连续进入 Node-RED，审计日志记录 7,883 条 `frame_received`。当次配置未产生可验收终态，说明“帧通路成功”与“业务判定完成”必须分开验收。

### 3.2 2026-07-08 历史流程记录

审计日志存在以下业务事件：

- `label_match_finished`；
- `sequence_transition`；
- `sequence_failed`；
- `db_write_queued`、`db_write_started`、`db_write_failed`；
- 汇总 CSV 中存在跳步、提前结束等 NG 结果。

样本文件包括：

- `node-red/logs/workflow/workflow-20260708-095453-22148.jsonl`
- 同目录下对应的结果汇总 CSV 及其他 2026-07-08 审计日志。

这些记录证明真实运行曾进入标签与 NG 判定路径，也暴露了数据库副作用失败；它们不能替代真实 MySQL 成功落库、真实 OK 和截图链路验收。

## 4. 架构限制

1. 当前主流程以线性 `aiban-label` 链表达顺序逻辑，尚不能统一表达计数、时长、无序集合、外部信号、循环和组合条件。
2. `aiban-result` 同时承担结果生成、流程收尾和部分副作用编排，职责偏重，降低了逻辑复用性。
3. 场景注册、版本、启停、路由和恢复能力尚未实现。
4. 真实 MySQL 成功落库和真实 SDK 完整 OK 链路尚未完成现场验收。

这些限制分别由 T09～T15、T16～T18 和 T19～T21 处理。

## 5. 未完成的生产验收

| 验收项 | 状态 | 对应任务 |
|---|---|---|
| Mock 顺序 OK/NG/TIMEOUT/INTERRUPTED | 通过 | T05～T08 |
| outcome 模式 OK/NG/TIMEOUT/INTERRUPTED | 通过 | T07～T08 |
| result-db 标准 outcome 兼容 | 通过 | T08 |
| `abc_result.event_id` 审计别名读取 | 通过 | T08 |
| 全量自动化回归 | 142/142 通过 | T08 |
| 真实标签进入判定链 | 有证据 | T16 补正式记录 |
| 真实序列 OK | 待验证 | T16 |
| 真实序列 NG | 有历史证据，待标准化 | T16 |
| 真实截图成功/失败 | 待验证 | T16 |
| MySQL 成功落库 | 待验证 | T17 |
| MySQL 失败降级与重放 | 自动化通过，真实库待验证 | T17 |
| 24 小时稳定性 | 待验证 | T18、T22 |

## 6. 验收判定

Phase 2 / M2 结果分层自动化验收通过。当前成果可作为 group/scene 配置、场景路由和复杂逻辑接入的输入基线，但在 T16～T18 完成前，不标记为生产实测闭环完成。

## 7. 2026-08-01 增量回归

- Node.js 全量回归：202/202 通过；Python unittest：31/31 通过。
- T19 Advanced Sequence 与 T20 Monitor/Timer Record 已接入独立规则层并统一提交 outcome/result。
- T17 的 MySQL 幂等/失败重放和 API side-effect ledger 已通过自动化，但真实 MySQL/API 未验收。
- T18 已具备 24 小时 harness，短时双 source 冒烟通过；正式 24 小时及完整现场故障矩阵未执行。
- T16 真实 YAML 解析成功，但 `libAiBanVideoPy3_9` 原生 DLL 初始化失败，未到 `runtime_ready`。

因此本报告原有 Phase 2 自动化结论保持有效，但生产实测闭环仍不通过。完整状态见 `docs/TEST_REPORT_T16_T20_2026-08-01.md`。
