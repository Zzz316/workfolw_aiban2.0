"use strict";

const { randomUUID } = require("node:crypto");
const { MemoryLogicStateStore } = require("./logic-state-store");
const { identityOf, matchedLabels, factSnapshot, terminalEvent } = require("./logic-runtime-common");

const LOGIC_TYPE = "custom-flow";
const OPS = new Set(["==", "!=", ">", ">=", "<", "<="]);

function toMs(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeVars(vars = {}) {
    const normalized = {};
    const entries = Array.isArray(vars)
        ? vars.map(item => [item.name, item])
        : Object.entries(vars);
    for (const [name, spec] of entries) {
        if (!name) continue;
        const item = spec && typeof spec === "object" ? spec : { initial: spec };
        const type = item.type === "bool" ? "bool" : item.type === "tracker" ? "tracker" : "counter";
        const initial = type === "bool" ? Boolean(item.initial)
            : type === "tracker" ? (item.initial || {
                total_movement: 0,
                was_tracking: false,
                detected_this_frame: false,
                start_pt: null,
                last_pt: null,
            })
                : Number(item.initial || 0);
        normalized[String(name)] = { type, initial };
    }
    return normalized;
}

function normalizeTimers(timers = {}) {
    const normalized = {};
    const entries = Array.isArray(timers)
        ? timers.map(item => [item.name, item])
        : Object.entries(timers);
    for (const [name, spec] of entries) {
        if (!name) continue;
        normalized[String(name)] = {
            timeout_ms: toMs(spec?.timeout_ms, toMs(spec?.timeout, 0) * 1000),
        };
    }
    return normalized;
}

function normalizeRule(rule = {}) {
    return {
        id: String(rule.id || rule.label_id || rule.label || "rule"),
        label_id: rule.label_id || rule.label ? String(rule.label_id || rule.label) : null,
        on: rule.on === "absent" || rule.on === "on_absent" ? "absent" : "present",
        guard: rule.guard || rule.when || null,
        actions: Array.isArray(rule.actions) ? rule.actions : [],
    };
}

function normalizeState(state = {}, index) {
    return {
        id: String(state.id || `state-${index + 1}`),
        scan: (state.scan || state.rules || []).map(normalizeRule),
        transitions: (state.transitions || []).map(transition => ({
            id: String(transition.id || transition.goto || "transition"),
            when: transition.when || transition.guard || null,
            goto: transition.goto ? String(transition.goto) : null,
            actions: Array.isArray(transition.actions) ? transition.actions : [],
        })),
        on_timer_expire: (state.on_timer_expire || state.timer_expire || []).map(item => ({
            timer: String(item.timer || ""),
            actions: Array.isArray(item.actions) ? item.actions : [],
        })),
    };
}

function compare(left, op, right) {
    if (!OPS.has(op)) throw new Error(`unsupported guard operator: ${op}`);
    if (op === "==") return left === right;
    if (op === "!=") return left !== right;
    if (op === ">") return left > right;
    if (op === ">=") return left >= right;
    if (op === "<") return left < right;
    return left <= right;
}

class CustomFlowRuntime {
    constructor(options = {}) {
        this.workflowId = options.workflowId || options.workflow_id || "custom-flow";
        this.sceneId = options.sceneId || options.scene_id || "default";
        this.initialState = String(options.initialState || options.initial_state || "start");
        this.varsSpec = normalizeVars(options.vars);
        this.timersSpec = normalizeTimers(options.timers);
        this.states = (options.states || []).map(normalizeState);
        if (this.states.length === 0) throw new Error("CustomFlowRuntime requires states");
        if (!this.states.some(state => state.id === this.initialState)) this.initialState = this.states[0].id;
        this.cycleTimeoutMs = toMs(options.cycleTimeoutMs, toMs(options.cycle_timeout_ms, 30000));
        this.resumeAfterRestart = Boolean(options.resumeAfterRestart || options.resume_after_restart);
        this.logicType = String(options.logicType || options.stateNamespace || LOGIC_TYPE);
        this.store = options.stateStore || new MemoryLogicStateStore();
    }

    process(msg, nowMs = Date.now()) {
        const identity = identityOf(msg, this.workflowId, this.sceneId);
        if (!identity.sessionId || !identity.groupId) return [];
        if (msg?.topic === "aiban-interrupt") return this.interrupt(msg, nowMs);
        const labels = matchedLabels(msg);
        const facts = factSnapshot(msg);
        let state = this.store.get(this.logicType, identity.stateKey);
        if (state && identity.eventSeq && identity.eventSeq <= Number(state.lastEventSeq || 0)) return [];
        if (!state) state = this._newState(identity, nowMs);
        state.lastEventSeq = identity.eventSeq;
        this._clearTrackerFrameFlags(state);

        if (nowMs - state.startedAtMs > this.cycleTimeoutMs) {
            return [this._finish(identity, state, "TIMEOUT", "CUSTOM_FLOW_TIMEOUT",
                "custom flow cycle timeout", nowMs)];
        }

        const events = [];
        events.push(...this._fireExpiredTimers(identity, state, labels, nowMs));
        if (events.some(event => event.type === "terminal")) return events;

        const current = this._currentState(state);
        for (const rule of current.scan) {
            const present = rule.label_id ? labels.has(rule.label_id) : true;
            const matched = rule.on === "present" ? present : !present;
            if (matched && this._evalGuard(rule.guard, state, labels, nowMs)) {
                events.push(...this._applyActions(identity, state, rule.actions, nowMs,
                    { rule_id: rule.id, label_id: rule.label_id, facts }));
                if (events.some(event => event.type === "terminal")) return events;
            }
        }

        const afterScan = this._currentState(state);
        for (const transition of afterScan.transitions) {
            if (!this._evalGuard(transition.when, state, labels, nowMs)) continue;
            if (transition.goto) state.stateId = transition.goto;
            events.push({ type: "transition", from_state: afterScan.id, to_state: state.stateId,
                transition_id: transition.id, state: structuredClone(state) });
            events.push(...this._applyActions(identity, state, transition.actions, nowMs,
                { transition_id: transition.id, facts }));
            break;
        }

        this.store.save(this.logicType, identity.stateKey, state);
        return events;
    }

    _newState(identity, nowMs) {
        const vars = {};
        for (const [name, spec] of Object.entries(this.varsSpec)) vars[name] = spec.initial;
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
            stateId: this.initialState,
            vars,
            timers: {},
            actualSteps: [],
            effects: [],
        };
    }

    _currentState(state) {
        return this.states.find(item => item.id === state.stateId) || this.states[0];
    }

    _timerValue(state, timerName, nowMs) {
        const timer = state.timers[timerName];
        if (!timer) return { running: false, elapsed_ms: 0, expired: false };
        const elapsed = timer.running ? nowMs - timer.startedAtMs : timer.elapsedMs;
        const timeout = this.timersSpec[timerName]?.timeout_ms || 0;
        return { running: timer.running, elapsed_ms: Math.max(0, elapsed), expired: timeout > 0 && elapsed >= timeout };
    }

    _evalGuard(guard, state, labels, nowMs) {
        if (!guard) return true;
        if (typeof guard !== "object" || Array.isArray(guard)) {
            throw new Error("custom flow guard must be a JSON object");
        }
        if (guard.all) return guard.all.every(item => this._evalGuard(item, state, labels, nowMs));
        if (guard.any) return guard.any.some(item => this._evalGuard(item, state, labels, nowMs));
        if (guard.not) return !this._evalGuard(guard.not, state, labels, nowMs);
        if (guard.label) {
            const present = labels.has(String(guard.label));
            return guard.present === false ? !present : present;
        }
        if (guard.state) return state.stateId === String(guard.state);
        if (guard.var) {
            return compare(state.vars[String(guard.var)], guard.op || "==", guard.value);
        }
        if (guard.tracker) {
            const tracker = state.vars[String(guard.tracker)] || {};
            return compare(tracker[String(guard.field || "total_movement")] || 0, guard.op || ">=", guard.value);
        }
        if (guard.timer) {
            const timer = this._timerValue(state, String(guard.timer), nowMs);
            const op = guard.op || "running";
            if (op === "running") return timer.running;
            if (op === "not_running") return !timer.running;
            if (op === "expired") return timer.expired;
            if (op === "elapsed_gte") return timer.elapsed_ms >= toMs(guard.value);
            throw new Error(`unsupported timer guard operator: ${op}`);
        }
        throw new Error("unsupported custom flow guard");
    }

    _applyActions(identity, state, actions, nowMs, context = {}) {
        const events = [];
        for (const action of actions) {
            if (!action || typeof action !== "object" || Array.isArray(action)) {
                throw new Error("custom flow action must be a JSON object");
            }
            if (action.inc) state.vars[String(action.inc)] = Number(state.vars[String(action.inc)] || 0) + Number(action.by || 1);
            else if (action.dec) state.vars[String(action.dec)] = Number(state.vars[String(action.dec)] || 0) - Number(action.by || 1);
            else if (action.set) state.vars[String(action.set.var)] = action.set.value;
            else if (action.track) this._track(state, action.track, context);
            else if (action.reset) this._reset(state, action.reset);
            else if (action.goto) state.stateId = String(action.goto);
            else if (action.start_timer) state.timers[String(action.start_timer)] = { running: true, startedAtMs: nowMs, elapsedMs: 0 };
            else if (action.stop_timer) this._stopTimer(state, String(action.stop_timer), nowMs);
            else if (action.effect) {
                const effect = { ...structuredClone(action.effect), ...context };
                state.effects.push(effect);
                events.push({ type: "effect", effect, state: structuredClone(state) });
            } else if (action.outcome) {
                const outcome = action.outcome;
                const status = String(outcome.status || "OK").toUpperCase();
                events.push(this._finish(identity, state, status, outcome.code || null,
                    outcome.reason || null, nowMs, outcome.effects || []));
                return events;
            } else if (action.log) {
                events.push({ type: "log", message: String(action.log), state: structuredClone(state) });
            } else {
                throw new Error(`unsupported custom flow action: ${Object.keys(action).join(",")}`);
            }
            if (context.label_id) state.actualSteps.push(context.label_id);
        }
        return events;
    }

    _clearTrackerFrameFlags(state) {
        for (const [name, spec] of Object.entries(this.varsSpec)) {
            if (spec.type !== "tracker") continue;
            const tracker = state.vars[name] || structuredClone(spec.initial);
            tracker.was_tracking = Boolean(tracker.detected_this_frame);
            tracker.detected_this_frame = false;
            state.vars[name] = tracker;
        }
    }

    _track(state, action, context) {
        const name = String(typeof action === "string" ? action : action.var);
        const label = String(action.label || context.label_id || "");
        const tracker = state.vars[name] || structuredClone(this.varsSpec[name]?.initial || {});
        const box = context.facts?.labels?.[label]?.boxes?.[0];
        const point = box?.center || null;
        tracker.was_tracking = Boolean(tracker.last_pt);
        tracker.detected_this_frame = Boolean(point);
        if (point) {
            if (!tracker.start_pt) tracker.start_pt = point;
            if (tracker.last_pt) {
                const dx = point.x - tracker.last_pt.x;
                const dy = point.y - tracker.last_pt.y;
                tracker.total_movement = Number(tracker.total_movement || 0) + Math.sqrt(dx * dx + dy * dy);
            }
            tracker.last_pt = point;
        }
        state.vars[name] = tracker;
    }

    _reset(state, target) {
        const items = Array.isArray(target) ? target : [target];
        for (const item of items) {
            const name = String(item);
            if (this.varsSpec[name]) state.vars[name] = this.varsSpec[name].initial;
            if (state.timers[name]) delete state.timers[name];
        }
    }

    _stopTimer(state, timerName, nowMs) {
        const timer = state.timers[timerName];
        if (!timer || !timer.running) return;
        timer.elapsedMs = Math.max(0, nowMs - timer.startedAtMs);
        timer.running = false;
    }

    _fireExpiredTimers(identity, state, labels, nowMs) {
        const events = [];
        const current = this._currentState(state);
        for (const expiry of current.on_timer_expire) {
            if (!expiry.timer || !this._timerValue(state, expiry.timer, nowMs).expired) continue;
            events.push(...this._applyActions(identity, state, expiry.actions, nowMs,
                { timer: expiry.timer }));
            if (events.some(event => event.type === "terminal")) return events;
        }
        return events;
    }

    _finish(identity, state, status, code, reason, nowMs, extraEffects = []) {
        const effects = [...(state.effects || []), ...extraEffects];
        const event = terminalEvent({
            identity, state, status, code, reason,
            expectedStep: state.stateId,
            actualSteps: [...new Set(state.actualSteps || [])],
            nowMs,
            details: {
                logic_type: "custom_flow",
                state_id: state.stateId,
                vars: structuredClone(state.vars || {}),
                timers: structuredClone(state.timers || {}),
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
        return [this._finish(identity, state, "INTERRUPTED", "CUSTOM_FLOW_INTERRUPTED", reason, nowMs)];
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
            events.push(this._finish(identity, state, "INTERRUPTED", "CUSTOM_FLOW_DEPLOY_RECOVERY",
                "active custom flow interrupted by Deploy/restart", nowMs));
        }
        return events;
    }
}

module.exports = { CustomFlowRuntime, LOGIC_TYPE, normalizeVars, normalizeTimers, normalizeState };
