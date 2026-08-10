"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { SceneRegistryStore, SceneRegistryError } = require("./lib/scene-registry-store");
const { runtimeGroups } = require("./aiban-scene-router");

module.exports = function registerSceneControlNode(RED) {
    function AibanSceneControlNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.type = "aiban-scene-control";
        node.runtimeNodeId = config.runtimeNodeId || "";
        const configuredAction = config.action || "";
        const databasePath = path.join(
            RED.settings.userDir || ".",
            "data",
            "scene",
            "scene-registry.sqlite"
        );

        node.on("input", function onInput(msg, send, done) {
            let store = null;
            try {
                const input = msg.payload && typeof msg.payload === "object"
                    ? msg.payload
                    : {};
                const action = input.action || configuredAction;
                const groupId = input.group_id;
                const sceneId = input.scene_id;
                const runtimeNode = RED.nodes.getNode(node.runtimeNodeId);
                const groups = runtimeGroups(runtimeNode);
                const knownGroupIds = groups.map((group) => group.group_id);
                const context = {
                    knownGroupIds,
                    operator: input.operator || msg.aiban?.operator || `node-red:${node.id}`,
                    requestId: input.request_id || msg._msgid || randomUUID(),
                };
                store = new SceneRegistryStore({
                    dbPath: databasePath,
                    knownGroupIds,
                });

                let data;
                if (action === "enable" || action === "disable") {
                    data = store.setEnabled(
                        groupId,
                        sceneId,
                        action === "enable",
                        input.revision,
                        context
                    );
                } else if (action === "select") {
                    data = store.selectExclusive(
                        groupId,
                        sceneId,
                        input.selection_revision,
                        context
                    );
                } else if (action === "status") {
                    data = {
                        scenes: store.listScenes(groupId),
                        selection: store.getSelection(groupId),
                    };
                } else {
                    throw new SceneRegistryError(
                        "INVALID_SCENE",
                        `Unsupported scene control action: ${action || "(empty)"}`
                    );
                }

                const result = {
                    ...msg,
                    topic: "aiban-scene-control",
                    payload: {
                        success: true,
                        action,
                        request_id: context.requestId,
                        data,
                    },
                };
                send([result, null]);
                node.status({ fill: "green", shape: "dot", text: `${action} OK` });
                if (done) done();
            } catch (error) {
                const failure = {
                    ...msg,
                    topic: "aiban-scene-control-error",
                    payload: {
                        success: false,
                        error_code: error.code || "SCENE_CONTROL_ERROR",
                        message: error.message,
                        details: error.details || null,
                    },
                };
                send([null, failure]);
                node.status({ fill: "red", shape: "ring", text: failure.payload.error_code });
                if (done) done();
            } finally {
                if (store) {
                    store.close();
                }
            }
        });
    }

    RED.nodes.registerType("aiban-scene-control", AibanSceneControlNode);
};
