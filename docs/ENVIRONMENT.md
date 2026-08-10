# 现场环境记录

> 记录日期：2026-07-02
> 记录人：Phase 0 基线建立

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
| 路径 | `C:\Users\s2017088\AppData\Local\Programs\Python\Python39\python.exe` |
| venv | `icameraapi/venv/` |

关键依赖（`icameraapi/my_reqs.txt`）：

| 包 | 版本 |
|-----|------|
| Flask | 3.1.2 |
| NumPy | 1.24.4 |
| Pandas | 1.5.3 |
| PyMySQL | 1.1.2 |
| PyYAML | 6.0.3 |
| Requests | 2.32.5 |
| OpenPyXL | 3.1.5 |
| DBUtils | 3.1.2 |
| Werkzeug | 3.1.5 |
| Redis | 4.6.0 |

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
| SDK 目录 | `icameraapi/` |
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
