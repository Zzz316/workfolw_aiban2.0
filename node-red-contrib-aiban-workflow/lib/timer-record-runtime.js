"use strict";

const { randomUUID } = require("node:crypto");
const { MemoryLogicStateStore } = require("./logic-state-store");
const { identityOf, matchedLabels, terminalEvent } = require("./logic-runtime-common");

const LOGIC_TYPE = "timer-record";

class TimerRecordRuntime {
    constructor(options = {}) {
        this.workflowId = options.workflowId || options.workflow_id || "timer-record";
        this.sceneId = options.sceneId || options.scene_id || "default";
        this.startLabel = String(options.startLabel || options.start_label || "start");
        this.endLabel = String(options.endLabel || options.end_label || "end");
        this.maxDurationMs = Math.max(1, Number(options.maxDurationMs || options.max_duration_ms || 8 * 3600 * 1000));
        this.absence = options.absence || options.absence_tracking || null;
        this.resumeAfterRestart = Boolean(options.resumeAfterRestart || options.resume_after_restart);
        this.logicType = String(options.logicType || options.stateNamespace || LOGIC_TYPE);
        this.store = options.stateStore || new MemoryLogicStateStore();
    }

    process(msg, nowMs = Date.now()) {
        const identity = identityOf(msg, this.workflowId, this.sceneId);
        if (!identity.sessionId || !identity.groupId) return [];
        if (msg?.topic === "aiban-interrupt") return this.interrupt(msg, nowMs);
        const labels = matchedLabels(msg);
        let state = this.store.get(this.logicType, identity.stateKey);
        if (state && identity.eventSeq && identity.eventSeq <= state.lastEventSeq) return [];

        if (!state) {
            if (!labels.has(this.startLabel)) {
                if (labels.has(this.endLabel)) return [{
                    type: "guard-rejected",
                    code: "TIMER_NOT_RUNNING",
                    reason: "end label ignored because timer is not running",
                }];
                return [];
            }
            state = {
                cycleId: randomUUID(),
                workflowId: identity.workflowId,
                sceneId: identity.sceneId,
                sessionId: identity.sessionId,
                groupId: identity.groupId,
                sourceId: identity.sourceId,
                startedAtMs: nowMs,
                startEventSeq: identity.eventSeq,
                lastEventSeq: identity.eventSeq,
                absenceSinceMs: null,
                absenceDurationMs: 0,
            };
            this._trackAbsence(state, labels, nowMs);
            this.store.save(this.logicType, identity.stateKey, state);
            return [{ type: "timer-started", cycle_id: state.cycleId, started_at_ms: nowMs }];
        }

        state.lastEventSeq = identity.eventSeq;
        this._trackAbsence(state, labels, nowMs);
        if (nowMs - state.startedAtMs > this.maxDurationMs) {
            return [this._finish(identity, state, "TIMEOUT", "TIMER_TIMEOUT",
                "timer exceeded maximum duration", nowMs)];
        }
        if (labels.has(this.endLabel)) {
            return [this._finish(identity, state, "OK", null, null, nowMs)];
        }
        this.store.save(this.logicType, identity.stateKey, state);
        return [];
    }

    _trackAbsence(state, labels, nowMs) {
        if (!this.absence || this.absence.enabled === false) return;
        const personLabel = String(this.absence.label_id || this.absence.person_label || "person");
        if (labels.has(personLabel)) {
            if (state.absenceSinceMs !== null) {
                state.absenceDurationMs += Math.max(0, nowMs - state.absenceSinceMs);
                state.absenceSinceMs = null;
            }
        } else if (state.absenceSinceMs === null) {
            state.absenceSinceMs = nowMs;
        }
    }

    _finish(identity, state, status, code, reason, nowMs) {
        if (state.absenceSinceMs !== null) {
            state.absenceDurationMs += Math.max(0, nowMs - state.absenceSinceMs);
            state.absenceSinceMs = null;
        }
        const durationMs = Math.max(0, nowMs - state.startedAtMs);
        const effects = [{
            type: "save_db",
            record_type: "timer_record",
            fields: {
                workflow_id: identity.workflowId,
                scene_id: identity.sceneId,
                cycle_id: state.cycleId,
                stream_id: identity.streamId,
                start_time_ms: state.startedAtMs,
                end_time_ms: nowMs,
                duration_ms: durationMs,
                absence_duration_ms: state.absenceDurationMs,
                result_status: status,
            },
        }];
        const event = terminalEvent({
            identity, state, status, code, reason,
            actualSteps: [this.startLabel, ...(status === "OK" ? [this.endLabel] : [])],
            nowMs,
            details: {
                logic_type: "timer_record",
                work_duration_ms: durationMs,
                absence_duration_ms: state.absenceDurationMs,
                start_label: this.startLabel,
                end_label: this.endLabel,
            },
            effects,
        });
        this.store.delete(this.logicType, identity.stateKey);
        return event;
    }

    interrupt(msg, nowMs = Date.now(), reason = "scene-disabled-or-deploy") {
        const identity = identityOf(msg, this.workflowId, this.sceneId);
        const state = this.store.get(this.logicType, identity.stateKey);
        if (!state) return [];
        return [this._finish(identity, state, "INTERRUPTED", "TIMER_INTERRUPTED", reason, nowMs)];
    }

    recover(nowMs = Date.now()) {
        if (this.resumeAfterRestart) return [];
        const events = [];
        for (const entry of this.store.list(this.logicType)) {
            const state = entry.state;
            const identity = {
                workflowId: state.workflowId,
                sceneId: state.sceneId,
                sessionId: state.sessionId,
                groupId: state.groupId,
                sourceId: state.sourceId,
                streamId: `group-${state.groupId}/source-${state.sourceId}`,
                eventSeq: state.lastEventSeq,
                stateKey: entry.state_key,
            };
            events.push(this._finish(identity, state, "INTERRUPTED", "TIMER_DEPLOY_RECOVERY",
                "active timer interrupted by Deploy/restart", nowMs));
        }
        return events;
    }
}

module.exports = { TimerRecordRuntime, LOGIC_TYPE };
