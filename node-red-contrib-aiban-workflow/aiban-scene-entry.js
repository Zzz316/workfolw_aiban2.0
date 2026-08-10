"use strict";

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

module.exports = function registerSceneEntryNode(RED) {
    function AibanSceneEntryNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.type = "aiban-scene-entry";
        node.runtimeNodeId = config.runtimeNodeId || "";
        const groupId = Number(config.group_id);
        const sceneId = clean(config.scene_id);
        const workflowId = clean(config.workflow_id);

        node.on("input", function onInput(msg, send, done) {
            const actualGroupId = Number(msg.aiban?.group_id ?? msg.payload?.group_id);
            const actualSceneId = clean(msg.aiban?.scene_id || msg.payload?.scene_id);
            const actualWorkflowId = clean(
                msg.aiban?.workflow_id
                || msg.workflow?.workflow_id
                || msg.payload?.workflow_id
            );
            const problems = [];
            if (!Number.isInteger(groupId) || groupId < 0 || actualGroupId !== groupId) {
                problems.push(`group_id expected ${groupId}, received ${actualGroupId}`);
            }
            if (!sceneId || actualSceneId !== sceneId) {
                problems.push(`scene_id expected ${sceneId}, received ${actualSceneId}`);
            }
            if (!workflowId || actualWorkflowId !== workflowId) {
                problems.push(`workflow_id expected ${workflowId}, received ${actualWorkflowId}`);
            }

            if (problems.length > 0) {
                const rejected = {
                    ...msg,
                    topic: "aiban-scene-entry-diagnostic",
                    payload: {
                        ...(msg.payload || {}),
                        diagnostic_code: "SCENE_IDENTITY_MISMATCH",
                        diagnostic_message: problems.join("; "),
                    },
                };
                send([null, rejected]);
                node.status({ fill: "red", shape: "ring", text: "identity mismatch" });
                if (done) done();
                return;
            }

            msg.aiban = {
                ...(msg.aiban || {}),
                group_id: groupId,
                scene_id: sceneId,
                workflow_id: workflowId,
            };
            msg.workflow = {
                ...(msg.workflow || {}),
                group_id: groupId,
                scene_id: sceneId,
                workflow_id: workflowId,
            };
            send([msg, null]);
            node.status({
                fill: msg.topic === "aiban-interrupt" ? "yellow" : "green",
                shape: "dot",
                text: msg.topic === "aiban-interrupt" ? "INTERRUPTED" : `${groupId}/${sceneId}`,
            });
            if (done) done();
        });
    }

    RED.nodes.registerType("aiban-scene-entry", AibanSceneEntryNode);
};
