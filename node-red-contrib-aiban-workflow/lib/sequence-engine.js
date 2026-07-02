"use strict";

const { randomUUID } = require("node:crypto");
const { beijingNowISO } = require("./workflow-audit");

/**
 * Standalone A-B-C sequence state machine engine.
 *
 * Testable independently of Node-RED. The aiban-abc-sequence node
 * wraps this engine with Node-RED lifecycle hooks.
 *
 * State transitions:
 *   IDLE --[A detected]--> WAIT_B
 *   WAIT_B --[B detected]--> WAIT_C
 *   WAIT_C --[C detected]--> IDLE (OK)
 *
 *   Any wrong step → NG
 *   Timeout → TIMEOUT
 */

const STATES = Object.freeze({
    IDLE: "IDLE",
    WAIT_B: "WAIT_B",
    WAIT_C: "WAIT_C",
});

const TERMINAL_STATUSES = Object.freeze(["OK", "NG", "TIMEOUT", "INTERRUPTED"]);

/**
 * Create a composite state key.
 */
function makeStateKey(workflowId, sessionId, groupId, sourceId) {
    return `${workflowId}:${sessionId}:${groupId}:${sourceId}`;
}

/**
 * Create an event_id for idempotent tracking.
 */
function makeEventId(workflowId, sessionId, streamId, cycleId, status) {
    return `${workflowId}:${sessionId}:${streamId}:${cycleId}:${status}`;
}

function makeStreamId(groupId, sourceId) {
    return `group-${groupId}/source-${sourceId}`;
}

class SequenceEngine {
    /**
     * @param {object} opts
     * @param {string} opts.workflowId
     * @param {number} opts.cycleTimeoutMs
     * @param {boolean} opts.allowSameFrameRestart
     * @param {object} opts.stateStore - WorkflowStateStore instance
     */
    constructor(opts) {
        this.workflowId = opts.workflowId || "abc-sequence-demo";
        this.cycleTimeoutMs = Math.max(1000, Number(opts.cycleTimeoutMs) || 30000);
        this.allowSameFrameRestart = Boolean(opts.allowSameFrameRestart);
        this.stateStore = opts.stateStore;

        // Ordered expected steps
        this.stepOrder = ["A", "B", "C"];
    }

    _expectedStep(currentState) {
        switch (currentState) {
        case STATES.IDLE: return "A";
        case STATES.WAIT_B: return "B";
        case STATES.WAIT_C: return "C";
        default: return null;
        }
    }

    _nextState(currentState) {
        switch (currentState) {
        case STATES.IDLE: return STATES.WAIT_B;
        case STATES.WAIT_B: return STATES.WAIT_C;
        case STATES.WAIT_C: return STATES.IDLE;
        default: return STATES.IDLE;
        }
    }

    /**
     * Process a frame event. Returns an array of result objects.
     * Each result object has:
     *   - type: "transition" | "terminal"
     *   - state: the updated state object
     *   - result: the abc_result-compatible object
     *
     * @param {object} frame - { workflow_id, session_id, group_id, source_id, frame_seq, message_id, matched_steps[] }
     * @param {number} nowMs - current time in ms (injectable for testing)
     * @returns {object[]} events to emit
     */
    process(frame, nowMs = Date.now()) {
        const events = [];
        const {
            workflow_id: wfId,
            session_id: sessionId,
            group_id: groupId,
            source_id: sourceId,
            frame_seq: frameSeq,
            message_id: messageId,
            matched_steps: matchedSteps,
        } = frame;

        if (!sessionId || groupId === undefined || sourceId === undefined) {
            return events;
        }

        const stateKey = makeStateKey(wfId || this.workflowId, sessionId, groupId, sourceId);
        const streamId = makeStreamId(groupId, sourceId);
        let state = this.stateStore.getState(stateKey);

        // frame_seq dedup
        if (state && state.last_frame_seq !== null && frameSeq <= state.last_frame_seq) {
            return events;
        }

        // Timeout check
        if (state && state.current_state !== STATES.IDLE && state.cycle_started_at_ms) {
            const elapsed = nowMs - state.cycle_started_at_ms;
            if (elapsed > this.cycleTimeoutMs) {
                const result = this._buildTerminalResult(state, "TIMEOUT",
                    `周期超时 (${elapsed.toFixed(0)}ms > ${this.cycleTimeoutMs}ms)`,
                    nowMs, "TIMEOUT");
                events.push({
                    type: "terminal",
                    stateKey,
                    state: { ...state },
                    result,
                });
                this.stateStore.resetState(stateKey);
                state = null;
            }
        }

        // Try to start new cycle on IDLE
        if (!state || state.current_state === STATES.IDLE) {
            if (matchedSteps && matchedSteps.includes("A")) {
                if (state && state.last_message_id === messageId) {
                    return events; // dedup
                }
                const cycleId = randomUUID();
                const newState = {
                    state_key: stateKey,
                    workflow_id: wfId || this.workflowId,
                    session_id: sessionId,
                    group_id: groupId,
                    source_id: sourceId,
                    current_state: STATES.WAIT_B,
                    cycle_id: cycleId,
                    cycle_started_at_ms: nowMs,
                    start_frame_seq: frameSeq,
                    last_frame_seq: frameSeq,
                    last_message_id: messageId,
                    step_a_frame_seq: frameSeq,
                    step_b_frame_seq: null,
                    step_c_frame_seq: null,
                    step_a_at_ms: nowMs,
                    step_b_at_ms: null,
                    step_c_at_ms: null,
                    actual_sequence: JSON.stringify(["A"]),
                };
                this.stateStore.saveState(stateKey, newState);
                events.push({
                    type: "transition",
                    stateKey,
                    state: { ...newState },
                    step: "A",
                    previousState: STATES.IDLE,
                });
            }
            return events;
        }

        // message_id dedup at same step
        if (state.last_message_id === messageId) {
            return events;
        }

        // Active state handling
        const expected = this._expectedStep(state.current_state);

        if (state.current_state === STATES.WAIT_B) {
            if (matchedSteps && matchedSteps.includes("B")) {
                // Correct
                const actualSeq = JSON.parse(state.actual_sequence || "[]");
                actualSeq.push("B");
                const updated = {
                    ...state,
                    current_state: STATES.WAIT_C,
                    last_frame_seq: frameSeq,
                    last_message_id: messageId,
                    step_b_frame_seq: frameSeq,
                    step_b_at_ms: nowMs,
                    actual_sequence: JSON.stringify(actualSeq),
                };
                this.stateStore.saveState(stateKey, updated);
                events.push({
                    type: "transition",
                    stateKey,
                    state: { ...updated },
                    step: "B",
                    previousState: STATES.WAIT_B,
                });
            } else if (matchedSteps && (matchedSteps.includes("C") || matchedSteps.includes("A"))) {
                // Wrong order
                const wrong = matchedSteps.includes("C") ? "C" : "A";
                const reason = matchedSteps.includes("C")
                    ? "期望步骤 B，但识别到 C (跳步)"
                    : "期望步骤 B，但再次识别到 A (乱序)";
                const result = this._buildTerminalResult(state, "NG", reason, nowMs, wrong);
                this.stateStore.resetState(stateKey);
                events.push({
                    type: "terminal",
                    stateKey,
                    state: { ...state },
                    result,
                });
            } else {
                // Unmatched, update tracking only
                this.stateStore.saveState(stateKey, {
                    ...state,
                    last_frame_seq: frameSeq,
                    last_message_id: messageId,
                });
            }
        } else if (state.current_state === STATES.WAIT_C) {
            if (matchedSteps && matchedSteps.includes("C")) {
                // OK!
                const actualSeq = JSON.parse(state.actual_sequence || "[]");
                actualSeq.push("C");
                const result = this._buildTerminalResult(state, "OK", null, nowMs, "C");
                const completed = {
                    ...state,
                    step_c_frame_seq: frameSeq,
                    step_c_at_ms: nowMs,
                    actual_sequence: JSON.stringify(actualSeq),
                };
                this.stateStore.resetState(stateKey);
                events.push({
                    type: "terminal",
                    stateKey,
                    state: { ...completed },
                    result,
                });
            } else if (matchedSteps && (matchedSteps.includes("A") || matchedSteps.includes("B"))) {
                // Wrong
                const wrong = matchedSteps.includes("A") ? "A" : "B";
                const result = this._buildTerminalResult(state, "NG",
                    `期望步骤 C，但识别到 ${wrong} (乱序)`, nowMs, wrong);
                this.stateStore.resetState(stateKey);
                events.push({
                    type: "terminal",
                    stateKey,
                    state: { ...state },
                    result,
                });
            } else {
                // Unmatched, update tracking
                this.stateStore.saveState(stateKey, {
                    ...state,
                    last_frame_seq: frameSeq,
                    last_message_id: messageId,
                });
            }
        }

        return events;
    }

    _buildTerminalResult(state, status, reason, nowMs, recognizedStep) {
        const streamId = makeStreamId(state.group_id, state.source_id);
        const cycleDuration = state.cycle_started_at_ms
            ? nowMs - state.cycle_started_at_ms
            : null;
        return {
            cycle_id: state.cycle_id,
            previous_state: state.current_state,
            current_state: STATES.IDLE,
            recognized_step: recognizedStep || null,
            expected_step: this._expectedStep(state.current_state),
            result_status: status,
            failure_reason: reason || null,
            cycle_started_at: state.cycle_started_at_ms
                ? beijingNowISO(state.cycle_started_at_ms) : null,
            cycle_finished_at: beijingNowISO(nowMs),
            cycle_duration_ms: cycleDuration,
            event_id: makeEventId(
                this.workflowId, state.session_id, streamId,
                state.cycle_id, status
            ),
            stage_duration_ms: 0,
            actual_sequence: state.actual_sequence,
            session_id: state.session_id,
            group_id: state.group_id,
            source_id: state.source_id,
            stream_id: streamId,
            start_frame_seq: state.start_frame_seq,
            end_frame_seq: state.last_frame_seq,
        };
    }

    /**
     * Check for expired active states (for restart recovery).
     * Returns terminal results for expired states.
     */
    recover(nowMs = Date.now()) {
        const results = [];
        const active = this.stateStore.listActive();
        for (const state of active) {
            const elapsed = state.cycle_started_at_ms
                ? nowMs - state.cycle_started_at_ms
                : Infinity;
            if (elapsed > this.cycleTimeoutMs || !state.cycle_started_at_ms) {
                const result = this._buildTerminalResult(
                    state, "INTERRUPTED",
                    `Node-RED 重启/Deploy 时周期已过期 (elapsed=${elapsed.toFixed(0)}ms)`,
                    nowMs, null
                );
                this.stateStore.resetState(state.state_key);
                results.push({ state, result });
            }
        }
        return results;
    }
}

module.exports = {
    SequenceEngine,
    STATES,
    TERMINAL_STATUSES,
    makeStateKey,
    makeEventId,
    makeStreamId,
};
