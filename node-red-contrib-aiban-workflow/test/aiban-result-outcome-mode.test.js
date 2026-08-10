"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const registerResultNode = require("../aiban-result");
const { OUTCOME_SCHEMA_VERSION } = require("../lib/workflow-contract");

function tempDir() {
    const dir = path.join(os.tmpdir(), `aiban-result-outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function safeCleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ok */ }
}

function createResultNode(config = {}, opts = {}) {
    let NodeCtor = null;
    const runtimeNode = opts.runtimeNode || null;
    const dir = tempDir();
    const nodesById = new Map();
    if (runtimeNode) {
        nodesById.set(runtimeNode.id, runtimeNode);
    }

    const RED = {
        settings: { userDir: dir },
        nodes: {
            createNode(node, nodeConfig) {
                const emitter = new EventEmitter();
                node.id = nodeConfig.id || "result-1";
                node.type = "aiban-result";
                node.sent = [];
                node.errors = [];
                node.warnings = [];
                node.logs = [];
                node.statuses = [];
                node.on = emitter.on.bind(emitter);
                node.emit = emitter.emit.bind(emitter);
                node.removeListener = emitter.removeListener.bind(emitter);
                node.send = (msg) => node.sent.push(msg);
                node.error = (err) => node.errors.push(err);
                node.warn = (msg) => node.warnings.push(msg);
                node.log = (msg) => node.logs.push(msg);
                node.status = (status) => node.statuses.push(status);
                nodesById.set(node.id, node);
            },
            registerType(type, ctor) {
                if (type === "aiban-result") NodeCtor = ctor;
            },
            getNode(id) {
                return nodesById.get(id);
            },
            eachNode(fn) {
                for (const node of nodesById.values()) {
                    fn(node);
                }
            },
        },
    };

    registerResultNode(RED);
    const node = new NodeCtor({
        id: "result-1",
        mode: "outcome",
        workflow_id: "abc-demo",
        scene_id: "default",
        stateDbPath: path.join(dir, "state.db"),
        auditDir: path.join(dir, "audit"),
        ...config,
    });

    return { node, dir };
}

function emitInput(node, msg) {
    const sent = [];
    return new Promise((resolve) => {
        node.emit("input", msg, (out) => {
            sent.push(out);
        }, () => resolve(sent));
    });
}

function closeNode(node) {
    return new Promise((resolve, reject) => {
        node.emit("close", (err) => err ? reject(err) : resolve());
    });
}

function outcome(status, overrides = {}) {
    return {
        schema_version: OUTCOME_SCHEMA_VERSION,
        workflow_id: "abc-demo",
        scene_id: "plug-sequence",
        cycle_id: `cycle-${status.toLowerCase()}`,
        status,
        started_at: "2026-07-24T10:00:00.000+08:00",
        finished_at: "2026-07-24T10:00:03.000+08:00",
        duration_ms: 3000,
        code: status === "OK" ? null : status,
        reason: status === "OK" ? null : `${status} reason`,
        expected_step: status === "OK" ? null : "C",
        actual_steps: status === "OK" ? ["A", "B", "C"] : ["A", "B"],
        runtime: {
            session_id: "session-001",
            stream_id: "group-1/source-1",
            group_id: 1,
            source_id: 1,
            start_event_seq: 100,
            end_event_seq: 102,
        },
        evidence: {
            image_path: "",
            screenshot_error: null,
        },
        compatibility: {
            abc_result_event_id: null,
        },
        ...overrides,
    };
}

function outcomeMsg(status, overrides = {}) {
    return {
        topic: "workflow/outcome",
        payload: {
            event_id: `event-${status}`,
            event_seq: 102,
            session_id: "session-001",
            group_id: 1,
            source_id: 1,
        },
        aiban: {
            event_id: `event-${status}`,
            event_seq: 102,
            session_id: "session-001",
            group_id: 1,
            source_id: 1,
        },
        workflow: {
            outcome: outcome(status, overrides),
        },
    };
}

describe("aiban-result outcome mode", () => {
    test("emits standard result for manually constructed OK/NG/TIMEOUT/INTERRUPTED outcomes", async () => {
        const { node, dir } = createResultNode();
        try {
            const statuses = ["OK", "NG", "TIMEOUT", "INTERRUPTED"];
            const outputs = [];
            for (const status of statuses) {
                const sent = await emitInput(node, outcomeMsg(status));
                assert.equal(sent.length, 1, `${status} should emit once`);
                outputs.push(sent[0]);
            }

            assert.deepEqual(outputs.map((msg) => msg.workflow.outcome.status), statuses);
            assert.deepEqual(outputs.map((msg) => msg.workflow.result.status), statuses);
            assert.deepEqual(outputs.map((msg) => msg.abc_result.result_status), statuses);
            assert.ok(outputs.every((msg) => msg.workflow.result.result_event_id));
            assert.ok(outputs.every((msg) => msg.workflow.result.result_event_id === msg.abc_result.result_event_id));
            assert.equal(node.errors.length, 0);
        } finally {
            await closeNode(node);
            safeCleanup(dir);
        }
    });

    test("duplicates the same outcome only once", async () => {
        const { node, dir } = createResultNode();
        try {
            const msg = outcomeMsg("OK", { cycle_id: "cycle-dup" });

            const first = await emitInput(node, msg);
            const second = await emitInput(node, msg);

            assert.equal(first.length, 1);
            assert.equal(second.length, 0);
            assert.ok(node.statuses.some((s) => String(s.text || "").includes("duplicate terminal")));
        } finally {
            await closeNode(node);
            safeCleanup(dir);
        }
    });

    test("screenshot failure does not drop the terminal result", async () => {
        const runtimeNode = {
            id: "runtime-1",
            type: "aiban-runtime",
            requestScreenshot() {
                return Promise.reject(new Error("screenshot timeout"));
            },
        };
        const { node, dir } = createResultNode({}, { runtimeNode });
        try {
            const sent = await emitInput(node, outcomeMsg("NG", { cycle_id: "cycle-shot-fail" }));

            assert.equal(sent.length, 1);
            assert.equal(sent[0].workflow.outcome.status, "NG");
            assert.equal(sent[0].workflow.outcome.evidence.screenshot_error, "screenshot timeout");
            assert.equal(sent[0].workflow.result.screenshot_error, "screenshot timeout");
        } finally {
            await closeNode(node);
            safeCleanup(dir);
        }
    });

    test("rejects mismatched upstream result_event_id", async () => {
        const { node, dir } = createResultNode();
        try {
            const msg = outcomeMsg("OK", { cycle_id: "cycle-bad-id" });
            msg.workflow.result = {
                result_event_id: "wrong:event:id",
            };

            const sent = await emitInput(node, msg);

            assert.equal(sent.length, 0);
            assert.ok(node.errors.some((err) => String(err).includes("result_event_id mismatch")));
        } finally {
            await closeNode(node);
            safeCleanup(dir);
        }
    });
});
