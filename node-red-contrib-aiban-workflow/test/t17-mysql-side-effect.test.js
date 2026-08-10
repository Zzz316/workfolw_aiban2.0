"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const { MysqlWriteQueue } = require("../lib/mysql-write-queue");
const { SideEffectLedger } = require("../lib/side-effect-ledger");
const { IdempotentHttpOutput } = require("../lib/idempotent-http-output");
const { OUTCOME_SCHEMA_VERSION, makeResultEventId } = require("../lib/workflow-contract");

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "aiban-t17-"));
}

function row(id, status = "OK") {
    return {
        result_event_id: id,
        workflow_id: "group/1/scene/plug",
        scene_id: "plug",
        cycle_id: `cycle-${id}`,
        session_id: "session-1",
        stream_id: "group-1/source-1",
        group_id: 1,
        source_id: 1,
        result_status: status,
        finished_at: "2026-08-01T10:00:00.000+08:00",
        image_path: "captures/result.jpg",
    };
}

function fakePool(options = {}) {
    const ids = options.ids || new Set();
    let failures = Number(options.failures || 0);
    const calls = [];
    return {
        ids,
        calls,
        async getConnection() {
            return {
                async execute(sql, values) {
                    calls.push({ sql, values });
                    if (failures > 0) {
                        failures--;
                        throw new Error("database unavailable");
                    }
                    const id = values[0];
                    if (ids.has(id)) return [{ affectedRows: 0 }];
                    ids.add(id);
                    return [{ affectedRows: 1 }];
                },
                release() {},
            };
        },
        async end() {},
    };
}

function standardMessage(status = "NG", cycleId = "cycle-api") {
    const outcome = {
        schema_version: OUTCOME_SCHEMA_VERSION,
        workflow_id: "group/1/scene/plug",
        scene_id: "plug",
        cycle_id: cycleId,
        status,
        started_at: "2026-08-01T10:00:00.000+08:00",
        finished_at: "2026-08-01T10:00:05.000+08:00",
        duration_ms: 5000,
        code: status === "OK" ? null : status,
        reason: status === "OK" ? null : "test alarm",
        expected_step: status === "OK" ? null : "C",
        actual_steps: ["A", "B"],
        runtime: {
            session_id: "session-1",
            stream_id: "group-1/source-1",
            group_id: 1,
            source_id: 1,
            start_event_seq: 1,
            end_event_seq: 3,
        },
        evidence: { image_path: "captures/result.jpg", screenshot_error: null },
    };
    return { workflow: { outcome } };
}

describe("T17 MySQL result idempotency", () => {
    test("duplicate result_event_id produces one business row", async () => {
        const pool = fakePool();
        const queue = new MysqlWriteQueue({
            tableName: "icamera_data.workflow_result_event",
            retryDelayMs: 1,
            poolFactory: () => pool,
        });
        assert.equal(queue.enqueue(row("evt-1")).status, "queued");
        assert.equal(queue.enqueue(row("evt-1")).status, "duplicate");
        await queue.waitForIdle();
        // A replay after success is still suppressed in-process; the SQL
        // UNIQUE key protects the same replay after restart.
        assert.equal(queue.enqueue(row("evt-1")).status, "duplicate");
        assert.equal(pool.ids.size, 1);
        assert.match(pool.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
        assert.equal(pool.calls[0].values[0], "evt-1");
        await queue.close();
    });

    test("temporary outage retries and close drains pending work", async () => {
        const pool = fakePool({ failures: 2 });
        const queue = new MysqlWriteQueue({
            maxRetries: 3,
            retryDelayMs: 1,
            poolFactory: () => pool,
        });
        queue.enqueue(row("evt-retry", "TIMEOUT"));
        await queue.close();
        assert.equal(queue.stats().succeeded, 1);
        assert.equal(queue.stats().retried, 2);
        assert.ok(pool.ids.has("evt-retry"));
    });

    test("terminal failure is journaled and can be replayed", async () => {
        const dir = tempDir();
        try {
            const failed = new MysqlWriteQueue({
                failureDir: dir,
                maxRetries: 1,
                retryDelayMs: 1,
                poolFactory: () => fakePool({ failures: 99 }),
            });
            failed.enqueue(row("evt-replay", "NG"));
            await failed.close();
            const journal = path.join(dir, "db-failed.jsonl");
            assert.ok(fs.existsSync(journal));

            const recoveredPool = fakePool();
            const recovered = new MysqlWriteQueue({
                failureDir: dir,
                retryDelayMs: 1,
                poolFactory: () => recoveredPool,
            });
            const replay = recovered.replayFailureFile(journal);
            assert.equal(replay.accepted, 1);
            assert.ok(fs.existsSync(replay.archived_to));
            await recovered.close();
            assert.ok(recoveredPool.ids.has("evt-replay"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("queue overflow is observable and journaled", async () => {
        const dir = tempDir();
        try {
            const pool = fakePool({ failures: 1 });
            const queue = new MysqlWriteQueue({
                failureDir: dir,
                queueSize: 1,
                maxRetries: 1,
                poolFactory: () => pool,
            });
            queue.enqueue(row("evt-first"));
            const overflow = queue.enqueue(row("evt-overflow"));
            assert.equal(overflow.status, "overflow");
            assert.equal(queue.stats().overflowed, 1);
            await queue.close();
            assert.match(fs.readFileSync(path.join(dir, "db-failed.jsonl"), "utf8"), /evt-overflow/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("T17 idempotent API side effect", () => {
    test("replay sends one HTTP notification and carries the idempotency key", async () => {
        const dir = tempDir();
        const received = [];
        const server = http.createServer((request, response) => {
            const chunks = [];
            request.on("data", chunk => chunks.push(chunk));
            request.on("end", () => {
                received.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
                response.writeHead(200, { "content-type": "application/json" });
                response.end("{\"ok\":true}");
            });
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const ledger = new SideEffectLedger(path.join(dir, "ledger.db"));
        try {
            const address = server.address();
            const output = new IdempotentHttpOutput({
                url: `http://127.0.0.1:${address.port}/result`,
                channel: "test-api",
                ledger,
                retryDelayMs: 1,
            });
            const msg = standardMessage();
            const expectedId = makeResultEventId(msg.workflow.outcome);
            const first = await output.deliver(msg);
            const duplicate = await output.deliver(msg);
            assert.equal(first.status, "delivered");
            assert.equal(duplicate.status, "duplicate");
            assert.equal(received.length, 1);
            assert.equal(received[0].headers["idempotency-key"], expectedId);
            assert.equal(JSON.parse(received[0].body).outcome.scene_id, "plug");
            assert.equal(ledger.get("test-api", expectedId).status, "DELIVERED");
        } finally {
            ledger.close();
            await new Promise(resolve => server.close(resolve));
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
