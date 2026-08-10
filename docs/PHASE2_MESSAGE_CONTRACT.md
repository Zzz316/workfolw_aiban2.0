# Phase 2 Runtime Message Contract

> Version: 2.3-logic
> Date: 2026-08-01
> Scope: Runtime frame, scene routing, workflow logic, outcome/result, side effects, and result audit fields

## 1. Overview

This document defines the standard message contract for the current 2.0 nodes. The input source is
`aiban-runtime`, which launches the Python Runner and consumes stdin/stdout JSON Lines events.

Each node in the pipeline augments the `msg` object without removing upstream fields, enabling traceability
from `runtime_id` / `session_id` / `event_id` / `event_seq` to the final `cycle_id` and `result_event_id`.

The primary business terminal contract is `msg.workflow.outcome`. The `msg.abc_result` block is a 2.0 result
audit mirror used by simple-sequence mode and database-oriented audit fields.

## 2. Pipeline

```text
aiban-runtime
  → aiban-scene-router
  → aiban-scene-entry
  → aiban-label(A) → aiban-label(B) → aiban-label(C)
  → aiban-result → aiban-result-db
```

## 3. Input Message (from aiban-runtime)

The `aiban-runtime` node produces inference frame messages on its first output:

```javascript
msg = {
  topic: "aiban/frame",
  payload: {
    schema_version: 1,
    type: "frame",
    runtime_id: "node-red-node-id",
    session_id: "uuid",
    event_id: "uuid",
    event_seq: 10241,
    emitted_at: "2026-07-07T10:00:00.123+08:00",
    group_id: 1,
    source_id: 1,
    stream_id: "group-1/source-1",
    captured_at: "2026-07-07T10:00:00.100+08:00",
    models: {
      "1": {
        ok: true,
        boxes: [
          {
            label: "A",
            label_index: 0,
            confidence: 0.94,
            polygon: [[10,20],[100,20],[100,200],[10,200]],
            mask_contours: [],
            tracker_id: 27,
            sub_models: {}
          }
        ]
      }
    }
  },
  aiban: {
    runtime_id: "node-red-node-id",
    session_id: "uuid",
    event_id: "uuid",
    event_seq: 10241,
    stream_id: "group-1/source-1",
    group_id: 1,
    source_id: 1
  }
};
```

### 3.1 Scene-routed Fields

`aiban-scene-router` preserves the Runtime frame and adds the deployed scene identity:

```javascript
msg.aiban = {
  ...msg.aiban,
  scene_id: "plug-sequence",
  workflow_id: "group/1/scene/plug-sequence",
  route_id: "route-group1-plug-sequence",
  routed_at: "2026-07-29T10:00:00.000Z"
};

msg.workflow = {
  ...msg.workflow,
  group_id: 1,
  scene_id: "plug-sequence",
  workflow_id: "group/1/scene/plug-sequence",
  route_id: "route-group1-plug-sequence"
};
```

Every active scene receives an independent message copy. The fixed route output index is deployment
configuration; it is not carried as mutable business state.

When a previously active scene becomes inactive because of selection, scene enable, or group enable
changes, the Router sends this control message to the old fixed route before routing the current frame:

```javascript
msg.topic = "aiban-interrupt";
msg.payload.reason = "scene-disabled-or-switched";
msg.payload.group_id = 1;
msg.payload.scene_id = "plug-sequence";
msg.payload.workflow_id = "group/1/scene/plug-sequence";
```

`aiban-scene-entry` must reject any message whose group/scene/workflow identity differs from its deployed
configuration. `aiban-result` converts a matching interrupt into a terminal `INTERRUPTED` result for only
the matching workflow/session/group/source state. Runtime and SDK lifecycle state are unchanged.

### 3.2 Normalized Input Fields

2.0 nodes MUST read Runtime frames from the current fields below. Older field names are not part of the
2.0 publishing contract.

| Non-contract field | Current field |
|---|---|
| `msg.payload.message_id` | `msg.payload.event_id` or `msg.aiban.event_id` |
| `msg.payload.frame_seq` | `msg.payload.event_seq` or `msg.aiban.event_seq` |
| `msg.payload.labels` | Scan `msg.payload.models[*].boxes[*]` in `aiban-label` |
| `msg.payload.label_summary` | Optional derived debug field only |
| `msg.payload.checksum` | Not required in local runtime pipe |
| `msg.payload._timing.wire_ms` | Use runtime timing/audit fields if available |

## 4. After aiban-label

```javascript
msg.workflow = {
  workflow_id: "abc-sequence-demo",   // Configured workflow ID
  matched_steps: ["A"],
  matched_labels: [
    {
      step_id: "A",
      model_id: "1",
      label: "A",
      confidence: 0.94,
      box_index: 0
    }
  ],
  match_started_at_ms: 1700000000150,
  match_finished_at_ms: 1700000000151,
  match_duration_ms: 1
};
```

**Rules:**
- If no steps match, the message is discarded (not sent).
- `matched_steps` contains only the `id` values from the configured step list.
- Matching uses strict equality on `model_id` and `label`, and `>=` on `confidence_min`.
- The `workflow` block does NOT overwrite any existing `msg.payload` fields.

## 5. After aiban-result

The `aiban-result` node is a dual-mode result outlet.

| Mode | Input | Responsibility |
|---|---|---|
| `simple-sequence` | `aiban-runtime → aiban-label... → aiban-result` | Compile the upstream linear label topology, run `SequenceRuntime`, and emit terminal outcomes. |
| `outcome` | `msg.workflow.outcome` | Validate the supplied outcome, generate or validate `result_event_id`, dedupe terminals, optionally screenshot, and emit the standard result. |

In `outcome` mode, `aiban-result` does not reverse-parse topology and does not infer complex-logic semantics.
The upstream logic node owns the business state machine and must submit one of the standard business terminal
statuses.

Fields from input and `workflow` are preserved. Terminal messages contain:

- `msg.workflow.outcome`: the standard workflow terminal outcome.
- `msg.workflow.result`: the standard result envelope and idempotency key.
- `msg.abc_result`: result audit mirror fields.

### 5.1 Standard Outcome and Result

```javascript
msg.workflow.outcome = {
  schema_version: "workflow-outcome/v1",
  workflow_id: "abc-sequence-demo",
  scene_id: "default",
  cycle_id: "550e8400-e29b-41d4-a716-446655440000",
  status: "OK",                    // "OK" | "NG" | "TIMEOUT" | "INTERRUPTED"
  started_at: "2026-07-02T08:00:00.150+08:00",
  finished_at: "2026-07-02T08:00:05.483+08:00",
  duration_ms: 5333,
  code: null,
  reason: null,
  expected_step: null,
  actual_steps: ["A", "B", "C"],
  runtime: {
    session_id: "uuid",
    stream_id: "group-1/source-1",
    group_id: 1,
    source_id: 1,
    start_event_seq: 100,
    end_event_seq: 102
  },
  evidence: {
    image_path: "logs/workflow/captures/550e8400.jpg",
    screenshot_error: null
  },
  compatibility: {
    abc_result_event_id: "abc-sequence-demo:uuid:group-1/source-1:550e8400:OK"
  }
};

msg.workflow.result = {
  schema_version: "workflow-result/v1",
  result_event_id: "abc-sequence-demo:uuid:group-1/source-1:550e8400:OK",
  dedupe_key: "abc-sequence-demo:uuid:group-1/source-1:550e8400:OK",
  workflow_id: "abc-sequence-demo",
  scene_id: "default",
  cycle_id: "550e8400-e29b-41d4-a716-446655440000",
  status: "OK",
  finished_at: "2026-07-02T08:00:05.483+08:00",
  screenshot_required: false,
  screenshot_error: null,
  outcome: msg.workflow.outcome
};
```

Field rules:

| Field | Required | Source | Compatibility |
|---|---:|---|---|
| `workflow_id` | Yes | result node config or upstream workflow | Also copied to `abc_result` audit fields |
| `scene_id` | Yes | scene registry; `default` for current simple sequence mode | Required scene identity |
| `cycle_id` | Yes | sequence runtime or complex logic owner | Idle terminal paths create a cycle ID |
| `status` | Yes | business logic terminal state | Maps to `abc_result.result_status` |
| `finished_at` | Yes | terminal creation time | Maps from `abc_result.cycle_finished_at` |
| `code` / `reason` | No for OK, supported for all failures | business logic | Maps from `failure_reason` when present |
| `expected_step` / `actual_steps` | Yes as typed fields | sequence/runtime logic | `actual_sequence` JSON is normalized to an array |
| `result_event_id` | Yes on result | deterministic result builder | Idempotency key |

Business terminal statuses are only `OK`, `NG`, `TIMEOUT`, and `INTERRUPTED`. System faults must use
`topic: "aiban/error"` and must not be disguised as business `NG`.

`result_event_id` is deterministic for the same outcome:

```text
{workflow_id}:{session_id}:{stream_id}:{cycle_id}:{status}
```

If a screenshot request fails, the final result is still emitted. The failure is recorded in
`workflow.outcome.evidence.screenshot_error` and `workflow.result.screenshot_error`.

Duplicate terminal outcomes are deduped by `result_event_id` before screenshot capture and before downstream
emission, so repeated inputs do not create duplicate side effects.

### 5.2 Transition Event (intermediate state change)

```javascript
msg.abc_result = {
  cycle_id: "550e8400-e29b-41d4-a716-446655440000",
  previous_state: "IDLE",
  current_state: "WAIT_B",
  recognized_step: "A",
  expected_step: "A",
  result_status: null,             // null = transition (not terminal)
  failure_reason: null,
  cycle_started_at: "2026-07-02T08:00:00.150+08:00",
  cycle_finished_at: null,
  cycle_duration_ms: null,
  result_event_id: "abc-sequence-demo:session-uuid:group-1/source-1:550e8400:TRANSITION",
  stage_duration_ms: 0.08
};
```

### 5.3 Terminal Audit Event (OK, NG, TIMEOUT, INTERRUPTED)

```javascript
msg.abc_result = {
  cycle_id: "550e8400-e29b-41d4-a716-446655440000",
  previous_state: "WAIT_C",
  current_state: "IDLE",
  recognized_step: "C",
  expected_step: "C",
  result_status: "OK",             // "OK" | "NG" | "TIMEOUT" | "INTERRUPTED"
  failure_reason: null,
  cycle_started_at: "2026-07-02T08:00:00.150+08:00",
  cycle_finished_at: "2026-07-02T08:00:05.483+08:00",
  cycle_duration_ms: 5333,
  result_event_id: "abc-sequence-demo:session-uuid:group-1/source-1:550e8400:OK",
  stage_duration_ms: 0.08
};
```

### 5.4 result_event_id Format

```
{workflow_id}:{session_id}:{stream_id}:{cycle_id}:{result_status}
```

For transition events, `result_status` is `"TRANSITION"`.

2.0 code MUST write `workflow.result.result_event_id` and `abc_result.result_event_id`. Tests and database
uniqueness MUST use `result_event_id`.

## 6. After aiban-result-db

The `aiban-result-db` node adds a `db_result` block. It only processes terminal events and reads terminal
status from `msg.workflow.result.status` or the mirrored `msg.abc_result.result_status` in
`["OK","NG","TIMEOUT","INTERRUPTED"]`.

```javascript
msg.db_result = {
  result_event_id: "abc-sequence-demo:session-uuid:group-1/source-1:550e8400:OK",
  status: "written",               // "written" | "failed" | "skipped"
  db_write_duration_ms: 3.60,
  attempts: 1,
  table: "icamera_data.workflow_result_event"
};
```

## 7. Field Preservation

All nodes MUST:
- Not delete or overwrite fields from upstream nodes.
- Add new data under dedicated keys (`workflow`, `abc_result`, `db_result`).
- Preserve `msg.payload.event_id` and `msg.payload.event_seq` through the entire pipeline for traceability.
- Preserve `msg.aiban.runtime_id`, `msg.aiban.session_id`, `msg.aiban.stream_id`, `msg.aiban.group_id`, and `msg.aiban.source_id`.

## 8. Timing Fields

| Field | Source | Meaning |
|-------|--------|---------|
| `emitted_at` | aiban-runtime | Runtime event emission time |
| `captured_at` | SDK | Frame capture business time |
| `match_duration_ms` | aiban-label | Label matching computation time |
| `stage_duration_ms` | aiban-result | State machine transition time |
| `cycle_duration_ms` | aiban-result | Business cycle A→C duration |
| `db_write_duration_ms` | result-db | MySQL INSERT execution time |

## 9. Permitted Side Effects

| Node | Side Effect | Idempotency Key |
|------|-------------|-----------------|
| `aiban-label` | None (pure function) | N/A |
| `aiban-result` | State store update | `workflow_id + session_id + stream_id` |
| `aiban-result-db` | MySQL INSERT | `result_event_id` UNIQUE index |
| `aiban-api-output` | HTTP result notification | SQLite ledger + `Idempotency-Key` |
| `aiban-workflow-audit` | File writes | `event_id + result_event_id` |

## 10. Error Handling

- If `aiban-label` encounters malformed input, it logs a warning and discards the message.
- If `aiban-result` detects an invalid state, it resets to IDLE and emits an INTERRUPTED outcome/result.
- If screenshot capture fails at terminal time, `aiban-result` still emits the terminal outcome/result and records the screenshot error.
- If `aiban-result-db` fails all retries, it writes to `data/workflow/db-failed.jsonl` and emits `db_result.status = "failed"`.
- No node in the pipeline may throw uncaught exceptions — all errors must be caught, logged, and surfaced via `node.error()` or the output message.

## 11. Advanced Logic Extensions

T19/T20 rule nodes run after `aiban-scene-entry` and before `aiban-result(mode=outcome)`. They may add two optional fields to `workflow.outcome`:

```javascript
msg.workflow.outcome.details = {
  step_records: [],
  missing_steps: [],
  elapsed_ms: 0,
  absence_ms: 0
};

msg.workflow.outcome.effects = [
  {
    type: "alarm",                 // alarm | save_db | api
    code: "ON_INCOMPLETE",
    idempotency_key: msg.workflow.outcome.result_event_id
  }
];
```

- `details` is structured business evidence and MUST be JSON-serializable.
- `effects` describes side-effect intent only. Logic nodes MUST NOT directly write MySQL or call network services.
- `workflow-contract` MUST preserve `details` and `effects` when normalizing outcome/result.
- Advanced Sequence, Monitor and Timer Record persistence is namespaced by the stable Node-RED node ID, then keyed by workflow, session, group and source identities; recovery and scene disable/selection change MUST not consume another node/scene/source state.
- Deploy recovery MUST either resume an explicitly resumable timer or emit a standard `INTERRUPTED` terminal result.

The full rule-specific contract is documented in `docs/ADVANCED_LOGIC_CONTRACTS.md`.
