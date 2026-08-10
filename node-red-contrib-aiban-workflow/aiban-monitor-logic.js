"use strict";

const path = require("node:path");
const { MonitorRuntime } = require("./lib/monitor-runtime");
const { LogicStateStore } = require("./lib/logic-state-store");
const { attachTerminal } = require("./lib/logic-runtime-common");

module.exports = function registerMonitorLogic(RED) {
    function AibanMonitorLogicNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        let rules;
        try { rules = JSON.parse(config.rulesJson || "[]"); }
        catch (error) { node.error(`monitor rules JSON invalid: ${error.message}`); return; }
        const store = new LogicStateStore(path.join(
            RED.settings?.userDir || process.cwd(), "data", "workflow", "logic-state.db"
        ));
        const runtime = new MonitorRuntime({
            workflowId: config.workflowId,
            sceneId: config.sceneId,
            rules,
            logicType: `monitor:${node.id}`,
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
                    else diagnostic.push({ ...structuredClone(msg), workflow: {
                        ...(msg.workflow || {}), logic_event: event,
                    } });
                }
                send([terminal.length ? terminal : null, diagnostic.length ? diagnostic : null]);
                if (done) done();
            } catch (error) { node.error(error, msg); if (done) done(error); }
        });
        node.on("close", function onClose(removed, done) {
            const callback = typeof removed === "function" ? removed : done;
            store.close();
            if (callback) callback();
        });
    }
    RED.nodes.registerType("aiban-monitor-logic", AibanMonitorLogicNode);
};
