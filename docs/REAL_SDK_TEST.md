# AiBan Workflow 2.0 真实 SDK 测试指南

> 文档版本：v2.0.0<br>
> 更新日期：2026-07-22<br>
> 适用架构：Node-RED `aiban-runtime → Python Runner → AiBan SDK`

本文只描述当前 2.0 主链路。旧 `main.py → ZeroMQ → aiban-frame-input` 步骤已经归档，不得用于当前阶段验收。

## 1. 验证目标

真实 SDK 验证分为四层，必须分别记录：

1. Runtime 层：Python 进程和 AiBan Pipeline 能启动、就绪和停止。
2. 帧链路层：真实 `group/source/model/boxes` 能进入 Node-RED。
3. 业务结果层：真实标签能产生预期 OK、NG、TIMEOUT 和截图。
4. 副作用层：最终 result 能幂等写入真实 MySQL，并按配置触发外部动作。

某一层通过不能代替下一层通过。

## 2. 环境要求

基线环境：

```text
Python:          3.9.13
Node.js:         v24.13.0
Node-RED:        v4.1.3
SDK home:        D:/product/AiBanWorkSpace
Pipeline YAML:   D:/product/AiBanWorkSpace/abvideo/main-flow.yaml
Runner:          python_runtime/aiban_runner.py
```

检查文件：

```powershell
Get-Item -LiteralPath 'D:\product\AiBanWorkSpace\abvideo\main-flow.yaml'
Get-Item -LiteralPath 'D:\product\AiBanWorkSpace\libAiBanVideoPy3_9.pyd'
python --version
node --version
```

生产测试前确认同一 Pipeline 没有被其他 `main.py`、Python Runner 或 Node-RED 实例占用。

## 3. Node-RED 配置

打开 `aiban-runtime` 节点并确认：

| 配置 | 要求 |
|---|---|
| Python 路径 | 指向 Python 3.9 环境；现场建议使用绝对路径 |
| SDK 目录 | `D:/product/AiBanWorkSpace` |
| Pipeline YAML | `D:/product/AiBanWorkSpace/abvideo/main-flow.yaml` |
| 使用模拟 SDK | 关闭，即 `useMock=false` |
| 自动启动 | 按测试目标设置 |
| 启动超时 | 首次加载模型时应留足时间 |
| 重启策略 | 基线功能测试建议 `never`，故障恢复测试单独切换 |

当前开发 flow 位于 `node-red/flows.json`。

## 4. 启动方式

只启动 Node-RED，不单独启动 `main.py`：

```powershell
cd node-red
npx.cmd node-red --settings settings.js
```

修改自定义节点 JavaScript 后必须重启 Node-RED 进程；仅 Deploy flow 不会重新加载已注册的节点模块。

## 5. Runtime 层验证

### 5.1 启动

观察 `aiban-runtime` 节点状态和第二输出端口：

```text
configured → starting → ready
runtime_starting → runtime_ready
```

`runtime_ready` 只能在 `checkAllConfig()` 和 `buildPipline()` 成功后产生。

记录：

- 测试时间。
- Node-RED node id。
- Python PID。
- session_id。
- SDK/YAML 路径。
- 从启动到 ready 的耗时。

### 5.2 停止

点击停止或发送正式控制消息，确认：

```text
ready → stopping → stopped
runtime_stopping → runtime_stopped
```

随后执行：

```powershell
powershell -ExecutionPolicy Bypass -File tools/check-orphan-python.ps1
```

正常停止的相关孤儿 Python 进程必须为 0。

### 5.3 当前已知限制

T01～T04 完成前：

- 编辑器按钮使用的显示状态可能与 Pipeline 实际状态短暂不一致。
- HTTP 控制请求被接收不等于已经到达 `READY/STOPPED`。
- restart 自动化测试尚未证明第二次 ready 后 Runner 长时间持续存活。

因此当前真实测试必须以生命周期事件、进程状态和日志共同判断，不能只看按钮颜色。

## 6. 帧链路验证

`aiban-runtime` 第一输出应产生：

```json
{
  "topic": "aiban/frame",
  "payload": {
    "group_id": 1,
    "source_id": 1,
    "stream_id": "group-1/source-1",
    "models": {
      "1": {
        "ok": true,
        "boxes": [
          {
            "label": "S2",
            "confidence": 0.83,
            "polygon": []
          }
        ]
      }
    }
  },
  "aiban": {
    "session_id": "uuid",
    "event_id": "uuid",
    "event_seq": 1,
    "group_id": 1,
    "source_id": 1
  }
}
```

检查项：

- `event_seq` 单调递增。
- group/source 与 YAML 一致。
- model id、label 和 confidence 与实际模型一致。
- 正常负载没有 `PARSE_ERROR` 和静默序号缺口。
- 回调、Python 队列和进程管道耗时可记录。

当前运行审计默认位于：

```text
logs/frame_bridge/runtime-*.log
node-red/logs/workflow/workflow-*.log
node-red/logs/workflow/workflow-*.jsonl
```

目录名 `frame_bridge` 是历史命名，当前 `runtime-*.log` 记录的是进程管道链路，不代表重新启用 ZMQ。

## 7. 业务结果验证

### 7.1 先对齐标签配置

真实模型输出标签必须与 `aiban-label` 节点的 `model_id`、`label` 和置信度一致。若模型输出 `S2/S3/S4`，但节点配置为“插接1/插接2/插接3”，只能证明帧进入，不能证明顺序逻辑通过。

### 7.2 最小场景矩阵

| 场景 | 输入动作 | 期望结果 |
|---|---|---|
| 正常顺序 | A→B→C→end | OK |
| 跳步 | A→C | NG，expected=B |
| 提前结束 | A→end | NG |
| 未完成 | A→B 后等待超时 | TIMEOUT |
| 重复帧 | 重放相同 event_id/event_seq | 不产生重复终态 |
| Deploy/重置 | 周期中 Deploy 或手动 reset | INTERRUPTED 或按恢复策略继续 |

每个结果至少记录：

- session_id、stream_id、event_seq。
- workflow_id、cycle_id、result_event_id。
- actual_sequence、expected_step、failure_reason。
- 截图请求和 image_path。

## 8. 截图验证

NG/TIMEOUT 终态产生时确认：

1. `aiban-result` 向 runtime 发送 screenshot 请求。
2. SDK 下一帧回调中调用 `metadata.saveImage()`。
3. result 中收到 image_path。
4. 截图超时时最终业务结果仍会输出，但日志包含截图错误。

Mock screenshot 不能替代真实文件存在性检查。

## 9. MySQL 与副作用验证

真实 MySQL 验收前确认 schema 对 `result_event_id` 存在 UNIQUE 约束。

测试：

- OK、NG、TIMEOUT 各写入一次。
- 重放同一 result_event_id，不产生第二条业务记录。
- 断开数据库，确认有限重试和失败队列。
- 恢复数据库，确认补偿策略符合设计。
- 至少联调 Socket 或 API Output 中的一种外部副作用。

数据库配置和日志不得输出密码。

## 10. 2026-07-22 仓库证据

现有本地证据：

- `node-red/flows.json` 的 `aiban-runtime.useMock=false`。
- `logs/frame_bridge/runtime-20260722-151307-7f59e2d67dde1743.log` 记录到 frame #7936，包含真实模型标签 S2/S3/S4。
- `node-red/logs/workflow/workflow-20260722-151311-9332.jsonl` 包含 7883 条 `frame_received`。
- 该次 2026-07-22 日志没有 terminal result，不能据此声明完整业务顺序闭环通过。
- 2026-07-08 审计中存在 sequence transition/NG 和 db_write_failed，说明结果链路曾被触发，但真实 MySQL 成功写入尚无证据。

因此当前结论为：

| 层次 | 状态 |
|---|---|
| 真实 SDK 帧进入 Node-RED | 有运行证据 |
| 真实标签触发顺序 NG | 有历史运行证据 |
| 真实顺序 OK | 未形成正式证据 |
| 真实截图文件 | 未形成正式证据 |
| 真实 MySQL 成功幂等写入 | 未形成正式证据 |
| 24 小时稳定性 | 未执行 |

## 11. 结果记录模板

```text
测试日期：
测试人员：
设备/OS：
Git commit：
Node/Python/SDK 版本：
Pipeline YAML 摘要：
group/source/model：
Node-RED flow：
操作步骤：
预期结果：
实际结果：
日志路径：
截图路径：
数据库记录：
结论：PASS / FAIL / BLOCKED
遗留问题：
```
