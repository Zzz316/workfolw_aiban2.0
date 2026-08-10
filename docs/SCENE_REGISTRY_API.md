# Scene Registry 存储与 API

> 合同版本：v1  
> 实现任务：T11、T12；运行时消费：T13～T15  
> 更新日期：2026-07-29

## 1. 边界

Scene Registry 是业务场景的控制平面。它保存场景定义、启用状态、每个 group 当前选中的 exclusive scene，以及所有变更历史。

Scene API 不调用 Python Runner、AiBan SDK 的 `startPipline()` / `stopPipline()`，也不改变 Runtime 的 `desired_state`。禁用 scene 只修改 Registry；`aiban-scene-router` 在下一帧读取新状态，停止向该 scene 分发新帧，并向旧 route 发送中断消息。

数据库默认位于：

```text
<Node-RED userDir>/data/scene/scene-registry.sqlite
```

Node.js 最低版本为 22.13，存储使用内置 `node:sqlite`。SQLite 启用 WAL 和外键检查。

## 2. 数据合同

Scene 的唯一键为 `(group_id, scene_id)`：

```json
{
  "group_id": 1,
  "scene_id": "plug-sequence",
  "name": "插接顺序检测",
  "mode": "exclusive",
  "workflow_id": "group/1/scene/plug-sequence",
  "node_red_tab_id": "tab-group1-plug-sequence",
  "enabled": false,
  "revision": 1,
  "created_at": "2026-07-29T09:00:00.000Z",
  "updated_at": "2026-07-29T09:00:00.000Z",
  "created_by": "scene-editor",
  "updated_by": "scene-editor"
}
```

- `mode` 只允许 `exclusive` 或 `parallel`。
- `scene_id` 为 1～64 位，仅允许字母、数字、点、下划线和连字符。
- 新建 scene 固定为 disabled；启用必须走场景控制权限接口。
- 未填写 `workflow_id` 时生成 `group/<group_id>/scene/<scene_id>`。
- `revision` 每次 Scene 变更后递增，更新、绑定、启停和删除必须提交当前 revision。
- exclusive 当前选择有独立的 `selection_revision`，避免两个操作员互相覆盖选择结果。

## 3. 权限

| 权限 | 能力 |
|---|---|
| `aiban-scene.read` | runtime/group 元数据、Scene、当前选择和历史只读查询 |
| `aiban-scene.edit` | 新建、编辑、删除 Scene，绑定 Node-RED tab |
| `aiban-scene.control` | enable、disable 和选择当前 exclusive scene |
| `aiban-runtime.write` | Runtime start、stop、restart；不授予 Scene API |

HTTP API 注册在 Node-RED Admin API 下，继续受 Node-RED `adminAuth` 和 `needsPermission()` 保护。

## 4. API

所有路径中的 `runtimeId` 是 `aiban-runtime` 节点 ID。API 使用该节点最近一次 `runtime_ready` 元数据校验 `group_id`，不维护第二份手工 group 清单。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/aiban-scenes/:runtimeId/metadata` | read | 获取 Runtime 和真实 group/source/model 元数据 |
| GET | `/aiban-scenes/:runtimeId/groups/:groupId/scenes` | read | 查询 group 下全部 Scene |
| GET | `/aiban-scenes/:runtimeId/groups/:groupId/scenes/:sceneId` | read | 查询单个 Scene |
| POST | `/aiban-scenes/:runtimeId/groups/:groupId/scenes` | edit | 新建 disabled Scene |
| PUT | `/aiban-scenes/:runtimeId/groups/:groupId/scenes/:sceneId` | edit | 编辑名称、mode、workflow 或 tab |
| DELETE | `/aiban-scenes/:runtimeId/groups/:groupId/scenes/:sceneId` | edit | 删除已禁用且未被选择的 Scene |
| POST | `/aiban-scenes/:runtimeId/groups/:groupId/scenes/:sceneId/enable` | control | 启用 Scene |
| POST | `/aiban-scenes/:runtimeId/groups/:groupId/scenes/:sceneId/disable` | control | 禁用 Scene；若为当前选择则同时清除选择 |
| PUT | `/aiban-scenes/:runtimeId/groups/:groupId/scenes/:sceneId/tab` | edit | 绑定或更新 `node_red_tab_id` |
| GET | `/aiban-scenes/:runtimeId/groups/:groupId/current` | read | 查询当前 exclusive Scene 和 selection revision |
| POST | `/aiban-scenes/:runtimeId/groups/:groupId/current` | control | 选择已启用的 exclusive Scene |
| GET | `/aiban-scenes/:runtimeId/groups/:groupId/history` | read | 查询变更历史，支持 `scene_id` 和 `limit` |

写请求通过 `X-Request-Id` 或 body 的 `request_id` 传入请求 ID；未传时服务生成 UUID。`operator` 优先取已认证的 Node-RED 用户名，无认证用户信息时必须在 body 中明确提供。

更新示例：

```json
{
  "name": "插接顺序检测 v2",
  "node_red_tab_id": "tab-group1-plug-sequence",
  "revision": 1
}
```

选择示例：

```json
{
  "scene_id": "plug-sequence",
  "selection_revision": 0
}
```

成功响应：

```json
{
  "success": true,
  "request_id": "req-001",
  "data": {}
}
```

错误响应：

```json
{
  "success": false,
  "request_id": "req-001",
  "error_code": "CONFLICT",
  "message": "Revision conflict",
  "details": {
    "expected_revision": 1,
    "current_revision": 2
  }
}
```

稳定错误码为：

- `NOT_FOUND`
- `CONFLICT`
- `INVALID_GROUP`
- `INVALID_SCENE`
- `FORBIDDEN`

## 5. 删除和未完成周期

API 拒绝删除 `enabled=true` 或仍是当前选择的 scene。调用方必须先 disable；disable 和清除当前选择在同一个 SQLite 事务中完成，并写入审计历史。

Registry 本身不直接操作场景周期。T14/T15 的 Router 在下一帧把 disable/select 变化转换为 `aiban-interrupt`，`aiban-scene-entry` 校验身份后由 `aiban-result` 将匹配的未完成周期收口为 `INTERRUPTED`。该动作不停止整个 SDK Pipeline，完整合同见 [SCENE_ROUTING.md](SCENE_ROUTING.md)。

## 6. 审计

每次写操作保存：

- action；
- group/scene；
- operator；
- request_id；
- Scene revision 或 selection revision；
- before / after JSON；
- created_at。

支持的主要 action 包括 `CREATE`、`UPDATE`、`BIND_TAB`、`ENABLE`、`DISABLE`、`SELECT`、`DESELECT_ON_DISABLE` 和 `DELETE`。
