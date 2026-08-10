"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CustomFlowRuntime } = require("../lib/custom-flow-runtime");
const { MemoryLogicStateStore } = require("../lib/logic-state-store");

function msg(seq, labels, overrides = {}) {
    return {
        payload: {
            group_id: overrides.group_id || 1,
            source_id: overrides.source_id || 1,
            event_seq: seq,
            models: {
                default: { boxes: labels.map(label => ({ label })) },
            },
        },
        aiban: {
            session_id: overrides.session_id || "session-1",
            event_seq: seq,
            label_matches: labels.map(label => ({ label_id: label, matched: true })),
        },
        workflow: {
            workflow_id: overrides.workflow_id || "group/1/scene/custom-flow",
            scene_id: overrides.scene_id || "custom-flow",
        },
    };
}

function runtime(options = {}) {
    return new CustomFlowRuntime({
        workflowId: "group/1/scene/custom-flow",
        sceneId: "custom-flow",
        initialState: "start",
        cycleTimeoutMs: 10000,
        vars: {
            hit_count: { type: "counter", initial: 0 },
            approved: { type: "bool", initial: false },
            last_label: { type: "tracker", initial: null },
        },
        timers: { process_timer: { timeout_ms: 100 } },
        states: [
            {
                id: "start",
                scan: [
                    {
                        id: "hit-a",
                        label_id: "A",
                        actions: [
                            { inc: "hit_count" },
                            { track: { var: "last_label", value: "A" } },
                            { start_timer: "process_timer" },
                        ],
                    },
                    {
                        id: "approve",
                        label_id: "B",
                        guard: { var: "hit_count", op: ">=", value: 1 },
                        actions: [{ set: { var: "approved", value: true } }],
                    },
                ],
                transitions: [
                    {
                        id: "approved",
                        when: { var: "approved", op: "==", value: true },
                        goto: "done",
                        actions: [{
                            outcome: {
                                status: "OK",
                                code: "CUSTOM_FLOW_COMPLETED",
                                effects: [{ type: "save_db", record_type: "custom_flow" }],
                            },
                        }],
                    },
                ],
                on_timer_expire: [{
                    timer: "process_timer",
                    actions: [{
                        outcome: {
                            status: "TIMEOUT",
                            code: "CUSTOM_FLOW_TIMER_TIMEOUT",
                            reason: "approval did not arrive in time",
                        },
                    }],
                }],
            },
            { id: "done", scan: [], transitions: [] },
        ],
        ...options,
    });
}

function terminal(events) {
    return events.find(event => event.type === "terminal");
}

test("T21 Custom Flow runtime", async t => {
    await t.test("vars, guard and state transition emit one standard OK outcome", () => {
        const rt = runtime();
        assert.deepEqual(rt.process(msg(1, ["B"]), 1000), []);
        assert.deepEqual(rt.process(msg(2, ["A"]), 1010).map(event => event.type), []);
        const events = rt.process(msg(3, ["B"]), 1020);
        const done = terminal(events);
        assert.equal(done.outcome.status, "OK");
        assert.equal(done.outcome.code, "CUSTOM_FLOW_COMPLETED");
        assert.equal(done.outcome.details.vars.hit_count, 1);
        assert.equal(done.outcome.details.vars.approved, true);
        assert.deepEqual(done.effects, [{ type: "save_db", record_type: "custom_flow" }]);
    });

    await t.test("timer expiry can terminate the active custom cycle", () => {
        const rt = runtime();
        assert.deepEqual(rt.process(msg(1, ["A"]), 1000), []);
        const events = rt.process(msg(2, []), 1120);
        assert.equal(events[0].type, "terminal");
        assert.equal(events[0].outcome.status, "TIMEOUT");
        assert.equal(events[0].outcome.code, "CUSTOM_FLOW_TIMER_TIMEOUT");
    });

    await t.test("JSON guard combinators support label and timer predicates", () => {
        const rt = runtime({
            states: [{
                id: "start",
                scan: [{
                    id: "combined",
                    label_id: "A",
                    guard: { all: [{ label: "A" }, { not: { timer: "t1", op: "running" } }] },
                    actions: [{ start_timer: "t1" }, { effect: { type: "alarm", alarm_name: "A first seen" } }],
                }],
                transitions: [],
            }],
            timers: { t1: { timeout_ms: 1000 } },
        });
        const events = rt.process(msg(1, ["A"]), 1000);
        assert.equal(events[0].type, "effect");
        assert.equal(events[0].effect.alarm_name, "A first seen");
        assert.deepEqual(rt.process(msg(2, ["A"]), 1010), []);
    });

    await t.test("string guards are rejected instead of evaluated", () => {
        const rt = runtime({
            states: [{
                id: "start",
                scan: [{ label_id: "A", guard: "hit_count.get() >= 1", actions: [{ inc: "hit_count" }] }],
                transitions: [],
            }],
        });
        assert.throws(() => rt.process(msg(1, ["A"]), 1000), /guard must be a JSON object/);
    });

    await t.test("state is isolated by source and session", () => {
        const rt = runtime();
        rt.process(msg(1, ["A"], { source_id: 1 }), 1000);
        assert.deepEqual(rt.process(msg(2, ["B"], { source_id: 2 })), []);
        assert.equal(terminal(rt.process(msg(3, ["B"], { source_id: 1 }), 1020)).outcome.status, "OK");
        rt.process(msg(1, ["A"], { session_id: "session-2" }), 2000);
        assert.equal(terminal(rt.process(msg(2, ["B"], { session_id: "session-2" }), 2010)).outcome.status, "OK");
    });

    await t.test("scene interrupt clears active state and emits INTERRUPTED", () => {
        const rt = runtime();
        rt.process(msg(1, ["A"]), 1000);
        const events = rt.process({ ...msg(2, []), topic: "aiban-interrupt" }, 1010);
        assert.equal(events[0].outcome.status, "INTERRUPTED");
        assert.equal(events[0].outcome.code, "CUSTOM_FLOW_INTERRUPTED");
        assert.deepEqual(rt.process(msg(3, ["B"]), 1020), []);
    });

    await t.test("Deploy recovery interrupts active flows unless resume is enabled", () => {
        const store = new MemoryLogicStateStore();
        runtime({ stateStore: store, logicType: "custom-flow:node-a" }).process(msg(1, ["A"]), 1000);
        const recovered = runtime({ stateStore: store, logicType: "custom-flow:node-a" }).recover(1100);
        assert.equal(recovered[0].outcome.status, "INTERRUPTED");
        runtime({ stateStore: store, logicType: "custom-flow:node-b" }).process(msg(2, ["A"]), 2000);
        assert.deepEqual(runtime({
            stateStore: store,
            logicType: "custom-flow:node-b",
            resumeAfterRestart: true,
        }).recover(2100), []);
    });

    await t.test("custom flow scenario can be represented without arbitrary code", () => {
        const rt = runtime({
            vars: { done: { type: "bool", initial: false } },
            states: [{
                id: "start",
                scan: [
                    { label_id: "start", actions: [{ start_timer: "work" }] },
                    {
                        label_id: "finish",
                        guard: { timer: "work", op: "running" },
                        actions: [{ set: { var: "done", value: true } }],
                    },
                ],
                transitions: [{
                    when: { var: "done", op: "==", value: true },
                    actions: [{ outcome: { status: "OK", code: "CUSTOM_LEGACY_MIGRATED" } }],
                }],
            }],
            timers: { work: { timeout_ms: 1000 } },
        });
        rt.process(msg(1, ["start"]), 1000);
        const events = rt.process(msg(2, ["finish"]), 1200);
        assert.equal(terminal(events).outcome.code, "CUSTOM_LEGACY_MIGRATED");
    });
});
