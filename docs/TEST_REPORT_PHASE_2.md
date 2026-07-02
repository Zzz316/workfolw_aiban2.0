# Phase 2 Test Report: A-B-C Sequential Recognition Closed Loop

> Version: 1.0
> Date: 2026-07-02
> Branch: v2.0-node-red-runtime
> Test framework: Node.js built-in `node:test` + `node:assert/strict`

## Summary

| Metric | Value |
|--------|-------|
| Total test scenarios | 14 |
| Passed | 14 |
| Failed | 0 |
| Phase 1 regression | 4/4 passing |
| Total tests (all) | 18/18 passing |
| Test duration | ~310 ms |

## Test Scenarios

### Scenario 1: A→B→C → OK ✅
- **Input**: Three frames with A, B, C labels in order
- **Expected**: OK result with correct cycle_duration_ms, event_id, cycle_id
- **Result**: PASS — OK emitted, state resets to IDLE, all fields present

### Scenario 2: B first (wrong order) → NG ✅
- **Input**: B frame while IDLE (ignored), then A starts cycle, then C while WAIT_B
- **Expected**: NG with failure_reason mentioning "skip B" or "expected B"
- **Result**: PASS — B during IDLE correctly ignored, C during WAIT_B causes NG

### Scenario 3: A→C (skip B) → NG ✅
- **Input**: A starts cycle, C directly after (no B)
- **Expected**: NG with failure_reason about missing B
- **Result**: PASS — skip detected, NG emitted

### Scenario 4: A→B then timeout → TIMEOUT ✅
- **Input**: A starts cycle, B detected, then 1100ms pass (timeout=1000ms)
- **Expected**: TIMEOUT result on next frame
- **Result**: PASS — timeout detected, TIMEOUT status emitted

### Scenario 5: Multi-frame same label → single advance ✅
- **Input**: A label across multiple consecutive frames while WAIT_B
- **Expected**: Re-seeing A while WAIT_B should produce NG (wrong order)
- **Result**: PASS — duplicate label behavior correct

### Scenario 6: message_id replay → dedup ✅
- **Input**: Same message_id and frame_seq repeated
- **Expected**: Second delivery skipped (frame_seq dedup + message_id dedup)
- **Result**: PASS — both dedup mechanisms work correctly

### Scenario 7: Parallel sources → state isolation ✅
- **Input**: Source 1 follows A→B→C, Source 2 follows A→C (skip)
- **Expected**: Each source has independent state, Source 1 gets OK, Source 2 gets NG
- **Result**: PASS — separate state_keys, correct results per source

### Scenario 8: Different sessions → state isolation ✅
- **Input**: Two different session_id values, same frame_seq
- **Expected**: Independent states with different cycle_ids
- **Result**: PASS — sessions isolated, different cycle_ids generated

### Scenario 9: Write queue structure → stats correct ✅
- **Test**: MysqlWriteQueue initialization and stats tracking
- **Expected**: Initial stats show zero enqueued/pending
- **Result**: PASS — queue initializes correctly

### Scenario 10: Queue overflow protection ✅
- **Input**: 8 rows into queue with queueSize=3
- **Expected**: At least 3 enqueued, pending ≤ 3
- **Result**: PASS — overflow protection working

### Scenario 11: Restart recovery → INTERRUPTED ✅
- **Input**: Start A (WAIT_B), create new engine instance, jump past timeout
- **Expected**: `recover()` returns INTERRUPTED result, state reset to IDLE
- **Result**: PASS — recovery correctly generates INTERRUPTED

### Scenario 12: Audit log completeness ✅
- **Test**: Record full event sequence through WorkflowAuditLogger
- **Expected**: Text log contains events, JSONL parses correctly, CSV has headers and data
- **Result**: PASS — all three output files verified

### Additional: Label match function ✅
- **Test**: Pure label matching logic (model_id + label + confidence)
- **Expected**: Correct matching, below-confidence rejection, wrong model_id rejection
- **Result**: PASS — all edge cases handled

### Additional: WorkflowStateStore CRUD ✅
- **Test**: Full CRUD cycle: create, read, update, reset, list active, counts
- **Expected**: All operations produce correct results
- **Result**: PASS — state store works correctly

## Files Verified

| File | Status |
|------|--------|
| `lib/workflow-audit.js` | ✅ Tests passing |
| `lib/workflow-state-store.js` | ✅ Tests passing |
| `lib/sequence-engine.js` | ✅ Tests passing |
| `lib/mysql-write-queue.js` | ✅ Tests passing |
| `test/frame-core.test.js` (Phase 1) | ✅ 4/4 passing, no regression |

## Known Limitations

1. **MySQL integration**: Scenarios 9-10 test the queue mechanics but not actual MySQL writes. Real MySQL testing requires a running MySQL instance with `workflow_abc_result` table.
2. **ZMQ integration**: Phase 2 tests are unit-level; end-to-end frame→ZMQ→Node-RED integration is deferred to on-site testing with real cameras.
3. **Concurrent state access**: The current `WorkflowStateStore` uses synchronous SQLite which is serialized by Node.js's event loop. Multi-worker scenarios need further validation.
4. **aiban-abc-sequence Node-RED node**: The `SequenceEngine` class is separately tested; the Node-RED node wrapper (`aiban-abc-sequence.js`) needs manual testing in a real Node-RED instance.

## Reproduction Command

```bash
cd node-red-contrib-aiban-workflow
npm install
npm run test:phase2
```

Or run all tests:
```bash
npm test
```

## Next Steps

1. Deploy to on-site Node-RED instance with real AiBan SDK and MySQL
2. Run 24-hour stability test
3. Multi-camera concurrent test (max expected cameras)
4. Node-RED stop/recovery test (1 min, 5 min, 30 min)
5. Real SDK A→B→C→MySQL→日志 end-to-end demo
6. Proceed to Phase 3: business mode migration (monitor, timer_record, extended sequence)
