"use strict";

const path = require("node:path");
const { SceneRegistryStore } = require("./lib/scene-registry-store");
const {
    ROUTING_DIAGNOSTICS,
    SceneRoutingEngine,
    diagnostic,
} = require("./lib/scene-routing");

function parseRoutes(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (!value) {
        return [];
    }
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
        throw new TypeError("routes must be a JSON array");
    }
    return parsed;
}

function runtimeGroups(runtimeNode) {
    if (!runtimeNode || typeof runtimeNode.getRuntimeStatus !== "function") {
        throw new Error("Configured aiban-runtime node is unavailable");
    }
    const status = runtimeNode.getRuntimeStatus();
    const metadata = status && status.ready_metadata;
    return metadata && Array.isArray(metadata.groups) ? metadata.groups : [];
}

module.exports = function registerSceneRouterNode(RED) {
    function AibanSceneRouterNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.type = "aiban-scene-router";
        node.runtimeNodeId = config.runtimeNodeId || "";

        let engine;
        try {
            engine = new SceneRoutingEngine({ routes: parseRoutes(config.routes) });
        } catch (error) {
            node.error(`[aiban-scene-router] Invalid route configuration: ${error.message}`);
            node.status({ fill: "red", shape: "ring", text: "invalid routes" });
            return;
        }

        const databasePath = path.join(
            RED.settings.userDir || ".",
            "data",
            "scene",
            "scene-registry.sqlite"
        );
        let store;
        try {
            store = new SceneRegistryStore({
                dbPath: databasePath,
                knownGroupIds: [],
            });
        } catch (error) {
            node.error(`[aiban-scene-router] Cannot open Scene Registry: ${error.message}`);
            node.status({ fill: "red", shape: "ring", text: "registry unavailable" });
            return;
        }

        node.on("input", function onInput(msg, send, done) {
            try {
                const runtimeNode = RED.nodes.getNode(node.runtimeNodeId);
                const groups = runtimeGroups(runtimeNode);
                const groupId = Number(msg.payload?.group_id ?? msg.aiban?.group_id);
                const knownGroupIds = groups.map((group) => group.group_id);
                store.setKnownGroups(knownGroupIds);
                const scenes = store.listScenes(groupId);
                const selection = store.getSelection(groupId);
                const outputs = engine.route(msg, { groups, scenes, selection });
                const routedCount = outputs.slice(0, -1).reduce(
                    (count, messages) => count + messages.filter(
                        (item) => item.topic !== "aiban-interrupt"
                    ).length,
                    0
                );
                const diagnosticCount = outputs[engine.diagnosticOutput].length;
                node.status({
                    fill: diagnosticCount > 0 ? "yellow" : "green",
                    shape: diagnosticCount > 0 ? "ring" : "dot",
                    text: diagnosticCount > 0
                        ? `${diagnosticCount} diagnostic(s)`
                        : `${routedCount} route(s)`,
                });
                send(outputs.map((messages) => messages.length > 0 ? messages : null));
                if (done) done();
            } catch (error) {
                const outputs = Array.from({ length: engine.outputCount }, () => null);
                outputs[engine.diagnosticOutput] = diagnostic(
                    error.code || ROUTING_DIAGNOSTICS.UNKNOWN_GROUP,
                    error.message,
                    {
                        groupId: Number(msg.payload?.group_id ?? msg.aiban?.group_id),
                    }
                );
                node.status({ fill: "red", shape: "ring", text: error.code || "routing error" });
                send(outputs);
                if (done) done();
            }
        });

        node.on("close", function onClose(done) {
            try {
                store.close();
                done();
            } catch (error) {
                done(error);
            }
        });

        node.status({
            fill: "grey",
            shape: "ring",
            text: `${engine.routes.length} fixed route(s)`,
        });
    }

    RED.nodes.registerType("aiban-scene-router", AibanSceneRouterNode);
};

module.exports.parseRoutes = parseRoutes;
module.exports.runtimeGroups = runtimeGroups;
