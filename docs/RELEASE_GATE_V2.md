# T22 运行管理与发布门禁

更新日期：2026-08-09

## 1. 自动门禁

执行：

```powershell
node tools/release_gate.js
```

脚本会检查：

- Node-RED 节点是否在 `package.json` 注册，并且 `.js/.html` 文件存在。
- README、开发计划、任务书、运维文档、2.0 功能清单、真实 SDK 测试报告和 T21/T22 文档是否存在。
- Node-RED 包是否只发布 `aiban-*` 2.0 节点，且不包含 `zeromq` 依赖。
- T19/T20/T21 示例 flow 是否存在。
- T21/T22 是否在任务书中记录为 `100% / DONE / 0`。
- T16/T17/T18 是否具备现场验收完成状态。
- 是否存在现场签字证据：`docs/FIELD_ACCEPTANCE_V2_0.md` 中包含 `status: ACCEPTED`，或执行环境设置 `AIBAN_RELEASE_FIELD_ACCEPTED=1`。

脚本退出码：

| 退出码 | 含义 |
|---:|---|
| `0` | 可发布 |
| `2` | 发布被门禁阻塞 |

## 2. 当前结论

截至 2026-08-09，T21/T22 的开发交付物和自动门禁工具已完成，但正式 `workflow-v2.0.0` 仍不得发布。

阻塞项：

- T16 真实 SDK 首场景闭环未完成正式现场验收。
- T17 真实 MySQL/API 副作用联调未完成正式现场验收。
- T18 24 小时稳定性和完整故障矩阵未完成正式现场验收。
- 尚无现场签字验收文件 `docs/FIELD_ACCEPTANCE_V2_0.md`。

## 3. 发布候选流程

1. 执行 Node.js 全量测试。
2. 执行 Python unittest。
3. 执行孤儿 Python 进程检查。
4. 在现场执行真实 SDK、真实 MySQL/API 和 24 小时稳定性矩阵。
5. 更新 `docs/FIELD_ACCEPTANCE_V2_0.md` 并记录 `status: ACCEPTED`。
6. 执行 `node tools/release_gate.js`，确认退出码为 `0`。
7. 仅在门禁通过后创建正式 `workflow-v2.0.0` 标签。

## 4. 回退

若现场验收失败，不创建正式发布标签；2.0 仓库继续保持 2.0-only 状态，现场回退由外部已发布生产版本承担，不在本仓库重新引入 1.0 组件。
