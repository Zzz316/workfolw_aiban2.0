# T16 真实 SDK 首场景闭环验证报告

> 报告版本：t16/v1<br>
> 对应任务：T16 真实 SDK 首场景闭环验证<br>
> 上位计划：[`WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md`](WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md)

---

## 1. 验证目标

使用真实 AiBan SDK 和真实 Pipeline 配置，验证首个 scene 的完整数据链路：

```text
AiBan SDK → Python Runner → aiban-runtime
  → Scene Router → Scene Entry
    → Labels → aiban-result → result-db
```

本报告需在**生产机器**上现场执行并填写。自动化脚本 `tools/verify_real_sdk.py` 覆盖 Runtime 和 Frame 层验证；场景层和业务结果层需配合 Node-RED 人工验证。

### 1.1 2026-08-01 已执行结果

- Mock 验证器：17/17 通过；Node T16 专项：12/12 通过。
- 真实 YAML：解析成功（group 1 / source 1 / model 1）。
- 真实 Runner：收到 `runtime_starting`，未收到 `runtime_ready`。
- 根因：`libAiBanVideoPy3_9` 原生 DLL 初始化失败。
- 真实结果：**FAIL / 环境待修复**；不得以 Mock 结果替代。
- 报告附件：`tmp/t16-real-audit-v3.json`；清理后 Python 孤儿进程为 0。

---

## 2. 复验环境记录（修复原生 DLL 后填写）

| 项目 | 值 |
|---|---|
| 测试日期 | `____` |
| 测试人员 | `____` |
| 设备/OS | `____` |
| Git commit | `____` |
| Python 版本 | `____` |
| Node.js 版本 | `____` |
| Node-RED 版本 | `____` |
| AiBan SDK 路径 | `D:/product/AiBanWorkSpace` |
| Pipeline YAML | `D:/product/AiBanWorkSpace/abvideo/main-flow.yaml` |
| 模型文件 | `____` |

---

## 3. 自动化验证（Python Verifier）

### 3.1 执行命令

```powershell
cd D:\workfolw_aiban_2.0
python tools/verify_real_sdk.py `
  --sdk-home D:/product/AiBanWorkSpace `
  --pipeline-config D:/product/AiBanWorkSpace/abvideo/main-flow.yaml `
  --max-frames 30 `
  --output tools/report-t16-$(Get-Date -Format 'yyyyMMdd-HHmmss').json
```

### 3.2 结果

| 验证项 | 状态 | 详情 |
|---|---|---|
| 环境采集 | `____` | `____` |
| spawn_runner | `____` | PID=`____` |
| startup_runtime_starting | `____` | `____` |
| startup_runtime_ready | `____` | groups=`____`, models=`____` |
| startup_session_consistency | `____` | session_id=`____` |
| frames_received | `____` | 帧数=`____` |
| frames_structure | `____` | `____` |
| frames_sequence_monotonic | `____` | `____` |
| frames_labels | `____` | 检测标签=`____` |
| health_check | `____` | state=`____`, uptime=`____`s |
| source_pause | `____` | `____` |
| source_resume | `____` | `____` |
| screenshot | `____` | image_path=`____` |
| stop_runtime_stopping | `____` | frames_emitted=`____` |
| stop_runtime_stopped | `____` | exit_code=`____` |
| stop_process_exit | `____` | exit_code=`____` |
| orphan_check | `____` | orphan_count=`____` |

### 3.3 Pipeline YAML 脱敏摘要

```yaml
# 从 runtime_ready.payload 提取的 group/source/model 映射
# （已脱敏，不含 RTSP URL、密码等敏感信息）
groups: ____
sources_per_group: ____
models_loaded: ____
```

---

## 4. Node.js 集成验证

### 4.1 执行命令

```powershell
$env:REAL_SDK_AVAILABLE="1"
$env:AIBAN_SDK_HOME="D:/product/AiBanWorkSpace"
$env:AIBAN_PIPELINE_CONFIG="D:/product/AiBanWorkSpace/abvideo/main-flow.yaml"
cd node-red-contrib-aiban-workflow
node --test test/aiban-real-sdk.test.js
```

### 4.2 结果

| 验证项 | 状态 | 详情 |
|---|---|---|
| runtime_starting + runtime_ready | `____` | `____` |
| frames valid structure | `____` | `____` |
| health command | `____` | `____` |
| pause_source/resume_source | `____` | `____` |
| screenshot command | `____` | `____` |
| stop + clean exit | `____` | `____` |
| stderr no tracebacks | `____` | `____` |

---

## 5. Node-RED 场景闭环验证（手动）

> 启动 Node-RED，确认 `node-red/flows.json` 中 aiban-runtime 配置为 `useMock=false`。

### 5.1 Runtime 层

| 检查项 | 预期 | 实际 |
|---|---|---|
| Runtime 状态从 configured → starting → ready | 按钮和状态接口一致 | `____` |
| `GET /aiban-runtime/:id/status` 返回 `actual_state=READY` | HTTP 200, state=ready | `____` |
| `ready_metadata` 包含真实 group/source/model | groups 非空，与 YAML 一致 | `____` |
| session_id 非空 | UUID v4 | `____` |
| 启动到 ready 耗时 | < 60s（含模型加载） | `____`s |

### 5.2 帧链路层

| 检查项 | 预期 | 实际 |
|---|---|---|
| Router 第 1 输出收到 `aiban/frame` | 帧包含 group_id, source_id, models | `____` |
| 帧字段与 Mock 契约一致 | 所有必填字段存在且类型正确 | `____` |
| event_seq 单调递增 | 无序号缺口 | `____` |
| 标签与真实模型一致 | 标签为实际模型输出（如 S2/S3/S4） | `____` |
| 正常负载无静默丢帧 | `QUEUE_OVERFLOW` 计数为 0 | `____` |

### 5.3 场景路由层

| 检查项 | 预期 | 实际 |
|---|---|---|
| Scene Router 正确路由到 scene tab | 帧经过 link out → link in 到达 scene tab | `____` |
| Scene Entry 校验通过 | 第一输出有消息，第二输出无诊断错误 | `____` |
| 场景诊断端口无错误 | 无 UNKNOWN_GROUP / NO_ACTIVE_SCENE 等 | `____` |

### 5.4 业务结果层

| 场景 | 输入动作 | 期望结果 | 实际 |
|---|---|---|---|
| 正常顺序 | 标签 A→B→C→end 顺序出现 | OK | `____` |
| 跳步 | 标签 A→C（跳过 B） | NG, expected=B | `____` |
| 提前结束 | 标签 A→end | NG | `____` |
| 超时 | 标签 A→B 后等待超时 | TIMEOUT | `____` |
| 中断恢复 | 周期中 scene disable/enable | INTERRUPTED | `____` |

> 注：业务结果层需要真实相机画面产生对应标签序列，可通过遮挡/移除物体模拟跳步和提前结束。
> cycle_timeout 可在 aiban-result 节点配置中临时调低（如 10000ms）以验证 TIMEOUT。

每次结果记录：
- session_id: `____`
- cycle_id: `____`
- result_event_id: `____`
- actual_sequence: `____`
- expected_step: `____`

### 5.5 截图验证

| 检查项 | 预期 | 实际 |
|---|---|---|
| NG/TIMEOUT 时触发截图请求 | result 节点发送 screenshot 命令 | `____` |
| screenshot_result 返回 image_path | 路径非空 | `____` |
| 截图超时不丢失结果 | result 仍输出，含 screenshot_error | `____` |

### 5.6 Source Pause/Resume

| 检查项 | 预期 | 实际 |
|---|---|---|
| pause source 1 不影响 source 2 | source 2 继续产生帧 | `____` |
| resume 后恢复帧输出 | source 1 恢复帧 | `____` |
| 运行时 pause/resume 不影响其他 source 的 scene 状态 | 其他 source 的 cycle 继续 | `____` |

### 5.7 Scene Enable/Disable/Select

| 检查项 | 预期 | 实际 |
|---|---|---|
| 禁用 scene 后帧不再路由到该 scene | Router 输出中断消息 | `____` |
| 启用 scene 后恢复路由 | 新帧进入启用后的 scene | `____` |
| Scene 启停不停止 SDK | Runtime 状态保持 READY | `____` |
| 选择切换不停止 SDK | Runtime 状态保持 READY | `____` |

### 5.8 停止验证

| 检查项 | 预期 | 实际 |
|---|---|---|
| 正常停止后无孤儿进程 | `check-orphan-python.ps1` 返回 0 | `____` |
| 停止序列完整 | runtime_stopping → runtime_stopped | `____` |
| 日志可串联 | session_id, event_seq, cycle_id 一致 | `____` |

---

## 6. 已知限制

| 编号 | 描述 |
|---|---|
| L-001 | `____` |
| L-002 | `____` |

---

## 7. 结论

| 层次 | 状态 | 证据 |
|---|---|---|
| 真实 SDK 帧进入 Node-RED | `____` | `____` |
| 真实标签触发顺序 NG | `____` | `____` |
| 真实顺序 OK | `____` | `____` |
| 真实截图文件 | `____` | `____` |
| Scene 启停不影响 SDK | `____` | `____` |
| Source pause/resume 隔离 | `____` | `____` |
| 正常停止无孤儿 | `____` | `____` |

**整体判定：** `FAIL（2026-08-01：原生 DLL 初始化失败，未到 runtime_ready）`

**遗留问题：**
`修复 libAiBanVideoPy3_9 及其原生依赖后，重新填写本节所有真实场景证据。`

---

## 8. 附录：自动化报告输出

`tools/verify_real_sdk.py` 输出的 JSON 报告包含结构化证据，可作为本报告的附件。

执行以下命令生成：

```powershell
python tools/verify_real_sdk.py --mock --max-frames 10 --output tools/report-t16-mock.json
# 或（生产机器）
python tools/verify_real_sdk.py `
  --sdk-home D:/product/AiBanWorkSpace `
  --pipeline-config D:/product/AiBanWorkSpace/abvideo/main-flow.yaml `
  --output tools/report-t16-live.json
```
