"use strict";

const path = require("node:path");
const { TopologyCompiler } = require("./lib/topology-compiler");
const { SequenceRuntime, makeStreamId, makeEventId } = require("./lib/sequence-runtime");
const { WorkflowStateStore } = require("./lib/workflow-state-store");
const { WorkflowAuditLogger, beijingNowISO } = require("./lib/workflow-audit");
const {
    DEFAULT_SCENE_ID,
    ContractValidationError,
    assertValidOutcome,
    buildResultFromOutcome,
    makeResultEventId,
    toAuditAbcResult,
} = require("./lib/workflow-contract");

/**
 * aiban-result — Topology-Driven Result Endpoint
 *
 * Sits at the end of an aiban-label chain. At startup (first input),
 * discovers the label chain topology from deployed wires, then uses
 * FlowRuntime to manage the sequence state machine.
 *
 * Output: terminal events ONLY (OK, NG, TIMEOUT, INTERRUPTED).
 * Transition events are logged via the audit logger internally.
 *
 * Features:
 * - Topology discovery from wire connections
 * - Dynamic state machine (any number of labels)
 * - frame_seq / message_id dedup
 * - Timeout detection per cycle
 * - SQLite state persistence (survives Node-RED restarts)
 * - Restart recovery: expired → INTERRUPTED, active → resume
 * - Manual reset via msg.topic === "aiban-reset"
 * - Scene switch/disable interruption via msg.topic === "aiban-interrupt"
 * - Audit logging (text + JSONL + CSV)
 */

module.exports = function registerResultNode(RED) {
    function AibanResultNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // === Configuration ===
        const workflowId = config.workflow_id || "abc-sequence-demo";
        const sceneId = config.scene_id || DEFAULT_SCENE_ID;
        const resultMode = config.mode || "simple-sequence";
        const cycleTimeoutMs = Math.max(1000, Number(config.cycle_timeout_ms) || 30000);
        const allowSameFrameRestart = config.allow_same_frame_restart === true
            || config.allow_same_frame_restart === "true";

        // State DB path
        const stateDbPath = config.stateDbPath
            ? (path.isAbsolute(config.stateDbPath)
                ? config.stateDbPath
                : path.join(RED.settings.userDir || ".", config.stateDbPath))
            : path.join(RED.settings.userDir || ".", "data", "workflow", "flow-state.db");

        // Audit directory
        const auditDir = config.auditDir
            ? (path.isAbsolute(config.auditDir)
                ? config.auditDir
                : path.join(RED.settings.userDir || ".", config.auditDir))
            : path.join(process.cwd(), "logs", "workflow");

        // === Internal state ===
        let flowRuntime = null;
        let topology = null;
        let stateStore = null;
        let auditLogger = null;
        let closed = false;
        let _runtimeNode = null; // aiban-runtime node instance (for on-demand screenshot)
        const timeoutTimers = new Map(); // state_key → setTimeout
        const emittedResultIds = new Set();

        function ensureAuditLogger() {
            if (!auditLogger) {
                auditLogger = new WorkflowAuditLogger(auditDir);
            }
        }

        function resolveRuntimeNode(entryNodeId) {
            if (entryNodeId) {
                _runtimeNode = RED.nodes.getNode(entryNodeId);
                if (_runtimeNode && _runtimeNode.type === "aiban-scene-entry") {
                    _runtimeNode = RED.nodes.getNode(_runtimeNode.runtimeNodeId);
                }
            }
            if (!_runtimeNode || _runtimeNode.type !== "aiban-runtime") {
                RED.nodes.eachNode(function (n) {
                    if (n.type === "aiban-runtime" && !_runtimeNode) {
                        _runtimeNode = RED.nodes.getNode(n.id);
                    }
                });
            }
            if (_runtimeNode && typeof _runtimeNode.requestScreenshot !== "function") {
                node.warn("[aiban-result] aiban-runtime 节点缺少 requestScreenshot 方法, "
                    + "截图功能不可用");
                _runtimeNode = null;
            }
            if (_runtimeNode) {
                node.log(`[aiban-result] 已连接 aiban-runtime (${_runtimeNode.id}), `
                    + "支持按需截图");
            }
        }

        // === Lazy initialization on first input ===
        function ensureInitialized() {
            if (flowRuntime) return true;

            // Initialize stores
            stateStore = new WorkflowStateStore(stateDbPath);
            ensureAuditLogger();

            // Discover topology from deployed wires
            const compiler = new TopologyCompiler(RED);
            const result = compiler.compile(node.id);

            if (!result.valid) {
                const errMsg = "[aiban-result] 拓扑编译失败: " + result.errors.join("; ");
                node.error(errMsg);
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "拓扑错误: " + result.errors[0],
                });
                return false;
            }

            topology = result.labels;

            // Resolve the upstream aiban-runtime node for on-demand screenshot
            // requests (V1 parity: saveImage at alarm time, not every frame).
            resolveRuntimeNode(result.entryNodeId);
            if (!_runtimeNode) {
                node.warn("[aiban-result] 未找到 aiban-runtime 节点, "
                    + "截图功能不可用 — 图片路径将为空");
            }

            // Create the runtime engine
            flowRuntime = new SequenceRuntime({
                topology,
                stateStore,
                auditLogger,
                workflowId,
                sceneId,
                cycleTimeoutMs,
                allowSameFrameRestart,
            });

            // Log discovered topology
            const labelNames = topology.map((l) => l.labelId).join(" → ");
            node.log(`[aiban-result] 拓扑: ${labelNames} → result (${topology.length} 个标签)`);

            // Run restart recovery
            recoverOnStart();

            node.status({
                fill: "green",
                shape: "ring",
                text: `ready | ${labelNames}`,
            });

            return true;
        }

        function ensureOutcomeInitialized() {
            ensureAuditLogger();
            if (!_runtimeNode) {
                resolveRuntimeNode(null);
            }
            if (!_runtimeNode) {
                node.warn("[aiban-result] outcome 模式未找到 aiban-runtime 节点, "
                    + "截图功能不可用 — 图片路径将为空");
            }
            topology = topology || [];
            node.status({
                fill: "green",
                shape: "ring",
                text: "ready | outcome",
            });
            return true;
        }

        // === Deploy/Restart Recovery ===
        function recoverOnStart() {
            if (!flowRuntime) return;

            const active = stateStore.listActive();
            if (active.length === 0) return;

            node.warn(
                `[aiban-result] 发现 ${active.length} 个未完成周期, 正在恢复...`
            );

            const now = Date.now();
            for (const state of active) {
                // Skip states that are not truly active (e.g. completed without end label)
                if (!flowRuntime._isActive(state)) continue;

                const startedAt = state.cycle_started_at_ms;
                const elapsed = startedAt ? now - startedAt : Infinity;

                if (elapsed > cycleTimeoutMs || !startedAt) {
                    // Expired → INTERRUPTED
                    const result = flowRuntime._buildTerminalResult(
                        state, "INTERRUPTED",
                        `Node-RED 重启/Deploy 时周期已过期 (elapsed=${elapsed.toFixed(0)}ms)`,
                        now
                    );
                    stateStore.resetState(state.state_key);

                    const msg = _makeResultMessage(state, result);
                    auditLogger.record("sequence_completed", _auditFields(state, result, "INTERRUPTED"));
                    auditLogger.recordCycleSummary(_cycleSummary(state, result));
                    node.send(msg);

                    node.warn(
                        `[aiban-result] ${state.state_key} cycle=${(state.cycle_id || "").slice(0, 8)}`
                        + ` 已过期 → INTERRUPTED`
                    );
                } else {
                    // Active → resume timeout timer
                    const remaining = cycleTimeoutMs - elapsed;
                    _scheduleTimeout(state.state_key, Math.max(1000, remaining));
                    node.warn(
                        `[aiban-result] ${state.state_key} cycle=${(state.cycle_id || "").slice(0, 8)}`
                        + ` 已运行 ${elapsed.toFixed(0)}ms, 恢复监控 (剩余 ${remaining.toFixed(0)}ms)`
                    );
                }
            }
        }

        // === Timeout Management ===
        function _scheduleTimeout(stateKey, delayMs) {
            if (timeoutTimers.has(stateKey)) {
                clearTimeout(timeoutTimers.get(stateKey));
            }
            const timer = setTimeout(() => _handleTimeout(stateKey), delayMs);
            timer.unref();
            timeoutTimers.set(stateKey, timer);
        }

        function _clearTimeout(stateKey) {
            if (timeoutTimers.has(stateKey)) {
                clearTimeout(timeoutTimers.get(stateKey));
                timeoutTimers.delete(stateKey);
            }
        }

        function _handleTimeout(stateKey) {
            if (closed || !flowRuntime) return;
            timeoutTimers.delete(stateKey);

            const state = stateStore.getState(stateKey);
            if (!state || !flowRuntime._isActive(state)) return;

            const now = Date.now();
            const elapsed = state.cycle_started_at_ms ? now - state.cycle_started_at_ms : cycleTimeoutMs;
            const result = flowRuntime._buildTerminalResult(
                state, "TIMEOUT",
                `周期超时: 在 ${cycleTimeoutMs}ms 内未完成, `
                + `当前步骤 ${state.step_index}/${flowRuntime.totalSteps}, `
                + `实际步骤: ${state.actual_sequence || "[]"}`,
                now
            );
            result.cycle_duration_ms = elapsed;
            result.cycle_finished_at = beijingNowISO(now);

            stateStore.resetState(stateKey);

            const msg = _makeResultMessage(state, result);
            auditLogger.record("sequence_timeout", _auditFields(state, result, "TIMEOUT"));
            auditLogger.recordCycleSummary(_cycleSummary(state, result));
            node.send(msg);

            node.status({
                fill: "orange",
                shape: "dot",
                text: `g${state.group_id}/s${state.source_id} ⏱ TIMEOUT`,
            });
        }

        // === Message Construction ===
        function _makeStreamId(groupId, sourceId) {
            return `group-${groupId}/source-${sourceId}`;
        }

        function _makeEventId(wfId, sessionId, streamId, cycleId, status) {
            return `${wfId}:${sessionId}:${streamId}:${cycleId}:${status}`;
        }

        function _makeResultMessage(state, result) {
            const workflowOutcome = result.workflow_outcome || null;
            const msgWorkflowId = workflowOutcome ? workflowOutcome.workflow_id : workflowId;
            const msgSceneId = workflowOutcome ? workflowOutcome.scene_id : sceneId;
            const streamId = workflowOutcome?.runtime?.stream_id
                || makeStreamId(state.group_id, state.source_id);
            // Primary idempotency key: result_event_id (Phase 2 contract)
            result.result_event_id = result.result_event_id
                || result.workflow_result?.result_event_id
                || makeEventId(
                    msgWorkflowId, state.session_id, streamId,
                    result.cycle_id, result.result_status
                );
            // Keep event_id as read-only alias for backward compat
            result.event_id = result.result_event_id;
            if (workflowOutcome) {
                result.workflow_outcome = {
                    ...workflowOutcome,
                    compatibility: {
                        ...(workflowOutcome.compatibility || {}),
                        abc_result_event_id: result.result_event_id,
                    },
                };
                result.workflow_result = buildResultFromOutcome(result.workflow_outcome, {
                    resultEventId: result.result_event_id,
                });
            }
            const workflowOutcomeForMessage = result.workflow_outcome || workflowOutcome;
            const workflowResult = result.workflow_result || null;
            return {
                _msgid: result.result_event_id,
                topic: streamId,
                payload: {
                    event_id: result.result_event_id,
                    message_id: state.last_message_id || state.last_event_id || "",
                    session_id: state.session_id,
                    stream_id: streamId,
                    event_seq: state.last_event_seq ?? state.last_frame_seq,
                    frame_seq: state.last_frame_seq,
                    group_id: state.group_id,
                    source_id: state.source_id,
                    scene_id: msgSceneId,
                },
                aiban: {
                    event_id: result.result_event_id,
                    message_id: state.last_message_id || state.last_event_id || "",
                    session_id: state.session_id,
                    stream_id: streamId,
                    event_seq: state.last_event_seq ?? state.last_frame_seq,
                    frame_seq: state.last_frame_seq,
                    scene_id: msgSceneId,
                },
                workflow: {
                    workflow_id: msgWorkflowId,
                    scene_id: msgSceneId,
                    topology: topology ? topology.map((l) => l.labelId) : [],
                    outcome: workflowOutcomeForMessage,
                    result: workflowResult,
                },
                abc_result: result,
                _audit: auditLogger,
            };
        }

        function _resultIdForTerminal(state, result) {
            const outcome = result.workflow_outcome || null;
            const wfId = outcome ? outcome.workflow_id : workflowId;
            const streamId = outcome?.runtime?.stream_id
                || result.stream_id
                || makeStreamId(state.group_id, state.source_id);
            return result.result_event_id
                || result.workflow_result?.result_event_id
                || outcome?.compatibility?.abc_result_event_id
                || makeEventId(wfId, state.session_id, streamId, result.cycle_id, result.result_status);
        }

        function _rememberTerminal(state, result) {
            const resultEventId = _resultIdForTerminal(state, result);
            if (emittedResultIds.has(resultEventId)) {
                node.status({
                    fill: "grey",
                    shape: "ring",
                    text: `duplicate terminal: ${resultEventId.slice(-16)}`,
                });
                return false;
            }
            emittedResultIds.add(resultEventId);
            result.result_event_id = resultEventId;
            result.event_id = resultEventId;
            return true;
        }

        function _auditFields(state, result, eventType) {
            const streamId = makeStreamId(state.group_id, state.source_id);
            const resultEventId = result.result_event_id || result.event_id || "";
            return {
                cycle_id: result.cycle_id,
                result_status: result.result_status,
                failure_reason: result.failure_reason || "",
                actual_sequence: state.actual_sequence || "",
                cycle_duration_ms: result.cycle_duration_ms,
                total_processing_ms: result.stage_duration_ms || 0,
                workflow_id: workflowId,
                scene_id: sceneId,
                event_id: resultEventId,
                result_event_id: resultEventId,
                message_id: state.last_message_id || state.last_event_id || "",
                event_seq: state.last_event_seq ?? state.last_frame_seq ?? 0,
                frame_seq: state.last_frame_seq ?? 0,
                group_id: state.group_id,
                source_id: state.source_id,
                session_id: state.session_id,
                stream_id: streamId,
            };
        }

        function _cycleSummary(state, result) {
            const stepsData = state.steps_data ? JSON.parse(state.steps_data) : {};
            const summary = {
                cycle_id: result.cycle_id,
                workflow_id: workflowId,
                scene_id: sceneId,
                stream_id: _makeStreamId(state.group_id, state.source_id),
                start_frame_seq: state.start_frame_seq,
                end_frame_seq: state.last_frame_seq,
                sequence_duration_ms: result.stage_duration_ms || 0,
                total_processing_ms: result.stage_duration_ms || 0,
                cycle_duration_ms: result.cycle_duration_ms,
                result_status: result.result_status,
                failure_reason: result.failure_reason || "",
            };
            // Add per-step timing if available
            if (topology) {
                for (const lbl of topology) {
                    const sd = stepsData[lbl.labelId];
                    summary[`step_${lbl.labelId}_frame`] = sd ? sd.frame_seq : "";
                    summary[`step_${lbl.labelId}_at`] = sd && sd.at_ms ? beijingNowISO(sd.at_ms) : "";
                }
            }
            return summary;
        }

        function _stateFromOutcome(outcome, msg) {
            const runtime = outcome.runtime || {};
            const groupId = Number(runtime.group_id ?? msg.payload?.group_id ?? msg.aiban?.group_id ?? 0);
            const sourceId = Number(runtime.source_id ?? msg.payload?.source_id ?? msg.aiban?.source_id ?? 0);
            const sessionId = runtime.session_id || msg.payload?.session_id || msg.aiban?.session_id || "";
            const streamId = runtime.stream_id || makeStreamId(groupId, sourceId);
            const actualSequence = JSON.stringify(outcome.actual_steps || []);

            return {
                state_key: `${outcome.workflow_id}:${sessionId}:${groupId}:${sourceId}`,
                workflow_id: outcome.workflow_id,
                session_id: sessionId,
                group_id: groupId,
                source_id: sourceId,
                stream_id: streamId,
                step_index: 0,
                total_steps: Array.isArray(outcome.actual_steps) ? outcome.actual_steps.length : 0,
                cycle_id: outcome.cycle_id,
                cycle_started_at_ms: outcome.started_at ? Date.parse(outcome.started_at) : null,
                start_frame_seq: runtime.start_event_seq ?? msg.payload?.event_seq ?? msg.aiban?.event_seq ?? null,
                last_frame_seq: runtime.end_event_seq ?? msg.payload?.event_seq ?? msg.aiban?.event_seq ?? null,
                last_message_id: msg.payload?.event_id || msg.aiban?.event_id || "",
                steps_data: "{}",
                actual_sequence: actualSequence,
            };
        }

        function _providedResultEventId(msg, outcome) {
            return msg.workflow?.result?.result_event_id
                || outcome.compatibility?.abc_result_event_id
                || msg.abc_result?.result_event_id
                || msg.abc_result?.event_id
                || "";
        }

        function _handleOutcomeInput(msg, send, done) {
            ensureOutcomeInitialized();

            try {
                if (!msg.workflow || !msg.workflow.outcome) {
                    throw new ContractValidationError(
                        "Invalid workflow outcome",
                        ["msg.workflow.outcome is required in outcome mode"]
                    );
                }

                const outcome = assertValidOutcome(msg.workflow.outcome);
                const expectedResultEventId = makeResultEventId(outcome);
                const providedResultEventId = _providedResultEventId(msg, outcome);
                if (providedResultEventId && providedResultEventId !== expectedResultEventId) {
                    throw new ContractValidationError(
                        "Invalid workflow result",
                        [`result_event_id mismatch: expected ${expectedResultEventId}, got ${providedResultEventId}`]
                    );
                }

                const workflowResult = buildResultFromOutcome(outcome, {
                    resultEventId: expectedResultEventId,
                });
                const auditResult = toAuditAbcResult(outcome, {
                    audit: msg.abc_result || {},
                    resultEventId: workflowResult.result_event_id,
                });
                auditResult.workflow_outcome = outcome;
                auditResult.workflow_result = workflowResult;

                const state = _stateFromOutcome(outcome, msg);
                const terminalEvt = {
                    evt: {
                        type: "terminal",
                        stateKey: state.state_key,
                        state,
                        outcome,
                        result: auditResult,
                    },
                    result: auditResult,
                    stageDurationMs: 0,
                };

                _emitTerminalWithScreenshot(terminalEvt, state.group_id, state.source_id, send, done);
            } catch (error) {
                const detail = error.errors ? `: ${error.errors.join("; ")}` : "";
                node.error(`[aiban-result] outcome 模式校验失败${detail}`, msg);
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "invalid outcome",
                });
                if (done) done();
            }
        }

        // === Main Input Handler ===
        node.on("input", function onInput(msg, send, done) {
            if (closed) {
                if (done) done();
                return;
            }

            // Manual reset
            if (msg.topic === "aiban-reset") {
                _handleReset(msg, send);
                if (done) done();
                return;
            }

            if (msg.topic === "aiban-interrupt") {
                if (ensureInitialized()) {
                    _handleInterrupt(msg, send);
                }
                if (done) done();
                return;
            }

            const hasWorkflowOutcome = Boolean(msg.workflow && msg.workflow.outcome);
            if (resultMode === "outcome" || hasWorkflowOutcome) {
                _handleOutcomeInput(msg, send, done);
                return;
            }

            // Lazy initialization
            if (!ensureInitialized()) {
                if (done) done();
                return;
            }

            const transStart = process.hrtime.bigint();

            try {
                // Extract key fields for audit — prefer new field names
                // (event_id / event_seq) from aiban-runtime, falling back
                // to alternate input names (message_id / frame_seq) when
                // imported flows still provide them.
                const payload = msg.payload || {};
                const aiban = msg.aiban || {};
                const sessionId = aiban.session_id || payload.session_id || "";
                const groupId = Number(payload.group_id ?? aiban.group_id ?? 0);
                const sourceId = Number(payload.source_id ?? aiban.source_id ?? 0);
                const eventSeq = Number(
                    aiban.event_seq ?? payload.event_seq
                    ?? aiban.frame_seq ?? payload.frame_seq ?? 0
                );
                const eventId = aiban.event_id
                    || payload.event_id
                    || aiban.message_id
                    || payload.message_id
                    || "";
                const streamId = makeStreamId(groupId, sourceId);

                if (!sessionId || !groupId || eventSeq === undefined) {
                    node.warn("[aiban-result] 帧缺少必要字段 (session_id/group_id/event_seq), 跳过");
                    if (done) done();
                    return;
                }

                // Audit: frame_received
                auditLogger.record("frame_received", {
                    event_id: eventId,
                    message_id: eventId,  // backward compat
                    event_seq: eventSeq,
                    frame_seq: eventSeq,  // backward compat
                    group_id: groupId,
                    source_id: sourceId,
                    session_id: sessionId,
                    stream_id: streamId,
                    label_summary: "",
                });

                // Audit label matches from this frame
                const labelMatches = aiban.label_matches || [];
                const matchedInFrame = labelMatches.filter((m) => m.matched === true);
                if (matchedInFrame.length > 0) {
                    auditLogger.record("label_match_finished", {
                        event_id: eventId,
                        message_id: eventId,
                        event_seq: eventSeq,
                        frame_seq: eventSeq,
                        group_id: groupId,
                        source_id: sourceId,
                        session_id: sessionId,
                        stream_id: streamId,
                        matched_steps: matchedInFrame.map((m) => m.label_id || m.labelId),
                        match_duration_ms: matchedInFrame.reduce(
                            (sum, m) => sum + (m.match_duration_ms || 0), 0
                        ),
                    });
                }

                // Process through the runtime engine
                const events = flowRuntime.process(msg);

                // Separate transition (audit-only) from terminal events.
                // Transitions are handled synchronously; terminals wait for
                // an on-demand screenshot before being emitted (V1 parity:
                // metadata.saveImage() is called only at alarm time, not
                // for every frame).
                let terminalEvt = null;
                for (const evt of events) {
                    const stageDurationMs = Number(
                        process.hrtime.bigint() - transStart
                    ) / 1e6;

                    if (evt.type === "terminal") {
                        const result = evt.result;
                        result.stage_duration_ms = Number(stageDurationMs.toFixed(3));
                        terminalEvt = { evt, result, stageDurationMs };
                    } else if (evt.type === "transition") {
                        // Transition — audit only, no wire output
                        const state = evt.state;
                        const previousStepIndex = evt.previousStepIndex || 0;
                        const previousState = flowRuntime._previousStateName(state.step_index);
                        const currentState = flowRuntime._stateName(state.step_index);

                        auditLogger.record("sequence_transition", {
                            cycle_id: state.cycle_id,
                            previous_state: previousState,
                            current_state: currentState,
                            recognized_step: evt.labelId,
                            stage_duration_ms: Number(stageDurationMs.toFixed(3)),
                            workflow_id: workflowId,
                            message_id: eventId,
                            frame_seq: eventSeq,
                            group_id: groupId,
                            source_id: sourceId,
                            session_id: sessionId,
                            stream_id: streamId,
                        });

                        // Schedule/reset timeout
                        if (state.cycle_started_at_ms) {
                            const now = Date.now();
                            const elapsed = now - state.cycle_started_at_ms;
                            const remaining = cycleTimeoutMs - elapsed;
                            if (remaining > 0) {
                                _scheduleTimeout(evt.stateKey, remaining);
                            }
                        }

                        // Update status
                        node.status({
                            fill: "yellow",
                            shape: "dot",
                            text: `g${groupId}/s${sourceId} ${evt.labelId} → ${currentState}`,
                        });
                    }
                }

                if (terminalEvt) {
                    // On-demand screenshot — only save image when a terminal
                    // judgment is produced (matching V1 alarm-time saveImage).
                    _emitTerminalWithScreenshot(terminalEvt, groupId, sourceId, send, done);
                } else {
                    if (done) done();
                }
            } catch (error) {
                node.error(
                    `aiban-result error: ${error.message}\n${error.stack}`,
                    msg
                );
                if (done) done();
            }
        });

        // === On-Demand Screenshot + Terminal Emit ===
        /**
         * Request a screenshot from the Python backend before emitting a
         * terminal result.  This mirrors V1 behaviour where
         * metadata.saveImage() is called only at alarm time (not for
         * every frame).
         *
         * If the aiban-runtime node is not available or the screenshot
         * fails, the result is still emitted — just without image_path.
         */
        function _emitTerminalWithScreenshot(tev, groupId, sourceId, send, done) {
            const { evt, result } = tev;

            if (!_rememberTerminal(evt.state, result)) {
                if (done) done();
                return;
            }

            function updateEvidence(imagePath, screenshotError) {
                if (imagePath) {
                    result.image_path = imagePath;
                }
                if (screenshotError) {
                    result.screenshot_error = screenshotError;
                }
                if (result.workflow_outcome) {
                    result.workflow_outcome = {
                        ...result.workflow_outcome,
                        evidence: {
                            ...(result.workflow_outcome.evidence || {}),
                            image_path: imagePath || result.workflow_outcome.evidence?.image_path || "",
                            screenshot_error: screenshotError || result.workflow_outcome.evidence?.screenshot_error || null,
                        },
                    };
                    result.workflow_result = buildResultFromOutcome(result.workflow_outcome, {
                        resultEventId: result.result_event_id,
                    });
                }
            }

            function emit(imagePath) {
                updateEvidence(imagePath, null);

                // Build and send message
                const resultMsg = _makeResultMessage(evt.state, result);

                // Audit
                const eventType = result.result_status === "OK"
                    ? "sequence_completed"
                    : result.result_status === "TIMEOUT"
                        ? "sequence_timeout"
                        : "sequence_failed";
                auditLogger.record(eventType, _auditFields(evt.state, result, result.result_status));
                auditLogger.recordCycleSummary(_cycleSummary(evt.state, result));

                // Clear timeout timer
                _clearTimeout(evt.stateKey);

                send(resultMsg);

                // Status update
                const statusText = result.result_status === "OK"
                    ? `g${groupId}/s${sourceId} ✅ OK ${(result.cycle_duration_ms / 1000).toFixed(1)}s`
                    : `g${groupId}/s${sourceId} ❌ ${result.result_status}`;
                node.status({
                    fill: result.result_status === "OK" ? "green" : "red",
                    shape: "dot",
                    text: statusText,
                });

                if (done) done();
            }

            if (_runtimeNode) {
                _runtimeNode.requestScreenshot(groupId, sourceId)
                    .then(function (imagePath) {
                        if (imagePath) {
                            node.log(`[aiban-result] 截图已保存: ${imagePath}`);
                        }
                        emit(imagePath);
                    })
                    .catch(function (err) {
                        node.warn(`[aiban-result] 截图失败: ${err.message}`);
                        updateEvidence("", err.message);
                        emit(""); // emit without image_path
                    });
            } else {
                // No runtime node available — emit without image_path
                emit("");
            }
        }

        // === Manual Reset ===
        function _handleReset(msg, send) {
            if (!stateStore) {
                stateStore = new WorkflowStateStore(stateDbPath);
            }
            const resetKey = msg.payload?.state_key
                || WorkflowStateStore.makeKey(
                    msg.payload?.workflow_id || workflowId,
                    msg.payload?.session_id || "",
                    msg.payload?.group_id || 0,
                    msg.payload?.source_id || 0
                );
            _clearTimeout(resetKey);
            const prev = stateStore.resetState(resetKey);
            if (prev && flowRuntime) {
                const now = Date.now();
                const result = flowRuntime._buildTerminalResult(
                    prev, "INTERRUPTED",
                    `手动重置: ${msg.payload?.reason || "manual"}`
                    + ` by ${msg.payload?.operator || "unknown"}`,
                    now
                );
                result.cycle_finished_at = beijingNowISO(now);
                send(_makeResultMessage(prev, result));
            }
            node.status({
                fill: "blue",
                shape: "dot",
                text: `reset: ${resetKey}`,
            });
        }

        function _handleInterrupt(msg, send) {
            const payload = msg.payload || {};
            const requestedWorkflowId = payload.workflow_id
                || msg.aiban?.workflow_id
                || msg.workflow?.workflow_id
                || workflowId;
            const requestedSceneId = payload.scene_id
                || msg.aiban?.scene_id
                || msg.workflow?.scene_id
                || sceneId;
            if (requestedWorkflowId !== workflowId || requestedSceneId !== sceneId) {
                node.warn(
                    `[aiban-result] ignoring interrupt for another scene: `
                    + `${requestedWorkflowId}/${requestedSceneId}`
                );
                return;
            }

            const hasGroup = payload.group_id !== undefined
                || msg.aiban?.group_id !== undefined;
            const hasSource = payload.source_id !== undefined
                || msg.aiban?.source_id !== undefined;
            const hasSession = Boolean(payload.session_id || msg.aiban?.session_id);
            const groupId = Number(payload.group_id ?? msg.aiban?.group_id);
            const sourceId = Number(payload.source_id ?? msg.aiban?.source_id);
            const sessionId = String(payload.session_id || msg.aiban?.session_id || "");
            const reason = payload.reason || "scene-disabled-or-switched";
            const now = Date.now();
            let interrupted = 0;

            for (const state of stateStore.listActive()) {
                if (state.workflow_id !== workflowId
                    || (hasGroup && state.group_id !== groupId)
                    || (hasSource && state.source_id !== sourceId)
                    || (hasSession && state.session_id !== sessionId)
                    || !flowRuntime._isActive(state)) {
                    continue;
                }
                _clearTimeout(state.state_key);
                const result = flowRuntime._buildTerminalResult(
                    state,
                    "INTERRUPTED",
                    `Scene disabled or switched: ${reason}`,
                    now
                );
                stateStore.resetState(state.state_key);
                if (!_rememberTerminal(state, result)) {
                    continue;
                }
                auditLogger.record(
                    "sequence_interrupted",
                    _auditFields(state, result, "INTERRUPTED")
                );
                auditLogger.recordCycleSummary(_cycleSummary(state, result));
                send(_makeResultMessage(state, result));
                interrupted++;
            }

            node.status({
                fill: "yellow",
                shape: "dot",
                text: `INTERRUPTED: ${interrupted}`,
            });
        }

        // === Lifecycle ===
        node.on("close", async function onClose(done) {
            closed = true;
            // Clear all timeout timers
            for (const [, timer] of timeoutTimers) {
                clearTimeout(timer);
            }
            timeoutTimers.clear();

            try {
                if (auditLogger) await auditLogger.close();
                if (stateStore) stateStore.close();
                node.status({});
                done();
            } catch (error) {
                done(error);
            }
        });

        // Initial status (topology will be discovered on first input)
        node.status({
            fill: "grey",
            shape: "ring",
            text: "等待初始化...",
        });
    }

    RED.nodes.registerType("aiban-result", AibanResultNode, {
        category: "艾班工作流",
        color: "#FFA07A",
        defaults: {
            name: { value: "结果判定" },
            mode: { value: "simple-sequence" },
            workflow_id: { value: "abc-sequence-demo" },
            scene_id: { value: DEFAULT_SCENE_ID },
            cycle_timeout_ms: { value: 30000 },
            allow_same_frame_restart: { value: false },
            stateDbPath: { value: "data/workflow/flow-state.db" },
            auditDir: { value: "logs/workflow" },
        },
        inputs: 1,
        outputs: 1,
        icon: "font-awesome/fa-flag-checkered",
        paletteLabel: "aiban result",
        label: function () {
            return this.name || "结果判定";
        },
    });
};

