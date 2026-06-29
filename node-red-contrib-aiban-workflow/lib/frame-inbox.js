"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

class FrameInbox {
    constructor(filename) {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.db = new DatabaseSync(filename);
        this.db.exec("PRAGMA journal_mode=WAL");
        this.db.exec("PRAGMA synchronous=FULL");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS frame_inbox (
                message_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                stream_id TEXT NOT NULL,
                frame_seq INTEGER NOT NULL,
                payload TEXT NOT NULL,
                received_at TEXT NOT NULL,
                emitted_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_inbox_unemitted
            ON frame_inbox(emitted_at, stream_id, frame_seq);
        `);
        this.insertStatement = this.db.prepare(`
            INSERT OR IGNORE INTO frame_inbox
            (message_id, session_id, stream_id, frame_seq, payload, received_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        this.markStatement = this.db.prepare(
            "UPDATE frame_inbox SET emitted_at = ? WHERE message_id = ? AND emitted_at IS NULL"
        );
    }

    persist(frame) {
        const result = this.insertStatement.run(
            frame.message_id,
            frame.session_id,
            frame.stream_id,
            Number(frame.frame_seq),
            JSON.stringify(frame),
            new Date().toISOString()
        );
        return Number(result.changes) === 1;
    }

    pending(limit = 1000) {
        return this.db.prepare(`
            SELECT message_id, payload FROM frame_inbox
            WHERE emitted_at IS NULL
            ORDER BY stream_id, frame_seq LIMIT ?
        `).all(Number(limit)).map((row) => ({
            message_id: row.message_id,
            frame: JSON.parse(row.payload),
        }));
    }

    markEmitted(messageId) {
        return Number(this.markStatement.run(new Date().toISOString(), messageId).changes) === 1;
    }

    counts() {
        const row = this.db.prepare(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN emitted_at IS NULL THEN 1 ELSE 0 END) AS pending
            FROM frame_inbox
        `).get();
        return { total: Number(row.total || 0), pending: Number(row.pending || 0) };
    }

    close() {
        this.db.close();
    }
}

module.exports = { FrameInbox };
