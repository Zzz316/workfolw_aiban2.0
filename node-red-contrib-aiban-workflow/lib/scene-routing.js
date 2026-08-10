"use strict";

const ROUTING_DIAGNOSTICS = Object.freeze({
    UNKNOWN_GROUP: "UNKNOWN_GROUP",
    NO_ACTIVE_SCENE: "NO_ACTIVE_SCENE",
    SCENE_DISABLED: "SCENE_DISABLED",
    ROUTE_NOT_BOUND: "ROUTE_NOT_BOUND",
});

function cloneMessage(value) {
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function normalizeGroupId(value) {
    const groupId = Number(value);
    return Number.isInteger(groupId) && groupId >= 0 ? groupId : null;
}

function normalizeRoutes(routes) {
    if (!Array.isArray(routes)) {
        throw new TypeError("routes must be an array");
    }
    const ids = new Set();
    const bindings = new Set();
    return Object.freeze(routes.map((route, index) => {
        const groupId = normalizeGroupId(route && route.group_id);
        const sceneId = String(route && route.scene_id || "").trim();
        const routeId = String(route && route.route_id || "").trim();
        if (groupId === null || !sceneId || !routeId) {
            throw new TypeError(`route ${index + 1} requires route_id, group_id and scene_id`);
        }
        if (ids.has(routeId)) {
            throw new TypeError(`duplicate route_id: ${routeId}`);
        }
        const bindingKey = `${groupId}:${sceneId}`;
        if (bindings.has(bindingKey)) {
            throw new TypeError(`duplicate scene route: ${bindingKey}`);
        }
        ids.add(routeId);
        bindings.add(bindingKey);
        return Object.freeze({
            route_id: routeId,
            group_id: groupId,
            scene_id: sceneId,
            output_index: index,
        });
    }));
}

function extractStream(msg) {
    const payload = msg && msg.payload || {};
    const aiban = msg && msg.aiban || {};
    const groupId = normalizeGroupId(payload.group_id ?? aiban.group_id);
    const sourceId = Number(payload.source_id ?? aiban.source_id ?? 0);
    const sessionId = String(payload.session_id ?? aiban.session_id ?? "");
    return {
        groupId,
        sourceId: Number.isFinite(sourceId) ? sourceId : 0,
        sessionId,
        key: `${sessionId}:${groupId}:${Number.isFinite(sourceId) ? sourceId : 0}`,
    };
}

function groupIds(groups) {
    return new Set((Array.isArray(groups) ? groups : []).map((group) => (
        normalizeGroupId(group && typeof group === "object" ? group.group_id : group)
    )).filter((groupId) => groupId !== null));
}

function diagnostic(code, message, context = {}) {
    const routedAt = context.routedAt || new Date().toISOString();
    return {
        topic: "aiban-scene-diagnostic",
        payload: {
            code,
            message,
            group_id: context.groupId ?? null,
            scene_id: context.sceneId || null,
            route_id: context.routeId || null,
            routed_at: routedAt,
        },
        aiban: {
            diagnostic: true,
            diagnostic_code: code,
            group_id: context.groupId ?? null,
            scene_id: context.sceneId || null,
            route_id: context.routeId || null,
            routed_at: routedAt,
        },
    };
}

class SceneRoutingEngine {
    constructor(options = {}) {
        this.routes = normalizeRoutes(options.routes || []);
        this.outputCount = this.routes.length + 1;
        this.diagnosticOutput = this.routes.length;
        this._now = typeof options.now === "function"
            ? options.now
            : () => new Date().toISOString();
        this._activeByStream = new Map();
    }

    _routeFor(groupId, sceneId) {
        return this.routes.find((route) => (
            route.group_id === groupId && route.scene_id === sceneId
        )) || null;
    }

    _activeScenes(groupId, scenes, selection) {
        const groupScenes = (Array.isArray(scenes) ? scenes : []).filter(
            (scene) => normalizeGroupId(scene.group_id) === groupId
        );
        const selectedSceneId = selection && normalizeGroupId(selection.group_id) === groupId
            ? selection.scene_id
            : null;
        const active = [];
        for (const scene of groupScenes) {
            if (!scene.enabled) {
                continue;
            }
            if (scene.mode === "parallel"
                || (scene.mode === "exclusive" && selectedSceneId === scene.scene_id)) {
                active.push(scene);
            }
        }
        return { active, groupScenes, selectedSceneId };
    }

    route(msg, snapshot = {}) {
        const outputs = Array.from({ length: this.outputCount }, () => []);
        const routedAt = this._now();
        const stream = extractStream(msg);
        const knownGroups = groupIds(snapshot.groups);

        const emitDiagnostic = (code, message, context = {}) => {
            outputs[this.diagnosticOutput].push(diagnostic(code, message, {
                routedAt,
                groupId: stream.groupId,
                ...context,
            }));
        };

        if (stream.groupId === null || !knownGroups.has(stream.groupId)) {
            emitDiagnostic(
                ROUTING_DIAGNOSTICS.UNKNOWN_GROUP,
                `Unknown Runtime group_id: ${stream.groupId}`
            );
            return outputs;
        }

        let { active, groupScenes, selectedSceneId } = this._activeScenes(
            stream.groupId,
            snapshot.scenes,
            snapshot.selection
        );
        const group = (Array.isArray(snapshot.groups) ? snapshot.groups : []).find(
            (item) => normalizeGroupId(
                item && typeof item === "object" ? item.group_id : item
            ) === stream.groupId
        );
        const groupDisabled = Boolean(
            group && typeof group === "object" && group.enabled === false
        );
        if (groupDisabled) {
            active = [];
        }
        const activeIds = new Set(active.map((scene) => scene.scene_id));
        const previousIds = this._activeByStream.get(stream.key) || new Set();

        for (const previousSceneId of previousIds) {
            if (activeIds.has(previousSceneId)) {
                continue;
            }
            const previousRoute = this._routeFor(stream.groupId, previousSceneId);
            if (!previousRoute) {
                emitDiagnostic(
                    ROUTING_DIAGNOSTICS.ROUTE_NOT_BOUND,
                    `Interrupted scene has no fixed route: ${stream.groupId}/${previousSceneId}`,
                    { sceneId: previousSceneId }
                );
                continue;
            }
            const previousScene = groupScenes.find(
                (scene) => scene.scene_id === previousSceneId
            );
            const interrupt = cloneMessage(msg);
            interrupt.topic = "aiban-interrupt";
            interrupt.payload = {
                ...(interrupt.payload || {}),
                group_id: stream.groupId,
                scene_id: previousSceneId,
                workflow_id: previousScene && previousScene.workflow_id || "",
                reason: "scene-disabled-or-switched",
            };
            interrupt.aiban = {
                ...(interrupt.aiban || {}),
                group_id: stream.groupId,
                scene_id: previousSceneId,
                workflow_id: previousScene && previousScene.workflow_id || "",
                route_id: previousRoute.route_id,
                routed_at: routedAt,
            };
            interrupt.workflow = {
                ...(interrupt.workflow || {}),
                group_id: stream.groupId,
                scene_id: previousSceneId,
                workflow_id: previousScene && previousScene.workflow_id || "",
                route_id: previousRoute.route_id,
            };
            outputs[previousRoute.output_index].push(interrupt);
        }

        if (selectedSceneId) {
            const selected = groupScenes.find((scene) => scene.scene_id === selectedSceneId);
            if (selected && !selected.enabled) {
                emitDiagnostic(
                    ROUTING_DIAGNOSTICS.SCENE_DISABLED,
                    `Selected scene is disabled: ${stream.groupId}/${selectedSceneId}`,
                    { sceneId: selectedSceneId }
                );
            }
        }

        if (active.length === 0) {
            emitDiagnostic(
                ROUTING_DIAGNOSTICS.NO_ACTIVE_SCENE,
                groupDisabled
                    ? `Runtime group_id ${stream.groupId} is disabled`
                    : `No active scene for group_id ${stream.groupId}`
            );
        }

        for (const scene of active) {
            const route = this._routeFor(stream.groupId, scene.scene_id);
            if (!route) {
                emitDiagnostic(
                    ROUTING_DIAGNOSTICS.ROUTE_NOT_BOUND,
                    `No fixed route for scene ${stream.groupId}/${scene.scene_id}; add a route and Deploy`,
                    { sceneId: scene.scene_id }
                );
                continue;
            }
            const routed = cloneMessage(msg);
            routed.aiban = {
                ...(routed.aiban || {}),
                group_id: stream.groupId,
                scene_id: scene.scene_id,
                workflow_id: scene.workflow_id,
                route_id: route.route_id,
                routed_at: routedAt,
            };
            routed.workflow = {
                ...(routed.workflow || {}),
                group_id: stream.groupId,
                scene_id: scene.scene_id,
                workflow_id: scene.workflow_id,
                route_id: route.route_id,
            };
            outputs[route.output_index].push(routed);
        }

        this._activeByStream.set(stream.key, activeIds);
        return outputs;
    }

    forgetStream(msg) {
        this._activeByStream.delete(extractStream(msg).key);
    }
}

module.exports = {
    ROUTING_DIAGNOSTICS,
    SceneRoutingEngine,
    cloneMessage,
    diagnostic,
    extractStream,
    normalizeRoutes,
};
