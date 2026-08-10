"use strict";

const crypto = require("node:crypto");

function getPathValue(source, path) {
    if (!path) return undefined;
    return String(path).split(".").reduce((current, key) => (
        current && Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined
    ), source);
}

function sha256(value) {
    return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

module.exports = function registerAibanApiTrigger(RED) {
    function AibanApiTriggerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const route = String(config.path || `/aiban/api-trigger/${node.id}`).trim();
        const method = String(config.method || "post").toLowerCase();
        const fullPath = route.startsWith("/") ? route : `/${route}`;

        function handler(req, res) {
            try {
                if (config.authType === "bearer") {
                    const header = req.get(config.authHeader || "authorization") || "";
                    const token = header.replace(/^Bearer\s+/i, "");
                    const expected = config.tokenSha256 || sha256(node.credentials?.authToken || "");
                    if (!expected || sha256(token) !== expected) {
                        res.status(401).json({ status: "401", errmsg: "unauthorized" });
                        return;
                    }
                }
                const body = req.body || {};
                const sourceFromPath = getPathValue({ body, headers: req.headers, query: req.query }, config.sourceIdPath);
                const targetFromPath = getPathValue({ body, headers: req.headers, query: req.query }, config.targetStepIdPath);
                const event = {
                    workflow_id: config.workflowId,
                    scene_id: config.sceneId,
                    external_event: String(targetFromPath || config.targetStepId || config.triggerId || node.id),
                    external_payload: body,
                    ttl_ms: Math.max(1, Number(config.ttlSeconds || 5) * 1000),
                };
                node.send({
                    topic: "aiban-api-trigger",
                    payload: {
                        group_id: Number(config.groupId || body.group_id || 0),
                        source_id: Number(sourceFromPath ?? config.sourceId ?? body.source_id ?? body.sourceid ?? 0),
                    },
                    aiban: {
                        session_id: String(body.session_id || `api-${Date.now()}`),
                        event_seq: Number(body.event_seq || Date.now()),
                    },
                    workflow: {
                        workflow_id: config.workflowId,
                        scene_id: config.sceneId,
                        external_event: event.external_event,
                        external_payload: body,
                    },
                });
                res.status(Number(config.responseStatus || 200)).json({
                    status: "200",
                    errmsg: "",
                    event,
                });
            } catch (error) {
                node.error(error);
                res.status(500).json({ status: "500", errmsg: error.message });
            }
        }

        const router = RED.httpNode;
        if (router && typeof router[method] === "function") router[method](fullPath, handler);
        else node.warn(`HTTP method not available: ${method}`);

        node.on("input", function onInput(msg, send, done) {
            const output = {
                ...msg,
                workflow: {
                    ...(msg.workflow || {}),
                    workflow_id: config.workflowId,
                    scene_id: config.sceneId,
                    external_event: msg.workflow?.external_event || msg.external_event || config.targetStepId || node.id,
                },
            };
            send(output);
            if (done) done();
        });
    }
    RED.nodes.registerType("aiban-api-trigger", AibanApiTriggerNode, {
        credentials: { authToken: { type: "password" } },
    });
};
