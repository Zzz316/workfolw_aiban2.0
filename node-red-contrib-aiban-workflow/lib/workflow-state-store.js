"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { beijingNowISO } = require("./workflow-audit");

/**
 * SQLite-backed state persistence for the topology-driven sequence state machine.
 *
 * V2 schema — supports arbitrary-length topology chains:
 *   - steps_data TEXT (JSON): {"A":{"frame_seq":100,"at_ms":1000}, "B":{...}, ...}
 *   - step_index INTEGER: current position (0=IDLE, 1..N=after N labels matched)
 *   - total_steps INTEGER: total number of label steps in the topology
 *
 * State isolation key: workflow_id:session_id:group_id:source_id
 */

const TABLE_NAME = "flow_state";
const SCHEMA_VERSION = 2;

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

        this._migrate();
        this._prepareStatements();
    }

    _migrate() {
        // Check if old abc_state table exists and migrate/drop it
        const oldTable = this.db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='abc_state'"
        ).get();

        if (oldTable) {
            // Old V1 schema — drop and recreate as V2
            // (No production data in Phase 2, safe to drop)
            this.db.exec("DROP TABLE IF EXISTS abc_state");
        }

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
                state_key TEXT PRIMARY KEY,
                workflow_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                source_id INTEGER NOT NULL,
                step_index INTEGER NOT NULL DEFAULT 0,
                total_steps INTEGER NOT NULL DEFAULT 3,
                cycle_id TEXT,
                cycle_started_at_ms REAL,
                start_frame_seq INTEGER,
                last_frame_seq INTEGER,
                last_message_id TEXT,
                steps_data TEXT,
                actual_sequence TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_flow_active
                ON ${TABLE_NAME}(step_index, updated_at)
                WHERE step_index > 0;
        `);
    }

    _prepareStatements() {
        this._getStmt = this.db.prepare(
            `SELECT * FROM ${TABLE_NAME} WHERE state_key = ?`
        );
        this._upsertStmt = this.db.prepare(`
            INSERT INTO ${TABLE_NAME} (
                state_key, workflow_id, session_id, group_id, source_id,
                step_index, total_steps,
                cycle_id, cycle_started_at_ms,
                start_frame_seq, last_frame_seq, last_message_id,
                steps_data, actual_sequence,
                created_at, updated_at
            ) VALUES (
                :state_key, :workflow_id, :session_id, :group_id, :source_id,
                :step_index, :total_steps,
                :cycle_id, :cycle_started_at_ms,
                :start_frame_seq, :last_frame_seq, :last_message_id,
                :steps_data, :actual_sequence,
                :created_at, :updated_at
            ) ON CONFLICT(state_key) DO UPDATE SET
                workflow_id = excluded.workflow_id,
                session_id = excluded.session_id,
                group_id = excluded.group_id,
                source_id = excluded.source_id,
                step_index = excluded.step_index,
                total_steps = excluded.total_steps,
                cycle_id = excluded.cycle_id,
                cycle_started_at_ms = excluded.cycle_started_at_ms,
                start_frame_seq = excluded.start_frame_seq,
                last_frame_seq = excluded.last_frame_seq,
                last_message_id = excluded.last_message_id,
                steps_data = excluded.steps_data,
                actual_sequence = excluded.actual_sequence,
                updated_at = excluded.updated_at
        `);
        this._resetStmt = this.db.prepare(`
            UPDATE ${TABLE_NAME} SET
                step_index = 0,
                cycle_id = NULL,
                cycle_started_at_ms = NULL,
                start_frame_seq = NULL,
                last_frame_seq = NULL,
                last_message_id = NULL,
                steps_data = NULL,
                actual_sequence = NULL,
                updated_at = :updated_at
            WHERE state_key = :state_key
        `);
        this._listActiveStmt = this.db.prepare(
            `SELECT * FROM ${TABLE_NAME} WHERE step_index > 0 AND step_index < total_steps`
        );
        this._deleteStmt = this.db.prepare(
            `DELETE FROM ${TABLE_NAME} WHERE state_key = ?`
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
            step_index: fields.step_index !== undefined ? Number(fields.step_index) : 0,
            total_steps: fields.total_steps !== undefined ? Number(fields.total_steps) : 3,
            cycle_id: fields.cycle_id || null,
            cycle_started_at_ms: fields.cycle_started_at_ms ?? null,
            start_frame_seq: fields.start_frame_seq ?? null,
            last_frame_seq: fields.last_frame_seq ?? null,
            last_message_id: fields.last_message_id || null,
            steps_data: fields.steps_data || null,
            actual_sequence: fields.actual_sequence || null,
            created_at: fields.created_at || now,
            updated_at: now,
        };
        this._upsertStmt.run(params);
    }

    /**
     * Reset state to IDLE (step_index=0), clearing cycle data.
     * Returns the previous state (for INTERRUPTED result generation).
     */
    resetState(stateKey) {
        const previous = this.getState(stateKey);
        const now = beijingNowISO();
        this._resetStmt.run({ state_key: stateKey, updated_at: now });
        return previous;
    }

    /**
     * List all active (non-IDLE) states.
     * Note: step_index == total_steps may still be active when an end label
     * exists (WAIT_END). Callers should use FlowRuntime._isActive() to filter.
     * Used for Deploy/restart recovery.
     */
    listActive() {
        const rows = this.db.prepare(
            `SELECT * FROM ${TABLE_NAME} WHERE step_index > 0`
        ).all();
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
                SUM(CASE WHEN step_index = 0 THEN 1 ELSE 0 END) AS idle,
                SUM(CASE WHEN step_index > 0 AND step_index < total_steps THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN step_index >= total_steps THEN 1 ELSE 0 END) AS completed
            FROM ${TABLE_NAME}
        `).get();
        return {
            total: Number(row.total || 0),
            idle: Number(row.idle || 0),
            active: Number(row.active || 0),
            completed: Number(row.completed || 0),
        };
    }

    _rowToObject(row) {
        return {
            state_key: row.state_key,
            workflow_id: row.workflow_id,
            session_id: row.session_id,
            group_id: Number(row.group_id),
            source_id: Number(row.source_id),
            step_index: Number(row.step_index),
            total_steps: Number(row.total_steps),
            cycle_id: row.cycle_id,
            cycle_started_at_ms: row.cycle_started_at_ms ? Number(row.cycle_started_at_ms) : null,
            start_frame_seq: row.start_frame_seq ?? null,
            last_frame_seq: row.last_frame_seq ?? null,
            last_message_id: row.last_message_id,
            steps_data: row.steps_data,
            actual_sequence: row.actual_sequence,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    close() {
        this.db.close();
    }
}

module.exports = { WorkflowStateStore };
