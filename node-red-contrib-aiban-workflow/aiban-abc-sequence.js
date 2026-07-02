"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WorkflowStateStore } = require("./lib/workflow-state-store");
const { WorkflowAuditLogger, beijingNowISO } = require("./lib/workflow-audit");

/**
 * aiban-abc-sequence — A→B→C Sequential Recognition State Machine
 *
 * Runs entirely in Node-RED runtime. Tracks strict A→B→C sequence per
 * (workflow_id + session_id + group_id + source_id) isolation key.
 *
 * Features:
 * - States: IDLE → WAIT_B → WAIT_C → terminal (OK/NG/TIMEOUT/INTERRUPTED)
 * - Edge detection per label (same label multi-frame = single transition)
 * - frame_seq dedup (older or same = skip)
 * - message_id dedup at same step
 * - Timeout detection
 * - SQLite state persistence (survives Node-RED restart)
 * - Restart recovery: expired cycles → INTERRUPTED; active cycles → resume
 * - Manual reset via input msg.topic === "aiban-reset"
 * - Audit logging via WorkflowAuditLogger
 */

const STATES = {
    IDLE: "IDLE",
    WAIT_B: "WAIT_B",
    WAIT_C: "WAIT_C",
};

// Ordered list of expected steps (A→B→C)
const STEP_ORDER = ["A", "B", "C"];

module.exports = function registerAbcSequenceNode(RED) {
    function AibanAbcSequenceNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // === Configuration ===
        const workflowId = config.workflow_id || "abc-sequence-demo";
        const cycleTimeoutMs = Math.max(1000, Number(config.cycle_timeout_ms) || 30000);
        const allowSameFrameRestart = config.allow_same_frame_restart === true
            || config.allow_same_frame_restart === "true";

        // Parse steps from config
        const configSteps = [];
        if (Array.isArray(config.steps)) {
            for (const s of config.steps) {
                if (s.id && s.label) {
                    configSteps.push({
                        id: String(s.id),
                        model_id: String(s.model_id || "1"),
                        label: String(s.label),
                        confidence_min: Number(s.confidence) || 0.5,
                    });
                }
            }
        }
        // Build step lookup
        const stepDefs = {};
        for (const s of configSteps) {
            stepDefs[s.id] = s;
        }

        // State DB path
        const stateDbPath = config.stateDbPath
            ? (path.isAbsolute(config.stateDbPath)
                ? config.stateDbPath
                : path.join(RED.settings.userDir || ".", config.stateDbPath))
            : path.join(RED.settings.userDir || ".", "data", "workflow", "abc-state.db");

        // Audit directory
        const auditDir = config.auditDir
            ? (path.isAbsolute(config.auditDir)
                ? config.auditDir
                : path.join(RED.settings.userDir || ".", config.auditDir))
            : path.join(process.cwd(), "logs", "workflow");

        // === State ===
        const stateStore = new WorkflowStateStore(stateDbPath);
        const auditLogger = new WorkflowAuditLogger(auditDir);

        let closed = false;

        // Timer handles for timeout detection
        const timeoutTimers = new Map(); // state_key → setTimeout handle

        // === Deploy/Restart Recovery ===
        function recoverOnStart() {
            const active = stateStore.listActive();
            if (active.length === 0) return;

            node.warn(
                `[abc-sequence] 发现 ${active.length} 个未完成周期, 正在恢复...`
            );

            const now = Date.now();
            for (const state of active) {
                const startedAt = state.cycle_started_at_ms;
                const elapsed = startedAt ? now - startedAt : Infinity;

                if (elapsed > cycleTimeoutMs || !startedAt) {
                    // Expired → INTERRUPTED
                    node.warn(
                        `[abc-sequence] ${state.state_key} cycle=${(state.cycle_id || "").slice(0, 8)}`
                        + ` 已过期 (${elapsed.toFixed(0)}ms > ${cycleTimeoutMs}ms), 标记为 INTERRUPTED`
                    );
                    const result = _buildResult(
                        state, "INTERRUPTED",
                        `Node-RED 重启/Deploy 时周期已过期 (elapsed=${elapsed.toFixed(0)}ms)`
                    );
                    stateStore.resetState(state.state_key);

                    // Emit INTERRUPTED result
                    const msg = _makeResultMessage(state, result);
                    auditLogger.record("sequence_completed", {
                        cycle_id: result.cycle_id,
                        result_status: "INTERRUPTED",
                        failure_reason: result.failure_reason,
                        cycle_duration_ms: elapsed,
                        actual_sequence: state.actual_sequence || "",
                        workflow_id: workflowId,
                        message_id: state.last_message_id || "",
                        event_id: result.event_id,
                        frame_seq: state.last_frame_seq ?? 0,
                        group_id: state.group_id,
                        source_id: state.source_id,
                        session_id: state.session_id,
                        stream_id: `${workflowId}:${state.session_id}:${state.group_id}:${state.source_id}`,
                    });
                    node.send(msg);
                } else {
                    // Active → resume, schedule timeout
                    node.warn(
                        `[abc-sequence] ${state.state_key} cycle=${(state.cycle_id || "").slice(0, 8)}`
                        + ` 已运行 ${elapsed.toFixed(0)}ms, 恢复监控`
                    );
                    _scheduleTimeout(state.state_key, cycleTimeoutMs - elapsed);
                }
            }
        }

        function _scheduleTimeout(stateKey, delayMs) {
            // Clear existing timer
            if (timeoutTimers.has(stateKey)) {
                clearTimeout(timeoutTimers.get(stateKey));
            }
            const timer = setTimeout(() => _handleTimeout(stateKey), delayMs);
            timer.unref(); // Don't keep process alive
            timeoutTimers.set(stateKey, timer);
        }

        function _clearTimeout(stateKey) {
            if (timeoutTimers.has(stateKey)) {
                clearTimeout(timeoutTimers.get(stateKey));
                timeoutTimers.delete(stateKey);
            }
        }

        function _handleTimeout(stateKey) {
            if (closed) return;
            timeoutTimers.delete(stateKey);

            const state = stateStore.getState(stateKey);
            if (!state || state.current_state === STATES.IDLE) return;

            const now = Date.now();
            const cycleDuration = state.cycle_started_at_ms
                ? now - state.cycle_started_at_ms
                : cycleTimeoutMs;

            const result = _buildResult(
                state, "TIMEOUT",
                `周期超时: 在 ${cycleTimeoutMs}ms 内未完成, 当前状态 ${state.current_state}, `
                + `实际步骤: ${state.actual_sequence || "[]"}`
            );
            result.cycle_duration_ms = cycleDuration;
            result.cycle_finished_at = beijingNowISO(now);

            stateStore.resetState(stateKey);

            const msg = _makeResultMessage(state, result);
            auditLogger.record("sequence_timeout", {
                cycle_id: result.cycle_id,
                result_status: "TIMEOUT",
                cycle_duration_ms: cycleDuration,
                actual_sequence: state.actual_sequence || "",
                workflow_id: workflowId,
                message_id: state.last_message_id || "",
                event_id: result.event_id,
                frame_seq: state.last_frame_seq ?? 0,
                group_id: state.group_id,
                source_id: state.source_id,
                session_id: state.session_id,
                stream_id: _makeStreamId(state.group_id, state.source_id),
                failure_reason: result.failure_reason,
            });
            node.send(msg);

            // Write cycle summary CSV row
            auditLogger.recordCycleSummary(_cycleSummaryFromResult(state, result));
        }

        function _makeStreamId(groupId, sourceId) {
            return `group-${groupId}/source-${sourceId}`;
        }

        function _buildResult(state, status, failureReason) {
            const now = Date.now();
            return {
                cycle_id: state.cycle_id,
                previous_state: state.current_state,
                current_state: STATES.IDLE,
                recognized_step: null,
                expected_step: _expectedStep(state.current_state),
                result_status: status,
                failure_reason: failureReason || null,
                cycle_started_at: state.cycle_started_at_ms
                    ? beijingNowISO(state.cycle_started_at_ms) : null,
                cycle_finished_at: beijingNowISO(now),
                cycle_duration_ms: state.cycle_started_at_ms
                    ? now - state.cycle_started_at_ms : null,
                event_id: null, // filled below
                stage_duration_ms: 0,
            };
        }

        function _expectedStep(currentState) {
            switch (currentState) {
            case STATES.IDLE: return "A";
            case STATES.WAIT_B: return "B";
            case STATES.WAIT_C: return "C";
            default: return null;
            }
        }

        function _makeEventId(workflowId, sessionId, streamId, cycleId, status) {
            return `${workflowId}:${sessionId}:${streamId}:${cycleId}:${status}`;
        }

        function _makeResultMessage(state, result) {
            const streamId = _makeStreamId(state.group_id, state.source_id);
            result.event_id = _makeEventId(
                workflowId, state.session_id, streamId,
                result.cycle_id, result.result_status || "TRANSITION"
            );
            return {
                _msgid: result.event_id,
                topic: streamId,
                payload: {
                    message_id: state.last_message_id || "",
                    session_id: state.session_id,
                    stream_id: streamId,
                    frame_seq: state.last_frame_seq,
                    group_id: state.group_id,
                    source_id: state.source_id,
                },
                aiban: {
                    message_id: state.last_message_id || "",
                    session_id: state.session_id,
                    stream_id: streamId,
                    frame_seq: state.last_frame_seq,
                },
                workflow: {
                    workflow_id: workflowId,
                    matched_steps: result.recognized_step ? [result.recognized_step] : [],
                },
                abc_result: result,
                _audit: auditLogger,
            };
        }

        function _makeTransitionMessage(state, stepId, stageDurationMs) {
            const streamId = _makeStreamId(state.group_id, state.source_id);
            const result = {
                cycle_id: state.cycle_id,
                previous_state: _previousStateFor(state.current_state),
                current_state: state.current_state,
                recognized_step: stepId,
                expected_step: _expectedStep(_previousStateFor(state.current_state)),
                result_status: null,
                failure_reason: null,
                cycle_started_at: state.cycle_started_at_ms
                    ? beijingNowISO(state.cycle_started_at_ms) : null,
                cycle_finished_at: null,
                cycle_duration_ms: null,
                event_id: _makeEventId(
                    workflowId, state.session_id, streamId,
                    state.cycle_id, "TRANSITION"
                ),
                stage_duration_ms: Number(stageDurationMs.toFixed(3)),
            };
            return {
                _msgid: result.event_id,
                topic: streamId,
                payload: {
                    message_id: state.last_message_id || "",
                    session_id: state.session_id,
                    stream_id: streamId,
                    frame_seq: state.last_frame_seq,
                    group_id: state.group_id,
                    source_id: state.source_id,
                },
                aiban: {
                    message_id: state.last_message_id || "",
                    session_id: state.session_id,
                    stream_id: streamId,
                    frame_seq: state.last_frame_seq,
                },
                workflow: {
                    workflow_id: workflowId,
                    matched_steps: stepId ? [stepId] : [],
                },
                abc_result: result,
                _audit: auditLogger,
            };
        }

        function _previousStateFor(currentState) {
            switch (currentState) {
            case STATES.WAIT_B: return STATES.IDLE;
            case STATES.WAIT_C: return STATES.WAIT_B;
            case STATES.IDLE: return STATES.WAIT_C; // completed
            default: return STATES.IDLE;
            }
        }

        function _cycleSummaryFromResult(state, result) {
            return {
                cycle_id: result.cycle_id,
                workflow_id: workflowId,
                stream_id: _makeStreamId(state.group_id, state.source_id),
                start_frame_seq: state.start_frame_seq,
                end_frame_seq: state.last_frame_seq,
                step_a_frame: state.step_a_frame_seq,
                step_a_at: state.step_a_at_ms ? beijingNowISO(state.step_a_at_ms) : "",
                step_b_frame: state.step_b_frame_seq,
                step_b_at: state.step_b_at_ms ? beijingNowISO(state.step_b_at_ms) : "",
                step_c_frame: state.step_c_frame_seq,
                step_c_at: state.step_c_at_ms ? beijingNowISO(state.step_c_at_ms) : "",
                match_duration_ms: null, // filled by label-match
                sequence_duration_ms: result.stage_duration_ms,
                total_processing_ms: null, // accumulated
                cycle_duration_ms: result.cycle_duration_ms,
                result_status: result.result_status,
                failure_reason: result.failure_reason || "",
            };
        }

        function _actualSequenceFromSteps(stepA, stepB, stepC) {
            const seq = [];
            if (stepA) seq.push("A");
            if (stepB) seq.push("B");
            if (stepC) seq.push("C");
            return JSON.stringify(seq);
        }

        // === Main Input Handler ===
        node.on("input", function onInput(msg, send, done) {
            if (closed) {
                if (done) done();
                return;
            }

            // Manual reset: msg.topic === "aiban-reset"
            if (msg.topic === "aiban-reset") {
                const resetKey = msg.payload?.state_key
                    || WorkflowStateStore.makeKey(
                        msg.payload?.workflow_id || workflowId,
                        msg.payload?.session_id || "",
                        msg.payload?.group_id || 0,
                        msg.payload?.source_id || 0
                    );
                const prev = stateStore.resetState(resetKey);
                _clearTimeout(resetKey);
                if (prev) {
                    const result = _buildResult(prev, "INTERRUPTED",
                        `手动重置: ${msg.payload?.reason || "manual"}`
                        + ` by ${msg.payload?.operator || "unknown"}`);
                    node.send(_makeResultMessage(prev, result));
                }
                node.status({
                    fill: "blue",
                    shape: "dot",
                    text: `reset: ${resetKey}`,
                });
                if (done) done();
                return;
            }

            const transStart = process.hrtime.bigint();

            try {
                // Extract key fields
                const frame = msg.payload;
                const workflowData = msg.workflow || {};

                const wfId = workflowData.workflow_id || workflowId;
                const sessionId = frame.session_id || msg.aiban?.session_id || "";
                const groupId = Number(frame.group_id ?? 0);
                const sourceId = Number(frame.source_id ?? 0);
                const frameSeq = Number(frame.frame_seq ?? 0);
                const messageId = frame.message_id || msg.aiban?.message_id || "";
                const matchedSteps = workflowData.matched_steps || [];

                if (!sessionId || !groupId || frameSeq === undefined) {
                    node.warn("[abc-sequence] 帧缺少必要字段 (session_id/group_id/frame_seq), 跳过");
                    if (done) done();
                    return;
                }

                const stateKey = WorkflowStateStore.makeKey(wfId, sessionId, groupId, sourceId);
                const streamId = _makeStreamId(groupId, sourceId);

                // Record frame_received audit event
                auditLogger.record("frame_received", {
                    message_id: messageId,
                    frame_seq: frameSeq,
                    group_id: groupId,
                    source_id: sourceId,
                    session_id: sessionId,
                    stream_id: streamId,
                    label_summary: frame.label_summary || "",
                });

                if (matchedSteps.length > 0) {
                    auditLogger.record("label_match_finished", {
                        message_id: messageId,
                        frame_seq: frameSeq,
                        group_id: groupId,
                        source_id: sourceId,
                        session_id: sessionId,
                        stream_id: streamId,
                        matched_steps: matchedSteps,
                        match_duration_ms: workflowData.match_duration_ms || 0,
                    });
                }

                // Load current state
                let state = stateStore.getState(stateKey);

                // frame_seq dedup
                if (state && state.last_frame_seq !== null
                    && frameSeq <= state.last_frame_seq) {
                    if (done) done();
                    return;
                }

                // Check for timeout on existing active state
                if (state && state.current_state !== STATES.IDLE
                    && state.cycle_started_at_ms) {
                    const elapsed = Date.now() - state.cycle_started_at_ms;
                    if (elapsed > cycleTimeoutMs) {
                        // Timeout!
                        _clearTimeout(stateKey);
                        const result = _buildResult(state, "TIMEOUT",
                            `周期超时 (${elapsed.toFixed(0)}ms > ${cycleTimeoutMs}ms)`);
                        result.cycle_duration_ms = elapsed;
                        result.cycle_finished_at = beijingNowISO();
                        result.stage_duration_ms = Number(
                            process.hrtime.bigint() - transStart
                        ) / 1e6;

                        stateStore.resetState(stateKey);

                        const timeoutMsg = _makeResultMessage(state, result);
                        auditLogger.record("sequence_timeout", {
                            cycle_id: result.cycle_id,
                            result_status: "TIMEOUT",
                            cycle_duration_ms: elapsed,
                            actual_sequence: state.actual_sequence || "",
                            workflow_id: wfId,
                            message_id: messageId,
                            event_id: result.event_id,
                            frame_seq: frameSeq,
                            group_id: groupId,
                            source_id: sourceId,
                            session_id: sessionId,
                            stream_id: streamId,
                            failure_reason: result.failure_reason,
                        });
                        auditLogger.recordCycleSummary(
                            _cycleSummaryFromResult(state, result)
                        );
                        node.send(timeoutMsg);
                        state = null; // Reset for potential new cycle below
                    }
                }

                // If state is null or IDLE, try to start a new cycle
                if (!state || state.current_state === STATES.IDLE) {
                    if (matchedSteps.includes("A")) {
                        // message_id dedup at IDLE step A
                        if (state && state.last_message_id === messageId) {
                            if (done) done();
                            return;
                        }
                        const now = Date.now();
                        const cycleId = randomUUID();
                        const newState = {
                            state_key: stateKey,
                            workflow_id: wfId,
                            session_id: sessionId,
                            group_id: groupId,
                            source_id: sourceId,
                            current_state: STATES.WAIT_B,
                            cycle_id: cycleId,
                            cycle_started_at_ms: now,
                            start_frame_seq: frameSeq,
                            last_frame_seq: frameSeq,
                            last_message_id: messageId,
                            step_a_frame_seq: frameSeq,
                            step_b_frame_seq: null,
                            step_c_frame_seq: null,
                            step_a_at_ms: now,
                            step_b_at_ms: null,
                            step_c_at_ms: null,
                            actual_sequence: JSON.stringify(["A"]),
                        };
                        stateStore.saveState(stateKey, newState);
                        _scheduleTimeout(stateKey, cycleTimeoutMs);

                        const stageDurationMs = Number(
                            process.hrtime.bigint() - transStart
                        ) / 1e6;

                        const transMsg = _makeTransitionMessage(
                            { ...newState, current_state: STATES.WAIT_B },
                            "A", stageDurationMs
                        );
                        auditLogger.record("sequence_transition", {
                            cycle_id: cycleId,
                            previous_state: STATES.IDLE,
                            current_state: STATES.WAIT_B,
                            recognized_step: "A",
                            stage_duration_ms: Number(stageDurationMs.toFixed(3)),
                            workflow_id: wfId,
                            message_id: messageId,
                            frame_seq: frameSeq,
                            group_id: groupId,
                            source_id: sourceId,
                            session_id: sessionId,
                            stream_id: streamId,
                        });
                        node.send(transMsg);

                        node.status({
                            fill: "yellow",
                            shape: "dot",
                            text: `g${groupId}/s${sourceId} A → WAIT_B`,
                        });
                    }
                    // If no A match while IDLE, just ignore
                    if (done) done();
                    return;
                }

                // === Active state: WAIT_B or WAIT_C ===

                // message_id dedup at same step
                if (state.last_message_id === messageId) {
                    if (done) done();
                    return;
                }

                const now = Date.now();
                const expectedStep = _expectedStep(state.current_state);
                const expectedStepId = expectedStep; // "B" or "C"

                if (state.current_state === STATES.WAIT_B) {
                    if (matchedSteps.includes("B")) {
                        // Correct: B found
                        const actualSeq = JSON.parse(state.actual_sequence || "[]");
                        actualSeq.push("B");
                        const updatedState = {
                            ...state,
                            current_state: STATES.WAIT_C,
                            last_frame_seq: frameSeq,
                            last_message_id: messageId,
                            step_b_frame_seq: frameSeq,
                            step_b_at_ms: now,
                            actual_sequence: JSON.stringify(actualSeq),
                        };
                        stateStore.saveState(stateKey, updatedState);
                        // Re-schedule timeout for remaining time
                        _scheduleTimeout(stateKey, cycleTimeoutMs - (now - state.cycle_started_at_ms));

                        const stageDurationMs = Number(
                            process.hrtime.bigint() - transStart
                        ) / 1e6;

                        const transMsg = _makeTransitionMessage(
                            { ...updatedState, current_state: STATES.WAIT_C },
                            "B", stageDurationMs
                        );
                        auditLogger.record("sequence_transition", {
                            cycle_id: state.cycle_id,
                            previous_state: STATES.WAIT_B,
                            current_state: STATES.WAIT_C,
                            recognized_step: "B",
                            stage_duration_ms: Number(stageDurationMs.toFixed(3)),
                            workflow_id: wfId,
                            message_id: messageId,
                            frame_seq: frameSeq,
                            group_id: groupId,
                            source_id: sourceId,
                            session_id: sessionId,
                            stream_id: streamId,
                        });
                        node.send(transMsg);
                        node.status({
                            fill: "yellow",
                            shape: "dot",
                            text: `g${groupId}/s${sourceId} B → WAIT_C`,
                        });
                    } else if (matchedSteps.includes("C")) {
                        // Wrong: C before B
                        _clearTimeout(stateKey);
                        const result = _buildResult(
                            state, "NG",
                            `期望步骤 B，但识别到 C (跳步)`
                        );
                        result.recognized_step = "C";
                        result.cycle_duration_ms = now - state.cycle_started_at_ms;
                        result.cycle_finished_at = beijingNowISO(now);
                        result.stage_duration_ms = Number(
                            process.hrtime.bigint() - transStart
                        ) / 1e6;
                        result.actual_sequence = state.actual_sequence;

                        stateStore.resetState(stateKey);
                        const ngMsg = _makeResultMessage(state, result);
                        auditLogger.record("sequence_failed", {
                            cycle_id: result.cycle_id,
                            result_status: "NG",
                            failure_reason: result.failure_reason,
                            actual_sequence: state.actual_sequence || "",
                            cycle_duration_ms: result.cycle_duration_ms,
                            workflow_id: wfId,
                            message_id: messageId,
                            event_id: result.event_id,
                            frame_seq: frameSeq,
                            group_id: groupId,
                            source_id: sourceId,
                            session_id: sessionId,
                            stream_id: streamId,
                        });
                        auditLogger.recordCycleSummary(
                            _cycleSummaryFromResult(state, result)
                        );
                        node.send(ngMsg);
                        node.status({
                            fill: "red",
                            shape: "ring",
                            text: `g${groupId}/s${sourceId} NG: 跳步 C`,
                        });
                    } else if (matchedSteps.includes("A")) {
                        // A again while WAIT_B — wrong order
                        _clearTimeout(stateKey);
                        const result = _buildResult(
                            state, "NG",
                            `期望步骤 B，但再次识别到 A (乱序)`
                        );
                        result.recognized_step = "A";
                        result.cycle_duration_ms = now - state.cycle_started_at_ms;
                        result.cycle_finished_at = beijingNowISO(now);
                        result.stage_duration_ms = Number(
                            process.hrtime.bigint() - transStart
                        ) / 1e6;
                        result.actual_sequence = state.actual_sequence;

                        stateStore.resetState(stateKey);
                        const ngMsg = _makeResultMessage(state, result);
                        auditLogger.record("sequence_failed", {
                            cycle_id: result.cycle_id,
                            result_status: "NG",
                            failure_reason: result.failure_reason,
                            actual_sequence: state.actual_sequence || "",
                            cycle_duration_ms: result.cycle_duration_ms,
                            workflow_id: wfId,
                            message_id: messageId,
                            event_id: result.event_id,
                            frame_seq: frameSeq,
                            group_id: groupId,
                            source_id: sourceId,
                            session_id: sessionId,
                            stream_id: streamId,
                        });
                        auditLogger.recordCycleSummary(
                            _cycleSummaryFromResult(state, result)
                        );
                        node.send(ngMsg);
                        node.status({
                            fill: "red",
                            shape: "ring",
                            text: `g${groupId}/s${sourceId} NG: 乱序 A`,
                        });
                    }
                    // Else: unmatched label, just update frame tracking
                    else {
                        stateStore.saveState(stateKey, {
                            ...state,
                            last_frame_seq: frameSeq,
                            last_message_id: messageId,
                        });
                    }
                } else if (state.current_state === STATES.WAIT_C) {
                    if (matchedSteps.includes("C")) {
                        // Correct: C found → OK!
                        _clearTimeout(stateKey);
                        const actualSeq = JSON.parse(state.actual_sequence || "[]");
                        actualSeq.push("C");
                        const cycleDuration = now - state.cycle_started_at_ms;
                        const result = {
                            cycle_id: state.cycle_id,
                            previous_state: STATES.WAIT_C,
                            current_state: STATES.IDLE,
                            recognized_step: "C",
                            expected_step: "C",
                            result_status: "OK",
                            failure_reason: null,
                            cycle_started_at: beijingNowISO(state.cycle_started_at_ms),
                            cycle_finished_at: beijingNowISO(now),
                            cycle_duration_ms: cycleDuration,
                            event_id: _makeEventId(wfId, sessionId, streamId,
                                state.cycle_id, "OK"),
                            stage_duration_ms: Number(
                                process.hrtime.bigint() - transStart
                            ) / 1e6,
                            actual_sequence: JSON.stringify(actualSeq),
                        };

                        // Update state with C info before reset
                        const completedState = {
                            ...state,
                            step_c_frame_seq: frameSeq,
                            step_c_at_ms: now,
                            actual_sequence: JSON.stringify(actualSeq),
                        };
                        stateStore.resetState(stateKey);

                        const okMsg = _makeResultMessage(completedState, result);
                        auditLogger.record("sequence_completed", {
                            cycle_id: result.cycle_id,
                            result_status: "OK",
                            cycle_duration_ms: cycleDuration,
                            actual_sequence: JSON.stringify(actualSeq),
                            total_processing_ms: result.stage_duration_ms,
                            workflow_id: wfId,
                            message_id: messageId,
                            event_id: result.event_id,
                            frame_seq: frameSeq,
                            group_id: groupId,
                            source_id: sourceId,
                            session_id: sessionId,
                            stream_id: streamId,
                        });
                        auditLogger.recordCycleSummary(
                            _cycleSummaryFromResult(completedState, result)
                        );
                        node.send(okMsg);
                        node.status({
                            fill: "green",
                            shape: "dot",
                            text: `g${groupId}/s${sourceId} ✅ OK ${(cycleDuration / 1000).toFixed(1)}s`,
                        });

                        // Check for same-frame restart (A in same frame after C)
                        if (allowSameFrameRestart && matchedSteps.includes("A")) {
                            // Start new cycle from this frame
                            setImmediate(() => {
                                const newMsg = JSON.parse(JSON.stringify(msg));
                                newMsg.workflow = {
                                    ...newMsg.workflow,
                                    matched_steps: ["A"],
                                };
                                node.receive
                                    ? node.receive(newMsg)
                                    : node.emit("input", newMsg);
                            });
                        }
                    } else if (matchedSteps.includes("A") || matchedSteps.includes("B")) {
                        // Wrong: A or B after B was already seen
                        _clearTimeout(stateKey);
                        const wrongStep = matchedSteps.includes("A") ? "A" : "B";
                        const result = _buildResult(
                            state, "NG",
                            `期望步骤 C，但识别到 ${wrongStep} (乱序)`
                        );
                        result.recognized_step = wrongStep;
                        result.cycle_duration_ms = now - state.cycle_started_at_ms;
                        result.cycle_finished_at = beijingNowISO(now);
                        result.stage_duration_ms = Number(
                            process.hrtime.bigint() - transStart
                        ) / 1e6;
                        result.actual_sequence = state.actual_sequence;

                        stateStore.resetState(stateKey);
                        const ngMsg = _makeResultMessage(state, result);
                        auditLogger.record("sequence_failed", {
                            cycle_id: result.cycle_id,
                            result_status: "NG",
                            failure_reason: result.failure_reason,
                            actual_sequence: state.actual_sequence || "",
                            cycle_duration_ms: result.cycle_duration_ms,
                            workflow_id: wfId,
                            message_id: messageId,
                            event_id: result.event_id,
                            frame_seq: frameSeq,
                            group_id: groupId,
                            source_id: sourceId,
                            session_id: sessionId,
                            stream_id: streamId,
                        });
                        auditLogger.recordCycleSummary(
                            _cycleSummaryFromResult(state, result)
                        );
                        node.send(ngMsg);
                        node.status({
                            fill: "red",
                            shape: "ring",
                            text: `g${groupId}/s${sourceId} NG: 乱序 ${wrongStep}`,
                        });
                    }
                    // Else: unmatched, update frame tracking
                    else {
                        stateStore.saveState(stateKey, {
                            ...state,
                            last_frame_seq: frameSeq,
                            last_message_id: messageId,
                        });
                    }
                }
            } catch (error) {
                node.error(
                    `abc-sequence error: ${error.message}\n${error.stack}`,
                    msg
                );
            }

            if (done) done();
        });

        // === Lifecycle ===
        node.on("close", async function onClose(done) {
            closed = true;
            // Clear all timeout timers
            for (const [key, timer] of timeoutTimers) {
                clearTimeout(timer);
            }
            timeoutTimers.clear();

            try {
                await auditLogger.close();
                stateStore.close();
                node.status({});
                done();
            } catch (error) {
                done(error);
            }
        });

        // Run startup recovery
        recoverOnStart();

        node.status({
            fill: "green",
            shape: "ring",
            text: `ready (${stateStore.counts().total} states)`,
        });
    }

    RED.nodes.registerType("aiban-abc-sequence", {
        category: "艾班工作流",
        color: "#FFA07A",
        defaults: {
            name: { value: "A-B-C顺序检测" },
            workflow_id: { value: "abc-sequence-demo" },
            steps: { value: [] },
            cycle_timeout_ms: { value: 30000 },
            allow_same_frame_restart: { value: false },
            stateDbPath: { value: "data/workflow/abc-state.db" },
            auditDir: { value: "logs/workflow" },
        },
        inputs: 1,
        outputs: 1,
        icon: "font-awesome/fa-sort-amount-asc",
        paletteLabel: "aiban abc sequence",
        label: function () {
            return this.name || "A-B-C顺序检测";
        },
    });
};
