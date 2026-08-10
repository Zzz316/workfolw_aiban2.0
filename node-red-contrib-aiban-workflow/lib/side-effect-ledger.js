"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { beijingNowISO } = require("./workflow-audit");

class SideEffectLedger {
    constructor(filename = ":memory:") {
        if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.db = new DatabaseSync(filename);
        this.db.exec(`
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS side_effect_delivery (
                channel TEXT NOT NULL,
                result_event_id TEXT NOT NULL,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(channel, result_event_id)
            );
            UPDATE side_effect_delivery
               SET status='FAILED', last_error='process_restarted', updated_at='${beijingNowISO()}'
             WHERE status='PENDING';
        `);
        this._get = this.db.prepare(
            "SELECT * FROM side_effect_delivery WHERE channel=? AND result_event_id=?"
        );
        this._insert = this.db.prepare(`
            INSERT OR IGNORE INTO side_effect_delivery
                (channel,result_event_id,status,attempts,last_error,updated_at)
            VALUES (?,?, 'PENDING', 1, NULL, ?)
        `);
        this._retry = this.db.prepare(`
            UPDATE side_effect_delivery
               SET status='PENDING', attempts=attempts+1, last_error=NULL, updated_at=?
             WHERE channel=? AND result_event_id=? AND status='FAILED'
        `);
        this._finish = this.db.prepare(`
            UPDATE side_effect_delivery
               SET status=?, last_error=?, updated_at=?
             WHERE channel=? AND result_event_id=?
        `);
    }

    begin(channel, resultEventId) {
        const now = beijingNowISO();
        const inserted = this._insert.run(channel, resultEventId, now);
        if (Number(inserted.changes) === 1) return { accepted: true, attempts: 1 };
        let row = this._get.get(channel, resultEventId);
        if (row && row.status === "FAILED") {
            this._retry.run(now, channel, resultEventId);
            row = this._get.get(channel, resultEventId);
            return { accepted: true, attempts: Number(row.attempts) };
        }
        return {
            accepted: false,
            duplicate: row && row.status === "DELIVERED",
            in_flight: row && row.status === "PENDING",
            status: row ? row.status : "UNKNOWN",
            attempts: row ? Number(row.attempts) : 0,
        };
    }

    delivered(channel, resultEventId) {
        this._finish.run("DELIVERED", null, beijingNowISO(), channel, resultEventId);
    }

    failed(channel, resultEventId, error) {
        this._finish.run("FAILED", String(error || "delivery failed"), beijingNowISO(), channel, resultEventId);
    }

    get(channel, resultEventId) {
        const row = this._get.get(channel, resultEventId);
        return row ? { ...row, attempts: Number(row.attempts) } : null;
    }

    close() {
        this.db.close();
    }
}

module.exports = { SideEffectLedger };
