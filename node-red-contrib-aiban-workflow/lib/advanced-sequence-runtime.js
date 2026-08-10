"use strict";

const { randomUUID } = require("node:crypto");
const { MemoryLogicStateStore } = require("./logic-state-store");
const { identityOf, matchedLabels, factSnapshot, terminalEvent } = require("./logic-runtime-common");

const LOGIC_TYPE = "advanced-sequence";

function positiveNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function toArray(value) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === "string" && value.trim()) return value.split(",").map(item => item.trim()).filter(Boolean);
    return [];
}

function normalizeStep(step, index) {
    const id = String(step.id || step.step_id || step.label_id || `step-${index + 1}`);
    return {
        id,
        label_id: String(step.label_id || step.label || id),
        alt_label_ids: toArray(step.alt_label_ids || step.alt_step_ids),
        type: step.type === "external" || step.external === true ? "external" : "label",
        external_event: String(step.external_event || step.event || id),
        duration_ms: positiveNumber(step.duration_ms, positiveNumber(step.duration, 0) * 1000),
        target_count: Math.max(1, Math.trunc(positiveNumber(step.target_count, step.count || 1))),
        step_code: String(step.step_code || id),
        transition_step_ids: toArray(step.transition_step_ids || step.transition_step_id),
        transition_alarm_name: String(step.transition_alarm_name || ""),
        repeat_alarm_name: String(step.repeat_alarm_name || ""),
        guard_step_ids: toArray(step.guard_step_ids),
        alarm_name: String(step.alarm_name || ""),
    };
}

function normalizeMonitorRule(rule, index) {
    return {
        id: String(rule.id || `monitor-${index + 1}`),
        label_id: String(rule.label_id || rule.label || ""),
        type: rule.type === "absence_duration" ? "absence_duration"
            : rule.type === "presence_duration" ? "presence_duration" : "count_exceeds",
        max_count: Math.max(0, Number(rule.max_count ?? rule.maxCount ?? 1)),
        duration_ms: positiveNumber(rule.duration_ms, positiveNumber(rule.duration, 0) * 1000),
        cooldown_ms: positiveNumber(rule.cooldown_ms, positiveNumber(rule.cooldown, 0) * 1000),
        alarm_name: String(rule.alarm_name || rule.label || rule.id || "process monitor"),
    };
}

function normalizeOptions(options) {
    let steps = Array.isArray(options.steps) ? options.steps : [];
    const loopMode = options.loopMode || options.loop_mode || {};
    if (loopMode.enabled && Array.isArray(loopMode.segments) && loopMode.segments.length > 0) {
        steps = loopMode.segments.map(segment => ({
            id: segment.id || segment.step_id,
            label_id: segment.label_id || segment.step_id,
            alt_label_ids: segment.alt_label_ids || segment.alt_step_ids,
            target_count: segment.target_count || segment.loop_count || 1,
            step_code: segment.step_code || segment.step_id,
            transition_step_ids: segment.transition_step_ids || segment.transition_step_id,
            transition_alarm_name: segment.transition_alarm_name,
            repeat_alarm_name: segment.repeat_alarm_name,
            guard_step_ids: segment.guard_step_ids,
            alarm_name: segment.alarm_name,
        }));
    }
    return {
        steps: steps.map(normalizeStep),
        loopMode: {
            enabled: Boolean(loopMode.enabled),
            cycles_target: Math.max(0, Math.trunc(positiveNumber(loopMode.cycles_target, 1))),
            cooldown_ms: positiveNumber(loopMode.out_of_order_cooldown_ms,
                positiveNumber(loopMode.out_of_order_cooldown, 0) * 1000),
        },
    };
}

class AdvancedSequenceRuntime {
    constructor(options = {}) {
        const normalized = normalizeOptions(options);
        if (normalized.steps.length === 0) throw new Error("AdvancedSequenceRuntime requires steps");
        this.workflowId = options.workflowId || options.workflow_id || "advanced-sequence";
        this.sceneId = options.sceneId || options.scene_id || "default";
        this.steps = normalized.steps;
        this.loopMode = normalized.loopMode;
        this.cycleTimeoutMs = Math.max(1, positiveNumber(options.cycleTimeoutMs,
            positiveNumber(options.cycle_timeout_ms, 30000)));
        this.completionEvent = String(options.completionEvent || options.completion_event || "complete");
        this.alarmEachMissing = Boolean(options.alarmEachMissing || options.alarm_each_missing);
        this.saveDbEachMissing = Boolean(options.saveDbEachMissing || options.save_db_each_missing);
        this.presence = options.presence || options.presence_tracking || null;
        this.processMonitoring = (options.processMonitoring || options.process_monitoring || []).map(normalizeMonitorRule);
        this.cycleRecord = options.cycleRecord || options.cycle_record || null;
        this.logicType = String(options.logicType || options.stateNamespace || LOGIC_TYPE);
        this.store = options.stateStore || new MemoryLogicStateStore();
    }

    process(msg, nowMs = Date.now()) {
        const identity = identityOf(msg, this.workflowId, this.sceneId);
        if (!identity.sessionId || !identity.groupId || !identity.workflowId || !identity.sceneId) return [];
        if (msg?.topic === "aiban-interrupt") return this.interrupt(msg, nowMs);
        const labels = matchedLabels(msg);
        const facts = factSnapshot(msg);
        const externalEvent = String(msg?.workflow?.external_event || msg?.external_event || "");
        let state = this.store.get(this.logicType, identity.stateKey);
        if (state && identity.eventSeq && identity.eventSeq <= Number(state.lastEventSeq || 0)) return [];

        if (state && nowMs - state.startedAtMs > this.cycleTimeoutMs) {
            return [this._finish(identity, state, "TIMEOUT", "ON_TIMEOUT",
                `sequence timeout after ${nowMs - state.startedAtMs}ms`, nowMs)];
        }

        if (!state) {
            if (!this._stepMatched(this.steps[0], labels, externalEvent)) return [];
            state = this._newState(identity, nowMs);
        }
        state.lastEventSeq = identity.eventSeq;

        const events = this._trackPresence(identity, state, labels, nowMs);
        if (events.some(event => event.type === "terminal")) return events;
        events.push(...this._trackProcessMonitoring(identity, state, facts, nowMs));
        if (events.some(event => event.type === "terminal")) return events;

        if (externalEvent === this.completionEvent && state.index < this.steps.length) {
            return [this._finish(identity, state, "NG", "ON_INCOMPLETE",
                "completion signal received before all steps", nowMs)];
        }

        const current = this.steps[state.index];
        const laterIndex = this._laterMatchedIndex(state.index, labels, externalEvent);
        if (laterIndex > state.index && !this._stepMatched(current, labels, externalEvent)) {
            const code = current.target_count > 1 && state.currentCount < current.target_count
                ? "ON_WRONG_COUNT" : "ON_SKIP";
            const reason = code === "ON_WRONG_COUNT"
                ? `${current.id} count ${state.currentCount}/${current.target_count}`
                : `expected ${current.id}, observed ${this.steps[laterIndex].id}`;
            return [this._finish(identity, state, "NG", code, reason, nowMs, laterIndex)];
        }

        if (state.awaitingTransition) return this._handleGuard(identity, state, current, labels, externalEvent, nowMs, events);
        return this._handleCurrentStep(identity, state, current, labels, externalEvent, nowMs, events);
    }

    _newState(identity, nowMs) {
        return {
            cycleId: randomUUID(),
            workflowId: identity.workflowId,
            sceneId: identity.sceneId,
            sessionId: identity.sessionId,
            groupId: identity.groupId,
            sourceId: identity.sourceId,
            startedAtMs: nowMs,
            startEventSeq: identity.eventSeq,
            lastEventSeq: 0,
            index: 0,
            currentCount: 0,
            lastPresent: false,
            candidateSince: null,
            awaitingTransition: false,
            completedLoops: 0,
            actualSteps: [],
            stepRecords: [],
            absenceSince: null,
            presenceAlarmed: false,
            processMonitor: {},
            pendingEffects: this._cycleRecordStartEffect(identity, nowMs),
        };
    }

    _handleGuard(identity, state, current, labels, externalEvent, nowMs, events) {
        const guard = current.guard_step_ids.find(label => labels.has(label));
        if (guard) {
            state.currentCount = 0;
            state.awaitingTransition = false;
            state.lastPresent = false;
            const effect = { type: "guard_reset", step_id: current.id, guard_step_id: guard };
            state.pendingEffects.push(effect);
            this.store.save(this.logicType, identity.stateKey, state);
            return [...events, { type: "effect", effect, state: structuredClone(state) }];
        }
        const transition = current.transition_step_ids.find(label => labels.has(label));
        if (transition) {
            if (current.transition_alarm_name) {
                const effect = {
                    type: "alarm",
                    step_id: current.id,
                    transition_step_id: transition,
                    alarm_name: current.transition_alarm_name,
                };
                state.pendingEffects.push(effect);
                this.store.save(this.logicType, identity.stateKey, state);
                return [...events, { type: "effect", effect, state: structuredClone(state) }];
            }
            events.push(...this._completeStep(identity, state, current, nowMs));
            return events;
        }
        if (this._stepMatched(current, labels, externalEvent) && current.repeat_alarm_name) {
            const effect = { type: "alarm", step_id: current.id, alarm_name: current.repeat_alarm_name };
            state.pendingEffects.push(effect);
            this.store.save(this.logicType, identity.stateKey, state);
            return [...events, { type: "effect", effect, state: structuredClone(state) }];
        }
        this.store.save(this.logicType, identity.stateKey, state);
        return events;
    }

    _handleCurrentStep(identity, state, current, labels, externalEvent, nowMs, events) {
        const present = this._stepMatched(current, labels, externalEvent);
        if (!present) {
            state.lastPresent = false;
            state.candidateSince = null;
            this.store.save(this.logicType, identity.stateKey, state);
            return events;
        }
        if (current.duration_ms > 0) {
            if (state.candidateSince === null) state.candidateSince = nowMs;
            if (nowMs - state.candidateSince < current.duration_ms) {
                state.lastPresent = true;
                this.store.save(this.logicType, identity.stateKey, state);
                return events;
            }
        }
        if (!state.lastPresent || current.type === "external" || current.duration_ms > 0) state.currentCount++;
        state.lastPresent = true;
        state.candidateSince = null;
        if (state.currentCount < current.target_count) {
            this.store.save(this.logicType, identity.stateKey, state);
            return events;
        }
        if (current.transition_step_ids.length > 0 || current.guard_step_ids.length > 0) {
            state.awaitingTransition = true;
            this.store.save(this.logicType, identity.stateKey, state);
            return [...events, {
                type: "transition-wait",
                step_id: current.id,
                transition_step_ids: current.transition_step_ids,
                guard_step_ids: current.guard_step_ids,
                state: structuredClone(state),
            }];
        }
        events.push(...this._completeStep(identity, state, current, nowMs));
        return events;
    }

    _stepMatched(step, labels, externalEvent) {
        return step.type === "external"
            ? externalEvent === step.external_event
            : labels.has(step.label_id) || step.alt_label_ids.some(label => labels.has(label));
    }

    _laterMatchedIndex(index, labels, externalEvent) {
        for (let i = index + 1; i < this.steps.length; i++) {
            if (this._stepMatched(this.steps[i], labels, externalEvent)) return i;
        }
        return -1;
    }

    _completeStep(identity, state, step, nowMs) {
        state.actualSteps.push(step.id);
        state.stepRecords.push({
            step_id: step.id,
            step_code: step.step_code,
            target_count: step.target_count,
            observed_count: state.currentCount,
            completed_at_ms: nowMs,
        });
        state.pendingEffects.push(...this._cycleRecordStepEffects(identity, state, step, nowMs));
        state.index++;
        state.currentCount = 0;
        state.lastPresent = false;
        state.awaitingTransition = false;
        state.candidateSince = null;
        if (state.index >= this.steps.length) {
            state.completedLoops++;
            const target = this.loopMode.enabled ? this.loopMode.cycles_target : 1;
            if (this.loopMode.enabled && (target === 0 || state.completedLoops < target)) {
                state.index = 0;
                this.store.save(this.logicType, identity.stateKey, state);
                return [{ type: "loop", completed_loops: state.completedLoops, state: structuredClone(state) }];
            }
            return [this._finish(identity, state, "OK", null, null, nowMs)];
        }
        this.store.save(this.logicType, identity.stateKey, state);
        return [{ type: "transition", completed_step: step.id,
            expected_step: this.steps[state.index].id, state: structuredClone(state) }];
    }

    _missingEffects(missing) {
        const effects = [];
        for (const step of missing) {
            if (this.alarmEachMissing) effects.push({
                type: "alarm", step_id: step.id, step_code: step.step_code,
                alarm_name: step.alarm_name || `missing:${step.id}`,
            });
            if (this.saveDbEachMissing) effects.push({
                type: "save_db", record_type: "missing_step",
                step_id: step.id, step_code: step.step_code,
            });
        }
        return effects;
    }

    _cycleRecordStartEffect(identity, nowMs) {
        if (!this.cycleRecord?.enabled) return [];
        return [{
            type: "save_db",
            record_type: "production_cycle_start",
            table: this.cycleRecord.master_table || "production_cycle_record",
            fields: {
                workflow_id: identity.workflowId,
                scene_id: identity.sceneId,
                cycle_id: null,
                group_id: identity.groupId,
                source_id: identity.sourceId,
                start_time_ms: nowMs,
                result_status: 0,
            },
        }];
    }

    _cycleRecordStepEffects(identity, state, step, nowMs) {
        if (!this.cycleRecord?.enabled) return [];
        return [{
            type: "save_db",
            record_type: "step_execution_log",
            table: this.cycleRecord.detail_table || "step_execution_log",
            fields: {
                workflow_id: identity.workflowId,
                scene_id: identity.sceneId,
                cycle_id: state.cycleId,
                step_config_id: step.step_code,
                step_id: step.id,
                step_result: 1,
                completed_at_ms: nowMs,
            },
        }];
    }

    _cycleRecordFinishEffect(identity, state, status, nowMs) {
        if (!this.cycleRecord?.enabled) return [];
        return [{
            type: "save_db",
            record_type: "production_cycle_finish",
            table: this.cycleRecord.master_table || "production_cycle_record",
            fields: {
                workflow_id: identity.workflowId,
                scene_id: identity.sceneId,
                cycle_id: state.cycleId,
                end_time_ms: nowMs,
                result_status: status === "OK" ? 1 : 2,
            },
        }];
    }

    _finish(identity, state, status, code, reason, nowMs, missingEnd = this.steps.length) {
        const missing = status === "OK" ? [] : this.steps.slice(state.index, missingEnd);
        const effects = [
            ...(state.pendingEffects || []),
            ...this._missingEffects(missing),
            ...this._cycleRecordFinishEffect(identity, state, status, nowMs),
        ];
        const event = terminalEvent({
            identity, state, status, code, reason,
            expectedStep: missing[0]?.id || null,
            actualSteps: state.actualSteps,
            nowMs,
            details: {
                callback: status === "OK" ? "on_complete"
                    : code === "ON_TIMEOUT" ? "on_timeout"
                        : code === "ON_WRONG_COUNT" ? "on_wrong_count"
                            : code === "ON_SKIP" ? "on_skip" : "on_incomplete",
                missing_steps: missing.map(step => ({ id: step.id, step_code: step.step_code })),
                step_records: state.stepRecords,
                completed_loops: state.completedLoops,
            },
            effects,
        });
        this.store.delete(this.logicType, identity.stateKey);
        return event;
    }

    _trackPresence(identity, state, labels, nowMs) {
        if (!this.presence || this.presence.enabled === false) return [];
        const label = String(this.presence.label_id || this.presence.person_label || "person");
        if (labels.has(label)) {
            state.absenceSince = null;
            state.presenceAlarmed = false;
            return [];
        }
        if (state.absenceSince === null) state.absenceSince = nowMs;
        const threshold = positiveNumber(this.presence.absence_duration_ms,
            positiveNumber(this.presence.absence_duration, 30) * 1000);
        if (!state.presenceAlarmed && nowMs - state.absenceSince >= threshold) {
            state.presenceAlarmed = true;
            const effect = { type: "presence_absent", duration_ms: nowMs - state.absenceSince };
            state.pendingEffects.push(effect);
            if (this.presence.terminal === true) {
                return [this._finish(identity, state, "NG", "PRESENCE_ABSENT",
                    "required person is absent", nowMs)];
            }
            return [{ type: "effect", effect, state: structuredClone(state) }];
        }
        return [];
    }

    _trackProcessMonitoring(identity, state, facts, nowMs) {
        const events = [];
        for (const rule of this.processMonitoring) {
            const count = facts.labels[rule.label_id]?.count || 0;
            const active = rule.type === "count_exceeds"
                ? count > rule.max_count
                : rule.type === "presence_duration" ? count > 0 : count === 0;
            const rs = state.processMonitor[rule.id] || { sinceMs: null, lastTriggeredMs: null };
            if (!active) {
                rs.sinceMs = null;
                state.processMonitor[rule.id] = rs;
                continue;
            }
            if (rs.sinceMs === null) rs.sinceMs = nowMs;
            const durationReady = nowMs - rs.sinceMs >= rule.duration_ms;
            const cooldownReady = rs.lastTriggeredMs === null || nowMs - rs.lastTriggeredMs >= rule.cooldown_ms;
            if (durationReady && cooldownReady) {
                const effect = {
                    type: "alarm",
                    rule_id: rule.id,
                    alarm_name: rule.alarm_name,
                    monitor_type: rule.type,
                    label_id: rule.label_id,
                    actual_count: count,
                    max_count: rule.max_count,
                };
                state.pendingEffects.push(effect);
                events.push({ type: "effect", effect, state: structuredClone(state) });
                rs.lastTriggeredMs = nowMs;
            }
            state.processMonitor[rule.id] = rs;
        }
        return events;
    }

    interrupt(msg, nowMs = Date.now(), reason = "scene-disabled-or-deploy") {
        const identity = identityOf(msg, this.workflowId, this.sceneId);
        const state = this.store.get(this.logicType, identity.stateKey);
        if (!state) return [];
        return [this._finish(identity, state, "INTERRUPTED", "INTERRUPTED", reason, nowMs)];
    }

    recover(nowMs = Date.now()) {
        const results = [];
        for (const entry of this.store.list(this.logicType)) {
            const state = entry.state;
            const identity = {
                workflowId: state.workflowId || this.workflowId,
                sceneId: state.sceneId || this.sceneId,
                sessionId: state.sessionId,
                groupId: state.groupId,
                sourceId: state.sourceId,
                streamId: `group-${state.groupId}/source-${state.sourceId}`,
                eventSeq: state.lastEventSeq || 0,
            };
            results.push(this._finish(identity, state, "INTERRUPTED", "DEPLOY_RECOVERY",
                "active sequence interrupted by Deploy/restart", nowMs));
        }
        return results;
    }
}

module.exports = { AdvancedSequenceRuntime, LOGIC_TYPE, normalizeStep };
