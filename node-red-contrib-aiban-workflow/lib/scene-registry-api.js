"use strict";

const { randomUUID } = require("node:crypto");
const path = require("node:path");

const {
    SceneRegistryError,
    SceneRegistryStore,
    normalizeGroupId,
} = require("./scene-registry-store");

const SCENE_PERMISSIONS = Object.freeze({
    READ: "aiban-scene.read",
    EDIT: "aiban-scene.edit",
    CONTROL: "aiban-scene.control",
    RUNTIME: "aiban-runtime.write",
});

const API_PREFIX = "/aiban-scenes/:runtimeId";

function defaultSendJson(res, statusCode, payload) {
    if (typeof res.status === "function") {
        const response = res.status(statusCode);
        if (response && typeof response.json === "function") {
            response.json(payload);
            return;
        }
    }
    if (typeof res.json === "function") {
        res.json(payload);
        return;
    }
    if (typeof res.send === "function") {
        res.send(payload);
    }
}

function requestBody(req) {
    return req && req.body && typeof req.body === "object" ? req.body : {};
}

function requestId(req) {
    const body = requestBody(req);
    const headerValue = req && req.headers
        ? req.headers["x-request-id"]
        : null;
    const value = headerValue || body.request_id;
    return typeof value === "string" && value.trim()
        ? value.trim()
        : randomUUID();
}

function requestOperator(req) {
    const body = requestBody(req);
    const user = req && req.user && typeof req.user === "object"
        ? req.user
        : {};
    const value = user.username
        || user.name
        || user.user
        || body.operator;
    return typeof value === "string" ? value.trim() : "";
}

function expectedRevision(req, fieldName = "revision") {
    const body = requestBody(req);
    if (Object.prototype.hasOwnProperty.call(body, fieldName)) {
        return body[fieldName];
    }
    if (fieldName !== "revision"
        && Object.prototype.hasOwnProperty.call(body, "revision")) {
        return body.revision;
    }
    if (req && req.query
        && Object.prototype.hasOwnProperty.call(req.query, fieldName)) {
        return req.query[fieldName];
    }
    const rawIfMatch = req && req.headers ? req.headers["if-match"] : null;
    if (typeof rawIfMatch === "string") {
        return rawIfMatch.replace(/^W\//, "").replace(/^"|"$/g, "");
    }
    return undefined;
}

function runtimeContext(RED, req) {
    const runtimeId = req && req.params ? req.params.runtimeId : null;
    const node = runtimeId ? RED.nodes.getNode(runtimeId) : null;
    if (!node || typeof node.getRuntimeStatus !== "function") {
        throw new SceneRegistryError(
            "NOT_FOUND",
            `Runtime node not found: ${runtimeId || ""}`,
            404
        );
    }
    const status = node.getRuntimeStatus();
    const readyMetadata = status && status.ready_metadata;
    const groups = readyMetadata && Array.isArray(readyMetadata.groups)
        ? readyMetadata.groups
        : [];
    return {
        runtimeId,
        node,
        status,
        readyMetadata,
        groups,
        knownGroupIds: groups.map((group) => group.group_id),
    };
}

function writeContext(req, runtime) {
    return {
        operator: requestOperator(req),
        requestId: requestId(req),
        knownGroupIds: runtime.knownGroupIds,
    };
}

function readContext(runtime) {
    return { knownGroupIds: runtime.knownGroupIds };
}

function hasPermission(scope, permission) {
    if (scope === "*" || scope === permission) {
        return true;
    }
    if (Array.isArray(scope)) {
        return scope.some((item) => hasPermission(item, permission));
    }
    if ((scope === "read" || scope === "*.read") && permission.endsWith(".read")) {
        return true;
    }
    if ((scope === "write" || scope === "*.write") && permission.endsWith(".write")) {
        return true;
    }
    return false;
}

function registerSceneRegistryApi(RED, options = {}) {
    const sendJson = options.sendJson || defaultSendJson;
    const dbPath = options.dbPath || path.join(
        RED.settings.userDir,
        "data",
        "scene",
        "scene-registry.sqlite"
    );

    function permission(permission) {
        const authenticate = RED.auth.needsPermission("");
        const middleware = function scenePermission(req, res, next) {
            return authenticate(req, res, () => {
                if (!RED.settings.adminAuth) {
                    next();
                    return;
                }
                const scope = req && req.authInfo
                    ? req.authInfo.scope
                    : req && req.user
                        ? req.user.permissions
                        : null;
                if (hasPermission(scope, permission)) {
                    next();
                    return;
                }
                sendJson(res, 403, {
                    success: false,
                    request_id: requestId(req),
                    error_code: "FORBIDDEN",
                    message: `Permission required: ${permission}`,
                    details: { permission },
                });
            });
        };
        middleware.aibanPermission = permission;
        return middleware;
    }

    function withStore(callback) {
        const store = new SceneRegistryStore({ dbPath });
        try {
            return callback(store);
        } finally {
            store.close();
        }
    }

    function success(res, statusCode, data, currentRequestId = null) {
        sendJson(res, statusCode, {
            success: true,
            request_id: currentRequestId,
            data,
        });
    }

    function failure(res, error, currentRequestId = null) {
        const knownError = error instanceof SceneRegistryError;
        sendJson(res, knownError ? error.statusCode : 500, {
            success: false,
            request_id: currentRequestId,
            error_code: knownError ? error.code : "INVALID_SCENE",
            message: error && error.message ? error.message : "Scene Registry request failed",
            details: knownError ? error.details : null,
        });
    }

    function handler(callback) {
        return function sceneRegistryHandler(req, res) {
            let currentRequestId = null;
            try {
                const result = callback(req, res, {
                    withStore,
                    success,
                    getRequestId() {
                        if (!currentRequestId) {
                            currentRequestId = requestId(req);
                        }
                        return currentRequestId;
                    },
                });
                return result;
            } catch (error) {
                failure(res, error, currentRequestId);
                return undefined;
            }
        };
    }

    RED.httpAdmin.get(
        `${API_PREFIX}/metadata`,
        permission(SCENE_PERMISSIONS.READ),
        handler((req, res, helpers) => {
            const runtime = runtimeContext(RED, req);
            success(res, 200, {
                runtime_id: runtime.runtimeId,
                actual_state: runtime.status.actual_state,
                desired_state: runtime.status.desired_state,
                session_id: runtime.status.session_id,
                groups: runtime.groups,
                sources_per_group: runtime.readyMetadata
                    ? runtime.readyMetadata.sources_per_group || {}
                    : {},
                models: runtime.readyMetadata
                    ? runtime.readyMetadata.models || []
                    : [],
                models_loaded: runtime.readyMetadata
                    ? runtime.readyMetadata.models_loaded || []
                    : [],
                metadata_available: runtime.groups.length > 0,
            });
        })
    );

    RED.httpAdmin.get(
        `${API_PREFIX}/groups/:groupId/scenes`,
        permission(SCENE_PERMISSIONS.READ),
        handler((req, res) => {
            const runtime = runtimeContext(RED, req);
            const scenes = withStore((store) => store.listScenes(
                req.params.groupId,
                readContext(runtime)
            ));
            success(res, 200, scenes);
        })
    );

    RED.httpAdmin.get(
        `${API_PREFIX}/groups/:groupId/scenes/:sceneId`,
        permission(SCENE_PERMISSIONS.READ),
        handler((req, res) => {
            const runtime = runtimeContext(RED, req);
            const scene = withStore((store) => store.getScene(
                req.params.groupId,
                req.params.sceneId,
                readContext(runtime)
            ));
            success(res, 200, scene);
        })
    );

    RED.httpAdmin.post(
        `${API_PREFIX}/groups/:groupId/scenes`,
        permission(SCENE_PERMISSIONS.EDIT),
        handler((req, res, helpers) => {
            const runtime = runtimeContext(RED, req);
            const currentRequestId = helpers.getRequestId();
            const body = requestBody(req);
            const scene = withStore((store) => store.createScene(
                {
                    ...body,
                    group_id: req.params.groupId,
                    enabled: false,
                },
                {
                    ...writeContext(req, runtime),
                    requestId: currentRequestId,
                }
            ));
            success(res, 201, scene, currentRequestId);
        })
    );

    RED.httpAdmin.put(
        `${API_PREFIX}/groups/:groupId/scenes/:sceneId`,
        permission(SCENE_PERMISSIONS.EDIT),
        handler((req, res, helpers) => {
            const runtime = runtimeContext(RED, req);
            const currentRequestId = helpers.getRequestId();
            const body = requestBody(req);
            const scene = withStore((store) => store.updateScene(
                req.params.groupId,
                req.params.sceneId,
                {
                    ...(Object.prototype.hasOwnProperty.call(body, "name")
                        ? { name: body.name }
                        : {}),
                    ...(Object.prototype.hasOwnProperty.call(body, "mode")
                        ? { mode: body.mode }
                        : {}),
                    ...(Object.prototype.hasOwnProperty.call(body, "workflow_id")
                        ? { workflow_id: body.workflow_id }
                        : {}),
                    ...(Object.prototype.hasOwnProperty.call(body, "node_red_tab_id")
                        ? { node_red_tab_id: body.node_red_tab_id }
                        : {}),
                },
                expectedRevision(req),
                {
                    ...writeContext(req, runtime),
                    requestId: currentRequestId,
                }
            ));
            success(res, 200, scene, currentRequestId);
        })
    );

    RED.httpAdmin.delete(
        `${API_PREFIX}/groups/:groupId/scenes/:sceneId`,
        permission(SCENE_PERMISSIONS.EDIT),
        handler((req, res, helpers) => {
            const runtime = runtimeContext(RED, req);
            const currentRequestId = helpers.getRequestId();
            const deleted = withStore((store) => store.deleteScene(
                req.params.groupId,
                req.params.sceneId,
                expectedRevision(req),
                {
                    ...writeContext(req, runtime),
                    requestId: currentRequestId,
                }
            ));
            success(res, 200, deleted, currentRequestId);
        })
    );

    RED.httpAdmin.post(
        `${API_PREFIX}/groups/:groupId/scenes/:sceneId/:action`,
        permission(SCENE_PERMISSIONS.CONTROL),
        handler((req, res, helpers) => {
            const action = req.params.action;
            if (!["enable", "disable"].includes(action)) {
                throw new SceneRegistryError(
                    "INVALID_SCENE",
                    `Unknown scene control action: ${action}`
                );
            }
            const runtime = runtimeContext(RED, req);
            const currentRequestId = helpers.getRequestId();
            const result = withStore((store) => store.setEnabled(
                req.params.groupId,
                req.params.sceneId,
                action === "enable",
                expectedRevision(req),
                {
                    ...writeContext(req, runtime),
                    requestId: currentRequestId,
                }
            ));
            success(res, 200, result, currentRequestId);
        })
    );

    RED.httpAdmin.put(
        `${API_PREFIX}/groups/:groupId/scenes/:sceneId/tab`,
        permission(SCENE_PERMISSIONS.EDIT),
        handler((req, res, helpers) => {
            const runtime = runtimeContext(RED, req);
            const currentRequestId = helpers.getRequestId();
            const body = requestBody(req);
            const scene = withStore((store) => store.bindTab(
                req.params.groupId,
                req.params.sceneId,
                body.node_red_tab_id,
                expectedRevision(req),
                {
                    ...writeContext(req, runtime),
                    requestId: currentRequestId,
                }
            ));
            success(res, 200, scene, currentRequestId);
        })
    );

    RED.httpAdmin.get(
        `${API_PREFIX}/groups/:groupId/current`,
        permission(SCENE_PERMISSIONS.READ),
        handler((req, res) => {
            const runtime = runtimeContext(RED, req);
            const selection = withStore((store) => store.getSelection(
                req.params.groupId,
                readContext(runtime)
            ));
            success(res, 200, selection);
        })
    );

    RED.httpAdmin.post(
        `${API_PREFIX}/groups/:groupId/current`,
        permission(SCENE_PERMISSIONS.CONTROL),
        handler((req, res, helpers) => {
            const runtime = runtimeContext(RED, req);
            const currentRequestId = helpers.getRequestId();
            const body = requestBody(req);
            const selection = withStore((store) => store.selectExclusive(
                req.params.groupId,
                body.scene_id,
                expectedRevision(req, "selection_revision"),
                {
                    ...writeContext(req, runtime),
                    requestId: currentRequestId,
                }
            ));
            success(res, 200, selection, currentRequestId);
        })
    );

    RED.httpAdmin.get(
        `${API_PREFIX}/groups/:groupId/history`,
        permission(SCENE_PERMISSIONS.READ),
        handler((req, res) => {
            const runtime = runtimeContext(RED, req);
            const query = req.query || {};
            const history = withStore((store) => store.listHistory(
                req.params.groupId,
                {
                    scene_id: query.scene_id,
                    limit: query.limit,
                },
                readContext(runtime)
            ));
            success(res, 200, history);
        })
    );

    return Object.freeze({
        dbPath,
        permissions: SCENE_PERMISSIONS,
    });
}

module.exports = {
    API_PREFIX,
    SCENE_PERMISSIONS,
    registerSceneRegistryApi,
    hasPermission,
    requestId,
    requestOperator,
    runtimeContext,
};
