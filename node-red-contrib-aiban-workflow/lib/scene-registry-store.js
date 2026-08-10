"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const VALID_MODES = Object.freeze(["exclusive", "parallel"]);
const SCENE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class SceneRegistryError extends Error {
    constructor(code, message, statusCode = 400, details = null) {
        super(message);
        this.name = "SceneRegistryError";
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
}

function clone(value) {
    return value === null || value === undefined
        ? value
        : JSON.parse(JSON.stringify(value));
}

function normalizeGroupId(value) {
    const groupId = Number(value);
    if (!Number.isInteger(groupId) || groupId < 0) {
        throw new SceneRegistryError(
            "INVALID_GROUP",
            `group_id must be a non-negative integer: ${value}`
        );
    }
    return groupId;
}

function normalizeSceneId(value) {
    const sceneId = typeof value === "string" ? value.trim() : "";
    if (!SCENE_ID_PATTERN.test(sceneId)) {
        throw new SceneRegistryError(
            "INVALID_SCENE",
            "scene_id must be 1-64 characters using letters, numbers, '.', '_' or '-'"
        );
    }
    return sceneId;
}

function requireRevision(value, fieldName = "revision", allowZero = false) {
    const revision = Number(value);
    const minimum = allowZero ? 0 : 1;
    if (!Number.isInteger(revision) || revision < minimum) {
        throw new SceneRegistryError(
            "INVALID_SCENE",
            `${fieldName} must be an integer greater than or equal to ${minimum}`
        );
    }
    return revision;
}

function requireActor(context = {}) {
    const operator = typeof context.operator === "string"
        ? context.operator.trim()
        : "";
    const requestId = typeof context.requestId === "string"
        ? context.requestId.trim()
        : "";
    if (!operator) {
        throw new SceneRegistryError("FORBIDDEN", "operator is required", 403);
    }
    if (!requestId) {
        throw new SceneRegistryError("INVALID_SCENE", "request_id is required");
    }
    return { operator, requestId };
}

function normalizeKnownGroups(values) {
    if (values === undefined || values === null) {
        return null;
    }
    const result = new Set();
    for (const value of values) {
        result.add(normalizeGroupId(
            value && typeof value === "object" ? value.group_id : value
        ));
    }
    return result;
}

function normalizeRequiredText(value, fieldName, maxLength = 128) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > maxLength) {
        throw new SceneRegistryError(
            "INVALID_SCENE",
            `${fieldName} must be between 1 and ${maxLength} characters`
        );
    }
    return text;
}

function normalizeOptionalText(value, fieldName, maxLength = 256) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    if (typeof value !== "string" || value.trim().length > maxLength) {
        throw new SceneRegistryError(
            "INVALID_SCENE",
            `${fieldName} must be a string no longer than ${maxLength} characters`
        );
    }
    return value.trim();
}

function sqliteChanged(result) {
    return Number(result && result.changes ? result.changes : 0);
}

class SceneRegistryStore {
    constructor(options = {}) {
        if (!options.dbPath && !options.database) {
            throw new TypeError("dbPath or database is required");
        }
        this.dbPath = options.dbPath || ":memory:";
        this._now = typeof options.now === "function"
            ? options.now
            : () => new Date().toISOString();
        this._knownGroupIds = normalizeKnownGroups(options.knownGroupIds);
        this._ownsDatabase = !options.database;

        if (this._ownsDatabase) {
            if (this.dbPath !== ":memory:") {
                fs.mkdirSync(path.dirname(path.resolve(this.dbPath)), { recursive: true });
            }
            this._db = new DatabaseSync(this.dbPath);
        } else {
            this._db = options.database;
        }

        this._initialize();
    }

    _initialize() {
        this._db.exec("PRAGMA foreign_keys = ON");
        if (this.dbPath !== ":memory:") {
            this._db.exec("PRAGMA journal_mode = WAL");
        }
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS scene_registry (
                group_id INTEGER NOT NULL,
                scene_id TEXT NOT NULL,
                name TEXT NOT NULL,
                mode TEXT NOT NULL CHECK (mode IN ('exclusive', 'parallel')),
                workflow_id TEXT NOT NULL,
                node_red_tab_id TEXT,
                enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
                revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                created_by TEXT NOT NULL,
                updated_by TEXT NOT NULL,
                PRIMARY KEY (group_id, scene_id)
            );

            CREATE TABLE IF NOT EXISTS scene_selection (
                group_id INTEGER PRIMARY KEY,
                scene_id TEXT,
                revision INTEGER NOT NULL CHECK (revision >= 1),
                updated_at TEXT NOT NULL,
                updated_by TEXT NOT NULL,
                request_id TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS scene_registry_audit (
                audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                scene_id TEXT,
                action TEXT NOT NULL,
                revision INTEGER NOT NULL,
                operator TEXT NOT NULL,
                request_id TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_scene_audit_group_created
            ON scene_registry_audit(group_id, audit_id DESC);

            CREATE INDEX IF NOT EXISTS idx_scene_audit_scene_created
            ON scene_registry_audit(group_id, scene_id, audit_id DESC);
        `);
    }

    close() {
        if (this._ownsDatabase && this._db) {
            this._db.close();
        }
        this._db = null;
    }

    setKnownGroups(values) {
        this._knownGroupIds = normalizeKnownGroups(values);
    }

    _knownGroupsFor(context = {}) {
        if (Object.prototype.hasOwnProperty.call(context, "knownGroupIds")) {
            return normalizeKnownGroups(context.knownGroupIds);
        }
        return this._knownGroupIds;
    }

    _requireKnownGroup(value, context = {}) {
        const groupId = normalizeGroupId(value);
        const knownGroups = this._knownGroupsFor(context);
        if (!knownGroups || !knownGroups.has(groupId)) {
            throw new SceneRegistryError(
                "INVALID_GROUP",
                `Unknown group_id: ${groupId}`
            );
        }
        return groupId;
    }

    _transaction(callback) {
        this._db.exec("BEGIN IMMEDIATE");
        try {
            const result = callback();
            this._db.exec("COMMIT");
            return result;
        } catch (error) {
            try {
                this._db.exec("ROLLBACK");
            } catch (_) {
                // Preserve the original error.
            }
            throw error;
        }
    }

    _sceneFromRow(row) {
        if (!row) {
            return null;
        }
        return Object.freeze({
            group_id: Number(row.group_id),
            scene_id: row.scene_id,
            name: row.name,
            mode: row.mode,
            workflow_id: row.workflow_id,
            node_red_tab_id: row.node_red_tab_id || null,
            enabled: Boolean(row.enabled),
            revision: Number(row.revision),
            created_at: row.created_at,
            updated_at: row.updated_at,
            created_by: row.created_by,
            updated_by: row.updated_by,
        });
    }

    _selectionFromRow(groupId, row) {
        if (!row) {
            return Object.freeze({
                group_id: groupId,
                scene_id: null,
                revision: 0,
                updated_at: null,
                updated_by: null,
                request_id: null,
            });
        }
        return Object.freeze({
            group_id: Number(row.group_id),
            scene_id: row.scene_id || null,
            revision: Number(row.revision),
            updated_at: row.updated_at,
            updated_by: row.updated_by,
            request_id: row.request_id,
        });
    }

    _findSceneRow(groupId, sceneId) {
        return this._db.prepare(`
            SELECT group_id, scene_id, name, mode, workflow_id, node_red_tab_id,
                   enabled, revision, created_at, updated_at, created_by, updated_by
            FROM scene_registry
            WHERE group_id = ? AND scene_id = ?
        `).get(groupId, sceneId);
    }

    _requireSceneRow(groupId, sceneId) {
        const row = this._findSceneRow(groupId, sceneId);
        if (!row) {
            throw new SceneRegistryError(
                "NOT_FOUND",
                `Scene not found: ${groupId}/${sceneId}`,
                404
            );
        }
        return row;
    }

    _findSelectionRow(groupId) {
        return this._db.prepare(`
            SELECT group_id, scene_id, revision, updated_at, updated_by, request_id
            FROM scene_selection
            WHERE group_id = ?
        `).get(groupId);
    }

    _recordAudit({
        groupId,
        sceneId = null,
        action,
        revision,
        operator,
        requestId,
        before = null,
        after = null,
        createdAt,
    }) {
        this._db.prepare(`
            INSERT INTO scene_registry_audit (
                group_id, scene_id, action, revision, operator, request_id,
                before_json, after_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            groupId,
            sceneId,
            action,
            revision,
            operator,
            requestId,
            before === null ? null : JSON.stringify(before),
            after === null ? null : JSON.stringify(after),
            createdAt
        );
    }

    _assertRevision(row, expectedRevision, identity) {
        const expected = requireRevision(expectedRevision);
        const actual = Number(row.revision);
        if (actual !== expected) {
            throw new SceneRegistryError(
                "CONFLICT",
                `Revision conflict for ${identity}: expected ${expected}, current ${actual}`,
                409,
                { expected_revision: expected, current_revision: actual }
            );
        }
        return expected;
    }

    getScene(groupIdValue, sceneIdValue, context = {}) {
        const groupId = this._requireKnownGroup(groupIdValue, context);
        const sceneId = normalizeSceneId(sceneIdValue);
        return this._sceneFromRow(this._requireSceneRow(groupId, sceneId));
    }

    listScenes(groupIdValue, context = {}) {
        const groupId = this._requireKnownGroup(groupIdValue, context);
        const rows = this._db.prepare(`
            SELECT group_id, scene_id, name, mode, workflow_id, node_red_tab_id,
                   enabled, revision, created_at, updated_at, created_by, updated_by
            FROM scene_registry
            WHERE group_id = ?
            ORDER BY name COLLATE NOCASE, scene_id
        `).all(groupId);
        return Object.freeze(rows.map((row) => this._sceneFromRow(row)));
    }

    createScene(input, context = {}) {
        const groupId = this._requireKnownGroup(input && input.group_id, context);
        const sceneId = normalizeSceneId(input && input.scene_id);
        const name = normalizeRequiredText(input && input.name, "name");
        const mode = input && input.mode;
        if (!VALID_MODES.includes(mode)) {
            throw new SceneRegistryError(
                "INVALID_SCENE",
                `mode must be one of ${VALID_MODES.join(", ")}`
            );
        }
        const workflowId = input && input.workflow_id
            ? normalizeRequiredText(input.workflow_id, "workflow_id", 256)
            : `group/${groupId}/scene/${sceneId}`;
        const nodeRedTabId = normalizeOptionalText(
            input && input.node_red_tab_id,
            "node_red_tab_id",
            128
        );
        const enabled = Boolean(input && input.enabled);
        const { operator, requestId } = requireActor(context);
        const now = this._now();

        return this._transaction(() => {
            if (this._findSceneRow(groupId, sceneId)) {
                throw new SceneRegistryError(
                    "CONFLICT",
                    `Scene already exists: ${groupId}/${sceneId}`,
                    409
                );
            }

            this._db.prepare(`
                INSERT INTO scene_registry (
                    group_id, scene_id, name, mode, workflow_id, node_red_tab_id,
                    enabled, revision, created_at, updated_at, created_by, updated_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
            `).run(
                groupId,
                sceneId,
                name,
                mode,
                workflowId,
                nodeRedTabId,
                enabled ? 1 : 0,
                now,
                now,
                operator,
                operator
            );

            const scene = this._sceneFromRow(this._findSceneRow(groupId, sceneId));
            this._recordAudit({
                groupId,
                sceneId,
                action: "CREATE",
                revision: scene.revision,
                operator,
                requestId,
                after: scene,
                createdAt: now,
            });
            return scene;
        });
    }

    updateScene(groupIdValue, sceneIdValue, patch = {}, expectedRevision, context = {}) {
        const groupId = this._requireKnownGroup(groupIdValue, context);
        const sceneId = normalizeSceneId(sceneIdValue);
        const { operator, requestId } = requireActor(context);
        const now = this._now();

        return this._transaction(() => {
            const row = this._requireSceneRow(groupId, sceneId);
            this._assertRevision(row, expectedRevision, `${groupId}/${sceneId}`);
            const before = this._sceneFromRow(row);

            const name = Object.prototype.hasOwnProperty.call(patch, "name")
                ? normalizeRequiredText(patch.name, "name")
                : row.name;
            const mode = Object.prototype.hasOwnProperty.call(patch, "mode")
                ? patch.mode
                : row.mode;
            if (!VALID_MODES.includes(mode)) {
                throw new SceneRegistryError(
                    "INVALID_SCENE",
                    `mode must be one of ${VALID_MODES.join(", ")}`
                );
            }
            const workflowId = Object.prototype.hasOwnProperty.call(patch, "workflow_id")
                ? normalizeRequiredText(patch.workflow_id, "workflow_id", 256)
                : row.workflow_id;
            const nodeRedTabId = Object.prototype.hasOwnProperty.call(patch, "node_red_tab_id")
                ? normalizeOptionalText(patch.node_red_tab_id, "node_red_tab_id", 128)
                : row.node_red_tab_id;

            const selection = this._findSelectionRow(groupId);
            if (selection && selection.scene_id === sceneId && mode !== "exclusive") {
                throw new SceneRegistryError(
                    "CONFLICT",
                    "The selected exclusive scene must be deselected before changing it to parallel",
                    409
                );
            }

            const nextRevision = Number(row.revision) + 1;
            const result = this._db.prepare(`
                UPDATE scene_registry
                SET name = ?, mode = ?, workflow_id = ?, node_red_tab_id = ?,
                    revision = ?, updated_at = ?, updated_by = ?
                WHERE group_id = ? AND scene_id = ? AND revision = ?
            `).run(
                name,
                mode,
                workflowId,
                nodeRedTabId,
                nextRevision,
                now,
                operator,
                groupId,
                sceneId,
                Number(row.revision)
            );
            if (sqliteChanged(result) !== 1) {
                throw new SceneRegistryError("CONFLICT", "Scene changed concurrently", 409);
            }

            const scene = this._sceneFromRow(this._findSceneRow(groupId, sceneId));
            this._recordAudit({
                groupId,
                sceneId,
                action: context.auditAction || "UPDATE",
                revision: scene.revision,
                operator,
                requestId,
                before,
                after: scene,
                createdAt: now,
            });
            return scene;
        });
    }

    bindTab(groupId, sceneId, nodeRedTabId, expectedRevision, context = {}) {
        const scene = this.updateScene(
            groupId,
            sceneId,
            { node_red_tab_id: nodeRedTabId },
            expectedRevision,
            { ...context, auditAction: "BIND_TAB" }
        );
        return scene;
    }

    setEnabled(
        groupIdValue,
        sceneIdValue,
        enabledValue,
        expectedRevision,
        context = {}
    ) {
        const groupId = this._requireKnownGroup(groupIdValue, context);
        const sceneId = normalizeSceneId(sceneIdValue);
        const enabled = enabledValue === true;
        const { operator, requestId } = requireActor(context);
        const now = this._now();

        return this._transaction(() => {
            const row = this._requireSceneRow(groupId, sceneId);
            this._assertRevision(row, expectedRevision, `${groupId}/${sceneId}`);
            const before = this._sceneFromRow(row);
            const nextRevision = Number(row.revision) + 1;

            this._db.prepare(`
                UPDATE scene_registry
                SET enabled = ?, revision = ?, updated_at = ?, updated_by = ?
                WHERE group_id = ? AND scene_id = ? AND revision = ?
            `).run(
                enabled ? 1 : 0,
                nextRevision,
                now,
                operator,
                groupId,
                sceneId,
                Number(row.revision)
            );
            const scene = this._sceneFromRow(this._findSceneRow(groupId, sceneId));

            let selection = this._selectionFromRow(
                groupId,
                this._findSelectionRow(groupId)
            );
            if (!enabled && selection.scene_id === sceneId) {
                const beforeSelection = selection;
                const selectionRevision = selection.revision + 1;
                this._db.prepare(`
                    UPDATE scene_selection
                    SET scene_id = NULL, revision = ?, updated_at = ?,
                        updated_by = ?, request_id = ?
                    WHERE group_id = ? AND revision = ?
                `).run(
                    selectionRevision,
                    now,
                    operator,
                    requestId,
                    groupId,
                    selection.revision
                );
                selection = this._selectionFromRow(
                    groupId,
                    this._findSelectionRow(groupId)
                );
                this._recordAudit({
                    groupId,
                    sceneId,
                    action: "DESELECT_ON_DISABLE",
                    revision: selection.revision,
                    operator,
                    requestId,
                    before: beforeSelection,
                    after: selection,
                    createdAt: now,
                });
            }

            this._recordAudit({
                groupId,
                sceneId,
                action: enabled ? "ENABLE" : "DISABLE",
                revision: scene.revision,
                operator,
                requestId,
                before,
                after: scene,
                createdAt: now,
            });
            return Object.freeze({ scene, selection });
        });
    }

    getSelection(groupIdValue, context = {}) {
        const groupId = this._requireKnownGroup(groupIdValue, context);
        return this._selectionFromRow(groupId, this._findSelectionRow(groupId));
    }

    selectExclusive(
        groupIdValue,
        sceneIdValue,
        expectedRevision,
        context = {}
    ) {
        const groupId = this._requireKnownGroup(groupIdValue, context);
        const sceneId = normalizeSceneId(sceneIdValue);
        const selectionRevision = requireRevision(
            expectedRevision,
            "selection revision",
            true
        );
        const { operator, requestId } = requireActor(context);
        const now = this._now();

        return this._transaction(() => {
            const scene = this._sceneFromRow(this._requireSceneRow(groupId, sceneId));
            if (!scene.enabled) {
                throw new SceneRegistryError(
                    "CONFLICT",
                    "The scene must be enabled before it can be selected",
                    409
                );
            }
            if (scene.mode !== "exclusive") {
                throw new SceneRegistryError(
                    "INVALID_SCENE",
                    "Only an exclusive scene can be selected as current"
                );
            }

            const before = this._selectionFromRow(
                groupId,
                this._findSelectionRow(groupId)
            );
            if (before.revision !== selectionRevision) {
                throw new SceneRegistryError(
                    "CONFLICT",
                    `Selection revision conflict: expected ${selectionRevision}, current ${before.revision}`,
                    409,
                    {
                        expected_revision: selectionRevision,
                        current_revision: before.revision,
                    }
                );
            }

            if (before.scene_id === sceneId) {
                this._recordAudit({
                    groupId,
                    sceneId,
                    action: "SELECT_IDEMPOTENT",
                    revision: before.revision,
                    operator,
                    requestId,
                    before,
                    after: before,
                    createdAt: now,
                });
                return before;
            }

            const nextRevision = before.revision + 1;
            if (before.revision === 0) {
                this._db.prepare(`
                    INSERT INTO scene_selection (
                        group_id, scene_id, revision, updated_at, updated_by, request_id
                    ) VALUES (?, ?, ?, ?, ?, ?)
                `).run(groupId, sceneId, nextRevision, now, operator, requestId);
            } else {
                const result = this._db.prepare(`
                    UPDATE scene_selection
                    SET scene_id = ?, revision = ?, updated_at = ?,
                        updated_by = ?, request_id = ?
                    WHERE group_id = ? AND revision = ?
                `).run(
                    sceneId,
                    nextRevision,
                    now,
                    operator,
                    requestId,
                    groupId,
                    before.revision
                );
                if (sqliteChanged(result) !== 1) {
                    throw new SceneRegistryError(
                        "CONFLICT",
                        "Selection changed concurrently",
                        409
                    );
                }
            }

            const selection = this._selectionFromRow(
                groupId,
                this._findSelectionRow(groupId)
            );
            this._recordAudit({
                groupId,
                sceneId,
                action: "SELECT",
                revision: selection.revision,
                operator,
                requestId,
                before,
                after: selection,
                createdAt: now,
            });
            return selection;
        });
    }

    deleteScene(groupIdValue, sceneIdValue, expectedRevision, context = {}) {
        const groupId = this._requireKnownGroup(groupIdValue, context);
        const sceneId = normalizeSceneId(sceneIdValue);
        const { operator, requestId } = requireActor(context);
        const now = this._now();

        return this._transaction(() => {
            const row = this._requireSceneRow(groupId, sceneId);
            this._assertRevision(row, expectedRevision, `${groupId}/${sceneId}`);
            const before = this._sceneFromRow(row);
            if (before.enabled) {
                throw new SceneRegistryError(
                    "CONFLICT",
                    "Disable the scene before deleting it",
                    409
                );
            }
            const selection = this._selectionFromRow(
                groupId,
                this._findSelectionRow(groupId)
            );
            if (selection.scene_id === sceneId) {
                throw new SceneRegistryError(
                    "CONFLICT",
                    "Deselect the current scene before deleting it",
                    409
                );
            }

            const result = this._db.prepare(`
                DELETE FROM scene_registry
                WHERE group_id = ? AND scene_id = ? AND revision = ?
            `).run(groupId, sceneId, Number(row.revision));
            if (sqliteChanged(result) !== 1) {
                throw new SceneRegistryError("CONFLICT", "Scene changed concurrently", 409);
            }
            this._recordAudit({
                groupId,
                sceneId,
                action: "DELETE",
                revision: Number(row.revision),
                operator,
                requestId,
                before,
                createdAt: now,
            });
            return Object.freeze({
                deleted: true,
                group_id: groupId,
                scene_id: sceneId,
                revision: Number(row.revision),
            });
        });
    }

    listHistory(groupIdValue, options = {}, context = {}) {
        const groupId = this._requireKnownGroup(groupIdValue, context);
        const sceneId = options.scene_id === undefined || options.scene_id === null
            ? null
            : normalizeSceneId(options.scene_id);
        const requestedLimit = Number(options.limit || 100);
        const limit = Number.isInteger(requestedLimit)
            ? Math.min(500, Math.max(1, requestedLimit))
            : 100;
        const rows = sceneId
            ? this._db.prepare(`
                SELECT audit_id, group_id, scene_id, action, revision, operator,
                       request_id, before_json, after_json, created_at
                FROM scene_registry_audit
                WHERE group_id = ? AND scene_id = ?
                ORDER BY audit_id DESC
                LIMIT ?
            `).all(groupId, sceneId, limit)
            : this._db.prepare(`
                SELECT audit_id, group_id, scene_id, action, revision, operator,
                       request_id, before_json, after_json, created_at
                FROM scene_registry_audit
                WHERE group_id = ?
                ORDER BY audit_id DESC
                LIMIT ?
            `).all(groupId, limit);

        return Object.freeze(rows.map((row) => Object.freeze({
            audit_id: Number(row.audit_id),
            group_id: Number(row.group_id),
            scene_id: row.scene_id || null,
            action: row.action,
            revision: Number(row.revision),
            operator: row.operator,
            request_id: row.request_id,
            before: row.before_json ? clone(JSON.parse(row.before_json)) : null,
            after: row.after_json ? clone(JSON.parse(row.after_json)) : null,
            created_at: row.created_at,
        })));
    }
}

module.exports = {
    SceneRegistryError,
    SceneRegistryStore,
    VALID_MODES,
    normalizeGroupId,
    normalizeSceneId,
};
