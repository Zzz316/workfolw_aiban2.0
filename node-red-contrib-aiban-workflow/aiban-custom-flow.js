"use strict";

const path = require("node:path");
const { CustomFlowRuntime } = require("./lib/custom-flow-runtime");
const { LogicStateStore } = require("./lib/logic-state-store");
const { attachTerminal } = require("./lib/logic-runtime-common");

module.exports = function registerCustomFlow(RED) {
    function AibanCustomFlowNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        let vars;
        let timers;
        let states;
        try {
            vars = JSON.parse(config.varsJson || "{}");
            timers = JSON.parse(config.timersJson || "{}");
            states = JSON.parse(config.statesJson || "[]");
        } catch (error) {
            node.error(`custom flow JSON invalid: ${error.message}`);
            return;
        }
        const store = new LogicStateStore(path.join(
            RED.settings?.userDir || process.cwd(), "data", "workflow", "logic-state.db"
        ));
        const runtime = new CustomFlowRuntime({
            workflowId: config.workflowId,
            sceneId: config.sceneId,
            initialState: config.initialState,
            vars,
            timers,
            states,
            cycleTimeoutMs: Number(config.cycleTimeoutMs) || 30000,
            resumeAfterRestart: Boolean(config.resumeAfterRestart),
            logicType: `custom-flow:${node.id}`,
            stateStore: store,
        });

        setImmediate(() => {
            for (const event of runtime.recover()) node.send([attachTerminal({}, event), null]);
        });

        node.on("input", function onInput(msg, send, done) {
            try {
                if (msg.workflow?.scene_id && msg.workflow.scene_id !== config.sceneId) {
                    throw new Error(`scene mismatch: ${msg.workflow.scene_id} != ${config.sceneId}`);
                }
                const terminal = [];
                const diagnostic = [];
                for (const event of runtime.process(msg)) {
                    if (event.type === "terminal") terminal.push(attachTerminal(msg, event));
                    else diagnostic.push({
                        ...structuredClone(msg),
                        workflow: { ...(msg.workflow || {}), logic_event: event },
                    });
                }
                send([terminal.length ? terminal : null, diagnostic.length ? diagnostic : null]);
                if (done) done();
            } catch (error) {
                node.error(error, msg);
                if (done) done(error);
            }
        });

        node.on("close", function onClose(removed, done) {
            const callback = typeof removed === "function" ? removed : done;
            store.close();
            if (callback) callback();
        });
    }
    RED.nodes.registerType("aiban-custom-flow", AibanCustomFlowNode);
};
