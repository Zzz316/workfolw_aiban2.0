"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { StabilityMetrics } = require("../lib/stability-metrics");

describe("T18 stability acceptance metrics", () => {
    test("healthy run satisfies zero-drop and zero-duplicate invariants", () => {
        const metrics = new StabilityMetrics();
        metrics.recordRuntimeEvent({ type: "runtime_starting", event_seq: 0 });
        metrics.recordRuntimeEvent({ type: "runtime_ready", event_seq: 1 });
        metrics.recordRuntimeEvent({ type: "frame", event_seq: 2,
            payload: { stream_id: "group-1/source-1" } });
        metrics.recordRuntimeEvent({ type: "command_result", event_seq: 3,
            payload: { command: "health", result: { queue_drops: 0, restart_count: 0 } } });
        metrics.recordTerminal({ result_event_id: "result-1" });
        metrics.recordSideEffect({ status: "delivered", result_event_id: "result-1" });
        metrics.recordRuntimeEvent({ type: "runtime_stopped", event_seq: 4 });
        const report = metrics.report();
        assert.equal(report.pass, true);
        assert.equal(report.counters.frames, 1);
    });

    test("duplicates, overflow, old-scene cycles and sequence regression fail visibly", () => {
        const metrics = new StabilityMetrics();
        metrics.recordRuntimeEvent({ type: "runtime_starting", event_seq: 1 });
        metrics.recordRuntimeEvent({ type: "runtime_ready", event_seq: 2 });
        metrics.recordRuntimeEvent({ type: "frame", event_seq: 3,
            payload: { stream_id: "group-1/source-1" } });
        metrics.recordRuntimeEvent({ type: "runtime_error", event_seq: 2,
            payload: { error_code: "QUEUE_OVERFLOW", message: "full" } });
        metrics.recordTerminal({ result_event_id: "same" });
        metrics.recordTerminal({ result_event_id: "same" });
        metrics.recordSideEffect({ status: "delivered", result_event_id: "same" });
        metrics.recordSideEffect({ status: "delivered", result_event_id: "same" });
        metrics.recordOldSceneCycle();
        const report = metrics.report({ expectedStops: 0 });
        assert.equal(report.pass, false);
        assert.equal(report.checks.event_seq_monotonic, false);
        assert.equal(report.checks.queue_overflow_zero, false);
        assert.equal(report.checks.duplicate_terminal_zero, false);
        assert.equal(report.checks.duplicate_side_effect_zero, false);
        assert.equal(report.checks.old_scene_new_cycles_zero, false);
    });
});
