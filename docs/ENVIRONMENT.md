# 现场环境记录

> 记录日期：2026-08-26
> 说明：2.0-only 仓库环境；1.0 Flask/ZeroMQ/Python scene 运行链路已移除

---

## 操作系统

| 项目 | 值 |
|------|-----|
| 系统 | Windows 11 Pro |
| 版本 | 10.0.26200.8655 |
| 架构 | x64 |

---

## Python

| 项目 | 值 |
|------|-----|
| 版本 | Python 3.9.13 |
| 路径 | `D:\my_env\python.exe` |
| 环境目录 | `D:\my_env\`（仓库外） |

2.0 Python Runner 依赖（`requirements-v2.txt`）：

| 包 | 版本 |
|-----|------|
| PyYAML | 6.0.3 |

MySQL 副作用由 Node-RED 包中的 `mysql2` 负责；Python Runner 不再依赖 Flask、ZeroMQ 或 PyMySQL。

---

## Node.js / Node-RED

| 项目 | 值 |
|------|-----|
| Node.js | v24.13.0 |
| npm | 11.6.2 |
| Node-RED | v4.1.3 |
| Node-RED 项目目录 | `node-red/` |
| Custom 节点包 | `node-red-contrib-aiban-workflow/` |

---

## AiBan SDK

| 项目 | 值 |
|------|-----|
| SDK 目录 | `D:/product/AiBanWorkSpace/`（仓库外） |
| SDK 库 | `libAiBanVideoPy3_9` |
| 部署路径 | `D:/product/AiBanWorkSpace/` |
| Pipeline YAML | `D:/product/AiBanWorkSpace/abvideo/main-flow.yaml` |
| 配置文件 | `D:/product/AiBanWorkSpace/config.ini` |

---

## 数据库

| 项目 | 值 |
|------|-----|
| 类型 | MySQL |
| 主要库 | `icamera_data` |
| 报警表 | `icam_alarm_data` |
| 生产周期主表 | `production_cycle_record` |
| 工序流水表 | `step_execution_log` |

---

## 网络

| 项目 | 值 |
|------|-----|
| Node-RED 端口 | 1880 |

---

## Git

| 项目 | 值 |
|------|-----|
| 当前分支 | `v2.0-runtime-restart` |
| 当前发布门禁 | T16～T18 和现场签字未完成前不得创建正式 `workflow-v2.0.0` 标签 |
