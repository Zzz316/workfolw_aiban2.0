"use strict";

const { afterEach, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMockRED } = require("./test-helpers");
const {
    SCENE_PERMISSIONS,
    registerSceneRegistryApi,
} = require("../lib/scene-registry-api");

const temporaryDirectories = [];

function createApi(directory = null) {
    const userDir = directory
        || fs.mkdtempSync(path.join(os.tmpdir(), "aiban-scene-api-"));
    if (!directory) {
        temporaryDirectories.push(userDir);
    }
    const { RED, nodeRegistry } = createMockRED({ userDir });
    const runtimeStatus = {
        actual_state: "READY",
        desired_state: "READY",
        session_id: "session-scene-api",
        ready_metadata: {
            groups: [
                { group_id: 1, name: "group-1", enabled: true, sources: [] },
                { group_id: 2, name: "group-2", enabled: false, sources: [] },
            ],
            sources_per_group: { "1": [], "2": [] },
            models: [{ model_id: 1, name: "demo-model" }],
            models_loaded: ["1"],
        },
    };
    let runtimeControlCalls = 0;
    const runtimeNode = {
        id: "runtime-1",
        getRuntimeStatus() {
            return JSON.parse(JSON.stringify(runtimeStatus));
        },
        controlRuntime() {
            runtimeControlCalls += 1;
            throw new Error("Scene API must not call Runtime control");
        },
    };
    RED.nodes.registerType("aiban-runtime", function FakeRuntime() {});
    nodeRegistry.get("aiban-runtime")._instances = new Map([
        [runtimeNode.id, runtimeNode],
    ]);
    const registration = registerSceneRegistryApi(RED);
    return {
        RED,
        registration,
        runtimeNode,
        runtimeStatus,
        userDir,
        runtimeControlCalls: () => runtimeControlCalls,
    };
}

function response() {
    return {
        statusCode: 0,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        send(payload) {
            this.body = payload;
            return this;
        },
    };
}

function route(api, method, routePath) {
    const found = api.RED.httpAdmin._routes.find(
        (item) => item.method === method && item.path === routePath
    );
    assert.ok(found, `Missing ${method} ${routePath}`);
    return found;
}

function invoke(api, method, routePath, request = {}) {
    const found = route(api, method, routePath);
    const res = response();
    const req = {
        params: {},
        query: {},
        headers: {},
        body: {},
        ...request,
    };
    found.handlers[found.handlers.length - 1](req, res);
    return res;
}

function baseParams(overrides = {}) {
    return {
        runtimeId: "runtime-1",
        groupId: "1",
        ...overrides,
    };
}

function writeRequest(params, body, requestId = "req-api") {
    return {
        params,
        body,
        headers: { "x-request-id": requestId },
        user: { username: "api-editor" },
    };
}

afterEach(() => {
    while (temporaryDirectories.length) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

describe("Scene Registry HTTP API", () => {
    test("publishes runtime metadata without controlling the Runtime", () => {
        const api = createApi();
        const res = invoke(
            api,
            "GET",
            "/aiban-scenes/:runtimeId/metadata",
            { params: baseParams() }
        );

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.data.runtime_id, "runtime-1");
        assert.equal(res.body.data.actual_state, "READY");
        assert.deepEqual(
            res.body.data.groups.map((group) => group.group_id),
            [1, 2]
        );
        assert.equal(res.body.data.metadata_available, true);
        assert.equal(api.runtimeControlCalls(), 0);
    });

    test("assigns read, edit and control permissions to the correct routes", () => {
        const api = createApi();
        const cases = [
            ["GET", "/aiban-scenes/:runtimeId/metadata", SCENE_PERMISSIONS.READ],
            ["GET", "/aiban-scenes/:runtimeId/groups/:groupId/scenes", SCENE_PERMISSIONS.READ],
            ["POST", "/aiban-scenes/:runtimeId/groups/:groupId/scenes", SCENE_PERMISSIONS.EDIT],
            ["PUT", "/aiban-scenes/:runtimeId/groups/:groupId/scenes/:sceneId", SCENE_PERMISSIONS.EDIT],
            ["DELETE", "/aiban-scenes/:runtimeId/groups/:groupId/scenes/:sceneId", SCENE_PERMISSIONS.EDIT],
            ["PUT", "/aiban-scenes/:runtimeId/groups/:groupId/scenes/:sceneId/tab", SCENE_PERMISSIONS.EDIT],
            ["POST", "/aiban-scenes/:runtimeId/groups/:groupId/scenes/:sceneId/:action", SCENE_PERMISSIONS.CONTROL],
            ["GET", "/aiban-scenes/:runtimeId/groups/:groupId/current", SCENE_PERMISSIONS.READ],
            ["POST", "/aiban-scenes/:runtimeId/groups/:groupId/current", SCENE_PERMISSIONS.CONTROL],
            ["GET", "/aiban-scenes/:runtimeId/groups/:groupId/history", SCENE_PERMISSIONS.READ],
        ];

        for (const [method, routePath, expected] of cases) {
            const found = route(api, method, routePath);
            assert.equal(found.handlers[0].aibanPermission, expected);
        }
        assert.equal(SCENE_PERMISSIONS.RUNTIME, "aiban-runtime.write");

        api.RED.settings.adminAuth = {};
        const editMiddleware = route(
            api,
            "POST",
            "/aiban-scenes/:runtimeId/groups/:groupId/scenes"
        ).handlers[0];
        const denied = response();
        let deniedNext = false;
        editMiddleware(
            {
                headers: { "x-request-id": "req-denied" },
                authInfo: { scope: SCENE_PERMISSIONS.READ },
                user: { username: "reader" },
            },
            denied,
            () => { deniedNext = true; }
        );
        assert.equal(deniedNext, false);
        assert.equal(denied.statusCode, 403);
        assert.equal(denied.body.error_code, "FORBIDDEN");

        const allowed = response();
        let allowedNext = false;
        editMiddleware(
            {
                headers: {},
                authInfo: { scope: [SCENE_PERMISSIONS.EDIT] },
                user: { username: "editor" },
            },
            allowed,
            () => { allowedNext = true; }
        );
        assert.equal(allowedNext, true);
    });

    test("supports CRUD, optimistic conflicts, enable/select and persistent restart reads", () => {
        const api = createApi();
        const collectionPath = "/aiban-scenes/:runtimeId/groups/:groupId/scenes";
        const itemPath = `${collectionPath}/:sceneId`;
        const actionPath = `${itemPath}/:action`;
        const tabPath = `${itemPath}/tab`;
        const currentPath = "/aiban-scenes/:runtimeId/groups/:groupId/current";
        const historyPath = "/aiban-scenes/:runtimeId/groups/:groupId/history";

        const createdResponse = invoke(
            api,
            "POST",
            collectionPath,
            writeRequest(
                baseParams(),
                {
                    scene_id: "plug-sequence",
                    name: "插接顺序检测",
                    mode: "exclusive",
                    enabled: true,
                },
                "req-create"
            )
        );
        assert.equal(createdResponse.statusCode, 201);
        assert.equal(createdResponse.body.data.revision, 1);
        assert.equal(createdResponse.body.data.enabled, false);
        assert.equal(createdResponse.body.request_id, "req-create");

        const restartedApi = createApi(api.userDir);
        const listAfterRestart = invoke(
            restartedApi,
            "GET",
            collectionPath,
            { params: baseParams() }
        );
        assert.equal(listAfterRestart.statusCode, 200);
        assert.equal(listAfterRestart.body.data.length, 1);
        assert.equal(listAfterRestart.body.data[0].scene_id, "plug-sequence");

        const staleUpdate = invoke(
            restartedApi,
            "PUT",
            itemPath,
            writeRequest(
                baseParams({ sceneId: "plug-sequence" }),
                { name: "stale", revision: 7 },
                "req-stale"
            )
        );
        assert.equal(staleUpdate.statusCode, 409);
        assert.equal(staleUpdate.body.error_code, "CONFLICT");
        assert.equal(staleUpdate.body.details.current_revision, 1);

        const updated = invoke(
            restartedApi,
            "PUT",
            itemPath,
            writeRequest(
                baseParams({ sceneId: "plug-sequence" }),
                {
                    name: "插接顺序检测 v2",
                    revision: 1,
                },
                "req-update"
            )
        );
        assert.equal(updated.statusCode, 200);
        assert.equal(updated.body.data.revision, 2);

        const bound = invoke(
            restartedApi,
            "PUT",
            tabPath,
            writeRequest(
                baseParams({ sceneId: "plug-sequence" }),
                {
                    node_red_tab_id: "tab-plug-sequence",
                    revision: 2,
                },
                "req-bind-tab"
            )
        );
        assert.equal(bound.statusCode, 200);
        assert.equal(bound.body.data.revision, 3);
        assert.equal(bound.body.data.node_red_tab_id, "tab-plug-sequence");

        const enabled = invoke(
            restartedApi,
            "POST",
            actionPath,
            writeRequest(
                baseParams({
                    sceneId: "plug-sequence",
                    action: "enable",
                }),
                { revision: 3 },
                "req-enable"
            )
        );
        assert.equal(enabled.statusCode, 200);
        assert.equal(enabled.body.data.scene.enabled, true);
        assert.equal(enabled.body.data.scene.revision, 4);

        const selected = invoke(
            restartedApi,
            "POST",
            currentPath,
            writeRequest(
                baseParams(),
                {
                    scene_id: "plug-sequence",
                    selection_revision: 0,
                },
                "req-select"
            )
        );
        assert.equal(selected.statusCode, 200);
        assert.equal(selected.body.data.scene_id, "plug-sequence");
        assert.equal(selected.body.data.revision, 1);

        const current = invoke(
            restartedApi,
            "GET",
            currentPath,
            { params: baseParams() }
        );
        assert.equal(current.body.data.scene_id, "plug-sequence");

        const history = invoke(
            restartedApi,
            "GET",
            historyPath,
            { params: baseParams(), query: { limit: "20" } }
        );
        assert.equal(history.statusCode, 200);
        assert.ok(history.body.data.some((item) => item.action === "CREATE"));
        assert.ok(history.body.data.some((item) => item.action === "BIND_TAB"));
        assert.ok(history.body.data.some((item) => item.action === "SELECT"));
        assert.ok(history.body.data.every((item) => item.operator));
        assert.ok(history.body.data.every((item) => item.request_id));
        assert.equal(restartedApi.runtimeControlCalls(), 0);
    });

    test("requires disable before delete and returns stable validation errors", () => {
        const api = createApi();
        const collectionPath = "/aiban-scenes/:runtimeId/groups/:groupId/scenes";
        const itemPath = `${collectionPath}/:sceneId`;
        const actionPath = `${itemPath}/:action`;

        const forbidden = invoke(
            api,
            "POST",
            collectionPath,
            {
                params: baseParams(),
                body: {
                    scene_id: "no-operator",
                    name: "No operator",
                    mode: "exclusive",
                },
                headers: { "x-request-id": "req-forbidden" },
            }
        );
        assert.equal(forbidden.statusCode, 403);
        assert.equal(forbidden.body.error_code, "FORBIDDEN");

        const invalidGroup = invoke(
            api,
            "POST",
            collectionPath,
            writeRequest(
                baseParams({ groupId: "99" }),
                {
                    scene_id: "unknown-group",
                    name: "Unknown",
                    mode: "exclusive",
                },
                "req-invalid-group"
            )
        );
        assert.equal(invalidGroup.statusCode, 400);
        assert.equal(invalidGroup.body.error_code, "INVALID_GROUP");

        const invalidScene = invoke(
            api,
            "POST",
            collectionPath,
            writeRequest(
                baseParams(),
                {
                    scene_id: "",
                    name: "Invalid",
                    mode: "serial",
                },
                "req-invalid-scene"
            )
        );
        assert.equal(invalidScene.statusCode, 400);
        assert.equal(invalidScene.body.error_code, "INVALID_SCENE");

        const created = invoke(
            api,
            "POST",
            collectionPath,
            writeRequest(
                baseParams(),
                {
                    scene_id: "delete-demo",
                    name: "Delete demo",
                    mode: "exclusive",
                },
                "req-create-delete"
            )
        ).body.data;
        const enabled = invoke(
            api,
            "POST",
            actionPath,
            writeRequest(
                baseParams({ sceneId: "delete-demo", action: "enable" }),
                { revision: created.revision },
                "req-enable-delete"
            )
        ).body.data.scene;

        const deleteEnabled = invoke(
            api,
            "DELETE",
            itemPath,
            writeRequest(
                baseParams({ sceneId: "delete-demo" }),
                { revision: enabled.revision },
                "req-delete-enabled"
            )
        );
        assert.equal(deleteEnabled.statusCode, 409);
        assert.equal(deleteEnabled.body.error_code, "CONFLICT");

        const disabled = invoke(
            api,
            "POST",
            actionPath,
            writeRequest(
                baseParams({ sceneId: "delete-demo", action: "disable" }),
                { revision: enabled.revision },
                "req-disable-delete"
            )
        ).body.data.scene;
        const deleted = invoke(
            api,
            "DELETE",
            itemPath,
            writeRequest(
                baseParams({ sceneId: "delete-demo" }),
                { revision: disabled.revision },
                "req-delete"
            )
        );
        assert.equal(deleted.statusCode, 200);
        assert.equal(deleted.body.data.deleted, true);

        const notFound = invoke(
            api,
            "GET",
            `${collectionPath}/:sceneId`,
            {
                params: baseParams({
                    runtimeId: "missing-runtime",
                    sceneId: "anything",
                }),
            }
        );
        assert.equal(notFound.statusCode, 404);
        assert.equal(notFound.body.error_code, "NOT_FOUND");
        assert.equal(api.runtimeControlCalls(), 0);
    });
});
