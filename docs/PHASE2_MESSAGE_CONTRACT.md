# Phase 2 Standard Message Contract

> Version: 1.0
> Date: 2026-07-02
> Scope: A-B-C sequential recognition closed loop

## 1. Overview

This document defines the standard message contract for Phase 2 nodes. Each node in the pipeline augments the `msg` object without removing upstream fields, enabling full traceability from `message_id` to `event_id`.

## 2. Pipeline

```
aiban-frame-input → aiban-label-match → aiban-abc-sequence → aiban-result-db
```

## 3. Input Message (from aiban-frame-input)

The `aiban-frame-input` node produces messages on its first output:

```javascript
msg = {
  _msgid: "frame-uuid",
  topic: "group-1/source-1",
  payload: {
    // === Frame Identity ===
    type: "frame",
    schema_version: 1,
    message_id: "uuid",              // Globally unique per-frame key
    session_id: "uuid",             // SDK pipeline session
    stream_id: "group-1/source-1",  // Stream identifier
    frame_seq: 10241,              // Per-stream monotonic sequence
    group_id: 1,
    source_id: 1,

    // === SDK Timing (all ms) ===
    captured_at: "2026-07-02T08:00:00.123+08:00",
    captured_monotonic_ns: 1234567890,
    sdk_received_at_ms: 1700000000000,
    sdk_convert_ms: 1.23,
    bridge_created_at_ms: 1700000000001,

    // === Model Detections ===
    models: {
      "1": {
        ok: true,
        boxes: [
          {
            label: "A",
            label_index: 0,
            confidence: 0.94,
            polygon: [[10,20],[100,20],[100,200],[10,200]],
            tracker_id: 27,
            mask_contours: [],
            sub_models: {}
          }
        ]
      }
    },

    // === Pre-computed by frame-input-node ===
    labels: [
      { model_id: "1", label: "A", confidence: 0.94 }
    ],
    label_summary: "m1:A(0.940)",

    // === Node-RED Receive Timing ===
    node_received_at: "2026-07-02T08:00:00.150+08:00",
    node_received_at_ms: 1700000000150,
    receive_diff_ms: 150,
    checksum: "sha256-hex",

    // === Internal Timing (for audit) ===
    _timing: {
      sdk_convert_ms: 1.23,
      python_to_node_ms: 149,
      wire_ms: 5,
      node_inbox_persist_ms: 0.45,
      node_received_at_ms: 1700000000150
    }
  },

  // === Convenience Accessors ===
  aiban: {
    message_id: "uuid",
    session_id: "uuid",
    stream_id: "group-1/source-1",
    frame_seq: 10241,
    timing: { ... }  // same as _timing
  }
};
```

## 4. After aiban-label-match

The `aiban-label-match` node adds a `workflow` block. Fields from the input are preserved.

```javascript
msg.workflow = {
  workflow_id: "abc-sequence-demo",   // Configured workflow ID
  matched_steps: ["A"],              // Step IDs that matched
  match_started_at_ms: 1700000000150.0,
  match_finished_at_ms: 1700000000150.42,
  match_duration_ms: 0.42
};
```

**Rules:**
- If no steps match, the message is discarded (not sent).
- `matched_steps` contains only the `id` values from the configured step list.
- Matching uses strict equality on `model_id` (string) and `label` (string), and `>=` on `confidence_min`.
- The `workflow` block does NOT overwrite any existing `msg.payload` fields.

## 5. After aiban-abc-sequence

The `aiban-abc-sequence` node adds an `abc_result` block. Fields from input and `workflow` are preserved.

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
  event_id: "abc-sequence-demo:session-uuid:group-1/source-1:550e8400:TRANSITION",
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
  event_id: "abc-sequence-demo:session-uuid:group-1/source-1:550e8400:OK",
  stage_duration_ms: 0.08
};
```

### 5.3 event_id Format

```
{workflow_id}:{session_id}:{stream_id}:{cycle_id}:{result_status}
```

For transition events, `result_status` is `"TRANSITION"`.

## 6. After aiban-result-db

The `aiban-result-db` node adds a `db_result` block. It only processes terminal events (non-null `result_status` in `["OK","NG","TIMEOUT","INTERRUPTED"]`).

```javascript
msg.db_result = {
  event_id: "abc-sequence-demo:session-uuid:group-1/source-1:550e8400:OK",
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
- Preserve `msg.payload.message_id` through the entire pipeline for traceability.
- Preserve `msg.payload.frame_seq`, `msg.payload.group_id`, `msg.payload.source_id`.

## 8. Timing Fields

| Field | Source | Meaning |
|-------|--------|---------|
| `captured_at` | SDK | Frame capture business time |
| `sdk_received_at_ms` | Bridge | SDK callback wall clock |
| `sdk_convert_ms` | Bridge | SDK metadata→dict conversion time |
| `python_to_node_ms` | frame-input | Bridge→Node total latency |
| `wire_ms` | frame-input | Network transmission time |
| `node_inbox_persist_ms` | frame-input | SQLite inbox write time |
| `receive_diff_ms` | frame-input | SDK→Node-RED total latency |
| `match_duration_ms` | label-match | Label matching computation time |
| `stage_duration_ms` | abc-sequence | State machine transition time |
| `cycle_duration_ms` | abc-sequence | Business cycle A→C duration |
| `db_write_duration_ms` | result-db | MySQL INSERT execution time |

## 9. Permitted Side Effects

| Node | Side Effect | Idempotency Key |
|------|-------------|-----------------|
| `aiban-label-match` | None (pure function) | N/A |
| `aiban-abc-sequence` | SQLite state update | `state_key` |
| `aiban-result-db` | MySQL INSERT | `event_id` UNIQUE index |
| `aiban-workflow-audit` | File writes | `message_id` + `event` |

## 10. Error Handling

- If `aiban-label-match` encounters malformed input, it logs a warning and discards the message.
- If `aiban-abc-sequence` detects an invalid state, it resets to IDLE and emits an INTERRUPTED result.
- If `aiban-result-db` fails all retries, it writes to `data/workflow/db-failed.jsonl` and emits `db_result.status = "failed"`.
- No node in the pipeline may throw uncaught exceptions — all errors must be caught, logged, and surfaced via `node.error()` or the output message.
