"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { beijingNowISO } = require("./workflow-audit");

const DEFAULT_CONFIG = Object.freeze({
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    password: "",
    database: "icamera_data",
    tableName: "icamera_data.workflow_result_event",
    poolSize: 5,
    maxRetries: 3,
    retryDelayMs: 500,
    queueSize: 1000,
    failureDir: "",
    poolFactory: null,
});

function assertSafeTableName(value) {
    const name = String(value || "").trim();
    if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?$/.test(name)) {
        throw new Error(`Unsafe MySQL table name: ${value}`);
    }
    return name;
}

function eventIdOf(row) {
    return String(row && (row.result_event_id || row.event_id) || "").trim();
}

class MysqlWriteQueue extends EventEmitter {
    constructor(config = {}, auditLogger = null) {
        super();
        this._config = { ...DEFAULT_CONFIG, ...config };
        this._audit = auditLogger;
        this._queue = [];
        this._processing = false;
        this._accepting = true;
        this._closed = false;
        this._pool = null;
        this._sqlTemplate = null;
        this._pendingEventIds = new Set();
        this._succeededEventIds = new Set();
        this._idleWaiters = [];
        this._stats = {
            enqueued: 0,
            succeeded: 0,
            failed: 0,
            retried: 0,
            skipped: 0,
            overflowed: 0,
        };
        this._failureDir = null;
    }

    _ensurePool() {
        if (this._pool) return;
        if (typeof this._config.poolFactory === "function") {
            this._pool = this._config.poolFactory(this._config);
        } else {
            const mysql2 = require("mysql2/promise");
            this._pool = mysql2.createPool({
                host: this._config.host,
                port: this._config.port,
                user: this._config.user,
                password: this._config.password,
                database: this._config.database,
                waitForConnections: true,
                connectionLimit: this._config.poolSize,
                queueLimit: 0,
                charset: "utf8mb4",
                enableKeepAlive: true,
                keepAliveInitialDelay: 10000,
            });
        }

        const tableName = assertSafeTableName(this._config.tableName);
        this._sqlTemplate = `
            INSERT INTO ${tableName} (
                result_event_id, workflow_id, scene_id, cycle_id,
                session_id, stream_id, group_id, source_id,
                result_status, failure_reason, image_path,
                started_at, finished_at, duration_ms, result_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE result_event_id = VALUES(result_event_id)
        `;
    }

    enqueue(row) {
        const resultEventId = eventIdOf(row);
        if (!resultEventId) {
            throw new Error("result_event_id is required for idempotent MySQL writes");
        }
        if (!this._accepting || this._closed) {
            return { accepted: false, status: "closed", result_event_id: resultEventId };
        }
        if (this._pendingEventIds.has(resultEventId) || this._succeededEventIds.has(resultEventId)) {
            this._stats.skipped++;
            const duplicate = { accepted: false, status: "duplicate", result_event_id: resultEventId };
            this.emit("duplicate", duplicate);
            return duplicate;
        }
        if (this._queue.length >= this._config.queueSize) {
            this._writeToFailureFile(row, "queue_full");
            this._stats.failed++;
            this._stats.overflowed++;
            const overflow = { accepted: false, status: "overflow", result_event_id: resultEventId };
            this.emit("overflow", overflow);
            return overflow;
        }

        this._ensurePool();
        this._queue.push({ row: { ...row, result_event_id: resultEventId }, attempts: 0 });
        this._pendingEventIds.add(resultEventId);
        this._stats.enqueued++;
        const queued = { accepted: true, status: "queued", result_event_id: resultEventId };
        this.emit("queued", queued);
        if (this._audit) {
            this._audit.record("db_write_queued", {
                result_event_id: resultEventId,
                event_id: resultEventId,
                queue_depth: this._queue.length,
            });
        }
        if (!this._processing) {
            this._processing = true;
            setImmediate(() => this._processQueue());
        }
        return queued;
    }

    _bindValues(row) {
        return [
            row.result_event_id,
            row.workflow_id || "",
            row.scene_id || "",
            row.cycle_id || "",
            row.session_id || "",
            row.stream_id || "",
            Number(row.group_id || 0),
            Number(row.source_id || 0),
            row.result_status || row.status || "",
            row.failure_reason || row.reason || null,
            row.image_path || "",
            row.started_at || null,
            row.finished_at || null,
            row.duration_ms === undefined ? null : row.duration_ms,
            JSON.stringify(row.result_json || row.outcome || row),
            row.created_at || beijingNowISO(),
        ];
    }

    async _processQueue() {
        while (this._queue.length > 0) {
            const task = this._queue.shift();
            task.attempts++;
            const resultEventId = eventIdOf(task.row);
            const started = process.hrtime.bigint();
            try {
                const connection = await this._pool.getConnection();
                try {
                    const [result] = await connection.execute(
                        this._sqlTemplate,
                        this._bindValues(task.row)
                    );
                    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
                    const duplicate = Number(result && result.affectedRows) === 0;
                    if (duplicate) this._stats.skipped++;
                    else this._stats.succeeded++;
                    this._pendingEventIds.delete(resultEventId);
                    this._succeededEventIds.add(resultEventId);
                    const info = {
                        result_event_id: resultEventId,
                        status: duplicate ? "duplicate" : "succeeded",
                        duplicate,
                        attempts: task.attempts,
                        db_write_duration_ms: Number(durationMs.toFixed(3)),
                    };
                    this.emit(duplicate ? "duplicate" : "succeeded", info);
                    if (this._audit) {
                        this._audit.record(duplicate ? "db_write_duplicate" : "db_write_succeeded", info);
                    }
                } finally {
                    connection.release();
                }
            } catch (error) {
                if (task.attempts < this._config.maxRetries) {
                    this._stats.retried++;
                    const delay = this._config.retryDelayMs * Math.pow(2, task.attempts - 1);
                    this.emit("retry", {
                        result_event_id: resultEventId,
                        attempts: task.attempts,
                        delay_ms: delay,
                        error: error.message,
                    });
                    await new Promise(resolve => setTimeout(resolve, delay));
                    this._queue.unshift(task);
                } else {
                    this._stats.failed++;
                    this._pendingEventIds.delete(resultEventId);
                    this._writeToFailureFile(task.row, error.message);
                    const info = {
                        result_event_id: resultEventId,
                        status: "failed",
                        attempts: task.attempts,
                        error: error.message,
                    };
                    this.emit("failed", info);
                    if (this._audit) this._audit.record("db_write_failed", info);
                }
            }
        }
        this._processing = false;
        this._resolveIdle();
        if (this._queue.length > 0 && !this._processing) {
            this._processing = true;
            setImmediate(() => this._processQueue());
        }
    }

    _failureFile() {
        if (!this._failureDir) {
            this._failureDir = this._config.failureDir
                || (process.env.NODE_RED_USER_DIR
                    ? path.join(process.env.NODE_RED_USER_DIR, "data", "workflow")
                    : path.join(os.tmpdir(), "aiban-workflow", "data", "workflow"));
            fs.mkdirSync(this._failureDir, { recursive: true });
        }
        return path.join(this._failureDir, "db-failed.jsonl");
    }

    _writeToFailureFile(row, errorMsg) {
        const entry = { failed_at: beijingNowISO(), error: String(errorMsg), row };
        fs.appendFileSync(this._failureFile(), JSON.stringify(entry) + "\n", "utf8");
    }

    replayFailureFile(filePath = this._failureFile()) {
        if (!fs.existsSync(filePath)) return { accepted: 0, duplicate: 0, archived_to: null };
        const entries = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
        let accepted = 0;
        let duplicate = 0;
        for (const line of entries) {
            const parsed = JSON.parse(line);
            const result = this.enqueue(parsed.row || parsed);
            if (result.accepted) accepted++;
            else if (result.status === "duplicate") duplicate++;
        }
        const archive = `${filePath}.replayed-${Date.now()}`;
        fs.renameSync(filePath, archive);
        return { accepted, duplicate, archived_to: archive };
    }

    stats() {
        return {
            ...this._stats,
            pending: this._queue.length + (this._processing ? 1 : 0),
            queueSize: this._config.queueSize,
        };
    }

    waitForIdle() {
        if (!this._processing && this._queue.length === 0) return Promise.resolve();
        return new Promise(resolve => this._idleWaiters.push(resolve));
    }

    _resolveIdle() {
        if (this._processing || this._queue.length > 0) return;
        for (const resolve of this._idleWaiters.splice(0)) resolve();
    }

    async close() {
        if (this._closed) return;
        this._accepting = false;
        await this.waitForIdle();
        if (this._pool && typeof this._pool.end === "function") await this._pool.end();
        this._pool = null;
        this._closed = true;
    }
}

module.exports = { MysqlWriteQueue, DEFAULT_CONFIG, assertSafeTableName };
