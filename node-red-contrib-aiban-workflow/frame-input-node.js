"use strict";

const path = require("node:path");
const { FrameInbox } = require("./lib/frame-inbox");
const protocol = require("./lib/frame-protocol");

module.exports = function registerFrameInputNode(RED) {
    function AibanFrameInputNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const endpoint = config.endpoint || "tcp://127.0.0.1:5557";
        const configuredPath = config.inboxPath || "data/frame_bridge/inbox.db";
        const inboxPath = path.isAbsolute(configuredPath)
            ? configuredPath
            : path.join(RED.settings.userDir, configuredPath);
        let inbox;
        let socket;
        let closed = false;

        function emitPending() {
            for (const item of inbox.pending(1000)) {
                node.send({
                    _msgid: item.message_id,
                    topic: item.frame.stream_id,
                    payload: item.frame,
                    aiban: {
                        message_id: item.message_id,
                        session_id: item.frame.session_id,
                        stream_id: item.frame.stream_id,
                        frame_seq: item.frame.frame_seq,
                    },
                });
                inbox.markEmitted(item.message_id);
            }
        }

        async function run() {
            try {
                const zmq = require("zeromq");
                inbox = new FrameInbox(inboxPath);
                socket = new zmq.Router();
                socket.linger = 0;
                await socket.bind(endpoint);
                node.status({ fill: "green", shape: "dot", text: `listening ${endpoint}` });
                emitPending();

                for await (const parts of socket) {
                    if (closed) break;
                    const identity = parts[0];
                    const body = parts[parts.length - 1];
                    try {
                        const envelope = JSON.parse(body.toString("utf8"));
                        const frame = protocol.unpackEnvelope(envelope);
                        if (frame.type !== "frame"
                            || frame.schema_version !== protocol.SCHEMA_VERSION) {
                            throw new Error("invalid frame protocol");
                        }
                        const inserted = inbox.persist(frame);
                        await socket.send([
                            identity,
                            Buffer.from(JSON.stringify(protocol.makeAck(frame)), "utf8"),
                        ]);
                        if (inserted) emitPending();
                        const counts = inbox.counts();
                        node.status({
                            fill: counts.pending ? "yellow" : "green",
                            shape: "dot",
                            text: `frames ${counts.total}, pending ${counts.pending}`,
                        });
                    } catch (error) {
                        node.warn(`frame rejected: ${error.message}`);
                    }
                }
            } catch (error) {
                node.status({ fill: "red", shape: "ring", text: error.message });
                node.error(`aiban-frame-input failed: ${error.stack || error.message}`);
            }
        }

        node.on("close", function onClose(done) {
            closed = true;
            try {
                if (socket) socket.close();
                if (inbox) inbox.close();
                done();
            } catch (error) {
                done(error);
            }
        });
        run();
    }

    RED.nodes.registerType("aiban-frame-input", AibanFrameInputNode);
};
