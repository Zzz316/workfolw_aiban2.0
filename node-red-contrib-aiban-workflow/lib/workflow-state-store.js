"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { beijingNowISO } = require("./workflow-audit");

/**
 * SQLite-backed state persistence for the A-B-C sequence state machine.
 * Modeled on the existing FrameInbox pattern:
 * - WAL mode, synchronous=FULL
 * - Single table with state_key as PRIMARY KEY
 * - Thread-safe via synchronous API (node:sqlite)
 */

const VALID_STATES = ["IDLE", "WAIT_B", "WAIT_C"];

class WorkflowStateStore {
    /**
     * @param {string} filename - path to SQLite file
     */
    constructor(filename) {
        const dir = path.dirname(filename);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new DatabaseSync(filename);
        this.db.exec("PRAGMA journal_mode=WAL");
        this.db.exec("PRAGMA synchronous=FULL");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS abc_state (
                state_key TEXT PRIMARY KEY,
                workflow_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                source_id INTEGER NOT NULL,
                current_state TEXT NOT NULL DEFAULT 'IDLE',
                cycle_id TEXT,
                cycle_started_at_ms REAL,
                start_frame_seq INTEGER,
                last_frame_seq INTEGER,
                last_message_id TEXT,
                step_a_frame_seq INTEGER,
                step_b_frame_seq INTEGER,
                step_c_frame_seq INTEGER,
                step_a_at_ms REAL,
                step_b_at_ms REAL,
                step_c_at_ms REAL,
                actual_sequence TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_abc_active
                ON abc_state(current_state, updated_at);
        `);

        // Prepared statements
        this._getStmt = this.db.prepare(
            "SELECT * FROM abc_state WHERE state_key = ?"
        );
        this._upsertStmt = this.db.prepare(`
            INSERT INTO abc_state (
                state_key, workflow_id, session_id, group_id, source_id,
                current_state, cycle_id, cycle_started_at_ms,
                start_frame_seq, last_frame_seq, last_message_id,
                step_a_frame_seq, step_b_frame_seq, step_c_frame_seq,
                step_a_at_ms, step_b_at_ms, step_c_at_ms,
                actual_sequence, created_at, updated_at
            ) VALUES (
                :state_key, :workflow_id, :session_id, :group_id, :source_id,
                :current_state, :cycle_id, :cycle_started_at_ms,
                :start_frame_seq, :last_frame_seq, :last_message_id,
                :step_a_frame_seq, :step_b_frame_seq, :step_c_frame_seq,
                :step_a_at_ms, :step_b_at_ms, :step_c_at_ms,
                :actual_sequence, :created_at, :updated_at
            ) ON CONFLICT(state_key) DO UPDATE SET
                current_state = excluded.current_state,
                cycle_id = excluded.cycle_id,
                cycle_started_at_ms = excluded.cycle_started_at_ms,
                start_frame_seq = excluded.start_frame_seq,
                last_frame_seq = excluded.last_frame_seq,
                last_message_id = excluded.last_message_id,
                step_a_frame_seq = excluded.step_a_frame_seq,
                step_b_frame_seq = excluded.step_b_frame_seq,
                step_c_frame_seq = excluded.step_c_frame_seq,
                step_a_at_ms = excluded.step_a_at_ms,
                step_b_at_ms = excluded.step_b_at_ms,
                step_c_at_ms = excluded.step_c_at_ms,
                actual_sequence = excluded.actual_sequence,
                updated_at = excluded.updated_at
        `);
        this._resetStmt = this.db.prepare(`
            UPDATE abc_state SET
                current_state = 'IDLE',
                cycle_id = NULL,
                cycle_started_at_ms = NULL,
                start_frame_seq = NULL,
                last_frame_seq = NULL,
                last_message_id = NULL,
                step_a_frame_seq = NULL,
                step_b_frame_seq = NULL,
                step_c_frame_seq = NULL,
                step_a_at_ms = NULL,
                step_b_at_ms = NULL,
                step_c_at_ms = NULL,
                actual_sequence = NULL,
                updated_at = :updated_at
            WHERE state_key = :state_key
        `);
        this._listActiveStmt = this.db.prepare(
            "SELECT * FROM abc_state WHERE current_state != 'IDLE'"
        );
        this._deleteStmt = this.db.prepare(
            "DELETE FROM abc_state WHERE state_key = ?"
        );
    }

    /**
     * Build a composite state key from isolation dimensions.
     */
    static makeKey(workflowId, sessionId, groupId, sourceId) {
        return `${workflowId}:${sessionId}:${groupId}:${sourceId}`;
    }

    /**
     * Get current state for a key. Returns null if not found.
     */
    getState(stateKey) {
        const row = this._getStmt.get(stateKey);
        if (!row) return null;
        return this._rowToObject(row);
    }

    /**
     * Save (insert or update) state.
     * @param {string} stateKey
     * @param {object} fields - flat object matching column names
     */
    saveState(stateKey, fields) {
        const now = beijingNowISO();
        const params = {
            state_key: stateKey,
            workflow_id: fields.workflow_id || "",
            session_id: fields.session_id || "",
            group_id: Number(fields.group_id || 0),
            source_id: Number(fields.source_id || 0),
            current_state: fields.current_state || "IDLE",
            cycle_id: fields.cycle_id || null,
            cycle_started_at_ms: fields.cycle_started_at_ms ?? null,
            start_frame_seq: fields.start_frame_seq ?? null,
            last_frame_seq: fields.last_frame_seq ?? null,
            last_message_id: fields.last_message_id || null,
            step_a_frame_seq: fields.step_a_frame_seq ?? null,
            step_b_frame_seq: fields.step_b_frame_seq ?? null,
            step_c_frame_seq: fields.step_c_frame_seq ?? null,
            step_a_at_ms: fields.step_a_at_ms ?? null,
            step_b_at_ms: fields.step_b_at_ms ?? null,
            step_c_at_ms: fields.step_c_at_ms ?? null,
            actual_sequence: fields.actual_sequence || null,
            created_at: fields.created_at || now,
            updated_at: now,
        };
        this._upsertStmt.run(params);
    }

    /**
     * Reset state to IDLE, clearing cycle data.
     * Returns the previous state (for INTERRUPTED result generation).
     */
    resetState(stateKey) {
        const previous = this.getState(stateKey);
        const now = beijingNowISO();
        this._resetStmt.run({ state_key: stateKey, updated_at: now });
        return previous;
    }

    /**
     * List all active (non-IDLE) states. Used for Deploy/restart recovery.
     */
    listActive() {
        const rows = this._listActiveStmt.all();
        return rows.map((r) => this._rowToObject(r));
    }

    /**
     * Delete a state entry entirely.
     */
    deleteState(stateKey) {
        this._deleteStmt.run(stateKey);
    }

    /**
     * Count states by status.
     */
    counts() {
        const row = this.db.prepare(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN current_state = 'IDLE' THEN 1 ELSE 0 END) AS idle,
                SUM(CASE WHEN current_state != 'IDLE' THEN 1 ELSE 0 END) AS active
            FROM abc_state
        `).get();
        return {
            total: Number(row.total || 0),
            idle: Number(row.idle || 0),
            active: Number(row.active || 0),
        };
    }

    _rowToObject(row) {
        return {
            state_key: row.state_key,
            workflow_id: row.workflow_id,
            session_id: row.session_id,
            group_id: Number(row.group_id),
            source_id: Number(row.source_id),
            current_state: row.current_state,
            cycle_id: row.cycle_id,
            cycle_started_at_ms: row.cycle_started_at_ms ? Number(row.cycle_started_at_ms) : null,
            start_frame_seq: row.start_frame_seq ?? null,
            last_frame_seq: row.last_frame_seq ?? null,
            last_message_id: row.last_message_id,
            step_a_frame_seq: row.step_a_frame_seq ?? null,
            step_b_frame_seq: row.step_b_frame_seq ?? null,
            step_c_frame_seq: row.step_c_frame_seq ?? null,
            step_a_at_ms: row.step_a_at_ms ? Number(row.step_a_at_ms) : null,
            step_b_at_ms: row.step_b_at_ms ? Number(row.step_b_at_ms) : null,
            step_c_at_ms: row.step_c_at_ms ? Number(row.step_c_at_ms) : null,
            actual_sequence: row.actual_sequence,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    close() {
        this.db.close();
    }
}

module.exports = { WorkflowStateStore, VALID_STATES };
