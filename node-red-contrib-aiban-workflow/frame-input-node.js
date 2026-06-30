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
        const showLatency = config.showLatency !== false;
        const logEvery = Math.max(1, Number(config.logEvery || 1));
        let receivedCount = 0;
        let latencyTotal = 0;

        function collectLabels(frame) {
            const labels = [];
            for (const [modelId, result] of Object.entries(frame.models || {})) {
                for (const box of (result && result.boxes) || []) {
                    labels.push({
                        model_id: String(modelId),
                        label: String(box.label || ""),
                        confidence: Number(box.confidence || 0),
                    });
                }
            }
            return labels;
        }

        function formatLabels(labels) {
            if (!labels.length) return "无标签";
            return labels.map((item) =>
                `m${item.model_id}:${item.label}(${item.confidence.toFixed(3)})`
            ).join(", ");
        }
        let inbox;
        let socket;
        let closed = false;

        function emitFrame(frame) {
            node.send({
                _msgid: frame.message_id,
                topic: frame.stream_id,
                payload: frame,
                aiban: {
                    message_id: frame.message_id,
                    session_id: frame.session_id,
                    stream_id: frame.stream_id,
                    frame_seq: frame.frame_seq,
                    timing: frame._timing || null,
                },
            });
            inbox.markEmitted(frame.message_id);
        }

        function emitPending() {
            for (const item of inbox.pending(1000)) emitFrame(item.frame);
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
                        const receivedAtMs = Date.now();
                        const persistStarted = process.hrtime.bigint();
                        const envelope = JSON.parse(body.toString("utf8"));
                        const unpacked = protocol.unpackEnvelope(envelope);
                        const frame = unpacked.frame;
                        if (frame.type !== "frame"
                            || frame.schema_version !== protocol.SCHEMA_VERSION) {
                            throw new Error("invalid frame protocol");
                        }
                        const receiveTotalMs = frame.bridge_created_at_ms
                            ? receivedAtMs - Number(frame.bridge_created_at_ms)
                            : null;
                        const wireMs = unpacked.sent_at_ms
                            ? receivedAtMs - unpacked.sent_at_ms
                            : null;
                        const inserted = inbox.persist(frame);
                        const inboxPersistMs = Number(
                            process.hrtime.bigint() - persistStarted
                        ) / 1e6;
                        frame._timing = {
                            sdk_convert_ms: Number(frame.sdk_convert_ms || 0),
                            python_to_node_ms: receiveTotalMs,
                            wire_ms: wireMs,
                            node_inbox_persist_ms: Number(inboxPersistMs.toFixed(3)),
                            node_received_at_ms: receivedAtMs,
                        };
                        frame.labels = collectLabels(frame);
                        frame.label_summary = formatLabels(frame.labels);
                        frame.node_received_at = new Date(receivedAtMs).toISOString();
                        frame.node_received_at_ms = receivedAtMs;
                        frame.receive_diff_ms = frame.sdk_received_at_ms
                            ? receivedAtMs - Number(frame.sdk_received_at_ms)
                            : null;
                        await socket.send([
                            identity,
                            Buffer.from(JSON.stringify(protocol.makeAck(frame)), "utf8"),
                        ]);
                        if (inserted) {
                            receivedCount += 1;
                            if (receiveTotalMs !== null) latencyTotal += receiveTotalMs;
                            emitFrame(frame);
                            if (showLatency && receivedCount % logEvery === 0) {
                                node.warn(
                                    `[Node-RED接收] 时间=${frame.node_received_at}`
                                    + ` group=${frame.group_id} source=${frame.source_id}`
                                    + ` frame=${frame.frame_seq}`
                                    + ` 标签=[${frame.label_summary}]`
                                    + ` 与SDK接收时间差=${frame.receive_diff_ms}ms`
                                    + ` SDK转换=${frame._timing.sdk_convert_ms}ms`
                                    + ` Python→Node=${receiveTotalMs}ms`
                                    + ` 线上=${wireMs}ms`
                                    + ` Inbox落盘=${frame._timing.node_inbox_persist_ms}ms`
                                );
                            }
                        }
                        const counts = inbox.counts();
                        const average = receivedCount
                            ? (latencyTotal / receivedCount).toFixed(1)
                            : "0.0";
                        node.status({
                            fill: counts.pending ? "yellow" : "green",
                            shape: "dot",
                            text: `本帧 ${receiveTotalMs ?? "-"}ms / 平均 ${average}ms`,
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
