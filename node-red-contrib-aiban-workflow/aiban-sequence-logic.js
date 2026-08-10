"use strict";

const path = require("node:path");
const { AdvancedSequenceRuntime } = require("./lib/advanced-sequence-runtime");
const { LogicStateStore } = require("./lib/logic-state-store");
const { attachTerminal } = require("./lib/logic-runtime-common");

module.exports = function registerSequenceLogic(RED) {
    function AibanSequenceLogicNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        let steps;
        let loopMode;
        let presence;
        try {
            steps = JSON.parse(config.stepsJson || "[]");
            loopMode = JSON.parse(config.loopModeJson || "{}");
            presence = JSON.parse(config.presenceJson || "null");
        } catch (error) {
            node.error(`sequence config JSON invalid: ${error.message}`);
            return;
        }
        const statePath = path.join(
            RED.settings?.userDir || process.cwd(), "data", "workflow", "logic-state.db"
        );
        const store = new LogicStateStore(statePath);
        const runtime = new AdvancedSequenceRuntime({
            workflowId: config.workflowId,
            sceneId: config.sceneId,
            steps,
            loopMode,
            presence,
            cycleTimeoutMs: Number(config.cycleTimeoutMs) || 30000,
            completionEvent: config.completionEvent || "complete",
            alarmEachMissing: config.alarmEachMissing,
            saveDbEachMissing: config.saveDbEachMissing,
            logicType: `advanced-sequence:${node.id}`,
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
                const outputs = [[], []];
                for (const event of runtime.process(msg)) {
                    if (event.type === "terminal") outputs[0].push(attachTerminal(msg, event));
                    else outputs[1].push({
                        ...structuredClone(msg),
                        workflow: { ...(msg.workflow || {}), logic_event: event },
                    });
                }
                send(outputs.map(items => items.length === 0 ? null : items));
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
    RED.nodes.registerType("aiban-sequence-logic", AibanSequenceLogicNode);
};
