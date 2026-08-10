# AiBan Workflow 2.0 Runtime 运维手册

> 版本：v2.0.1<br>
> 日期：2026-08-09<br>
> 适用范围：Node-RED `aiban-runtime` 托管 Python Runner 与 AiBan Pipeline

## 1. 当前运行结构

```text
Node-RED
  └─ aiban-runtime
      └─ child_process.spawn(python -u python_runtime/aiban_runner.py)
          └─ AiBan SDK Pipeline
```

Node-RED 是 Runtime 生命周期的唯一生产控制面。Python Runner 负责 SDK 配置校验、Pipeline 启停、帧/心跳/错误/截图协议，不执行通用业务判定。

2.0 生产主链路由 Node-RED `aiban-runtime` 直接托管 Python Runner 和 AiBan Pipeline。

## 2. 关键配置

| 配置 | 典型值 | 说明 |
|---|---|---|
| Python | Python 3.9.13 | 必须与 AiBan Python 绑定版本匹配 |
| `pythonPath` | Python 3.9 `python.exe` | Runner 解释器 |
| `runnerPath` | `python_runtime/aiban_runner.py` | Python Runner |
| `sdkHome` | `D:/product/AiBanWorkSpace` | AiBan SDK 根目录 |
| `pipelineConfig` | `.../abvideo/main-flow.yaml` | Pipeline YAML |
| `useMock` | 现场必须为 `false` | `true` 仅用于开发/自动化 |
| `startupTimeoutMs` | 30000 | 等待 `runtime_ready` |
| `shutdownTimeoutMs` | 10000 | 等待优雅退出 |
| `heartbeatTimeoutMs` | 15000 | READY 后心跳超时 |
| `restartPolicy` | `never/on-failure/always` | 非预期退出恢复策略 |

## 3. 启动与状态确认

### 3.1 启动 Node-RED

```powershell
cd D:\workfolw_aiban_2.0\node-red
npx.cmd node-red --settings settings.js
```

Runtime 节点配置 `autoStart=true` 时会在部署后自动请求启动；`autoStart=false` 时可从编辑器按钮、HTTP 或消息入口手动启动。`autoStart` 只是部署策略，不代表当前是否运行。

### 3.2 查询真实状态

```http
GET /aiban-runtime/:id/status
```

必须同时查看：

- `actual_state`：`STOPPED/STARTING/READY/STOPPING/ERROR/RECOVERING`；
- `desired_state`：期望为 `READY` 或 `STOPPED`；
- `pid`：Python 进程真实退出后才清空；
- `session_id`：最近一次 READY 会话；
- `last_error`、`restart_count`、`last_state_at`。

只有收到 `runtime_ready` 后才能把启动判定为成功。HTTP `202` 或“请求已接收”不等于 READY。

## 4. 控制入口与语义

编辑器按钮、管理 HTTP 和 `msg.topic="aiban/control"` 都调用同一个 `controlRuntime()`。

| 操作 | 完成条件 | 关键约束 |
|---|---|---|
| start | `actual_state=READY` | 进程已创建但未 READY 时仍是 STARTING |
| stop | Python 进程 exit，状态 STOPPED、PID 为空 | Runner 先调用 `stopPipline()` |
| restart | 新 PID、新 session 达到 READY | 必须等待旧 PID exit 后才能 spawn |
| status | 返回当前快照 | 不改变 autoStart/desired/actual |

每次生命周期操作返回 `operation_id`。排障时必须用 operation ID 关联控制响应、状态变化、PID 和强制清理日志。

## 5. 正常停止、Deploy、删除与退出

正常 stop 顺序：

```text
requestStop
  → Python runtime_stopping
  → SDK stopPipline()
  → Python runtime_stopped
  → command_result 写出
  → Python exit
  → Node RuntimeController 清空 PID 并确认 STOPPED
```

Deploy、删除 Runtime 节点或退出 Node-RED 时，节点同样先发送 stop 并等待 exit。超过 `shutdownTimeoutMs` 才强制结束。强制日志必须包含：

```text
operation_id=<id> pid=<pid> reason=<reason> signal=SIGKILL
```

`child.killed=true` 只说明已经发出 kill 请求，不表示进程已经退出；必须等待 `exit` 事件。

## 6. restart 与恢复策略

生产 restart 是完整进程替换：停止旧 Runner、等待旧 PID exit、spawn 一个新 Runner、等待新 session READY。Python 的 `restart` 命令只保留作协议兼容，不作为编辑器/HTTP/消息生产路径。

| `restartPolicy` | 非零退出 | 零退出 |
|---|---|---|
| `never` | ERROR，不重启 | ERROR，不重启 |
| `on-failure` | 自动恢复 | 不重启 |
| `always` | 自动恢复 | 自动恢复 |

连续恢复次数达到 `maxRestartCount` 后进入 `MAX_RESTARTS_REACHED`，必须修复根因并人工 start。成功 READY 后连续恢复计数归零。

## 7. 故障处理

| 错误 | 常见原因 | 恢复动作 |
|---|---|---|
| `SPAWN_FAILED` | Python/Runner 路径错误、权限不足 | 修正路径，确认旧进程不存在后 start |
| `SDK_START_FAILED` | SDK import、DLL、YAML、模型或 Pipeline 构建失败 | 查看 stderr/SDK 日志，修复后 restart |
| `STARTUP_TIMEOUT` | SDK 初始化卡住、模型加载过慢 | 确认强杀旧 PID，调整配置/超时后 start |
| `HEARTBEAT_TIMEOUT` | SDK 卡死、Runner/管道阻塞、系统过载 | 检查负载和 stderr，按策略恢复 |
| `STOP_TIMEOUT` | `stopPipline()` 或进程退出卡住 | 检查强杀日志和旧 PID；restart 会保留 READY 意图 |
| `PROCESS_EXITED` | Python 崩溃或外部终止 | 检查退出码、信号、stderr 和策略 |
| `MAX_RESTARTS_REACHED` | 连续恢复进程在 READY 前失败 | 停止自动尝试，修复根因后人工 start |

完整映射见 [Runtime 生命周期故障与 Windows 验收矩阵](RUNTIME_LIFECYCLE_MATRIX.md)。

## 8. 日志与证据

| 路径/来源 | 内容 |
|---|---|
| Node-RED 节点日志 | spawn、stderr、退出、重启、强杀 |
| `logs/runtime/runtime-*.log` | Runtime 帧时序/审计 |
| `log/abvideologs/` | AiBan SDK 日志 |
| `node-red/logs/workflow/*.jsonl` | 工作流审计 |
| GET status | 当前状态、PID、session、最后错误 |

现场问题至少保存：时间、节点 ID、operation ID、旧/新 PID、旧/新 session、状态序列、错误码、stderr、SDK 日志和恢复结果。不要提交账号、密码或敏感现场 YAML。

## 9. Windows 生命周期验收

完整回归并检查前后无 AiBan Runner 进程：

```powershell
cd D:\workfolw_aiban_2.0
powershell -ExecutionPolicy Bypass -File tools\verify-runtime-lifecycle.ps1
```

只扫描进程：

```powershell
powershell -ExecutionPolicy Bypass -File tools\check-orphan-python.ps1 -Verbose
```

成功条件：测试全部通过，Windows 真子进程 restart 只有一个新 PID，节点删除后所有子进程退出，最终扫描为 0 个 `aiban_runner.py` 进程。

## 10. 发布前检查

```powershell
cd D:\workfolw_aiban_2.0\node-red-contrib-aiban-workflow
npm.cmd test

cd ..
D:\my_env\python.exe -m unittest discover tests
powershell -ExecutionPolicy Bypass -File tools\check-orphan-python.ps1 -Verbose
node tools\release_gate.js
```

`tools\release_gate.js` 在 T16～T18 现场验收或现场签字缺失时必须返回 `BLOCKED`。Mock/自动化验收不能替代真实 SDK 场景闭环、真实 MySQL、副作用和 24 小时长稳测试；这些分别由 T16～T18 和发布任务验收。

## 11. T16～T18 现场收口

### 11.1 T16 真实 SDK 当前阻塞

2026-08-01 已使用 `D:\my_env\python.exe`、`D:\product\AiBanWorkSpace` 和真实 `main-flow.yaml` 执行验证。YAML 可解析为 group 1 / source 1 / model 1，Runner 发出 `runtime_starting`，但 `libAiBanVideoPy3_9` 原生 DLL 初始化失败，未到 `runtime_ready`。

处理顺序：

1. 核对 SDK 对应的 Python 3.9 位数、VC++ Runtime、原生 DLL 及其依赖 DLL 是否一致。
2. 在 SDK 工作目录直接执行最小 import，确认不再出现 `DLL initialization routine failed`。
3. 重新执行 `tools/verify_real_sdk.py`，必须取得真实 READY、帧、截图和停止证据。
4. 再在 Node-RED 完成 Registry → Router → Scene Entry → Result 的真实 OK/NG/TIMEOUT 与 scene/source 控制验收。

不得用 Mock 17/17 或 Node 专项 12/12 替代上述真实证据。当前报告见 `docs/TEST_REPORT_T16_REAL_SDK.md`。

### 11.2 T17 标准结果库和 API Output

首次部署 schema：

```powershell
Get-Content node-red-contrib-aiban-workflow\sql\schema.sql -Raw |
  mysql.exe -h 127.0.0.1 -u root -p
```

`aiban-result-db` 默认写入 `icamera_data.workflow_result_event`。验收时至少查询：

```sql
SELECT result_event_id, workflow_id, scene_id, cycle_id,
       result_status, image_path, cycle_finished_at
FROM icamera_data.workflow_result_event
ORDER BY id DESC
LIMIT 50;
```

必须重复投递同一 `result_event_id`，确认数据库只有一行。断库期间最终失败记录位于 Node-RED userDir 的 `data/workflow/db-failed.jsonl`；恢复后使用 `MysqlWriteQueue.replayFailureFile()` 的受控维护脚本重放，并保存归档文件名和队列统计。

`aiban-api-output` 只消费标准 terminal result，请求携带 `Idempotency-Key` 和 `x-aiban-result-event-id`。本地副作用 ledger 位于 Node-RED userDir 的 `data/workflow/side-effects.db`。现场验收必须重复投递同一结果并确认对端只产生一次业务通知。

### 11.3 T18 稳定性运行

短时冒烟：

```powershell
node tools\run_stability_test.js --mock `
  --duration-seconds 120 `
  --output tmp\t18-smoke.json
```

正式 24 小时：

```powershell
node tools\run_stability_test.js `
  --duration-hours 24 `
  --python D:\my_env\python.exe `
  --sdk-home D:\product\AiBanWorkSpace `
  --pipeline-config D:\product\AiBanWorkSpace\abvideo\main-flow.yaml `
  --working-directory D:\product\AiBanWorkSpace `
  --output outputs\t18-24h.json
```

Harness 报告只覆盖可由 Runner 自动观测的指标。Node-RED Deploy、Python 崩溃/恢复、SDK 启动失败/恢复、真实 MySQL 断开/恢复、scene 快切和 screenshot 超时还必须按现场矩阵逐项执行，并附 operation ID、result event ID、时间段和日志路径。
