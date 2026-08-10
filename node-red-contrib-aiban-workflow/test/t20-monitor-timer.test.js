"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { MonitorRuntime } = require("../lib/monitor-runtime");
const { TimerRecordRuntime } = require("../lib/timer-record-runtime");
const { MemoryLogicStateStore } = require("../lib/logic-state-store");

function msg(seq, labels = [], options = {}) {
    const sourceId = options.sourceId || 1;
    const sessionId = options.sessionId || "session-1";
    return {
        topic: options.topic,
        payload: {
            session_id: sessionId, group_id: 1, source_id: sourceId,
            event_seq: seq, event_id: `${sessionId}:${sourceId}:${seq}`,
        },
        aiban: {
            session_id: sessionId, group_id: 1, source_id: sourceId,
            event_seq: seq, event_id: `${sessionId}:${sourceId}:${seq}`,
            label_matches: labels.map(label => ({ label_id: label, matched: true })),
        },
        workflow: {
            workflow_id: options.workflowId || "group/1/scene/logic",
            scene_id: options.sceneId || "logic",
        },
    };
}

function terminal(events) { return events.find(event => event.type === "terminal"); }

describe("T20 Monitor runtime", () => {
    test("present rule supports frame threshold and cooldown", () => {
        const rt = new MonitorRuntime({
            workflowId: "group/1/scene/logic", sceneId: "logic",
            rules: [{ id: "helmet", label_id: "no-helmet", frame_threshold: 2, cooldown_ms: 100 }],
        });
        assert.equal(terminal(rt.process(msg(1, ["no-helmet"]), 1000)), undefined);
        const first = terminal(rt.process(msg(2, ["no-helmet"]), 1010));
        assert.equal(first.outcome.code, "MONITOR_PRESENT");
        assert.equal(terminal(rt.process(msg(3, ["no-helmet"]), 1050)), undefined);
        const repeated = terminal(rt.process(msg(4, ["no-helmet"]), 1110));
        assert.equal(repeated.outcome.details.rule_id, "helmet");
    });

    test("absent rule supports duration threshold", () => {
        const rt = new MonitorRuntime({
            workflowId: "group/1/scene/logic", sceneId: "logic",
            rules: [{ id: "person-missing", label_id: "person", condition: "absent", duration_ms: 50 }],
        });
        rt.process(msg(1, []), 1000);
        assert.equal(terminal(rt.process(msg(2, []), 1049)), undefined);
        const absent = terminal(rt.process(msg(3, []), 1050));
        assert.equal(absent.outcome.code, "MONITOR_ABSENT");
        assert.equal(absent.outcome.details.duration_ms, 50);
    });

    test("source state and cooldown are isolated", () => {
        const rt = new MonitorRuntime({
            workflowId: "group/1/scene/logic", sceneId: "logic",
            rules: [{ id: "danger", label_id: "danger", frame_threshold: 2, cooldown_ms: 1000 }],
        });
        rt.process(msg(1, ["danger"], { sourceId: 1 }), 1000);
        rt.process(msg(1, ["danger"], { sourceId: 2 }), 1000);
        assert.ok(terminal(rt.process(msg(2, ["danger"], { sourceId: 1 }), 1010)));
        assert.ok(terminal(rt.process(msg(2, ["danger"], { sourceId: 2 }), 1010)));
    });

    test("scene disable and Deploy clear active duration with INTERRUPTED", () => {
        const store = new MemoryLogicStateStore();
        const rt = new MonitorRuntime({
            workflowId: "group/1/scene/logic", sceneId: "logic", stateStore: store,
            logicType: "monitor:node-a",
            rules: [{ id: "missing", label_id: "person", condition: "absent", duration_ms: 1000 }],
        });
        rt.process(msg(1, []), 1000);
        const interrupted = terminal(rt.interrupt(msg(2, [], { topic: "aiban-interrupt" }), 1100));
        assert.equal(interrupted.outcome.status, "INTERRUPTED");

        rt.process(msg(3, []), 1200);
        const other = new MonitorRuntime({
            workflowId: "group/1/scene/logic", sceneId: "logic", stateStore: store,
            logicType: "monitor:node-b",
            rules: [{ id: "missing", label_id: "person", condition: "absent", duration_ms: 1000 }],
        });
        other.process(msg(3, []), 1200);
        const recovered = new MonitorRuntime({
            workflowId: "group/1/scene/logic", sceneId: "logic", stateStore: store,
            logicType: "monitor:node-a",
            rules: [{ id: "missing", label_id: "person", condition: "absent", duration_ms: 1000 }],
        }).recover(1300);
        assert.equal(recovered[0].outcome.code, "MONITOR_DEPLOY_RECOVERY");
        assert.equal(store.list("monitor:node-b").length, 1);
    });
});

describe("T20 Timer Record runtime", () => {
    function timer(options = {}) {
        return new TimerRecordRuntime({
            workflowId: "group/1/scene/logic", sceneId: "logic",
            startLabel: "start", endLabel: "end", maxDurationMs: 1000,
            ...options,
        });
    }

    test("end guard rejects an end label before start", () => {
        const event = timer().process(msg(1, ["end"]), 1000)[0];
        assert.equal(event.type, "guard-rejected");
        assert.equal(event.code, "TIMER_NOT_RUNNING");
    });

    test("start/end produces work result and save_db effect", () => {
        const rt = timer();
        assert.equal(rt.process(msg(1, ["start"]), 1000)[0].type, "timer-started");
        const done = terminal(rt.process(msg(2, ["end"]), 1250));
        assert.equal(done.outcome.status, "OK");
        assert.equal(done.outcome.details.work_duration_ms, 250);
        assert.equal(done.outcome.effects[0].record_type, "timer_record");
        assert.equal(done.result.status, "OK");
    });

    test("absence time accumulates only while timer is running", () => {
        const rt = timer({ absence: { enabled: true, label_id: "person" } });
        rt.process(msg(1, ["start", "person"]), 1000);
        rt.process(msg(2, []), 1100);
        rt.process(msg(3, ["person"]), 1200);
        const done = terminal(rt.process(msg(4, ["end", "person"]), 1300));
        assert.equal(done.outcome.details.absence_duration_ms, 100);
    });

    test("timeout clears timer with TIMEOUT outcome", () => {
        const rt = timer({ maxDurationMs: 50 });
        rt.process(msg(1, ["start"]), 1000);
        const timeout = terminal(rt.process(msg(2, []), 1051));
        assert.equal(timeout.outcome.status, "TIMEOUT");
        assert.equal(timeout.outcome.code, "TIMER_TIMEOUT");
    });

    test("scene disable interrupts and prevents a later end from completing old timer", () => {
        const rt = timer();
        rt.process(msg(1, ["start"]), 1000);
        const interrupted = terminal(rt.interrupt(msg(2, [], { topic: "aiban-interrupt" }), 1100));
        assert.equal(interrupted.outcome.status, "INTERRUPTED");
        assert.equal(rt.process(msg(3, ["end"]), 1200)[0].code, "TIMER_NOT_RUNNING");
    });

    test("Deploy recovery is explicit or configured to resume", () => {
        const store = new MemoryLogicStateStore();
        timer({ stateStore: store, logicType: "timer-record:node-a" })
            .process(msg(1, ["start"]), 1000);
        timer({ stateStore: store, logicType: "timer-record:node-b" })
            .process(msg(1, ["start"]), 1000);
        const interrupted = timer({
            stateStore: store, logicType: "timer-record:node-a",
        }).recover(1100);
        assert.equal(interrupted[0].outcome.code, "TIMER_DEPLOY_RECOVERY");
        assert.equal(store.list("timer-record:node-b").length, 1);

        timer({ stateStore: store, logicType: "timer-record:node-a" })
            .process(msg(2, ["start"]), 1200);
        assert.deepEqual(timer({
            stateStore: store, logicType: "timer-record:node-a", resumeAfterRestart: true,
        }).recover(1300), []);
        assert.equal(terminal(timer({
            stateStore: store, logicType: "timer-record:node-a", resumeAfterRestart: true,
        })
            .process(msg(3, ["end"]), 1400)).outcome.status, "OK");
    });
});
