# AiBan Workflow 2.0 Scene Registry 测试报告

> 验收范围：T11～T15  
> 执行日期：2026-07-29  
> 结论：自动化验收通过

## 1. 验收对象

- `lib/scene-registry-store.js`
- `lib/scene-registry-api.js`
- `aiban-runtime.js` 中的 API 注册
- `frontend-demo/scene-manager/index.html` 与 `app.js`
- `lib/scene-routing.js`
- `aiban-scene-control.js/.html`
- `aiban-scene-router.js/.html`
- `aiban-scene-entry.js/.html`
- `aiban-result.js` 的场景中断处理
- `node-red/flows.json`
- `test/scene-registry-store.test.js`
- `test/scene-registry-api.test.js`
- `test/scene-router.test.js`
- `test/scene-flow.test.js`

## 2. 专项结果

执行：

```powershell
cd node-red-contrib-aiban-workflow
node --test test/scene-registry-store.test.js test/scene-registry-api.test.js
```

结果：

```text
tests 20
pass 20
fail 0
```

覆盖：

- SQLite 目录自动创建和服务重启后持久化读取；
- `(group_id, scene_id)` 重复冲突；
- 空或非法 scene、非法 mode、未知 group；
- Scene revision 更新冲突；
- Node-RED tab 绑定；
- exclusive selection 独立 revision 和旧 revision 冲突；
- parallel scene 不能成为当前 exclusive scene；
- disable 当前 scene 时原子清除选择；
- enabled scene 删除保护和删除审计；
- 所有写入的 operator、request_id、revision、before/after 审计；
- Runtime/group metadata 查询；
- read/edit/control/runtime 权限边界；
- CRUD、enable/disable、select/current/history API；
- API 重建后读取相同 SQLite 数据；
- Scene API 不调用 Runtime control。
- group 禁用、unknown group 和无 active scene 均走 diagnostics；
- exclusive 切换只把新帧送入新 scene，并向旧 route 发出 interrupt；
- parallel 与 exclusive 获取互不共享引用的独立消息副本；
- active scene 未配置固定 route 时明确报告，不静默丢帧；
- scene-entry 严格校验 group/scene/workflow；
- TopologyCompiler 接受 scene-entry 作为简单顺序入口；
- interrupt 只终止匹配 workflow/session/group/source 的活动周期；
- 主流程不含业务 label，场景 Tab 保持 `1 → 2 → 3 → end`；
- Mock 示例 JSON 可直接导入。

专项执行：

```powershell
node --test test/scene-registry-store.test.js test/scene-registry-api.test.js `
  test/scene-router.test.js test/scene-flow.test.js
```

## 3. 浏览器验收

使用本地 Mock Registry 服务和应用内浏览器加载真实 API 模式页面，完成：

- metadata、Scene 和 current selection 首次加载；
- 创建 parallel Scene，确认默认 disabled；
- 刷新页面后新 Scene 保持；
- 启用 Scene 后 revision 和 UI 状态同步；
- 创建重复 Scene 触发 `CONFLICT`，页面提示并保留服务端数据；
- 点击未绑定 Tab 的 Scene 不打开新页并显示绑定指引；
- `?demo=1` 显示“演示模式、localStorage、不写 Registry”；
- 浏览器 console error 为 0。

## 4. 全量回归

Node.js：

```powershell
cd node-red-contrib-aiban-workflow
npm.cmd test
```

结果：

```text
tests 163
suites 32
pass 163
fail 0
```

Python：

```powershell
D:\my_env\python.exe -m unittest discover tests
```

结果：

```text
Ran 31 tests
OK
```

默认 PATH 指向的 `C:\Users\s2017088\AppData\Local\Programs\Python\Python39\python.exe` 中，已安装的 `yaml` 和 `zmq` 包在本次机器上出现 `source code string cannot contain null bytes`，因此本报告使用项目可用的 `D:\my_env\python.exe` 完成 Python 回归。该环境问题不由 T11/T12 代码引入。

## 5. 验收结论

T11～T15 的 Registry、前端、路由、入口、中断语义、流程迁移和文档达到任务书的自动化/Mock 验收条件：

- T11：`DONE`
- T12：`DONE`
- T13：`DONE`
- T14：`DONE`
- T15：`DONE`
- 下一任务：T16 真实 SDK 首场景闭环验证

## 6. 已知边界

- Scene Registry 使用 Node.js 内置 `node:sqlite`，当前运行时会输出 ExperimentalWarning；项目最低 Node.js 版本已调整为 22.13。
- API 依赖目标 `aiban-runtime` 最近一次 `runtime_ready` 中的 group metadata。Runtime 尚未 READY 时，不允许对无法验证的 group 写入。
- Scene 启停和选择不停止 SDK；Router 在下一帧观察 Registry 变化并向旧 route 发出 interrupt。
- 新增 Scene 后仍需在 Node-RED 增加固定 route、连接对应 Tab 并 Deploy。
- 本报告未替代 T16 的真实 SDK、T17 的真实 MySQL 或 T18 的 24 小时稳定性验收。
