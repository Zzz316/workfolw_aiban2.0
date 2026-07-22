# Runtime 生命周期故障与 Windows 验收矩阵

> 版本：v1.0.0<br>
> 日期：2026-07-22<br>
> 对应任务：T04<br>
> 适用主线：Node-RED `aiban-runtime` → Python Runner → AiBan Pipeline

## 1. 验收结论

Runtime 生命周期自动化与 Windows 真子进程验收已通过。测试覆盖 6 个控制状态、3 种重启策略、启动/心跳/停止超时、异常退出、重启上限、节点关闭/删除、stdin EOF 和进程级 restart。

2026-07-22 本机结果：

- 全量自动化：125 / 125 通过，0 失败。
- Windows 真进程：旧 PID 退出后才创建一个新 PID；节点删除后全部 Python 子进程退出。
- 验收后扫描：0 个 `aiban_runner.py` 进程。
- 真实 AiBan SDK 帧已有历史运行证据；真实相机的完整故障注入和 24 小时长稳分别保留给 T16、T18。

## 2. 故障矩阵

| 场景 | 期望状态/错误 | 自动恢复 | 自动化证据 | Windows/现场动作 |
|---|---|---|---|---|
| Python 或 Runner 路径错误 | `ERROR / SPAWN_FAILED`，PID 为空 | 修正路径后手动 start | Node 测试 19；Controller spawn failure | 在节点中填入无效路径，确认错误后恢复 |
| SDK import、配置或启动命令失败 | `ERROR / SDK_START_FAILED` | 修复 SDK/配置，stop 旧进程后 start | Node 测试 16b | 检查 Python 3.9、DLL 搜索路径和 SDK home |
| YAML `checkAllConfig()` 失败 | start `command_result.ok=false` | 修复 YAML 后重启 | Python 测试 4、23 | 保留 SDK stderr 和配置路径 |
| `buildPipline()` 失败 | start `command_result.ok=false` | 修复模型/资源后重启 | Python 测试 5 | 检查模型、显存和 SDK 日志 |
| startup timeout | `ERROR / STARTUP_TIMEOUT`，强制结束旧 PID | 按 restartPolicy 决定 | Node 测试 16 | 日志必须有 operation ID、PID、原因 |
| heartbeat timeout | `ERROR / HEARTBEAT_TIMEOUT`，强制结束旧 PID | 按 restartPolicy 决定 | Node 测试 27 | 检查 SDK 卡死、stdout 和系统负载 |
| stop timeout | 先 `ERROR / STOP_TIMEOUT`，exit 后 `STOPPED` | restart 请求保留 `desired=READY` | Node 测试 27b；Controller restart-intent 测试 | 强杀日志必须可追踪；确认旧 PID 已退出 |
| Python 非预期退出 | `ERROR / PROCESS_EXITED` | 由策略决定 | Node 测试 14、14b～14d | 查询退出码、信号和 stderr |
| 连续恢复达到上限 | `ERROR / MAX_RESTARTS_REACHED` | 不再自动恢复 | Node 测试 15 | 修复根因后人工 start |
| 同进程兼容 restart | 两次 READY、新 session、第二次 READY 后持续出帧 | Runner 保持存活 | Python 测试 25 | 仅用于协议兼容，不作为生产控制路径 |
| 生产进程级 restart | 旧 PID exit 后只产生一个新 PID/新 session | 是 | Node 测试 29b、30；Windows 真进程测试 | 不得把 `child.killed=true` 当作已退出 |
| 正常 stop | 先 `stopPipline()`，写出 stopped/result，再退出 | 否 | Python 测试 6 | 最终状态 `STOPPED`、PID 为空 |
| Node Deploy/关闭 | 发 stop，等待 exit，超时强杀 | 否 | Node 测试 18、28 | Deploy 后检查状态和进程数 |
| 删除 Runtime 节点 | 同关闭；超时原因标记为 node deleted | 否 | Node 测试 28b；Windows 真进程测试 | 删除后执行孤儿扫描 |
| Node-RED 退出/stdin EOF | Runner 先停止 Pipeline 再退出 | 否 | Python 测试 14 | Node-RED 退出后执行孤儿扫描 |

## 3. restartPolicy 独立语义

| 策略 | 非零退出 | 零退出 | 达到上限 |
|---|---|---|---|
| `never` | 保持 ERROR，不重启 | 保持 ERROR，不重启 | 不适用 |
| `on-failure` | 自动恢复 | 不重启 | `MAX_RESTARTS_REACHED` |
| `always` | 自动恢复 | 自动恢复 | `MAX_RESTARTS_REACHED` |

一次 `runtime_ready` 表示本次恢复成功，连续恢复计数归零。只有新进程在 READY 前继续失败时才累计到最大重启次数。

## 4. Windows 一键复验

```powershell
cd D:\workfolw_aiban_2.0
powershell -ExecutionPolicy Bypass -File tools\verify-runtime-lifecycle.ps1
```

只做进程泄漏扫描：

```powershell
powershell -ExecutionPolicy Bypass -File tools\verify-runtime-lifecycle.ps1 -SkipTests
```

脚本在测试前后都调用 `tools/check-orphan-python.ps1`。任一阶段发现 `aiban_runner.py` 进程或测试失败都会返回非零退出码。

## 5. 现场记录要求

真实 SDK 验证时至少保存：操作入口、operation ID、旧/新 PID、旧/新 session、状态序列、错误码、强杀原因、SDK stderr、孤儿扫描结果。真实配置、账号和敏感 YAML 不进入仓库。
