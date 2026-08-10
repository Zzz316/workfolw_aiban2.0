"use strict";

const { randomUUID } = require("node:crypto");
const { beijingNowISO } = require("./workflow-audit");
const {
    DEFAULT_SCENE_ID,
    buildResultFromOutcome,
    normalizeOutcome,
    toAuditAbcResult,
} = require("./workflow-contract");

/**
 * flow-runtime — Topology-driven sequence state machine engine.
 *
 * Replaces the hardcoded A/B/C state machine with a dynamic engine
 * that derives execution order from the deployed Node-RED wire topology.
 *
 * Classes:
 *   TopologyCompiler — discovers label chain from deployed nodes & wires
 *   FlowRuntime      — topology-driven state machine (testable standalone)
 */

// ---------------------------------------------------------------------------
// TopologyCompiler
// ---------------------------------------------------------------------------

/**
 * Discovers aiban-label chains from Node-RED's deployed flow.
 *
 * Usage (inside a Node-RED node):
 *   const compiler = new TopologyCompiler(RED);
 *   const topology = compiler.compile(this.id);
 *   if (!topology.valid) { node.error(topology.errors.join("; ")); return; }
 */
class TopologyCompiler {
    /**
     * @param {object} RED - Node-RED runtime API
     */
    constructor(RED) {
        this.RED = RED;
    }

    /**
     * Compile topology by tracing wires backward from resultNodeId
     * through aiban-label nodes to the entry point (frame-input or inject).
     *
     * @param {string} resultNodeId - the aiban-result node's own id
     * @returns {object} { labels, entryNodeId, valid, errors }
     */
    compile(resultNodeId) {
        const errors = [];
        const allNodes = this._gatherAllNodes();

        if (allNodes.length === 0) {
            return { labels: [], entryNodeId: null, valid: false, errors: ["No nodes found in flow"] };
        }

        // Build reverse wire map: nodeId → [nodes that output TO it]
        const reverseMap = this._buildReverseMap(allNodes);

        // Trace backward from resultNodeId
        const chain = this._traceBackward(resultNodeId, allNodes, reverseMap, errors);

        // Validate the compiled topology
        const validated = this._validate(chain, allNodes, errors);

        return {
            labels: chain,
            entryNodeId: chain.length > 0 ? this._findEntry(chain[0].nodeId, reverseMap, allNodes) : null,
            valid: validated && errors.length === 0,
            errors,
        };
    }

    /**
     * Validate a topology without requiring a RED runtime (for testing).
     * @param {object[]} labels - [{labelId, modelId, label, confidenceMin}]
     * @returns {object} { valid, errors }
     */
    static validate(labels) {
        const errors = [];
        if (!Array.isArray(labels) || labels.length === 0) {
            errors.push("至少需要一个 aiban-label 节点");
            return { valid: false, errors };
        }
        // Check for duplicate label_ids
        const seen = new Set();
        for (const l of labels) {
            const id = l.labelId || l.label_id;
            if (!id) {
                errors.push("每个 label 节点必须配置 label_id");
            } else if (seen.has(id)) {
                errors.push(`重复的 label_id: "${id}"`);
            }
            seen.add(id);
            if (!l.label) {
                errors.push(`label_id="${id}" 的节点缺少 label 配置`);
            }
            if (l.frameCount !== undefined && (!Number.isInteger(l.frameCount) || l.frameCount < 1)) {
                errors.push(`label_id="${id}" 的 frame_count 必须 >= 1`);
            }
        }
        // Validate end label: at most one
        const endLabels = labels.filter((l) => l.isEnd === true);
        if (endLabels.length > 1) {
            errors.push(
                `发现 ${endLabels.length} 个结束标签 (${endLabels.map((l) => l.labelId || l.label_id).join(", ")})，最多只能有一个`
            );
        }
        return { valid: errors.length === 0, errors };
    }

    // ---- internal helpers ----

    _gatherAllNodes() {
        const nodes = [];
        // RED.nodes.eachNode iterates all known nodes
        if (this.RED && this.RED.nodes && typeof this.RED.nodes.eachNode === "function") {
            this.RED.nodes.eachNode(function (n) {
                nodes.push({
                    id: n.id,
                    type: n.type,
                    name: n.name || "",
                    wires: n.wires || [],
                    // Config fields from defaults (if available)
                    label_id: n.label_id,
                    model_id: n.model_id,
                    label: n.label,
                    confidence: n.confidence,
                    frame_count: n.frame_count,
                    is_end: n.is_end,
                    alarm_name: n.alarm_name,
                    runtime_node_id: n.runtime_node_id || n.runtimeNodeId,
                });
            });
        }
        return nodes;
    }

    _buildReverseMap(allNodes) {
        const map = {};
        for (const node of allNodes) {
            if (node.wires && Array.isArray(node.wires)) {
                for (const outGroup of node.wires) {
                    if (Array.isArray(outGroup)) {
                        for (const targetId of outGroup) {
                            if (!map[targetId]) map[targetId] = [];
                            map[targetId].push(node);
                        }
                    }
                }
            }
        }
        return map;
    }

    /**
     * Trace backward from a node through aiban-label nodes.
     * Stops when hitting a non-label node (entry point).
     */
    _traceBackward(startId, allNodes, reverseMap, errors) {
        const chain = [];
        const visited = new Set();
        let currentId = startId;

        while (currentId) {
            if (visited.has(currentId)) {
                errors.push(`检测到回路: 节点 ${currentId} 被重复访问`);
                break;
            }
            visited.add(currentId);

            const predecessors = reverseMap[currentId] || [];

            // Filter to aiban-label predecessors
            const labelPreds = predecessors.filter(
                (n) => n.type === "aiban-label"
            );

            if (labelPreds.length === 1) {
                const lp = labelPreds[0];
                chain.unshift({
                    nodeId: lp.id,
                    labelId: lp.label_id || lp.name || "?",
                    modelId: String(lp.model_id || "1"),
                    label: lp.label || "",
                    confidenceMin: Number(lp.confidence) || 0.5,
                    frameCount: Number(lp.frame_count) || 1,
                    isEnd: lp.is_end === true || lp.is_end === "true",
                    alarmName: lp.alarm_name || "",
                });
                currentId = lp.id;
            } else if (labelPreds.length > 1) {
                errors.push(
                    `节点 ${currentId} 有多个 aiban-label 上游 — 拓扑必须为线性链, `
                    + `发现 ${labelPreds.length} 个上游 label 节点`
                );
                break;
            } else {
                // No label predecessors — check for entry point
                const entryPreds = predecessors.filter(
                    (n) =>
                        n.type === "aiban-runtime" ||
                        n.type === "aiban-scene-entry" ||
                        n.type === "inject" ||
                        n.type === "aiban-result" // in case of chaining
                );
                if (entryPreds.length === 0 && predecessors.length > 0) {
                    const predTypes = predecessors.map((n) => n.type).join(", ");
                    errors.push(
                        `标签链入口必须是 aiban-runtime 或 inject, `
                        + `实际为: ${predTypes}`
                    );
                }
                break;
            }
        }

        return chain;
    }

    _findEntry(firstLabelNodeId, reverseMap, allNodes) {
        const predecessors = reverseMap[firstLabelNodeId] || [];
        const entry = predecessors.find(
            (n) =>
                n.type === "aiban-runtime"
                || n.type === "aiban-scene-entry"
                || n.type === "inject"
        );
        return entry ? entry.id : null;
    }

    _validate(chain, allNodes, errors) {
        if (chain.length === 0) {
            errors.push("未发现 aiban-label 节点链 — 请在 aiban-result 上游连接至少一个 aiban-label");
            return false;
        }

        // Check for dangling aiban-label nodes (not in chain, not connected to result)
        // This is informational — labels might be in other flows
        const chainIds = new Set(chain.map((l) => l.nodeId));

        // Check each label has valid config
        for (let i = 0; i < chain.length; i++) {
            const label = chain[i];
            if (!label.labelId || !label.label) {
                errors.push(
                    `拓扑位置 ${i + 1} (node ${label.nodeId}): label_id 和 label 不能为空`
                );
            }
            if (isNaN(label.confidenceMin) || label.confidenceMin < 0 || label.confidenceMin > 1) {
                errors.push(
                    `拓扑位置 ${i + 1} (${label.labelId}): confidence 必须在 0-1 之间`
                );
            }
        }

        // Check for duplicate label_ids
        const seenIds = new Set();
        for (const label of chain) {
            if (seenIds.has(label.labelId)) {
                errors.push(`重复的 label_id: "${label.labelId}" — 每个 aiban-label 必须使用唯一 label_id`);
            }
            seenIds.add(label.labelId);
        }

        // Validate end label: at most one, must have valid config
        const endLabels = chain.filter((l) => l.isEnd);
        if (endLabels.length > 1) {
            errors.push(
                `发现 ${endLabels.length} 个结束标签 (${endLabels.map((l) => l.labelId).join(", ")})，最多只能有一个`
            );
        }

        return errors.length === 0;
    }
}

// ---------------------------------------------------------------------------
// FlowRuntime
// ---------------------------------------------------------------------------

/**
 * Topology-driven sequence state machine.
 *
 * Given an ordered topology (e.g. [{labelId:"A"}, {labelId:"B"}, {labelId:"C"}]),
 * generates states dynamically:
 *   IDLE → WAIT_B → WAIT_C → terminal (OK)
 *
 * For a 4-label topology [A, B, D, C]:
 *   IDLE → WAIT_B → WAIT_D → WAIT_C → terminal (OK)
 *
 * The state machine is isolated per (workflow_id, session_id, group_id, source_id).
 */

const TERMINAL_STATUSES = Object.freeze(["OK", "NG", "TIMEOUT", "INTERRUPTED"]);

/**
 * Create a composite state key from isolation dimensions.
 */
function makeStateKey(workflowId, sessionId, groupId, sourceId) {
    return `${workflowId}:${sessionId}:${groupId}:${sourceId}`;
}

/**
 * Create an event_id for idempotent DB tracking.
 */
function makeEventId(workflowId, sessionId, streamId, cycleId, status) {
    return `${workflowId}:${sessionId}:${streamId}:${cycleId}:${status}`;
}

function makeStreamId(groupId, sourceId) {
    return `group-${groupId}/source-${sourceId}`;
}

class FlowRuntime {
    /**
     * @param {object} opts
     * @param {object[]} opts.topology - ordered label definitions [{labelId, modelId, label, confidenceMin}, ...]
     * @param {object} opts.stateStore - WorkflowStateStore instance
     * @param {object} opts.auditLogger - WorkflowAuditLogger instance
     * @param {string} opts.workflowId
     * @param {string} opts.sceneId
     * @param {number} opts.cycleTimeoutMs
     * @param {boolean} opts.allowSameFrameRestart
     */
    constructor(opts) {
        if (!Array.isArray(opts.topology) || opts.topology.length === 0) {
            throw new Error("FlowRuntime requires a non-empty topology array");
        }
        this.topology = opts.topology;
        this.stateStore = opts.stateStore;
        this.auditLogger = opts.auditLogger;
        this.workflowId = opts.workflowId || "abc-sequence-demo";
        this.sceneId = opts.sceneId || DEFAULT_SCENE_ID;
        this.cycleTimeoutMs = Math.max(1, Number(opts.cycleTimeoutMs) || 30000);
        this.allowSameFrameRestart = Boolean(opts.allowSameFrameRestart);

        // Separate end label from sequence labels
        const endLabels = this.topology.filter((l) => l.isEnd === true);
        if (endLabels.length > 1) {
            throw new Error("FlowRuntime: 最多只能有一个结束标签");
        }
        this.endLabel = endLabels.length === 1 ? endLabels[0] : null;
        this.sequenceLabels = this.topology.filter((l) => !l.isEnd);

        // Derived: total steps = sequence labels only (not counting end label)
        this.totalSteps = this.sequenceLabels.length;

        if (this.totalSteps === 0 && !this.endLabel) {
            throw new Error("FlowRuntime: 至少需要一个非结束标签的序列标签");
        }

        // Per-state-key frame_count accumulator.
        // Keyed by stateKey, stores { labelId, count } for the expected label.
        // This ensures frame_count counts only when the flow is actually
        // expecting a specific label — preventing premature accumulation
        // from detections before the step is reached.
        this._frameCountAccum = new Map();

        // Build a quick lookup: labelId → position in topology (0-indexed)
        // Sequence labels get positions 0..totalSteps-1
        // End label gets virtual position = totalSteps
        this._labelIndex = new Map();
        for (let i = 0; i < this.sequenceLabels.length; i++) {
            this._labelIndex.set(this.sequenceLabels[i].labelId, i);
        }
        if (this.endLabel) {
            this._endLabelId = this.endLabel.labelId;
            // End label has a virtual position beyond sequence labels
            // but it can be detected at any state
        } else {
            this._endLabelId = null;
        }
    }

    /**
     * Return the state name for a given step_index.
     * step_index = number of labels already matched.
     *   0 → "IDLE"
     *   N (== totalSteps) → "IDLE" (completed)
     *   otherwise → "WAIT_<nextLabelId>"
     */
    _stateName(stepIndex) {
        if (stepIndex === 0) return "IDLE";
        if (stepIndex >= this.totalSteps) {
            // All sequence labels matched — waiting for end, or completed
            if (this.endLabel) return "WAIT_END";
            return "IDLE";
        }
        return `WAIT_${this.sequenceLabels[stepIndex].labelId}`;
    }

    /**
     * Return the labelId expected at the given step_index.
     * If stepIndex == totalSteps, no more steps are expected.
     */
    _expectedLabelId(stepIndex) {
        if (stepIndex < 0 || stepIndex >= this.totalSteps) return null;
        return this.sequenceLabels[stepIndex].labelId;
    }

    /**
     * Return whether a state is still considered active (not IDLE/completed).
     */
    _isActive(state) {
        if (!state || state.step_index <= 0) return false;
        if (state.step_index < this.totalSteps) return true;
        // step_index == totalSteps: active only if end label exists (WAIT_END)
        if (this.endLabel && state.step_index === this.totalSteps) return true;
        return false;
    }

    /**
     * Return the previous state name for a given step_index (for display).
     */
    _previousStateName(stepIndex) {
        if (stepIndex <= 1) return "IDLE";
        if (stepIndex > this.totalSteps) return "WAIT_END";
        return `WAIT_${this.sequenceLabels[stepIndex - 1].labelId}`;
    }

    /**
     * Process a frame message. Returns an array of event objects.
     *
     * Each event: { type: "transition"|"terminal", stateKey, state, result }
     *
     * @param {object} frameMsg - enriched frame message containing:
     *   msg.payload / msg.aiban with frame identity fields,
     *   and msg.aiban.label_matches[] from aiban-label nodes
     * @param {number} [nowMs] - injectable current time (for testing)
     * @returns {object[]} events
     */
    process(frameMsg, nowMs = Date.now()) {
        const events = [];

        // Extract identity fields
        const payload = frameMsg.payload || {};
        const aiban = frameMsg.aiban || {};
        const workflowData = frameMsg.workflow || {};

        const sessionId = aiban.session_id || payload.session_id || "";
        const groupId = Number(payload.group_id ?? aiban.group_id ?? 0);
        const sourceId = Number(payload.source_id ?? aiban.source_id ?? 0);
        // Prefer new field names (event_seq / event_id) from aiban-runtime.
        // Fall back to alternate names (frame_seq / message_id) if imported flows provide them.
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

        // Extract matched labels from this frame
        const labelMatches = aiban.label_matches || [];

        // Only consider labels that actually matched
        const matchedLabelIds = labelMatches
            .filter((m) => m.matched === true)
            .map((m) => m.label_id || m.labelId);

        // Validate required fields
        if (!sessionId || !groupId || eventSeq === undefined) {
            return events;
        }

        const stateKey = makeStateKey(this.workflowId, sessionId, groupId, sourceId);
        let state = this.stateStore.getState(stateKey);

        // ---- event_seq dedup (with backward compat for frame_seq) ----
        const slfs = state ? (state.last_event_seq ?? state.last_frame_seq) : null;
        if (state && slfs !== null && slfs !== undefined && eventSeq <= slfs) {
            return events;
        }

        // ---- Timeout check on active state ----
        if (state && this._isActive(state) && state.cycle_started_at_ms) {
            const elapsed = nowMs - state.cycle_started_at_ms;
            if (elapsed > this.cycleTimeoutMs) {
                const result = this._buildTerminalResult(
                    state, "TIMEOUT",
                    `周期超时 (${elapsed.toFixed(0)}ms > ${this.cycleTimeoutMs}ms)`,
                    nowMs
                );
                events.push({
                    type: "terminal",
                    stateKey,
                    state: { ...state },
                    outcome: result.workflow_outcome,
                    result,
                });
                this.stateStore.resetState(stateKey);
                this._frameCountAccum.delete(stateKey);
                state = null;
            }
        }

        // ---- End label detection (at any state, including IDLE) ----
        if (this.endLabel && matchedLabelIds.includes(this._endLabelId)) {
            // End label detected — judge current progress and reset
            const stepIndex = state ? state.step_index : 0;
            const allMatched = stepIndex >= this.totalSteps;
            const status = allMatched ? "OK" : "NG";
            const reason = allMatched
                ? null
                : `提前结束: 期望完成 ${this.totalSteps} 个步骤，实际完成 ${stepIndex} 个 (${this.sequenceLabels.map((l) => l.labelId).join("→")})`;

            if (state && state.step_index > 0) {
                // Active cycle → build terminal result
                const result = this._buildTerminalResult(state, status, reason, nowMs);
                this.stateStore.resetState(stateKey);
                this._frameCountAccum.delete(stateKey);
                events.push({
                    type: "terminal",
                    stateKey,
                    state: { ...state },
                    outcome: result.workflow_outcome,
                    result,
                });
            } else {
                // IDLE state → create a minimal terminal result
                const streamId = makeStreamId(groupId, sourceId);
                const idleCycleId = randomUUID();
                const resultEventId = makeEventId(
                    this.workflowId, sessionId, streamId,
                    idleCycleId, status
                );
                // Look up the first expected step's alarm_name for NG
                const firstExpected = this._expectedLabelId(0);
                let idleMissingAlarmName = null;
                if (status !== "OK" && firstExpected) {
                    const firstDef = this.sequenceLabels.find(
                        (l) => l.labelId === firstExpected
                    );
                    if (firstDef && firstDef.alarmName) {
                        idleMissingAlarmName = firstDef.alarmName;
                    }
                }
                const idleResult = this._attachWorkflowContract({
                    cycle_id: idleCycleId,
                    previous_state: "IDLE",
                    current_state: "IDLE",
                    recognized_step: null,
                    expected_step: firstExpected,
                    result_status: status,
                    failure_reason: reason || null,
                    missing_step_alarm_name: idleMissingAlarmName,
                    cycle_started_at: null,
                    cycle_finished_at: beijingNowISO(nowMs),
                    cycle_duration_ms: null,
                    result_event_id: resultEventId,
                    event_id: resultEventId,
                    stage_duration_ms: 0,
                    actual_sequence: "[]",
                    session_id: sessionId,
                    group_id: groupId,
                    source_id: sourceId,
                    stream_id: streamId,
                    start_frame_seq: eventSeq,
                    end_frame_seq: eventSeq,
                    steps_data: "{}",
                });
                events.push({
                    type: "terminal",
                    stateKey,
                    state: {
                        state_key: stateKey,
                        workflow_id: this.workflowId,
                        session_id: sessionId,
                        group_id: groupId,
                        source_id: sourceId,
                        step_index: 0,
                        total_steps: this.totalSteps,
                        cycle_id: null,
                        actual_sequence: "[]",
                        start_frame_seq: eventSeq,
                        last_frame_seq: eventSeq,
                        last_message_id: eventId,
                    },
                    outcome: idleResult.workflow_outcome,
                    result: idleResult,
                });
            }
            return events;
        }

        // ---- IDLE: try to start a new cycle ----
        if (!state || state.step_index === 0) {
            if (matchedLabelIds.length > 0) {
                const firstLabelId = this._expectedLabelId(0);
                const firstDef = this.sequenceLabels[0];
                const requiredFrames = firstDef && firstDef.frameCount ? firstDef.frameCount : 1;
                if (matchedLabelIds.includes(firstLabelId)) {
                    // message_id dedup at IDLE
                    if (state && state.last_message_id === eventId) {
                        return events;
                    }
                    // frame_count accumulation for first label
                    let accumCount = 1;
                    const accum = this._frameCountAccum.get(stateKey);
                    if (accum && accum.labelId === firstLabelId) {
                        accumCount = accum.count + 1;
                    }
                    this._frameCountAccum.set(stateKey, { labelId: firstLabelId, count: accumCount });
                    if (accumCount < requiredFrames) {
                        // Not enough frames yet — silently accumulate
                        if (!state) {
                            // Persist a minimal tracking state so the accumulator
                            // survives across frames while still IDLE.
                            this.stateStore.saveState(stateKey, {
                                state_key: stateKey,
                                workflow_id: this.workflowId,
                                session_id: sessionId,
                                group_id: groupId,
                                source_id: sourceId,
                                step_index: 0,
                                total_steps: this.totalSteps,
                                cycle_id: null,
                                cycle_started_at_ms: null,
                                start_frame_seq: eventSeq,
                                last_frame_seq: eventSeq,
                                last_message_id: eventId,
                                steps_data: "{}",
                                actual_sequence: "[]",
                            });
                        }
                        return events;
                    }
                    // Threshold met — reset accumulator and start cycle
                    this._frameCountAccum.delete(stateKey);
                    const cycleId = randomUUID();
                    const initialStepsData = {};
                    initialStepsData[firstLabelId] = {
                        frame_seq: eventSeq,
                        at_ms: nowMs,
                    };
                    const actualSeq = [firstLabelId];
                    const newState = {
                        state_key: stateKey,
                        workflow_id: this.workflowId,
                        session_id: sessionId,
                        group_id: groupId,
                        source_id: sourceId,
                        step_index: 1,
                        total_steps: this.totalSteps,
                        cycle_id: cycleId,
                        cycle_started_at_ms: nowMs,
                        start_frame_seq: eventSeq,
                        last_frame_seq: eventSeq,
                        last_message_id: eventId,
                        steps_data: JSON.stringify(initialStepsData),
                        actual_sequence: JSON.stringify(actualSeq),
                    };
                    this.stateStore.saveState(stateKey, newState);
                    events.push({
                        type: "transition",
                        stateKey,
                        state: { ...newState },
                        labelId: firstLabelId,
                        previousStepIndex: 0,
                    });

                    // If this was the only step (1-label topology) and no end label, complete immediately
                    if (this.totalSteps === 1 && !this.endLabel) {
                        const result = this._buildTerminalResult(
                            newState, "OK", null, nowMs
                        );
                        this.stateStore.resetState(stateKey);
                this._frameCountAccum.delete(stateKey);
                        events.push({
                            type: "terminal",
                            stateKey,
                            state: { ...newState },
                            outcome: result.workflow_outcome,
                            result,
                        });
                    }
                }
                // If first label not matched, ignore frame
            }
            return events;
        }

        // ---- Active state: 0 < step_index <= totalSteps (with end label) ----
        if (state.step_index <= 0) {
            return events; // Shouldn't happen, but guard
        }
        if (state.step_index > this.totalSteps) {
            return events;
        }
        // step_index == totalSteps is active only when end label exists (WAIT_END)
        if (state.step_index === this.totalSteps && !this.endLabel) {
            return events;
        }

        // message_id dedup at current step
        if (state.last_message_id === eventId) {
            return events;
        }

        const currentStepIndex = state.step_index;
        const expectedLabelId = this._expectedLabelId(currentStepIndex);

        // Check what was matched in this frame against topology
        const matchedPositions = matchedLabelIds
            .map((lid) => this._labelIndex.get(lid))
            .filter((pos) => pos !== undefined)
            .sort((a, b) => a - b);

        if (matchedPositions.length === 0) {
            // No topology labels matched — just update frame tracking
            this.stateStore.saveState(stateKey, {
                ...state,
                last_frame_seq: eventSeq,
                last_message_id: eventId,
            });
            return events;
        }

        // Check if any matched label is at the expected position
        const hasExpected = matchedPositions.includes(currentStepIndex);
        // Check for skip (label beyond expected)
        const hasSkip = matchedPositions.some((p) => p > currentStepIndex);
        // Check for repeat (label before current position, excluding ones already matched)
        const hasRepeat = matchedPositions.some((p) => p < currentStepIndex);

        if (hasExpected && !hasSkip) {
            // Correct step matched — apply frame_count threshold.
            const expectedDef = this.sequenceLabels[currentStepIndex];
            const requiredFrames = expectedDef && expectedDef.frameCount
                ? expectedDef.frameCount : 1;

            let accumCount = 1;
            const accum = this._frameCountAccum.get(stateKey);
            if (accum && accum.labelId === expectedLabelId) {
                accumCount = accum.count + 1;
            }
            if (accumCount < requiredFrames) {
                // Not enough frames yet — persist accumulator, update tracking
                this._frameCountAccum.set(stateKey, { labelId: expectedLabelId, count: accumCount });
                this.stateStore.saveState(stateKey, {
                    ...state,
                    last_frame_seq: eventSeq,
                    last_message_id: eventId,
                });
                return events;
            }
            // Threshold met — reset accumulator and advance
            this._frameCountAccum.delete(stateKey);

            const actualSeq = JSON.parse(state.actual_sequence || "[]");
            actualSeq.push(expectedLabelId);

            const stepsData = JSON.parse(state.steps_data || "{}");
            stepsData[expectedLabelId] = {
                frame_seq: eventSeq,
                at_ms: nowMs,
            };

            const newStepIndex = currentStepIndex + 1;

            if (newStepIndex >= this.totalSteps) {
                // All sequence steps completed
                const completedState = {
                    ...state,
                    step_index: newStepIndex,
                    last_frame_seq: eventSeq,
                    last_message_id: eventId,
                    steps_data: JSON.stringify(stepsData),
                    actual_sequence: JSON.stringify(actualSeq),
                };
                if (this.endLabel) {
                    // End label exists → transition to WAIT_END, don't auto-complete
                    this.stateStore.saveState(stateKey, completedState);
                    events.push({
                        type: "transition",
                        stateKey,
                        state: { ...completedState },
                        labelId: expectedLabelId,
                        previousStepIndex: currentStepIndex,
                    });
                } else {
                    // No end label → auto-complete with OK
                    const result = this._buildTerminalResult(
                        completedState, "OK", null, nowMs
                    );
                    this.stateStore.resetState(stateKey);
                this._frameCountAccum.delete(stateKey);
                    events.push({
                        type: "terminal",
                        stateKey,
                        state: { ...completedState },
                        outcome: result.workflow_outcome,
                        result,
                    });
                }
            } else {
                // Advance to next step
                const updatedState = {
                    ...state,
                    step_index: newStepIndex,
                    last_frame_seq: eventSeq,
                    last_message_id: eventId,
                    steps_data: JSON.stringify(stepsData),
                    actual_sequence: JSON.stringify(actualSeq),
                };
                this.stateStore.saveState(stateKey, updatedState);
                events.push({
                    type: "transition",
                    stateKey,
                    state: { ...updatedState },
                    labelId: expectedLabelId,
                    previousStepIndex: currentStepIndex,
                });
            }
        } else if (hasSkip && !hasExpected) {
            // Skip: matched a label ahead of expected → NG
            const skippedLabel = this.sequenceLabels[matchedPositions[matchedPositions.length - 1]].labelId;
            const result = this._buildTerminalResult(
                state, "NG",
                `期望步骤 ${expectedLabelId}，但识别到 ${skippedLabel} (跳步)`,
                nowMs
            );
            this.stateStore.resetState(stateKey);
                this._frameCountAccum.delete(stateKey);
            events.push({
                type: "terminal",
                stateKey,
                state: { ...state },
                outcome: result.workflow_outcome,
                result,
            });
        } else if (hasRepeat && !hasExpected) {
            // Repeat: matched an earlier label → silently ignore, just update tracking
            this.stateStore.saveState(stateKey, {
                ...state,
                last_frame_seq: eventSeq,
                last_message_id: eventId,
            });
            return events;
        } else if (hasExpected && hasSkip) {
            // Both expected and skip in same frame — ambiguous, treat as NG (skip)
            const skippedLabel = this.sequenceLabels[matchedPositions.find((p) => p > currentStepIndex)].labelId;
            const result = this._buildTerminalResult(
                state, "NG",
                `同一帧中同时匹配 ${expectedLabelId} 和 ${skippedLabel}，判定为跳步`,
                nowMs
            );
            this.stateStore.resetState(stateKey);
                this._frameCountAccum.delete(stateKey);
            events.push({
                type: "terminal",
                stateKey,
                state: { ...state },
                outcome: result.workflow_outcome,
                result,
            });
        } else {
            // Mixed case with repeat + something else → NG
            const result = this._buildTerminalResult(
                state, "NG",
                `期望步骤 ${expectedLabelId}，但识别到非预期标签 [${matchedLabelIds.join(", ")}]`,
                nowMs
            );
            this.stateStore.resetState(stateKey);
                this._frameCountAccum.delete(stateKey);
            events.push({
                type: "terminal",
                stateKey,
                state: { ...state },
                outcome: result.workflow_outcome,
                result,
            });
        }

        return events;
    }

    _attachWorkflowContract(auditResult) {
        const outcome = normalizeOutcome({
            ...auditResult,
            workflow_id: this.workflowId,
            scene_id: auditResult.scene_id || this.sceneId,
            status: auditResult.result_status,
            finished_at: auditResult.cycle_finished_at,
        }, {
            workflowId: this.workflowId,
            sceneId: this.sceneId,
            resultEventId: auditResult.result_event_id,
        });
        const workflowResult = buildResultFromOutcome(outcome, {
            resultEventId: auditResult.result_event_id,
        });
        return toAuditAbcResult(outcome, {
            audit: {
                ...auditResult,
                workflow_outcome: outcome,
                workflow_result: workflowResult,
            },
            resultEventId: auditResult.result_event_id,
        });
    }

    /**
     * Build a terminal result object from a state row.
     */
    _buildTerminalResult(state, status, reason, nowMs) {
        const streamId = makeStreamId(state.group_id, state.source_id);
        const cycleDuration = state.cycle_started_at_ms
            ? nowMs - state.cycle_started_at_ms
            : null;
        const expectedLabel = state.step_index < this.totalSteps
            ? this._expectedLabelId(state.step_index)
            : null;

        // Look up the missing/expected step's alarm_name for NG cases
        let missingStepAlarmName = null;
        if (status !== "OK" && expectedLabel) {
            const expectedDef = this.sequenceLabels.find(
                (l) => l.labelId === expectedLabel
            );
            if (expectedDef && expectedDef.alarmName) {
                missingStepAlarmName = expectedDef.alarmName;
            }
        }

        const resultEventId = makeEventId(
            this.workflowId, state.session_id, streamId,
            state.cycle_id || randomUUID(), status
        );
        return this._attachWorkflowContract({
            cycle_id: state.cycle_id,
            previous_state: this._stateName(state.step_index),
            current_state: "IDLE",
            recognized_step: status === "OK" && this.totalSteps > 0
                ? this.sequenceLabels[this.totalSteps - 1].labelId
                : null,
            expected_step: expectedLabel,
            result_status: status,
            failure_reason: reason || null,
            missing_step_alarm_name: missingStepAlarmName,
            cycle_started_at: state.cycle_started_at_ms
                ? beijingNowISO(state.cycle_started_at_ms) : null,
            cycle_finished_at: beijingNowISO(nowMs),
            cycle_duration_ms: cycleDuration,
            // Phase 2 primary idempotency key (result_event_id).
            // event_id is kept as a read-only alias for backward compat.
            result_event_id: resultEventId,
            event_id: resultEventId,
            stage_duration_ms: 0,
            actual_sequence: state.actual_sequence,
            session_id: state.session_id,
            group_id: state.group_id,
            source_id: state.source_id,
            stream_id: streamId,
            start_frame_seq: state.start_frame_seq,
            end_frame_seq: state.last_frame_seq,
            steps_data: state.steps_data,
            image_path: state.image_path || state.last_image_path || "",
        });
    }

    /**
     * Build a transition event result (for the aiban-result node to emit).
     */
    buildTransitionResult(state, labelId, previousStepIndex, stageDurationMs) {
        const streamId = makeStreamId(state.group_id, state.source_id);
        const resultEventId = makeEventId(
            this.workflowId, state.session_id, streamId,
            state.cycle_id || randomUUID(), "TRANSITION"
        );
        return {
            cycle_id: state.cycle_id,
            previous_state: this._previousStateName(state.step_index),
            current_state: this._stateName(state.step_index),
            recognized_step: labelId,
            expected_step: this._expectedLabelId(previousStepIndex),
            result_status: null, // null = transition, not terminal
            failure_reason: null,
            cycle_started_at: state.cycle_started_at_ms
                ? beijingNowISO(state.cycle_started_at_ms) : null,
            cycle_finished_at: null,
            cycle_duration_ms: null,
            result_event_id: resultEventId,
            event_id: resultEventId,
            stage_duration_ms: Number(stageDurationMs.toFixed(3)),
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
     * Check for expired active states (restart/Deploy recovery).
     * Returns terminal results for expired states.
     */
    recover(nowMs = Date.now()) {
        const results = [];
        const active = this.stateStore.listActive(this.totalSteps);
        for (const state of active) {
            // Also recognize states at totalSteps when end label exists (WAIT_END)
            if (!this._isActive(state)) continue;
            const elapsed = state.cycle_started_at_ms
                ? nowMs - state.cycle_started_at_ms
                : Infinity;
            if (elapsed > this.cycleTimeoutMs || !state.cycle_started_at_ms) {
                const result = this._buildTerminalResult(
                    state, "INTERRUPTED",
                    `Node-RED 重启/Deploy 时周期已过期 (elapsed=${elapsed.toFixed(0)}ms)`,
                    nowMs
                );
                this.stateStore.resetState(state.state_key);
                results.push({ state, outcome: result.workflow_outcome, result });
            }
        }
        return results;
    }
}

module.exports = {
    TopologyCompiler,
    FlowRuntime,
    TERMINAL_STATUSES,
    makeStateKey,
    makeEventId,
    makeStreamId,
};

