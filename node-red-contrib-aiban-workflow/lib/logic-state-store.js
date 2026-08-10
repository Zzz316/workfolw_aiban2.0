"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { beijingNowISO } = require("./workflow-audit");

class LogicStateStore {
    constructor(filename = ":memory:") {
        if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.db = new DatabaseSync(filename);
        this.db.exec(`
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS logic_state (
                logic_type TEXT NOT NULL,
                state_key TEXT NOT NULL,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(logic_type, state_key)
            );
        `);
        this._get = this.db.prepare(
            "SELECT state_json FROM logic_state WHERE logic_type=? AND state_key=?"
        );
        this._upsert = this.db.prepare(`
            INSERT INTO logic_state(logic_type,state_key,state_json,updated_at)
            VALUES (?,?,?,?)
            ON CONFLICT(logic_type,state_key) DO UPDATE SET
                state_json=excluded.state_json, updated_at=excluded.updated_at
        `);
        this._delete = this.db.prepare(
            "DELETE FROM logic_state WHERE logic_type=? AND state_key=?"
        );
        this._list = this.db.prepare(
            "SELECT state_key,state_json FROM logic_state WHERE logic_type=?"
        );
    }

    get(logicType, stateKey) {
        const row = this._get.get(logicType, stateKey);
        return row ? JSON.parse(row.state_json) : null;
    }

    save(logicType, stateKey, state) {
        this._upsert.run(logicType, stateKey, JSON.stringify(state), beijingNowISO());
    }

    delete(logicType, stateKey) {
        this._delete.run(logicType, stateKey);
    }

    list(logicType) {
        return this._list.all(logicType).map(row => ({
            state_key: row.state_key,
            state: JSON.parse(row.state_json),
        }));
    }

    close() {
        this.db.close();
    }
}

class MemoryLogicStateStore {
    constructor() { this.rows = new Map(); }
    _key(type, key) { return `${type}\u0000${key}`; }
    get(type, key) {
        const value = this.rows.get(this._key(type, key));
        return value ? structuredClone(value) : null;
    }
    save(type, key, state) { this.rows.set(this._key(type, key), structuredClone(state)); }
    delete(type, key) { this.rows.delete(this._key(type, key)); }
    list(type) {
        const prefix = `${type}\u0000`;
        return [...this.rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, state]) => ({
            state_key: key.slice(prefix.length), state: structuredClone(state),
        }));
    }
    close() {}
}

module.exports = { LogicStateStore, MemoryLogicStateStore };
