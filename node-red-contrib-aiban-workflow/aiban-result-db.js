"use strict";

const { MysqlWriteQueue } = require("./lib/mysql-write-queue");
const { beijingNowISO } = require("./lib/workflow-audit");

/**
 * aiban-result-db — Async MySQL Result Writer
 *
 * Processes terminal events (OK, NG, TIMEOUT, INTERRUPTED) from the
 * aiban-result node and writes them idempotently to MySQL.
 *
 * Features:
 * - Async write queue (non-blocking)
 * - ON DUPLICATE KEY UPDATE for idempotency (event_id UNIQUE)
 * - Configurable retry with exponential backoff
 * - Failure fallback to local JSONL file
 * - Per-cycle write timing measurement
 * - Reports db_result status back on output
 *
 * Input: terminal events from aiban-result node
 * Output: same message with db_result block appended
 */

const TERMINAL_STATUSES = ["OK", "NG", "TIMEOUT", "INTERRUPTED"];

module.exports = function registerResultDbNode(RED) {
    function AibanResultDbNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const tableName = config.tableName || "icamera_data.workflow_abc_result";
        const maxRetries = Math.max(1, Number(config.maxRetries) || 3);
        const retryDelayMs = Math.max(100, Number(config.retryDelayMs) || 500);
        const queueSize = Math.max(10, Number(config.queueSize) || 1000);

        // Create write queue (env-var based config, no passwords in flow JSON)
        const writeQueue = new MysqlWriteQueue({
            host: process.env.MYSQL_HOST || "127.0.0.1",
            port: Number(process.env.MYSQL_PORT) || 3306,
            user: process.env.MYSQL_USER || "root",
            password: process.env.MYSQL_PASSWD || "",
            database: process.env.MYSQL_DB || "icamera_data",
            maxRetries,
            retryDelayMs,
            queueSize,
        });

        let writeCount = 0;
        let closed = false;

        node.on("input", function onInput(msg, send, done) {
            if (closed) {
                if (done) done();
                return;
            }

            try {
                const abcResult = msg.abc_result;

                // Only process terminal events (from aiban-result, these are always terminal)
                if (!abcResult || !TERMINAL_STATUSES.includes(abcResult.result_status)) {
                    // Pass through non-terminal events unchanged
                    send(msg);
                    if (done) done();
                    return;
                }

                const frame = msg.payload || {};
                const workflowData = msg.workflow || {};
                const now = beijingNowISO();

                // Build the DB row from new message format
                const row = {
                    event_id: abcResult.event_id,
                    cycle_id: abcResult.cycle_id,
                    workflow_id: workflowData.workflow_id || "",
                    session_id: abcResult.session_id || frame.session_id || msg.aiban?.session_id || "",
                    stream_id: abcResult.stream_id || frame.stream_id || msg.aiban?.stream_id || "",
                    group_id: Number(abcResult.group_id || frame.group_id || 0),
                    source_id: Number(abcResult.source_id || frame.source_id || 0),
                    start_frame_seq: abcResult.start_frame_seq ?? null,
                    end_frame_seq: Number(abcResult.end_frame_seq || frame.frame_seq || 0),
                    actual_sequence: abcResult.actual_sequence || null,
                    result_status: abcResult.result_status,
                    failure_reason: abcResult.failure_reason || null,
                    started_at: abcResult.cycle_started_at || null,
                    finished_at: abcResult.cycle_finished_at || null,
                    cycle_duration_ms: abcResult.cycle_duration_ms ?? null,
                    db_write_duration_ms: null,
                    created_at: now,
                };

                // Enqueue for async write
                writeQueue.enqueue(row);
                writeCount++;

                // Attach db_result to msg
                msg.db_result = {
                    event_id: abcResult.event_id,
                    status: "queued",
                    db_write_duration_ms: null,
                    attempts: 0,
                    table: tableName,
                };

                // Share audit logger reference with write queue for db_write events
                if (msg._audit && !writeQueue._audit) {
                    writeQueue._audit = msg._audit;
                }

                node.status({
                    fill: "blue",
                    shape: "dot",
                    text: `已写入 ${writeCount} | 队列 ${writeQueue.stats().pending}`,
                });

                // Pass through with db_result
                send(msg);
            } catch (error) {
                node.error(`result-db error: ${error.message}`, msg);
                msg.db_result = {
                    event_id: msg.abc_result?.event_id || "",
                    status: "failed",
                    db_write_duration_ms: null,
                    attempts: 0,
                    table: tableName,
                    error: error.message,
                };
                send(msg);
            }

            if (done) done();
        });

        node.on("close", async function onClose(done) {
            closed = true;
            try {
                await writeQueue.close();
                node.status({});
                done();
            } catch (error) {
                done(error);
            }
        });

        node.status({
            fill: "green",
            shape: "ring",
            text: `ready (${tableName})`,
        });
    }

    RED.nodes.registerType("aiban-result-db", AibanResultDbNode, {
        category: "艾班工作流",
        color: "#90EE90",
        defaults: {
            name: { value: "结果入库" },
            tableName: { value: "icamera_data.workflow_abc_result" },
            maxRetries: { value: 3 },
            retryDelayMs: { value: 500 },
            queueSize: { value: 1000 },
        },
        inputs: 1,
        outputs: 1,
        icon: "font-awesome/fa-database",
        paletteLabel: "aiban result db",
        label: function () {
            return this.name || "结果入库";
        },
    });
};
