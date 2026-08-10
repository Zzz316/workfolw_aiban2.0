"use strict";

const { afterEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    SceneRegistryError,
    SceneRegistryStore,
} = require("../lib/scene-registry-store");

const temporaryDirectories = [];
const openStores = [];

function createStore(options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aiban-scene-registry-"));
    temporaryDirectories.push(directory);
    const dbPath = path.join(directory, "data", "scene", "scene-registry.sqlite");
    const store = new SceneRegistryStore({
        dbPath,
        knownGroupIds: [1, 2],
        ...options,
    });
    openStores.push(store);
    return { store, dbPath };
}

function actor(overrides = {}) {
    return {
        operator: "scene-editor",
        requestId: "req-001",
        ...overrides,
    };
}

function scene(overrides = {}) {
    return {
        group_id: 1,
        scene_id: "plug-sequence",
        name: "插接顺序检测",
        mode: "exclusive",
        ...overrides,
    };
}

function assertRegistryError(callback, code, statusCode) {
    assert.throws(callback, (error) => {
        assert.ok(error instanceof SceneRegistryError);
        assert.equal(error.code, code);
        if (statusCode !== undefined) {
            assert.equal(error.statusCode, statusCode);
        }
        return true;
    });
}

afterEach(() => {
    while (openStores.length) {
        const store = openStores.pop();
        try {
            store.close();
        } catch (_) {
            // Test cleanup must not hide the assertion failure.
        }
    }
    while (temporaryDirectories.length) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

describe("SceneRegistryStore", () => {
    test("persists scenes and audit history across store restarts", () => {
        const { store, dbPath } = createStore();
        const created = store.createScene(scene(), actor());

        assert.equal(created.revision, 1);
        assert.equal(created.workflow_id, "group/1/scene/plug-sequence");
        assert.equal(created.enabled, false);
        assert.ok(fs.existsSync(dbPath));
        store.close();
        openStores.splice(openStores.indexOf(store), 1);

        const reopened = new SceneRegistryStore({
            dbPath,
            knownGroupIds: [1, 2],
        });
        openStores.push(reopened);

        assert.deepEqual(
            reopened.listScenes(1).map((item) => item.scene_id),
            ["plug-sequence"]
        );
        const history = reopened.listHistory(1);
        assert.equal(history.length, 1);
        assert.equal(history[0].action, "CREATE");
        assert.equal(history[0].operator, "scene-editor");
        assert.equal(history[0].request_id, "req-001");
        assert.equal(history[0].after.revision, 1);
    });

    test("rejects duplicate scenes, unknown groups, invalid modes and empty scene ids", () => {
        const { store } = createStore();
        store.createScene(scene(), actor());

        assertRegistryError(
            () => store.createScene(scene(), actor({ requestId: "duplicate" })),
            "CONFLICT",
            409
        );
        assertRegistryError(
            () => store.createScene(scene({ group_id: 99 }), actor()),
            "INVALID_GROUP",
            400
        );
        assertRegistryError(
            () => store.createScene(scene({ scene_id: " " }), actor()),
            "INVALID_SCENE",
            400
        );
        assertRegistryError(
            () => store.createScene(scene({ scene_id: "bad-mode", mode: "serial" }), actor()),
            "INVALID_SCENE",
            400
        );
    });

    test("uses scene revision for optimistic updates and tab binding", () => {
        const { store } = createStore();
        const created = store.createScene(scene(), actor());
        const updated = store.updateScene(
            1,
            created.scene_id,
            { name: "插接检测 v2" },
            created.revision,
            actor({ requestId: "req-update" })
        );
        assert.equal(updated.name, "插接检测 v2");
        assert.equal(updated.revision, 2);

        assertRegistryError(
            () => store.updateScene(
                1,
                created.scene_id,
                { name: "stale" },
                1,
                actor({ requestId: "req-stale" })
            ),
            "CONFLICT",
            409
        );

        const bound = store.bindTab(
            1,
            created.scene_id,
            "tab-group1-plug-sequence",
            updated.revision,
            actor({ requestId: "req-tab" })
        );
        assert.equal(bound.node_red_tab_id, "tab-group1-plug-sequence");
        assert.equal(bound.revision, 3);
    });

    test("tracks exclusive selection independently and clears it when disabled", () => {
        const { store } = createStore();
        const first = store.createScene(scene(), actor());
        const second = store.createScene(
            scene({
                scene_id: "backup-sequence",
                name: "备用顺序检测",
            }),
            actor({ requestId: "req-create-backup" })
        );
        const parallel = store.createScene(
            scene({
                scene_id: "safety-monitor",
                name: "安全监控",
                mode: "parallel",
            }),
            actor({ requestId: "req-create-parallel" })
        );

        const firstEnabled = store.setEnabled(
            1,
            first.scene_id,
            true,
            first.revision,
            actor({ requestId: "req-enable-first" })
        ).scene;
        const secondEnabled = store.setEnabled(
            1,
            second.scene_id,
            true,
            second.revision,
            actor({ requestId: "req-enable-second" })
        ).scene;
        const parallelEnabled = store.setEnabled(
            1,
            parallel.scene_id,
            true,
            parallel.revision,
            actor({ requestId: "req-enable-parallel" })
        ).scene;

        const selected = store.selectExclusive(
            1,
            first.scene_id,
            0,
            actor({ requestId: "req-select-first" })
        );
        assert.equal(selected.scene_id, first.scene_id);
        assert.equal(selected.revision, 1);

        assertRegistryError(
            () => store.selectExclusive(
                1,
                parallelEnabled.scene_id,
                selected.revision,
                actor({ requestId: "req-select-parallel" })
            ),
            "INVALID_SCENE",
            400
        );
        assertRegistryError(
            () => store.selectExclusive(
                1,
                secondEnabled.scene_id,
                0,
                actor({ requestId: "req-stale-selection" })
            ),
            "CONFLICT",
            409
        );

        const disabled = store.setEnabled(
            1,
            firstEnabled.scene_id,
            false,
            firstEnabled.revision,
            actor({ requestId: "req-disable-first" })
        );
        assert.equal(disabled.scene.enabled, false);
        assert.equal(disabled.selection.scene_id, null);
        assert.equal(disabled.selection.revision, 2);
        assert.equal(store.getSelection(1).scene_id, null);

        const selectedBackup = store.selectExclusive(
            1,
            secondEnabled.scene_id,
            disabled.selection.revision,
            actor({ requestId: "req-select-backup" })
        );
        assert.equal(selectedBackup.scene_id, second.scene_id);
        assert.equal(selectedBackup.revision, 3);
    });

    test("requires disable before delete and preserves the delete audit", () => {
        const { store } = createStore();
        const created = store.createScene(scene(), actor());
        const enabled = store.setEnabled(
            1,
            created.scene_id,
            true,
            created.revision,
            actor({ requestId: "req-enable" })
        ).scene;

        assertRegistryError(
            () => store.deleteScene(
                1,
                created.scene_id,
                enabled.revision,
                actor({ requestId: "req-delete-enabled" })
            ),
            "CONFLICT",
            409
        );

        const disabled = store.setEnabled(
            1,
            created.scene_id,
            false,
            enabled.revision,
            actor({ requestId: "req-disable" })
        ).scene;
        const deleted = store.deleteScene(
            1,
            created.scene_id,
            disabled.revision,
            actor({ requestId: "req-delete" })
        );
        assert.equal(deleted.deleted, true);
        assert.deepEqual(store.listScenes(1), []);

        const history = store.listHistory(1);
        assert.equal(history[0].action, "DELETE");
        assert.equal(history[0].request_id, "req-delete");
        assert.equal(history[0].before.enabled, false);
    });

    test("requires operator and request_id on every write", () => {
        const { store } = createStore();

        assertRegistryError(
            () => store.createScene(scene(), { requestId: "req-no-operator" }),
            "FORBIDDEN",
            403
        );
        assertRegistryError(
            () => store.createScene(scene(), { operator: "editor" }),
            "INVALID_SCENE",
            400
        );
    });
});
