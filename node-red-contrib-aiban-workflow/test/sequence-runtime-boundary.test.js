"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { SequenceRuntime } = require("../lib/sequence-runtime");
const { validateOutcome } = require("../lib/workflow-contract");

class MemoryStateStore {
    constructor() {
        this.rows = new Map();
    }

    getState(key) {
        return this.rows.get(key) || null;
    }

    saveState(key, fields) {
        this.rows.set(key, { ...fields, state_key: key });
    }

    resetState(key) {
        const previous = this.rows.get(key) || null;
        if (previous) {
            this.rows.set(key, {
                ...previous,
                step_index: 0,
                cycle_id: null,
                cycle_started_at_ms: null,
                actual_sequence: null,
                steps_data: null,
            });
        }
        return previous;
    }

    listActive() {
        return Array.from(this.rows.values()).filter((row) => row.step_index > 0);
    }
}

const TOPOLOGY = [
    { labelId: "A", modelId: "1", label: "A", confidenceMin: 0.5, frameCount: 1 },
    { labelId: "B", modelId: "1", label: "B", confidenceMin: 0.5, frameCount: 1 },
];

function makeFrame(eventSeq, matchedIds) {
    return {
        payload: {
            event_id: `event-${eventSeq}`,
            event_seq: eventSeq,
            session_id: "session-001",
            group_id: 1,
            source_id: 1,
            models: {},
        },
        aiban: {
            event_id: `event-${eventSeq}`,
            event_seq: eventSeq,
            session_id: "session-001",
            group_id: 1,
            source_id: 1,
            stream_id: "group-1/source-1",
            label_matches: TOPOLOGY.map((label) => ({
                label_id: label.labelId,
                model_id: label.modelId,
                label: label.label,
                matched: matchedIds.includes(label.labelId),
                confidence: matchedIds.includes(label.labelId) ? 0.9 : null,
            })),
        },
    };
}

describe("SequenceRuntime public boundary", () => {
    test("runs without Node-RED and returns a standard OK outcome", () => {
        const runtime = new SequenceRuntime({
            topology: TOPOLOGY,
            stateStore: new MemoryStateStore(),
            workflowId: "abc-demo",
            sceneId: "plug-sequence",
            cycleTimeoutMs: 1000,
        });

        const transition = runtime.process(makeFrame(100, ["A"]), 1000);
        assert.equal(transition.length, 1);
        assert.equal(transition[0].type, "transition");
        assert.equal(transition[0].outcome, undefined);

        const terminal = runtime.process(makeFrame(101, ["B"]), 1200);
        assert.equal(terminal.length, 1);
        assert.equal(terminal[0].type, "terminal");
        assert.equal(terminal[0].outcome.status, "OK");
        assert.equal(terminal[0].outcome.workflow_id, "abc-demo");
        assert.equal(terminal[0].outcome.scene_id, "plug-sequence");
        assert.equal(validateOutcome(terminal[0].outcome).valid, true);

        assert.equal(terminal[0].result.result_status, "OK");
        assert.equal(terminal[0].result.workflow_result.outcome.status, "OK");
    });

    test("restart recovery returns an INTERRUPTED outcome", () => {
        const store = new MemoryStateStore();
        const runtime = new SequenceRuntime({
            topology: TOPOLOGY,
            stateStore: store,
            workflowId: "abc-demo",
            sceneId: "plug-sequence",
            cycleTimeoutMs: 300,
        });

        runtime.process(makeFrame(100, ["A"]), 1000);
        const recovered = runtime.recover(2000);

        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].outcome.status, "INTERRUPTED");
        assert.equal(recovered[0].outcome.scene_id, "plug-sequence");
        assert.equal(validateOutcome(recovered[0].outcome).valid, true);
    });
});
