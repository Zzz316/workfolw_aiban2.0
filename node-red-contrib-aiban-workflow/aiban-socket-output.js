"use strict";

const net = require("node:net");

function findSpeakEffect(msg) {
    const effects = msg?.workflow?.outcome?.effects || msg?.workflow?.result?.effects || [];
    return effects.find(effect => effect && (effect.type === "speaker" || effect.type === "socket" || effect.speak !== undefined));
}

function sendTcp({ host, port, payload, encoding = "utf8", timeoutMs = 3000 }) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port: Number(port) });
        const timer = setTimeout(() => socket.destroy(new Error("socket output timeout")), timeoutMs);
        socket.on("connect", () => {
            if (encoding === "hex") socket.write(Buffer.from(String(payload).replace(/\s+/g, ""), "hex"));
            else socket.write(String(payload), encoding);
            socket.end();
        });
        socket.on("error", reject);
        socket.on("close", hadError => {
            clearTimeout(timer);
            if (!hadError) resolve({ status: "sent", host, port });
        });
    });
}

module.exports = function registerAibanSocketOutput(RED) {
    function AibanSocketOutputNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.on("input", async function onInput(msg, send, done) {
            try {
                const effect = findSpeakEffect(msg);
                const speak = effect?.speak ?? effect?.command ?? msg.speak;
                const payload = speak === 0 || speak === "off" ? config.speakOffPayload : config.speakOnPayload;
                if (!payload) {
                    msg.socket_output = { status: "ignored", reason: "no_payload" };
                    send(msg);
                    if (done) done();
                    return;
                }
                msg.socket_output = await sendTcp({
                    host: effect?.host || config.host,
                    port: effect?.port || config.port,
                    payload,
                    encoding: config.encoding || "utf8",
                    timeoutMs: Number(config.timeoutMs) || 3000,
                });
                send(msg);
                if (done) done();
            } catch (error) {
                node.error(error, msg);
                if (done) done(error);
            }
        });
    }
    RED.nodes.registerType("aiban-socket-output", AibanSocketOutputNode);
};
