"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { beijingNowISO } = require("./workflow-audit");

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
    tableName: "icamera_data.icam_alarm_data",
    failureDir: "",
};

function assertSafeTableName(tableName) {
    const value = String(tableName || "");
    if (!/^[A-Za-z0-9_$.]+$/.test(value)) {
        throw new Error(`unsafe table name: ${value}`);
    }
    return value;
}

class MysqlWriteQueue {
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

        const tableName = assertSafeTableName(this._config.tableName);
        this._sqlTemplate = `
            INSERT INTO ${tableName} (
                day, time, time_division, time_month, week, region,
                group_id, camera_id, alarm_content, img_path, timedate, alarm_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
    }

    enqueue(row) {
        if (this._closed) return;
        this._ensurePool();

        if (this._queue.length >= this._config.queueSize) {
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
                event_id: row.event_id || row.result_event_id || "",
                queue_depth: this._queue.length,
            });
        }

        if (!this._processing) {
            this._processing = true;
            setImmediate(() => this._processQueue());
        }
    }

    async _processQueue() {
        while (this._queue.length > 0 && !this._closed) {
            const task = this._queue.shift();
            task.attempts++;
            const dbWriteStart = process.hrtime.bigint();

            if (this._audit) {
                this._audit.record("db_write_started", {
                    event_id: task.row.event_id || task.row.result_event_id || "",
                    attempts: task.attempts,
                });
            }

            try {
                const connection = await this._pool.getConnection();
                try {
                    const row = task.row;
                    await connection.execute(this._sqlTemplate, [
                        row.day || "",
                        row.time || "",
                        row.time_division || "",
                        row.time_month || "",
                        String(row.week || ""),
                        row.region || "",
                        Number(row.group_id || 0),
                        Number(row.camera_id || 0),
                        row.alarm_content || "",
                        row.img_path || "",
                        row.timedate || null,
                        row.alarm_status || "",
                    ]);

                    const dbWriteMs = Number(process.hrtime.bigint() - dbWriteStart) / 1e6;
                    this._stats.succeeded++;

                    if (this._audit) {
                        this._audit.record("db_write_succeeded", {
                            event_id: row.event_id || row.result_event_id || "",
                            db_write_duration_ms: Number(dbWriteMs.toFixed(3)),
                            attempts: task.attempts,
                        });
                        this._audit.recordCycleSummary({
                            cycle_id: row.cycle_id || "",
                            db_write_ms: Number(dbWriteMs.toFixed(3)),
                        });
                    }
                } finally {
                    connection.release();
                }
            } catch (error) {
                const dbWriteMs = Number(process.hrtime.bigint() - dbWriteStart) / 1e6;

                if (task.attempts < this._config.maxRetries) {
                    this._stats.retried++;
                    const delay = this._config.retryDelayMs * Math.pow(2, task.attempts - 1);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    this._queue.unshift(task);
                } else {
                    this._stats.failed++;
                    this._writeToFailureFile(task.row, error.message);

                    if (this._audit) {
                        this._audit.record("db_write_failed", {
                            event_id: task.row.event_id || task.row.result_event_id || "",
                            db_write_duration_ms: Number(dbWriteMs.toFixed(3)),
                            attempts: task.attempts,
                            error_message: error.message,
                        });
                    }
                }
            }
        }

        this._processing = false;
        if (this._queue.length > 0 && !this._closed) {
            this._processing = true;
            setImmediate(() => this._processQueue());
        }
    }

    _writeToFailureFile(row, errorMsg) {
        if (!this._failureDir) {
            const baseDir = this._config.failureDir
                || (process.env.NODE_RED_USER_DIR
                    ? path.join(process.env.NODE_RED_USER_DIR, "data", "workflow")
                    : path.join(os.tmpdir(), "aiban-workflow", "data", "workflow"));
            this._failureDir = baseDir;
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

    stats() {
        return {
            ...this._stats,
            pending: this._queue.length,
            queueSize: this._config.queueSize,
        };
    }

    async close() {
        this._closed = true;
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
