"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { AdvancedSequenceRuntime } = require("../lib/advanced-sequence-runtime");
const { MemoryLogicStateStore } = require("../lib/logic-state-store");

function msg(seq, labels = [], overrides = {}) {
    const sessionId = overrides.sessionId || "session-1";
    const sourceId = overrides.sourceId || 1;
    return {
        topic: overrides.topic,
        payload: {
            session_id: sessionId,
            group_id: 1,
            source_id: sourceId,
            event_seq: seq,
            event_id: `${sessionId}:${sourceId}:${seq}`,
        },
        aiban: {
            session_id: sessionId,
            group_id: 1,
            source_id: sourceId,
            event_seq: seq,
            event_id: `${sessionId}:${sourceId}:${seq}`,
            label_matches: labels.map(label => ({ label_id: label, matched: true })),
        },
        workflow: {
            workflow_id: "group/1/scene/advanced",
            scene_id: "advanced",
            external_event: overrides.externalEvent,
        },
    };
}

function runtime(options = {}) {
    return new AdvancedSequenceRuntime({
        workflowId: "group/1/scene/advanced",
        sceneId: "advanced",
        cycleTimeoutMs: 1000,
        stateStore: options.stateStore || new MemoryLogicStateStore(),
        steps: options.steps || [
            { id: "A", label_id: "A", step_code: "D1" },
            { id: "B", label_id: "B", step_code: "D2" },
            { id: "C", label_id: "C", step_code: "D3" },
        ],
        ...options,
    });
}

function terminal(events) { return events.find(event => event.type === "terminal"); }

describe("T19 advanced Sequence callbacks and contracts", () => {
    test("on_complete emits one standard OK outcome with step_code records", () => {
        const rt = runtime();
        rt.process(msg(1, ["A"]), 1000);
        rt.process(msg(2, ["B"]), 1100);
        const done = terminal(rt.process(msg(3, ["C"]), 1200));
        assert.equal(done.outcome.status, "OK");
        assert.equal(done.outcome.details.callback, "on_complete");
        assert.deepEqual(done.outcome.details.step_records.map(record => record.step_code), ["D1", "D2", "D3"]);
        assert.ok(done.result.result_event_id);
    });

    test("on_skip lists and emits alarm/save effects for each missing step", () => {
        const rt = runtime({ alarmEachMissing: true, saveDbEachMissing: true });
        rt.process(msg(1, ["A"]), 1000);
        const failed = terminal(rt.process(msg(2, ["C"]), 1100));
        assert.equal(failed.outcome.status, "NG");
        assert.equal(failed.outcome.code, "ON_SKIP");
        assert.deepEqual(failed.outcome.details.missing_steps, [{ id: "B", step_code: "D2" }]);
        assert.deepEqual(failed.outcome.effects.map(effect => effect.type), ["alarm", "save_db"]);
    });

    test("on_wrong_count fires when the next step arrives before target count", () => {
        const rt = runtime({ steps: [
            { id: "A", label_id: "A", target_count: 2 },
            { id: "B", label_id: "B" },
        ] });
        rt.process(msg(1, ["A"]), 1000);
        const failed = terminal(rt.process(msg(2, ["B"]), 1100));
        assert.equal(failed.outcome.code, "ON_WRONG_COUNT");
        assert.match(failed.outcome.reason, /1\/2/);
    });

    test("target count uses appearance edges rather than frame count", () => {
        const rt = runtime({ steps: [{ id: "A", label_id: "A", target_count: 2 }] });
        assert.equal(terminal(rt.process(msg(1, ["A"]), 1000)), undefined);
        assert.equal(terminal(rt.process(msg(2, ["A"]), 1010)), undefined);
        rt.process(msg(3, []), 1020);
        const done = terminal(rt.process(msg(4, ["A"]), 1030));
        assert.equal(done.outcome.status, "OK");
        assert.equal(done.outcome.details.step_records[0].observed_count, 2);
    });

    test("step duration resets when the label disappears", () => {
        const rt = runtime({ steps: [{ id: "A", label_id: "A", duration_ms: 100 }] });
        rt.process(msg(1, ["A"]), 1000);
        rt.process(msg(2, []), 1050);
        rt.process(msg(3, ["A"]), 1100);
        assert.equal(terminal(rt.process(msg(4, ["A"]), 1199)), undefined);
        assert.equal(terminal(rt.process(msg(5, ["A"]), 1200)).outcome.status, "OK");
    });

    test("external/API step advances by workflow.external_event", () => {
        const rt = runtime({ steps: [
            { id: "scan", type: "external", external_event: "barcode-ok", step_code: "API1" },
            { id: "C", label_id: "C" },
        ] });
        rt.process(msg(1, [], { externalEvent: "barcode-ok" }), 1000);
        const done = terminal(rt.process(msg(2, ["C"]), 1100));
        assert.equal(done.outcome.status, "OK");
        assert.equal(done.outcome.details.step_records[0].step_code, "API1");
    });

    test("on_incomplete and on_timeout have distinct result codes", () => {
        const incompleteRt = runtime();
        incompleteRt.process(msg(1, ["A"]), 1000);
        const incomplete = terminal(incompleteRt.process(msg(2, [], { externalEvent: "complete" }), 1100));
        assert.equal(incomplete.outcome.code, "ON_INCOMPLETE");

        const timeoutRt = runtime({ cycleTimeoutMs: 50 });
        timeoutRt.process(msg(1, ["A"]), 1000);
        const timeout = terminal(timeoutRt.process(msg(2, []), 1051));
        assert.equal(timeout.outcome.status, "TIMEOUT");
        assert.equal(timeout.outcome.code, "ON_TIMEOUT");
    });

    test("presence tracking is isolated and can terminate an active cycle", () => {
        const rt = runtime({
            presence: { enabled: true, label_id: "person", absence_duration_ms: 50, terminal: true },
        });
        rt.process(msg(1, ["A", "person"], { sourceId: 1 }), 1000);
        rt.process(msg(1, ["A", "person"], { sourceId: 2 }), 1000);
        rt.process(msg(2, [], { sourceId: 1 }), 1010);
        const absent = terminal(rt.process(msg(3, [], { sourceId: 1 }), 1060));
        assert.equal(absent.outcome.code, "PRESENCE_ABSENT");
        // Source 2 remains active and can continue independently.
        assert.ok(rt.process(msg(2, ["B", "person"], { sourceId: 2 }), 1070)
            .some(event => event.type === "transition"));
    });

    test("loop segment count, guard reset and transition step are explicit", () => {
        const rt = runtime({
            steps: [],
            loopMode: {
                enabled: true,
                cycles_target: 1,
                segments: [{
                    step_id: "A", loop_count: 2,
                    guard_step_ids: ["G"], transition_step_id: "T",
                }],
            },
        });
        rt.process(msg(1, ["A"]), 1000);
        rt.process(msg(2, []), 1010);
        const waiting = rt.process(msg(3, ["A"]), 1020);
        assert.ok(waiting.some(event => event.type === "transition-wait"));
        const reset = rt.process(msg(4, ["G"]), 1030);
        assert.equal(reset[0].effect.type, "guard_reset");
        rt.process(msg(5, ["A"]), 1040);
        rt.process(msg(6, []), 1050);
        rt.process(msg(7, ["A"]), 1060);
        const done = terminal(rt.process(msg(8, ["T"]), 1070));
        assert.equal(done.outcome.status, "OK");
    });

    test("Deploy recovery emits explicit INTERRUPTED outcome", () => {
        const store = new MemoryLogicStateStore();
        const first = runtime({ stateStore: store, logicType: "advanced-sequence:node-a" });
        const other = runtime({ stateStore: store, logicType: "advanced-sequence:node-b" });
        first.process(msg(1, ["A"]), 1000);
        other.process(msg(1, ["A"]), 1000);
        const recovered = runtime({
            stateStore: store, logicType: "advanced-sequence:node-a",
        }).recover(1200);
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].outcome.status, "INTERRUPTED");
        assert.equal(recovered[0].outcome.code, "DEPLOY_RECOVERY");
        assert.equal(store.list("advanced-sequence:node-b").length, 1);
        assert.equal(runtime({
            stateStore: store, logicType: "advanced-sequence:node-b",
        }).recover(1200).length, 1);
    });
});
