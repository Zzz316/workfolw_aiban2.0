"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, beforeEach, describe, test } = require("node:test");

const { MysqlWriteQueue } = require("../lib/mysql-write-queue");
const registerResultDbNode = require("../aiban-result-db");
const { OUTCOME_SCHEMA_VERSION, makeResultEventId } = require("../lib/workflow-contract");

let originalEnqueue;
let capturedRows;

before(() => {
    originalEnqueue = MysqlWriteQueue.prototype.enqueue;
    MysqlWriteQueue.prototype.enqueue = function enqueueForTest(row) {
        capturedRows.push(row);
        this._stats.enqueued++;
        return { accepted: true, status: "queued", result_event_id: row.result_event_id };
    };
});

after(() => {
    MysqlWriteQueue.prototype.enqueue = originalEnqueue;
});

beforeEach(() => {
    capturedRows = [];
});

function tempDir() {
    const dir = path.join(os.tmpdir(), `aiban-result-db-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function safeCleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ok */ }
}

function createDbNode(config = {}) {
    let NodeCtor = null;
    const dir = tempDir();
    const RED = {
        settings: { userDir: dir },
        nodes: {
            createNode(node, nodeConfig) {
                const emitter = new EventEmitter();
                node.id = nodeConfig.id || "result-db-1";
                node.type = "aiban-result-db";
                node.errors = [];
                node.statuses = [];
                node.credentials = {};
                node.on = emitter.on.bind(emitter);
                node.emit = emitter.emit.bind(emitter);
                node.error = (err) => node.errors.push(err);
                node.status = (status) => node.statuses.push(status);
            },
            registerType(type, ctor) {
                if (type === "aiban-result-db") NodeCtor = ctor;
            },
        },
    };

    registerResultDbNode(RED);
    const node = new NodeCtor({
        id: "result-db-1",
        tableName: "icamera_data.workflow_result_event",
        regionName: "line-1",
        okAlarmContent: "流程OK",
        queueSize: 10,
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
    const base = {
        schema_version: OUTCOME_SCHEMA_VERSION,
        workflow_id: "complex-demo",
        scene_id: "complex-scene",
        cycle_id: `cycle-${status.toLowerCase()}`,
        status,
        started_at: "2026-07-24T10:00:00.000+08:00",
        finished_at: "2026-07-24T10:00:05.000+08:00",
        duration_ms: 5000,
        code: status === "OK" ? null : status,
        reason: status === "OK" ? null : `${status} by complex logic`,
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
            image_path: "captures/cycle.jpg",
            screenshot_error: null,
        },
        compatibility: {
            abc_result_event_id: null,
        },
    };
    return { ...base, ...overrides };
}

function standardMsg(status, overrides = {}) {
    const workflowOutcome = outcome(status, overrides);
    return {
        payload: {
            event_id: `evt-${status}`,
            event_seq: workflowOutcome.runtime.end_event_seq,
            session_id: workflowOutcome.runtime.session_id,
            group_id: workflowOutcome.runtime.group_id,
            source_id: workflowOutcome.runtime.source_id,
            region: "payload-region",
        },
        aiban: {
            event_id: `evt-${status}`,
            event_seq: workflowOutcome.runtime.end_event_seq,
            session_id: workflowOutcome.runtime.session_id,
            group_id: workflowOutcome.runtime.group_id,
            source_id: workflowOutcome.runtime.source_id,
        },
        workflow: {
            outcome: workflowOutcome,
        },
    };
}

describe("aiban-result-db result compatibility", () => {
    test("function/switch-style NG outcome without abc_result is queued and backfilled", async () => {
        const { node, dir } = createDbNode();
        try {
            const msg = standardMsg("NG", {
                cycle_id: "cycle-function-ng",
                reason: "switch branch saw C before B",
            });
            const expectedId = makeResultEventId(msg.workflow.outcome);

            const sent = await emitInput(node, msg);

            assert.equal(sent.length, 1);
            assert.equal(sent[0].abc_result.result_status, "NG");
            assert.equal(sent[0].abc_result.result_event_id, expectedId);
            assert.equal(sent[0].workflow.result.result_event_id, expectedId);
            assert.equal(sent[0].db_result.status, "queued");
            assert.equal(capturedRows.length, 1);
            assert.equal(capturedRows[0].result_event_id, expectedId);
            assert.equal(capturedRows[0].failure_reason, "switch branch saw C before B");
            assert.equal(capturedRows[0].workflow_id, "complex-demo");
            assert.equal(capturedRows[0].scene_id, "complex-scene");
        } finally {
            await closeNode(node);
            safeCleanup(dir);
        }
    });

    test("timer-style TIMEOUT outcome maps to an NG alarm row", async () => {
        const { node, dir } = createDbNode();
        try {
            const msg = standardMsg("TIMEOUT", {
                cycle_id: "cycle-timer-timeout",
                reason: "timer expired waiting for C",
            });

            const sent = await emitInput(node, msg);

            assert.equal(sent.length, 1);
            assert.equal(sent[0].workflow.outcome.status, "TIMEOUT");
            assert.equal(sent[0].db_result.result_event_id, makeResultEventId(msg.workflow.outcome));
            assert.equal(capturedRows.length, 1);
            assert.equal(capturedRows[0].result_status, "TIMEOUT");
            assert.equal(capturedRows[0].failure_reason, "timer expired waiting for C");
        } finally {
            await closeNode(node);
            safeCleanup(dir);
        }
    });

    test("abc_result.event_id audit alias is accepted as the idempotency key", async () => {
        const { node, dir } = createDbNode();
        try {
            const sent = await emitInput(node, {
                payload: {
                    group_id: 1,
                    source_id: 2,
                    region: "audit-region",
                },
                aiban: {
                    group_id: 1,
                    source_id: 2,
                },
                abc_result: {
                    cycle_id: "audit-cycle",
                    result_status: "OK",
                    event_id: "audit:event:id",
                    group_id: 1,
                    source_id: 2,
                    failure_reason: null,
                    image_path: "audit.jpg",
                },
            });

            assert.equal(sent.length, 1);
            assert.equal(sent[0].db_result.result_event_id, "audit:event:id");
            assert.equal(capturedRows.length, 1);
            assert.equal(capturedRows[0].event_id, "audit:event:id");
            assert.equal(capturedRows[0].result_status, "OK");
        } finally {
            await closeNode(node);
            safeCleanup(dir);
        }
    });

    test("mismatched workflow result_event_id is rejected before enqueue", async () => {
        const { node, dir } = createDbNode();
        try {
            const msg = standardMsg("OK", { cycle_id: "cycle-bad-result-id" });
            msg.workflow.result = {
                result_event_id: "wrong:event:id",
            };

            const sent = await emitInput(node, msg);

            assert.equal(sent.length, 1);
            assert.equal(sent[0].db_result.status, "failed");
            assert.equal(capturedRows.length, 0);
            assert.ok(node.errors.some((err) => String(err).includes("result_event_id mismatch")));
        } finally {
            await closeNode(node);
            safeCleanup(dir);
        }
    });
});
