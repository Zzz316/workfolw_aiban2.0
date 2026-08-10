"use strict";

const path = require("node:path");
const { SideEffectLedger } = require("./lib/side-effect-ledger");
const { IdempotentHttpOutput } = require("./lib/idempotent-http-output");

module.exports = function registerApiOutput(RED) {
    function AibanApiOutputNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const userDir = RED.settings?.userDir || process.cwd();
        const ledger = new SideEffectLedger(path.join(userDir, "data", "workflow", "side-effects.db"));
        const output = new IdempotentHttpOutput({
            url: config.url,
            channel: config.channel || `api:${node.id}`,
            ledger,
            timeoutMs: config.timeoutMs,
            maxAttempts: config.maxAttempts,
            retryDelayMs: config.retryDelayMs,
        });

        node.on("input", async function onInput(msg, send, done) {
            try {
                msg.side_effect = await output.deliver(msg);
                node.status({
                    fill: msg.side_effect.status === "delivered" ? "green" : "yellow",
                    shape: "dot",
                    text: msg.side_effect.status,
                });
                send(msg);
                if (done) done();
            } catch (error) {
                node.error(error, msg);
                if (done) done(error);
            }
        });
        node.on("close", function onClose(done) {
            ledger.close();
            done();
        });
    }

    RED.nodes.registerType("aiban-api-output", AibanApiOutputNode, {
        credentials: {},
    });
};
