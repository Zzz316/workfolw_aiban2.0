"use strict";

const { randomUUID } = require("node:crypto");
const { MemoryLogicStateStore } = require("./logic-state-store");
const { identityOf, factSnapshot, terminalEvent } = require("./logic-runtime-common");

const LOGIC_TYPE = "monitor";

function normalizeRule(rule, index) {
    const condition = rule.condition || rule.type || "present";
    const normalizedCondition = condition === "absent" || condition === "on_absent"
        ? "absent"
        : condition === "count_exceeds" ? "count_exceeds" : "present";
    return {
        id: String(rule.id || `rule-${index + 1}`),
        label_id: String(rule.label_id || rule.label || ""),
        condition: normalizedCondition,
        max_count: Math.max(0, Number(rule.max_count ?? rule.maxCount ?? 1)),
        frame_threshold: Math.max(1, Number(rule.frame_threshold || rule.frames || 1)),
        duration_ms: Math.max(0, Number(rule.duration_ms || 0)),
        cooldown_ms: Math.max(0, Number(rule.cooldown_ms || Number(rule.cooldown || 0) * 1000)),
        alarm_name: String(rule.alarm_name || rule.label || rule.id || "monitor alarm"),
        save_db: Boolean(rule.save_db),
    };
}

class MonitorRuntime {
    constructor(options = {}) {
        this.workflowId = options.workflowId || options.workflow_id || "monitor";
        this.sceneId = options.sceneId || options.scene_id || "default";
        this.rules = (options.rules || []).map(normalizeRule);
        if (this.rules.length === 0) throw new Error("MonitorRuntime requires rules");
        this.logicType = String(options.logicType || options.stateNamespace || LOGIC_TYPE);
        this.store = options.stateStore || new MemoryLogicStateStore();
    }

    process(msg, nowMs = Date.now()) {
        const identity = identityOf(msg, this.workflowId, this.sceneId);
        if (!identity.sessionId || !identity.groupId) return [];
        if (msg?.topic === "aiban-interrupt") return this.interrupt(msg, nowMs);
        const facts = factSnapshot(msg);
        const state = this.store.get(this.logicType, identity.stateKey) || {
            workflowId: identity.workflowId,
            sceneId: identity.sceneId,
            sessionId: identity.sessionId,
            groupId: identity.groupId,
            sourceId: identity.sourceId,
            lastEventSeq: 0,
            rules: {},
        };
        if (identity.eventSeq && identity.eventSeq <= state.lastEventSeq) return [];
        state.lastEventSeq = identity.eventSeq;
        const events = [];

        for (const rule of this.rules) {
            const ruleState = state.rules[rule.id] || {
                frames: 0, sinceMs: null, lastTriggeredMs: null,
            };
            const actualCount = facts.labels[rule.label_id]?.count || 0;
            const present = actualCount > 0;
            const conditionMet = rule.condition === "present"
                ? present
                : rule.condition === "absent" ? !present : actualCount > rule.max_count;
            if (!conditionMet) {
                ruleState.frames = 0;
                ruleState.sinceMs = null;
                state.rules[rule.id] = ruleState;
                continue;
            }
            ruleState.frames++;
            if (ruleState.sinceMs === null) ruleState.sinceMs = nowMs;
            const frameReady = ruleState.frames >= rule.frame_threshold;
            const durationReady = nowMs - ruleState.sinceMs >= rule.duration_ms;
            const cooldownReady = ruleState.lastTriggeredMs === null
                || nowMs - ruleState.lastTriggeredMs >= rule.cooldown_ms;
            if (frameReady && durationReady && cooldownReady) {
                const cycleState = {
                    cycleId: randomUUID(),
                    startedAtMs: ruleState.sinceMs,
                    startEventSeq: identity.eventSeq - ruleState.frames + 1,
                };
                const effects = [{
                    type: "alarm", rule_id: rule.id, alarm_name: rule.alarm_name,
                    condition: rule.condition, label_id: rule.label_id,
                }];
                if (rule.save_db) effects.push({
                    type: "save_db", record_type: "monitor_alarm", rule_id: rule.id,
                });
                events.push(terminalEvent({
                    identity,
                    state: cycleState,
                    status: "NG",
                    code: rule.condition === "present" ? "MONITOR_PRESENT"
                        : rule.condition === "absent" ? "MONITOR_ABSENT" : "MONITOR_COUNT_EXCEEDS",
                    reason: `${rule.id}: ${rule.condition} threshold reached`,
                    expectedStep: rule.label_id,
                    actualSteps: present ? [rule.label_id] : [],
                    nowMs,
                    details: {
                        logic_type: "monitor",
                        rule_id: rule.id,
                        condition: rule.condition,
                        actual_count: actualCount,
                        max_count: rule.max_count,
                        frames: ruleState.frames,
                        duration_ms: nowMs - ruleState.sinceMs,
                    },
                    effects,
                }));
                ruleState.lastTriggeredMs = nowMs;
            }
            state.rules[rule.id] = ruleState;
        }
        this.store.save(this.logicType, identity.stateKey, state);
        return events;
    }

    interrupt(msg, nowMs = Date.now(), reason = "scene-disabled-or-deploy") {
        const identity = identityOf(msg, this.workflowId, this.sceneId);
        const state = this.store.get(this.logicType, identity.stateKey);
        if (!state) return [];
        const activeRules = Object.entries(state.rules)
            .filter(([, value]) => value.frames > 0 || value.sinceMs !== null)
            .map(([id]) => id);
        this.store.delete(this.logicType, identity.stateKey);
        if (activeRules.length === 0) return [];
        return [terminalEvent({
            identity,
            state: { cycleId: randomUUID(), startedAtMs: nowMs, startEventSeq: identity.eventSeq },
            status: "INTERRUPTED",
            code: "MONITOR_INTERRUPTED",
            reason,
            actualSteps: [],
            nowMs,
            details: { logic_type: "monitor", active_rules: activeRules },
        })];
    }

    recover(nowMs = Date.now()) {
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
            const activeRules = Object.entries(state.rules)
                .filter(([, value]) => value.frames > 0 || value.sinceMs !== null)
                .map(([id]) => id);
            this.store.delete(this.logicType, entry.state_key);
            if (activeRules.length) events.push(terminalEvent({
                identity,
                state: { cycleId: randomUUID(), startedAtMs: nowMs, startEventSeq: state.lastEventSeq },
                status: "INTERRUPTED",
                code: "MONITOR_DEPLOY_RECOVERY",
                reason: "monitor threshold state cleared on Deploy/restart",
                actualSteps: [],
                nowMs,
                details: { logic_type: "monitor", active_rules: activeRules },
            }));
        }
        return events;
    }
}

module.exports = { MonitorRuntime, LOGIC_TYPE, normalizeRule };
