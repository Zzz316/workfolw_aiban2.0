# Phase 2 Test Report — A-B-C 拓扑闭环 (v2.0-runtime-restart)

> Version: v2.0
> Date: 2026-07-07
> Branch: `v2.0-runtime-restart`
> Scope: `aiban-runtime → aiban-label(A/B/C) → aiban-result → aiban-result-db` closed loop

---

## 1. Summary

Phase 2 development completed. All 82 tests pass (27 Phase 1 runtime + 30 Phase 1 node + 25 Phase 2 closed-loop). The A-B-C topology-driven closed loop now works end-to-end with the `aiban-runtime` node as the entry point, replacing the deprecated `aiban-frame-input`/ZMQ/Inbox chain.

### Test Results Summary

| Suite | Tests | Pass | Fail | Duration |
|-------|-------|------|------|----------|
| Phase 1 runtime (`aiban-runtime.test.js`) | 27 | 27 | 0 | ~99s |
| Phase 1 node (`aiban-runtime-node.test.js`) | 30 | 30 | 0 | ~26s |
| Phase 2 closed-loop (`phase2-closed-loop.test.js`) | 25 | 25 | 0 | ~0.4s |
| **Total** | **82** | **82** | **0** | **~125s** |

---

## 2. Changes Made

### 2.1 `aiban-runtime.js` — Added `group_id` and `source_id` to `msg.aiban`

The runtime now includes `group_id` and `source_id` in `msg.aiban` on port 1 frame output, matching the Phase 2 message contract. This allows downstream nodes to read these fields from `msg.aiban` as well as `msg.payload`.

### 2.2 `aiban-label.js` — Updated input scanning to `models[*].boxes[*]`

**Before**: Read `msg.payload.labels[]` (flat array, deprecated).
**After**: Scans `msg.payload.models[*].boxes[*]` (nested from aiban-runtime).

Additionally:
- Adds `box_index` and `boxes_scanned` to match result entries.
- Populates `msg.workflow.matched_steps[]` and `msg.workflow.matched_labels[]` per Phase 2 contract.
- Preserves `msg.aiban.label_matches[]` for backward compatibility with `aiban-result`.

### 2.3 `aiban-result.js` — Updated to new field names

- Reads `msg.aiban.event_id` / `msg.aiban.event_seq` as primary identity fields.
- Falls back to `msg.payload.event_id` / `msg.payload.event_seq`, then legacy `message_id` / `frame_seq`.
- `_makeResultMessage` now outputs both old and new field names in `msg.payload` and `msg.aiban`.
- Added `makeEventId` import from `flow-runtime.js`.

### 2.4 `flow-runtime.js` — Engine field name update + `result_event_id`

- `process()` reads `event_id`/`event_seq` with backward-compat fallback.
- `_buildTerminalResult` and `buildTransitionResult` now produce `result_event_id` (primary) and keep `event_id` as alias.
- TopologyCompiler now accepts `aiban-runtime` as a valid entry node type (alongside `aiban-frame-input`, `inject`, and `aiban-result`).
- `cycleTimeoutMs` minimum reduced from 1000ms to 1ms (testability).

### 2.5 `aiban-result-db.js` — `result_event_id` for idempotency

- Primary idempotency key changed to `abc_result.result_event_id` (falls back to `abc_result.event_id`).
- `msg.db_result` output now includes both `result_event_id` and `event_id`.

### 2.6 `abc-sequence-flow.json` — Entry switched to `aiban-runtime`

- Replaced `aiban-frame-input` with `aiban-runtime` (with `useMock: true`, `autoStart: false`).
- Inject test nodes send messages in the new `models[*].boxes[*]` format with `msg.aiban` metadata.
- Inject nodes connect directly to the first `aiban-label` (bypassing runtime in manual test mode).

### 2.7 `phase2-closed-loop.test.js` — Updated to new field format

- `makeFrame()` helper produces messages with `event_id`/`event_seq` (primary) and backward-compat fields.
- All 25 test scenarios updated and passing.

---

## 3. Test Scenario Coverage

### 3.1 Phase 2 Closed-Loop Tests (25 scenarios)

| # | Scenario | Status |
|---|----------|--------|
| 1 | A→B→C complete sequence → OK | ✅ |
| 2 | B first (wrong order), then A→C → NG | ✅ |
| 3 | A→C skip B → NG | ✅ |
| 4 | A→B then timeout → TIMEOUT | ✅ |
| 5 | Same label repeat (乱序) → NG | ✅ |
| 6 | `event_id` replay dedup | ✅ |
| 7 | Parallel source isolation | ✅ |
| 8 | Session isolation | ✅ |
| 9 | MysqlWriteQueue initial stats | ✅ |
| 10 | Queue overflow → fallback | ✅ |
| 11 | Recovery: expired → INTERRUPTED | ✅ |
| 12 | Audit log (text + JSONL + CSV) completeness | ✅ |
| 13 | Rewire topology A→C→B (correct + wrong order) | ✅ |
| 14 | 4-label topology A→B→D→C (correct + skip) | ✅ |
| — | TopologyCompiler static validation (4 tests) | ✅ |
| — | WorkflowStateStore V2 CRUD (1 test) | ✅ |
| — | FlowRuntime helpers (3 tests) | ✅ |
| — | Edge: multi-label in same frame → NG | ✅ |

### 3.2 Phase 1 Runtime Tests (27 scenarios)

All 27 scenarios pass, covering: startup, frame output, heartbeat, config failure, graceful stop, health, screenshot, malformed protocol, parse errors, sequence monotonicity, multi-source, duplicate start, stdin close, unknown command, sustained streaming, queue backpressure, queue overflow, startup timeout, stop during startup, stderr resilience, duplicate screenshot, restart, pause/resume, and heartbeat overload status.

### 3.3 Phase 1 Node Tests (30 scenarios)

All 30 scenarios pass, covering: spawn and auto-start, frame/lifecycle/error output ports, protocol parse errors, native DLL compatibility, empty lines, half-JSON, glued JSON, oversized lines, non-strict mode, input commands, invalid commands, on-failure restart, max restart limit, startup timeout, stop during startup, node close, spawn failure, stderr forwarding, admin HTTP endpoints, sequence gaps, missing heartbeat detection, and close with stop+exit.

---

## 4. Field Migration Status

| Old Field | New Field | Status |
|-----------|-----------|--------|
| `msg.payload.message_id` | `msg.aiban.event_id` | ✅ Migrated (backward compat kept) |
| `msg.payload.frame_seq` | `msg.aiban.event_seq` | ✅ Migrated (backward compat kept) |
| `msg.payload.labels` | `msg.payload.models[*].boxes[*]` | ✅ Migrated in aiban-label |
| `msg.payload.label_summary` | (removed / derived) | ✅ Deprecated |
| `abc_result.event_id` | `abc_result.result_event_id` | ✅ Migrated (alias kept) |
| `msg.aiban.label_matches` | `msg.workflow.matched_steps/matched_labels` | ✅ Both populated |
| `aiban-frame-input` entry | `aiban-runtime` entry | ✅ Example flow updated |
| TopologyCompiler entry check | Added `aiban-runtime` | ✅ Updated |

---

## 5. Known Limitations

1. **MySQL write verification**: The `MysqlWriteQueue` is tested for stats and overflow, but actual MySQL INSERT idempotency requires a running MySQL instance. This is validated via env-var configuration during real SDK testing.

2. **`aiban-label.html` help text**: Still references `frame-input` in examples. Updated example flow correctly uses `aiban-runtime`.

3. **Transition events**: Still audited internally but not emitted on wires. The Phase 2 contract reserves this for later audit-focused nodes.

4. **`result_event_id` database schema**: The MySQL schema must have `result_event_id` column with UNIQUE index for idempotency. The existing `event_id` UNIQUE index is kept for backward compatibility.

5. **State store column names**: SQLite state store still uses `last_frame_seq` and `last_message_id` column names internally. No migration needed — `flow-runtime.js` handles the mapping.

---

## 6. Next Steps (Phase 3+)

- Real SDK end-to-end A-B-C closed loop verification (requires on-site hardware).
- MySQL write with `result_event_id` UNIQUE key confirmation.
- 24-hour stability test with A-B-C topology.
- Migration of remaining business logic components per `WORKFLOW_1_0_PARITY_MATRIX.md`.
- Review and deletion of legacy ZMQ bridge code per `LEGACY_ZMQ_MIGRATION.md`.

---

## 7. Git Commits

```
a1ea8cd docs(phase1): update development plan, migration docs, and test report
...
(phase2 commits to be pushed)
```
