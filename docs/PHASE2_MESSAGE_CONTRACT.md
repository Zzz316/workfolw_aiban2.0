# Phase 2 Runtime Message Contract

> Version: 2.0-runtime
> Date: 2026-07-07
> Scope: A-B-C sequential recognition closed loop on top of `aiban-runtime`

## 1. Overview

This document defines the standard message contract for new Phase 2 nodes. Phase 2 starts after the new
Phase 1 runtime has passed real SDK validation. The input source is now `aiban-runtime`, not the archived
`aiban-frame-input` / ZMQ / Inbox chain.

Each node in the pipeline augments the `msg` object without removing upstream fields, enabling traceability
from `runtime_id` / `session_id` / `event_id` / `event_seq` to the final `cycle_id`.

## 2. Pipeline

```
aiban-runtime → aiban-label(A) → aiban-label(B) → aiban-label(C) → aiban-result → aiban-result-db
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

### 3.1 Deprecated Fields

New Phase 2 code MUST NOT require these archived fields:

| Archived field | Replacement |
|---|---|
| `msg.payload.message_id` | `msg.payload.event_id` or `msg.aiban.event_id` |
| `msg.payload.frame_seq` | `msg.payload.event_seq` or `msg.aiban.event_seq` |
| `msg.payload.labels` | Scan `msg.payload.models[*].boxes[*]` in `aiban-label` |
| `msg.payload.label_summary` | Optional derived debug field only |
| `msg.payload.checksum` | Not required in local runtime pipe |
| `msg.payload._timing.wire_ms` | Use runtime timing/audit fields if available |
| `node_inbox_persist_ms` | Removed; no Inbox in new architecture |

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

The `aiban-result` node discovers the upstream label topology and adds an `abc_result` block. Fields from input
and `workflow` are preserved.

### 5.1 Transition Event (intermediate state change)

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

### 5.2 Terminal Event (OK, NG, TIMEOUT, INTERRUPTED)

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

### 5.3 result_event_id Format

```
{workflow_id}:{session_id}:{stream_id}:{cycle_id}:{result_status}
```

For transition events, `result_status` is `"TRANSITION"`.

Compatibility note: old Phase 2 code used `abc_result.event_id` for the terminal business result. New code
SHOULD write `abc_result.result_event_id`. During migration, nodes MAY keep `abc_result.event_id` as a
read-only alias, but new tests and database uniqueness MUST use `result_event_id`.

## 6. After aiban-result-db

The `aiban-result-db` node adds a `db_result` block. It only processes terminal events (non-null `result_status` in `["OK","NG","TIMEOUT","INTERRUPTED"]`).

```javascript
msg.db_result = {
  result_event_id: "abc-sequence-demo:session-uuid:group-1/source-1:550e8400:OK",
  status: "written",               // "written" | "failed" | "skipped"
  db_write_duration_ms: 3.60,
  attempts: 1,
  table: "icamera_data.workflow_abc_result"
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
| `aiban-workflow-audit` | File writes | `event_id + result_event_id` |

## 10. Error Handling

- If `aiban-label` encounters malformed input, it logs a warning and discards the message.
- If `aiban-result` detects an invalid state, it resets to IDLE and emits an INTERRUPTED result.
- If `aiban-result-db` fails all retries, it writes to `data/workflow/db-failed.jsonl` and emits `db_result.status = "failed"`.
- No node in the pipeline may throw uncaught exceptions — all errors must be caught, logged, and surfaced via `node.error()` or the output message.
