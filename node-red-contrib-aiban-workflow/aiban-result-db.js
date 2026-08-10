"use strict";

const path = require("node:path");
const { MysqlWriteQueue } = require("./lib/mysql-write-queue");
const {
    applyNormalizedTerminalResult,
    normalizeTerminalResultMessage,
} = require("./lib/result-message");

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

const RECOVERY_EXPIRED_REASON_RE = /Node-RED[\s\S]*Deploy[\s\S]*elapsed=/;

function beijingDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(date).reduce((acc, part) => {
        if (part.type !== "literal") acc[part.type] = part.value;
        return acc;
    }, {});
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}:${parts.second}`;

    return {
        day,
        time,
        time_division: `${parts.hour}:${parts.minute}`,
        time_month: parts.month,
        week: isoWeekNumber(Number(parts.year), Number(parts.month), Number(parts.day)),
        timedate: `${day} ${time}`,
    };
}

function isoWeekNumber(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - weekday);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function normalizeImagePath(value) {
    if (!value) return "";
    return String(value).replace(/\\/g, "/").replace(/^D:\/product/i, "");
}

function buildAlarmContent(status, reason, okAlarmContent, missingStepAlarmName) {
    if (status === "OK") return okAlarmContent || "流程OK";
    // For NG/TIMEOUT/INTERRUPTED: prefer the missing step's alarm_name
    // from icam_alarmname_data, then fall back to the reason string
    if (missingStepAlarmName) return missingStepAlarmName;
    if (reason) return String(reason);
    if (status === "TIMEOUT") return "流程超时";
    if (status === "INTERRUPTED") return "流程中断";
    return "流程NG";
}

function shouldSkipDbWrite(abcResult) {
    const status = abcResult && abcResult.result_status;
    const reason = String((abcResult && abcResult.failure_reason) || "");
    return status === "INTERRUPTED" && RECOVERY_EXPIRED_REASON_RE.test(reason);
}

module.exports = function registerResultDbNode(RED) {
    function AibanResultDbNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const tableName = config.tableName || "icamera_data.workflow_result_event";
        const regionName = config.regionName || "";
        const okAlarmContent = config.okAlarmContent || "流程OK";
        const maxRetries = Math.max(1, Number(config.maxRetries) || 3);
        const retryDelayMs = Math.max(100, Number(config.retryDelayMs) || 500);
        const queueSize = Math.max(10, Number(config.queueSize) || 1000);

        // DB connection: credentials > env var > default
        const dbHost = config.dbHost || process.env.MYSQL_HOST || "127.0.0.1";
        const dbPort = Number(config.dbPort) || Number(process.env.MYSQL_PORT) || 3306;
        const dbUser = config.dbUser || process.env.MYSQL_USER || "root";
        // Password uses the Node-RED credentials mechanism so it is never
        // written to flows.json in plaintext.  Fall back to MYSQL_PASSWD env var.
        const dbPassword = node.credentials?.dbPassword !== undefined
            && node.credentials.dbPassword !== ""
            ? node.credentials.dbPassword
            : (process.env.MYSQL_PASSWD || "");
        const dbName = config.dbName || process.env.MYSQL_DB || "icamera_data";

        // Create write queue
        const writeQueue = new MysqlWriteQueue({
            host: dbHost,
            port: dbPort,
            user: dbUser,
            password: dbPassword,
            database: dbName,
            tableName,
            failureDir: path.join(
                (RED.settings && RED.settings.userDir) || process.cwd(),
                "data",
                "workflow"
            ),
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
                const normalized = normalizeTerminalResultMessage(msg);

                // Only process terminal events (from aiban-result, these are always terminal)
                if (!normalized.terminal) {
                    // Pass through non-terminal events unchanged
                    send(msg);
                    if (done) done();
                    return;
                }
                applyNormalizedTerminalResult(msg, normalized);
                const abcResult = normalized.abcResult;

                const resultEventId = normalized.resultEventId || abcResult.result_event_id || abcResult.event_id || "";
                if (shouldSkipDbWrite(abcResult)) {
                    msg.db_result = {
                        result_event_id: resultEventId,
                        event_id: resultEventId,
                        status: "skipped",
                        reason: "recovery_expired_interrupted",
                        db_write_duration_ms: null,
                        attempts: 0,
                        table: tableName,
                    };
                    node.status({
                        fill: "grey",
                        shape: "ring",
                        text: "skipped recovery interrupted",
                    });
                    send(msg);
                    if (done) done();
                    return;
                }

                const frame = msg.payload || {};
                const now = beijingDateParts();
                const workflowResult = normalized.workflowResult || msg.workflow?.result || {};
                const workflowOutcome = normalized.workflowOutcome || msg.workflow?.outcome || {};

                // Persist the standard result contract.  Audit alarm fields
                // stay inside result_json; the idempotency key and query
                // dimensions are first-class columns in workflow_result_event.
                const resultStatus = abcResult.result_status;
                const row = {
                    result_event_id: resultEventId,
                    event_id: resultEventId,
                    workflow_id: workflowResult.workflow_id || msg.workflow?.workflow_id
                        || abcResult.workflow_id || "unknown",
                    scene_id: workflowResult.scene_id || msg.workflow?.scene_id
                        || abcResult.scene_id || "default",
                    cycle_id: abcResult.cycle_id,
                    session_id: abcResult.session_id,
                    stream_id: abcResult.stream_id,
                    group_id: Number(abcResult.group_id || frame.group_id || msg.aiban?.group_id || 0),
                    source_id: Number(abcResult.source_id || frame.source_id || msg.aiban?.source_id || 0),
                    result_status: resultStatus,
                    failure_reason: abcResult.failure_reason || null,
                    image_path: normalizeImagePath(
                        abcResult.image_path || frame.image_path || frame.img_path || msg.image_path
                    ),
                    started_at: workflowOutcome.started_at || abcResult.cycle_started_at || null,
                    finished_at: workflowOutcome.finished_at || abcResult.cycle_finished_at
                        || `${now.day}T${now.time}+08:00`,
                    duration_ms: workflowOutcome.duration_ms ?? abcResult.cycle_duration_ms ?? null,
                    created_at: `${now.day}T${now.time}+08:00`,
                    result_json: {
                        result: workflowResult,
                        outcome: workflowOutcome,
                        audit_alarm: {
                            region: frame.region || msg.region || regionName,
                            alarm_content: buildAlarmContent(
                                resultStatus,
                                abcResult.failure_reason,
                                okAlarmContent,
                                abcResult.missing_step_alarm_name
                            ),
                            alarm_status: resultStatus === "OK" ? "OK" : "NG",
                        },
                    },
                };

                const queueResult = writeQueue.enqueue(row);
                if (queueResult.accepted) writeCount++;

                // Attach db_result to msg
                msg.db_result = {
                    result_event_id: resultEventId,
                    event_id: resultEventId,  // backward compat alias
                    status: queueResult.status,
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
                const fallbackEventId = msg.workflow?.result?.result_event_id
                    || msg.workflow?.outcome?.compatibility?.abc_result_event_id
                    || msg.abc_result?.result_event_id
                    || msg.abc_result?.event_id || "";
                msg.db_result = {
                    result_event_id: fallbackEventId,
                    event_id: fallbackEventId,
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
            tableName: { value: "icamera_data.workflow_result_event" },
            regionName: { value: "" },
            okAlarmContent: { value: "流程OK" },
            dbHost: { value: "127.0.0.1" },
            dbPort: { value: 3306 },
            dbUser: { value: "root" },
            dbName: { value: "icamera_data" },
            maxRetries: { value: 3 },
            retryDelayMs: { value: 500 },
            queueSize: { value: 1000 },
        },
        credentials: {
            dbPassword: { type: "password" },
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
