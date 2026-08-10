"use strict";

const path = require("node:path");
const { TimerRecordRuntime } = require("./lib/timer-record-runtime");
const { LogicStateStore } = require("./lib/logic-state-store");
const { attachTerminal } = require("./lib/logic-runtime-common");

module.exports = function registerTimerRecord(RED) {
    function AibanTimerRecordNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        let absence;
        try { absence = JSON.parse(config.absenceJson || "null"); }
        catch (error) { node.error(`timer absence JSON invalid: ${error.message}`); return; }
        const store = new LogicStateStore(path.join(
            RED.settings?.userDir || process.cwd(), "data", "workflow", "logic-state.db"
        ));
        const runtime = new TimerRecordRuntime({
            workflowId: config.workflowId,
            sceneId: config.sceneId,
            startLabel: config.startLabel,
            endLabel: config.endLabel,
            maxDurationMs: Number(config.maxDurationMs),
            absence,
            resumeAfterRestart: config.resumeAfterRestart,
            logicType: `timer-record:${node.id}`,
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
                const outcomes = [];
                const stateEvents = [];
                for (const event of runtime.process(msg)) {
                    if (event.type === "terminal") outcomes.push(attachTerminal(msg, event));
                    else stateEvents.push({ ...structuredClone(msg), workflow: {
                        ...(msg.workflow || {}), logic_event: event,
                    } });
                }
                send([outcomes.length ? outcomes : null, stateEvents.length ? stateEvents : null]);
                if (done) done();
            } catch (error) { node.error(error, msg); if (done) done(error); }
        });
        node.on("close", function onClose(removed, done) {
            const callback = typeof removed === "function" ? removed : done;
            store.close();
            if (callback) callback();
        });
    }
    RED.nodes.registerType("aiban-timer-record", AibanTimerRecordNode);
};
