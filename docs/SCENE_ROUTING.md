# Scene Manager、Router 与场景入口

> 合同版本：v1  
> 实现任务：T13～T15  
> 更新日期：2026-07-29

## 1. 运行边界

Scene Registry 是场景定义、启用状态和 exclusive 选择的唯一控制面；`aiban-scene-router` 只读取它并分发帧。Scene enable/disable/select 不调用 Runtime 或 AiBan SDK 的 start/stop/restart。

```text
aiban-runtime
  → aiban-scene-router
      → 固定 route 输出 → link → aiban-scene-entry → 场景业务链
      → diagnostics（最后一个输出）
```

Router 的 route 列表属于 Node-RED 可部署拓扑。新建 Scene 不会动态修改连线，必须为它新增 route、连接目标 Tab 并 Deploy。

## 2. Scene Manager

入口为 `frontend-demo/scene-manager/index.html`，业务脚本在 `app.js`。

默认参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `runtimeId` | `7f59e2d67dde1743` | `aiban-runtime` 节点 ID |
| `nodeRed` | `http://127.0.0.1:1880` | Node-RED 编辑器地址 |
| `api` | 与 `nodeRed` 相同 | Scene Registry API 地址 |
| `operator` | `scene-manager-ui` | 无 Node-RED 登录用户时的写入操作者 |
| `demo` | 未启用 | 只有 `demo=1` 才使用 localStorage |

生产接入时建议从 Node-RED 同源静态目录提供页面；如果单独部署，必须为 Admin API 配置受控的 CORS 和认证策略。

页面行为：

- group 来自 `/metadata` 的 Runtime 权威元数据；
- scene 和 current selection 每次加载都从 Registry API 读取；
- create/update/delete/enable/disable/select 都调用正式 API；
- Scene revision 与 selection revision 分开提交；
- `CONFLICT` 后刷新服务端权威状态；
- `FORBIDDEN`、网络失败、metadata 不可用分别提示；
- group enabled、scene enabled、当前 exclusive scene 分开显示；
- 只有 `node_red_tab_id` 存在时才允许打开对应 `#flow/<tab-id>`；
- `?demo=1` 显示醒目横幅，明确数据只在浏览器 localStorage。

## 3. 固定路由合同

`aiban-scene-router` 的 `routes` 是 JSON 数组，数组顺序就是 Node-RED 输出端口顺序：

```json
[
  {
    "route_id": "route-group1-plug-sequence",
    "group_id": 1,
    "scene_id": "plug-sequence"
  }
]
```

若配置 N 条 route，节点有 N+1 个输出，索引 N 固定为 diagnostics。

活动规则：

- group 必须存在且未禁用；
- exclusive scene 必须 enabled 且等于该 group 的 current selection；
- parallel scene 只要 enabled 即活动；
- 每个活动 route 得到独立消息副本；
- 消息补充 `scene_id`、`workflow_id`、`route_id`、`routed_at`。

诊断码：

| code | 含义 |
|---|---|
| `UNKNOWN_GROUP` | 帧 group 不在 Runtime metadata 中 |
| `NO_ACTIVE_SCENE` | group disabled 或没有活动 scene |
| `SCENE_DISABLED` | current selection 指向 disabled scene |
| `ROUTE_NOT_BOUND` | 活动 scene 没有部署固定 route |

## 4. 切换与中断

Router 按 `session_id + group_id + source_id` 记住上一帧的活动 scene 集合。当 Registry 状态变化后，下一帧到达时：

1. 对不再活动的旧 scene route 先发送 `topic=aiban-interrupt`；
2. 当前帧只发送给新的活动 scene；
3. Runtime/Python/AiBan Pipeline 保持运行。

`aiban-scene-entry` 验证 `group_id`、`scene_id`、`workflow_id`。身份不一致的消息从第二输出诊断，不进入业务链。

`aiban-label` 对 `aiban-interrupt` 直接透传。`aiban-result` 只终止与本节点 workflow/scene 及消息 session/group/source 一致的活动状态，清理 timeout，并输出标准 `INTERRUPTED` 结果。状态键和 `result_event_id` 使用 workflow ID，审计同时记录 scene ID。

## 5. 当前首场景

`node-red/flows.json` 包含：

```text
AiBan 主流程：
runtime → scene-router → link / diagnostics

group/1/scene/plug-sequence：
link-in → scene-entry → 1 → 2 → 3 → end → result → result-db
```

主流程不包含业务 label。Registry 中需存在、启用并选择：

```json
{
  "group_id": 1,
  "scene_id": "plug-sequence",
  "name": "插接顺序检测",
  "mode": "exclusive",
  "workflow_id": "group/1/scene/plug-sequence",
  "node_red_tab_id": "tab-group1-plug-sequence"
}
```

可导入的 Mock 示例位于 `node-red-contrib-aiban-workflow/examples/group-scene-flow.json`。Mock Runtime READY 后，仍需通过 Scene Registry API 创建、启用并选择该 Scene；示例不会绕过 Registry 或暗中创建业务配置。

## 6. 当前边界

- Registry 变化由 Router 在下一帧观察，因此无新帧时不会主动发出中断消息。
- 当前 route 列表通过 JSON 编辑；更友好的可视化 route 编辑器可后续增强，但不改变固定端口合同。
- T13～T15 已完成 Mock/自动化验收；真实 SDK、真实 MySQL 和长稳验证分别属于 T16～T18。
