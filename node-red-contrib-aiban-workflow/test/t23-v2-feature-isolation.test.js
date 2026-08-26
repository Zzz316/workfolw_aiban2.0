"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AdvancedSequenceRuntime } = require("../lib/advanced-sequence-runtime");
const { CustomFlowRuntime } = require("../lib/custom-flow-runtime");
const { MonitorRuntime } = require("../lib/monitor-runtime");
const { factSnapshot } = require("../lib/logic-runtime-common");

function msg(seq, labels, extra = {}) {
    return {
        payload: {
            group_id: 1,
            source_id: extra.source_id || 1,
            event_seq: seq,
            models: {
                default: {
                    boxes: labels.map(label => (
                        typeof label === "string" ? { label } : label
                    )),
                },
            },
        },
        aiban: {
            session_id: extra.session_id || "session-1",
            event_seq: seq,
        },
        workflow: {
            workflow_id: extra.workflow_id || "group/1/scene/parity",
            scene_id: extra.scene_id || "parity",
        },
    };
}

function terminal(events) {
    return events.find(event => event.type === "terminal");
}

test("T23 2.0 feature coverage on isolated runtime", async t => {
    await t.test("fact snapshot extracts model labels and second-level labels", () => {
        const facts = factSnapshot(msg(1, [{
            label: "parent",
            confidence: 0.9,
            x: 10,
            y: 20,
            sub_models: [{ boxes: [{ label: "child-a" }, { label: "child-b" }] }],
        }]));
        assert.equal(facts.labels.parent.count, 1);
        assert.equal(facts.labels.parent.sub_labels["child-a"], 1);
        assert.equal(facts.sub_labels["child-b"], 1);
        assert.deepEqual(facts.labels.parent.boxes[0].center, { x: 10, y: 20 });
    });

    await t.test("sequence supports alt steps, process monitoring and cycle record effects", () => {
        const rt = new AdvancedSequenceRuntime({
            workflowId: "group/1/scene/parity",
            sceneId: "parity",
            steps: [
                { id: "A", label_id: "A", alt_label_ids: ["A2"], step_code: "D1" },
                { id: "B", label_id: "B", step_code: "D2" },
            ],
            processMonitoring: [{ id: "too-many-x", label: "X", type: "count_exceeds", max_count: 1, alarm_name: "X too many" }],
            cycleRecord: { enabled: true, master_table: "cycle", detail_table: "step_log" },
        });
        const first = rt.process(msg(1, ["A2"]), 1000);
        assert.equal(first.length, 1);
        assert.equal(first[0].type, "transition");
        const monitorEvents = rt.process(msg(2, [{ label: "X" }, { label: "X" }]), 1010);
        assert.equal(monitorEvents[0].effect.alarm_name, "X too many");
        const done = terminal(rt.process(msg(3, ["B"]), 1020));
        assert.equal(done.outcome.status, "OK");
        assert.ok(done.effects.some(effect => effect.record_type === "production_cycle_start"));
        assert.ok(done.effects.some(effect => effect.record_type === "step_execution_log"));
        assert.ok(done.effects.some(effect => effect.record_type === "production_cycle_finish"));
    });

    await t.test("custom flow tracker accumulates movement without eval", () => {
        const rt = new CustomFlowRuntime({
            workflowId: "group/1/scene/parity",
            sceneId: "parity",
            vars: { move: { type: "tracker" } },
            states: [{
                id: "start",
                scan: [{ label_id: "part", actions: [{ track: { var: "move", label: "part" } }] }],
                transitions: [{
                    when: { tracker: "move", field: "total_movement", op: ">=", value: 5 },
                    actions: [{ outcome: { status: "OK", code: "TRACKER_MOVED" } }],
                }],
            }],
        });
        rt.process(msg(1, [{ label: "part", x: 0, y: 0 }]), 1000);
        const done = terminal(rt.process(msg(2, [{ label: "part", x: 3, y: 4 }]), 1010));
        assert.equal(done.outcome.code, "TRACKER_MOVED");
        assert.equal(done.outcome.details.vars.move.total_movement, 5);
    });

    await t.test("monitor supports count_exceeds as a native rule", () => {
        const rt = new MonitorRuntime({
            workflowId: "group/1/scene/parity",
            sceneId: "parity",
            rules: [{ id: "crowd", label: "person", type: "count_exceeds", max_count: 1 }],
        });
        const done = terminal(rt.process(msg(1, [{ label: "person" }, { label: "person" }]), 1000));
        assert.equal(done.outcome.code, "MONITOR_COUNT_EXCEEDS");
        assert.equal(done.outcome.details.actual_count, 2);
    });

    await t.test("published Node-RED package exposes only 2.0 nodes and current runtime dependencies", () => {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
        const nodeNames = Object.keys(pkg["node-red"].nodes);
        assert.match(pkg.version, /^2\.0\./);
        assert.equal(nodeNames.every(name => name.startsWith("aiban-")), true);
        assert.equal(Boolean(pkg.dependencies.zeromq), false);
        assert.ok(nodeNames.includes("aiban-api-trigger"));
        assert.ok(nodeNames.includes("aiban-socket-output"));
    });

    await t.test("repository contains no 1.0 runtime or Python bridge dependencies", () => {
        const root = path.resolve(__dirname, "../..");
        const requirements = fs.readFileSync(path.join(root, "requirements-v2.txt"), "utf8");
        assert.equal(fs.existsSync(path.join(root, "icameraapi")), false);
        assert.equal(fs.existsSync(path.join(root, "scenes")), false);
        assert.equal(fs.existsSync(path.join(root, "core")), false);
        assert.equal(fs.existsSync(path.join(root, "workflows")), false);
        assert.doesNotMatch(requirements, /^\s*pyzmq(?:[<>=!~]|\s|$)/mi);
        assert.doesNotMatch(requirements, /^\s*pymysql(?:[<>=!~]|\s|$)/mi);
    });
});
