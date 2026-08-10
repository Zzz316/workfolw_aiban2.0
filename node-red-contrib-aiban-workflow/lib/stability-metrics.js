"use strict";

class StabilityMetrics {
    constructor() {
        this.startedAt = new Date().toISOString();
        this.frames = 0;
        this.framesByStream = {};
        this.lastEventSeq = null;
        this.nonMonotonicEvents = 0;
        this.queueDrops = 0;
        this.queueOverflows = 0;
        this.runtimeStarts = 0;
        this.runtimeReady = 0;
        this.runtimeStops = 0;
        this.runtimeErrors = [];
        this.restartCountMax = 0;
        this.resultIds = new Set();
        this.duplicateTerminals = 0;
        this.sideEffectIds = new Set();
        this.duplicateSideEffects = 0;
        this.oldSceneCycles = 0;
        this.screenshotTimeouts = 0;
    }

    recordRuntimeEvent(event) {
        const seq = Number(event?.event_seq);
        if (Number.isFinite(seq)) {
            if (this.lastEventSeq !== null && seq <= this.lastEventSeq) this.nonMonotonicEvents++;
            this.lastEventSeq = seq;
        }
        const type = event?.type;
        if (type === "runtime_starting") this.runtimeStarts++;
        if (type === "runtime_ready") this.runtimeReady++;
        if (type === "runtime_stopped") this.runtimeStops++;
        if (type === "frame") {
            this.frames++;
            const stream = event.payload?.stream_id || "unknown";
            this.framesByStream[stream] = (this.framesByStream[stream] || 0) + 1;
        }
        if (type === "runtime_error") {
            const code = event.payload?.error_code || "UNKNOWN";
            this.runtimeErrors.push({ code, message: event.payload?.message || "" });
            if (code === "QUEUE_OVERFLOW") this.queueOverflows++;
        }
        if (type === "screenshot_result" && event.payload?.ok === false) this.screenshotTimeouts++;
        if (type === "command_result" && event.payload?.command === "health") {
            const health = event.payload?.result || {};
            this.queueDrops = Math.max(this.queueDrops, Number(health.queue_drops || 0));
            this.restartCountMax = Math.max(this.restartCountMax, Number(health.restart_count || 0));
        }
    }

    recordTerminal(result) {
        const id = result?.result_event_id || result?.workflow?.result?.result_event_id;
        if (!id) return;
        if (this.resultIds.has(id)) this.duplicateTerminals++;
        else this.resultIds.add(id);
    }

    recordSideEffect(info) {
        const id = info?.result_event_id;
        if (!id || info.status !== "delivered") return;
        if (this.sideEffectIds.has(id)) this.duplicateSideEffects++;
        else this.sideEffectIds.add(id);
    }

    recordOldSceneCycle() {
        this.oldSceneCycles++;
    }

    report(options = {}) {
        const expectedStops = Number(options.expectedStops || 1);
        const checks = {
            frames_received: this.frames > 0,
            event_seq_monotonic: this.nonMonotonicEvents === 0,
            silent_queue_drops_zero: this.queueDrops === 0,
            queue_overflow_zero: this.queueOverflows === 0,
            duplicate_terminal_zero: this.duplicateTerminals === 0,
            duplicate_side_effect_zero: this.duplicateSideEffects === 0,
            old_scene_new_cycles_zero: this.oldSceneCycles === 0,
            runtime_stopped: this.runtimeStops >= expectedStops,
        };
        return {
            schema_version: "stability-report/v1",
            started_at: this.startedAt,
            finished_at: new Date().toISOString(),
            counters: {
                frames: this.frames,
                frames_by_stream: this.framesByStream,
                non_monotonic_events: this.nonMonotonicEvents,
                queue_drops: this.queueDrops,
                queue_overflows: this.queueOverflows,
                runtime_starts: this.runtimeStarts,
                runtime_ready: this.runtimeReady,
                runtime_stops: this.runtimeStops,
                restart_count_max: this.restartCountMax,
                duplicate_terminals: this.duplicateTerminals,
                duplicate_side_effects: this.duplicateSideEffects,
                old_scene_new_cycles: this.oldSceneCycles,
                screenshot_timeouts: this.screenshotTimeouts,
            },
            runtime_errors: this.runtimeErrors,
            checks,
            pass: Object.values(checks).every(Boolean),
        };
    }
}

module.exports = { StabilityMetrics };
