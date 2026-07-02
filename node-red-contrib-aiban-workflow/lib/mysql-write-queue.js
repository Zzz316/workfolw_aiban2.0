"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { beijingNowISO } = require("./workflow-audit");

/**
 * Async MySQL write queue with connection pooling and retry.
 * Uses mysql2 package for native Promise support and prepared statements.
 *
 * Features:
 * - Connection pool (mysql2.createPool)
 * - Non-blocking enqueue → worker drains queue
 * - ON DUPLICATE KEY UPDATE for idempotency
 * - Retry with configurable max attempts and backoff
 * - Failure fallback to local JSONL file
 */

const DEFAULT_CONFIG = {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWD || "",
    database: process.env.MYSQL_DB || "icamera_data",
    poolSize: 5,
    maxRetries: 3,
    retryDelayMs: 500,
    queueSize: 1000,
};

class MysqlWriteQueue {
    /**
     * @param {object} config - { host, port, user, password, database, poolSize, maxRetries, retryDelayMs, queueSize }
     * @param {object} [auditLogger] - WorkflowAuditLogger instance for event recording
     */
    constructor(config = {}, auditLogger = null) {
        this._config = { ...DEFAULT_CONFIG, ...config };
        this._audit = auditLogger;
        this._queue = [];
        this._processing = false;
        this._closed = false;
        this._pool = null;
        this._sqlTemplate = null;
        this._stats = {
            enqueued: 0,
            succeeded: 0,
            failed: 0,
            retried: 0,
            skipped: 0,
        };
        this._failureDir = null;
    }

    /**
     * Initialize the connection pool lazily (on first use).
     */
    _ensurePool() {
        if (this._pool) return;
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
        // Build SQL template once
        this._sqlTemplate = `
            INSERT INTO icamera_data.workflow_abc_result (
                event_id, cycle_id, workflow_id, session_id, stream_id,
                group_id, source_id, start_frame_seq, end_frame_seq,
                actual_sequence, result_status, failure_reason,
                started_at, finished_at, cycle_duration_ms,
                db_write_duration_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                db_write_duration_ms = VALUES(db_write_duration_ms),
                failure_reason = COALESCE(VALUES(failure_reason), failure_reason)
        `;
    }

    /**
     * Enqueue a write task. Returns immediately (non-blocking).
     *
     * @param {object} row - flat object matching workflow_abc_result columns
     */
    enqueue(row) {
        if (this._closed) return;
        this._ensurePool();

        // Queue overflow protection
        if (this._queue.length >= this._config.queueSize) {
            // Write to failure file instead of silently dropping
            this._writeToFailureFile(row, "queue_full");
            this._stats.failed++;
            return;
        }

        this._queue.push({
            row,
            attempts: 0,
            enqueuedAt: Date.now(),
        });
        this._stats.enqueued++;

        if (this._audit) {
            this._audit.record("db_write_queued", {
                event_id: row.event_id,
                queue_depth: this._queue.length,
            });
        }

        // Trigger drain
        if (!this._processing) {
            this._processing = true;
            setImmediate(() => this._processQueue());
        }
    }

    /**
     * Drain the queue asynchronously. Each item gets up to maxRetries attempts.
     */
    async _processQueue() {
        while (this._queue.length > 0 && !this._closed) {
            const task = this._queue.shift();
            task.attempts++;
            const dbWriteStart = process.hrtime.bigint();

            if (this._audit) {
                this._audit.record("db_write_started", {
                    event_id: task.row.event_id,
                    attempts: task.attempts,
                });
            }

            try {
                const connection = await this._pool.getConnection();
                try {
                    const row = task.row;
                    await connection.execute(this._sqlTemplate, [
                        row.event_id,
                        row.cycle_id,
                        row.workflow_id || "",
                        row.session_id || "",
                        row.stream_id || "",
                        Number(row.group_id || 0),
                        Number(row.source_id || 0),
                        row.start_frame_seq ?? null,
                        row.end_frame_seq ?? null,
                        row.actual_sequence || null,
                        row.result_status,
                        row.failure_reason || null,
                        row.started_at || null,
                        row.finished_at || null,
                        row.cycle_duration_ms ?? null,
                        null, // db_write_duration_ms — filled on retry
                        row.created_at || beijingNowISO(),
                    ]);

                    const dbWriteMs = Number(process.hrtime.bigint() - dbWriteStart) / 1e6;
                    this._stats.succeeded++;

                    if (this._audit) {
                        this._audit.record("db_write_succeeded", {
                            event_id: row.event_id,
                            db_write_duration_ms: Number(dbWriteMs.toFixed(3)),
                            attempts: task.attempts,
                        });
                        // Update cycle summary with actual DB write time
                        this._audit.recordCycleSummary({
                            cycle_id: row.cycle_id,
                            db_write_ms: Number(dbWriteMs.toFixed(3)),
                        });
                    }
                } finally {
                    connection.release();
                }
            } catch (error) {
                const dbWriteMs = Number(process.hrtime.bigint() - dbWriteStart) / 1e6;

                if (task.attempts < this._config.maxRetries) {
                    // Retry with backoff
                    this._stats.retried++;
                    const delay = this._config.retryDelayMs * Math.pow(2, task.attempts - 1);
                    await new Promise((r) => setTimeout(r, delay));
                    // Push back to front of queue
                    this._queue.unshift(task);
                } else {
                    // Exhausted retries → failure fallback
                    this._stats.failed++;
                    this._writeToFailureFile(task.row, error.message);

                    if (this._audit) {
                        this._audit.record("db_write_failed", {
                            event_id: task.row.event_id,
                            db_write_duration_ms: Number(dbWriteMs.toFixed(3)),
                            attempts: task.attempts,
                            error_message: error.message,
                        });
                    }
                }
            }
        }
        this._processing = false;

        // Check if more items arrived during processing
        if (this._queue.length > 0 && !this._closed) {
            this._processing = true;
            setImmediate(() => this._processQueue());
        }
    }

    /**
     * Write failed row to local JSONL fallback file for manual recovery.
     */
    _writeToFailureFile(row, errorMsg) {
        if (!this._failureDir) {
            this._failureDir = path.join(
                process.env.NODE_RED_USER_DIR || ".",
                "data", "workflow"
            );
            if (!fs.existsSync(this._failureDir)) {
                fs.mkdirSync(this._failureDir, { recursive: true });
            }
        }
        const filePath = path.join(this._failureDir, "db-failed.jsonl");
        const entry = {
            failed_at: beijingNowISO(),
            error: String(errorMsg),
            row,
        };
        fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
    }

    /**
     * Get current statistics.
     */
    stats() {
        return {
            ...this._stats,
            pending: this._queue.length,
            queueSize: this._config.queueSize,
        };
    }

    /**
     * Close the connection pool and drain remaining items.
     */
    async close() {
        this._closed = true;
        // Final drain attempt
        if (this._queue.length > 0) {
            await this._processQueue();
        }
        if (this._pool) {
            await this._pool.end();
            this._pool = null;
        }
    }
}

module.exports = { MysqlWriteQueue, DEFAULT_CONFIG };
