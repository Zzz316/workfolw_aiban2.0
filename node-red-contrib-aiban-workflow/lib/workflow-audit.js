"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/**
 * Non-blocking async audit logger for workflow events.
 * Modeled on Python's TransmissionAuditLogger:
 * - Human-readable text log
 * - Machine-readable JSONL
 * - Summary CSV (written on close)
 *
 * Events: frame_received, label_match_started, label_match_finished,
 *         sequence_transition, sequence_completed, sequence_failed,
 *         sequence_timeout, db_write_queued, db_write_started,
 *         db_write_succeeded, db_write_failed
 */

function beijingNowISO(tsMs) {
    const d = tsMs ? new Date(tsMs) : new Date();
    const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
    const Y = beijing.getUTCFullYear();
    const M = String(beijing.getUTCMonth() + 1).padStart(2, "0");
    const D = String(beijing.getUTCDate()).padStart(2, "0");
    const h = String(beijing.getUTCHours()).padStart(2, "0");
    const m = String(beijing.getUTCMinutes()).padStart(2, "0");
    const s = String(beijing.getUTCSeconds()).padStart(2, "0");
    const ms = String(beijing.getUTCMilliseconds()).padStart(3, "0");
    return `${Y}-${M}-${D}T${h}:${m}:${s}.${ms}+08:00`;
}

function beijingTimeCompact(tsMs) {
    const d = tsMs ? new Date(tsMs) : new Date();
    const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
    const h = String(beijing.getUTCHours()).padStart(2, "0");
    const m = String(beijing.getUTCMinutes()).padStart(2, "0");
    const s = String(beijing.getUTCSeconds()).padStart(2, "0");
    const ms = String(beijing.getUTCMilliseconds()).padStart(3, "0");
    return `${h}:${m}:${s}.${ms}`;
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

class WorkflowAuditLogger {
    /**
     * @param {string} directory - e.g. "logs/workflow"
     * @param {string} [runId] - auto-generated if not provided
     */
    constructor(directory, runId) {
        ensureDir(directory);
        this._dir = directory;
        this._runId = runId || this._generateRunId();
        this._queue = [];
        this._draining = false;
        this._closed = false;
        this._drainTimer = null;
        this._cycles = new Map(); // cycle_id → summary data

        // File handles (opened lazily)
        this._textPath = path.join(directory, `workflow-${this._runId}.log`);
        this._jsonlPath = path.join(directory, `workflow-${this._runId}.jsonl`);
        this._csvPath = path.join(directory, `workflow-${this._runId}-summary.csv`);

        this._textFd = null;
        this._jsonlFd = null;

        this._openFiles();

        // Start periodic drain
        this._drainTimer = setInterval(() => this._processQueue(), 500);
        // Also drain more aggressively — use setImmediate when queue builds up
        this._drainTimer.unref();
    }

    _generateRunId() {
        const now = new Date();
        // YYYYMMDD-HHmmss format like Python
        const Y = String(now.getFullYear());
        const M = String(now.getMonth() + 1).padStart(2, "0");
        const D = String(now.getDate()).padStart(2, "0");
        const h = String(now.getHours()).padStart(2, "0");
        const m = String(now.getMinutes()).padStart(2, "0");
        const s = String(now.getSeconds()).padStart(2, "0");
        return `${Y}${M}${D}-${h}${m}${s}-${process.pid}`;
    }

    _openFiles() {
        // Open text log with header
        this._textFd = fs.openSync(this._textPath, "w");
        const header = `# AiBan Workflow Audit Log
# Run ID: ${this._runId}
# Started: ${beijingNowISO()}
# ============================================================
`;
        fs.writeSync(this._textFd, header);

        // Open JSONL (no header)
        this._jsonlFd = fs.openSync(this._jsonlPath, "w");
    }

    /**
     * Non-blocking: enqueues an event and schedules drain.
     * @param {string} event - event type (e.g. "sequence_transition")
     * @param {object} fields - flat key-value object with audit data
     */
    record(event, fields) {
        if (this._closed) return;
        const entry = {
            audit_at: beijingNowISO(),
            event,
            ...fields,
        };
        this._queue.push(entry);
        if (this._queue.length > 100) {
            // Drain immediately when queue is large
            setImmediate(() => this._processQueue());
        }
    }

    /**
     * Track per-cycle summary data (called by sequence node).
     * On close, this data is written as CSV.
     */
    recordCycleSummary(cycleData) {
        this._cycles.set(cycleData.cycle_id, cycleData);
    }

    _processQueue() {
        if (this._draining || this._queue.length === 0) return;
        this._draining = true;
        try {
            let textBuf = "";
            let jsonlBuf = "";
            while (this._queue.length > 0) {
                const entry = this._queue.shift();
                textBuf += this._formatText(entry);
                jsonlBuf += JSON.stringify(entry) + "\n";
            }
            if (textBuf) fs.writeSync(this._textFd, textBuf);
            if (jsonlBuf) fs.writeSync(this._jsonlFd, jsonlBuf);
        } finally {
            this._draining = false;
        }
    }

    _formatText(entry) {
        const e = entry;
        switch (e.event) {
        case "frame_received":
            if (e.stage_duration_ms !== undefined && e.elapsed_from_frame_ms !== undefined) {
                return `[AUDIT] #${String(e.frame_seq).padEnd(5)} g${e.group_id}/s${e.source_id} │ `
                    + `帧接收 ${e.elapsed_from_frame_ms.toFixed(2)}ms │ `
                    + `${e.label_summary || "-"} │ ${beijingTimeCompact()}\n`;
            }
            return `[AUDIT] frame_received │ ${e.message_id} │ `
                + `g${e.group_id}/s${e.source_id} seq=${e.frame_seq}\n`;
        case "label_match_finished":
            return `[MATCH] #${String(e.frame_seq).padEnd(5)} g${e.group_id}/s${e.source_id} │ `
                + `标签匹配 ${e.match_duration_ms.toFixed(2)}ms │ `
                + `匹配: [${(e.matched_steps || []).join(", ") || "无"}] │ `
                + `${beijingTimeCompact()}\n`;
        case "sequence_transition":
            return `[ABC] #${String(e.frame_seq).padEnd(5)} g${e.group_id}/s${e.source_id} `
                + `cycle=${(e.cycle_id || "").slice(0, 8)} │ `
                + `${e.previous_state} → ${e.current_state} │ `
                + `步骤: ${e.recognized_step || "-"} │ `
                + `stage ${e.stage_duration_ms?.toFixed(2) || "-"}ms │ `
                + `${beijingTimeCompact()}\n`;
        case "sequence_completed":
            return `[ABC] ✅ OK │ cycle=${(e.cycle_id || "").slice(0, 8)} │ `
                + `A→B→C │ 业务耗时 ${e.cycle_duration_ms?.toFixed(1) || "-"}ms │ `
                + `处理耗时 ${e.total_processing_ms?.toFixed(2) || "-"}ms │ `
                + `${beijingTimeCompact()}\n`;
        case "sequence_failed":
            return `[ABC] ❌ NG │ cycle=${(e.cycle_id || "").slice(0, 8)} │ `
                + `原因: ${e.failure_reason || "-"} │ `
                + `实际步骤: ${e.actual_sequence || "-"} │ `
                + `${beijingTimeCompact()}\n`;
        case "sequence_timeout":
            return `[ABC] ⏱ TIMEOUT │ cycle=${(e.cycle_id || "").slice(0, 8)} │ `
                + `超时 ${e.cycle_duration_ms?.toFixed(1) || "-"}ms │ `
                + `${beijingTimeCompact()}\n`;
        case "db_write_queued":
            return `[DB] 排队 │ event_id=${(e.event_id || "").slice(0, 12)}... │ `
                + `queue_depth=${e.queue_depth} │ ${beijingTimeCompact()}\n`;
        case "db_write_succeeded":
            return `[DB] ✅ 写入成功 │ event_id=${(e.event_id || "").slice(0, 12)}... │ `
                + `MySQL ${e.db_write_duration_ms?.toFixed(2) || "-"}ms │ `
                + `attempts=${e.attempts} │ ${beijingTimeCompact()}\n`;
        case "db_write_failed":
            return `[DB] ❌ 写入失败 │ event_id=${(e.event_id || "").slice(0, 12)}... │ `
                + `attempts=${e.attempts} │ `
                + `error=${e.error_message || "-"} │ ${beijingTimeCompact()}\n`;
        default:
            return `[AUDIT] ${e.event} │ ${JSON.stringify(e)} │ ${beijingTimeCompact()}\n`;
        }
    }

    /**
     * Drain all pending events, write CSV summary, close files.
     * @returns {Promise<void>}
     */
    async close() {
        if (this._closed) return;
        this._closed = true;
        if (this._drainTimer) {
            clearInterval(this._drainTimer);
            this._drainTimer = null;
        }
        // Final drain
        this._processQueue();
        // Wait for any in-flight drain
        while (this._queue.length > 0) {
            this._processQueue();
            await new Promise((r) => setTimeout(r, 10));
        }
        // Write CSV summary
        this._writeCsv();
        // Close file handles
        if (this._textFd) { fs.closeSync(this._textFd); this._textFd = null; }
        if (this._jsonlFd) { fs.closeSync(this._jsonlFd); this._jsonlFd = null; }
    }

    _writeCsv() {
        if (this._cycles.size === 0) return;
        const headers = [
            "cycle_id", "workflow_id", "stream_id",
            "start_frame_seq", "end_frame_seq",
            "step_a_frame", "step_a_at",
            "step_b_frame", "step_b_at",
            "step_c_frame", "step_c_at",
            "match_duration_ms", "sequence_duration_ms",
            "db_queue_ms", "db_write_ms",
            "total_processing_ms", "cycle_duration_ms",
            "result_status", "failure_reason",
        ];
        const lines = [headers.join(",")];
        for (const [, row] of this._cycles) {
            lines.push(headers.map((h) => {
                const v = row[h];
                if (v === null || v === undefined) return "";
                if (typeof v === "string" && v.includes(",")) return `"${v}"`;
                return String(v);
            }).join(","));
        }
        fs.writeFileSync(this._csvPath, lines.join("\n") + "\n", "utf8");
    }

    /** Get the paths of all output files */
    get filePaths() {
        return {
            text: this._textPath,
            jsonl: this._jsonlPath,
            csv: this._csvPath,
        };
    }

    /** Get the run ID */
    get runId() {
        return this._runId;
    }
}

module.exports = { WorkflowAuditLogger, beijingNowISO, beijingTimeCompact };
