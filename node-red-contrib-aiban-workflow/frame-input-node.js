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

        /** 返回当前北京时间的 ISO 8601 字符串 (UTC+8) */
        function beijingNowISO(tsMs) {
            const d = tsMs ? new Date(tsMs) : new Date();
            // 转为北京时间 (UTC+8)
            const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
            const Y = beijing.getUTCFullYear();
            const M = String(beijing.getUTCMonth() + 1).padStart(2, "0");
            const D = String(beijing.getUTCDate()).padStart(2, "0");
            const h = String(beijing.getUTCHours()).padStart(2, "0");
            const m = String(beijing.getUTCMinutes()).padStart(2, "0");
            const s = String(beijing.getUTCSeconds()).padStart(2, "0");
            const ms = String(beijing.getUTCMilliseconds()).padStart(3, "0");
            return `${Y}-${M}-${D}T${h}:${m}:${s}.${ms}+08:00`;
        }

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
        let bridgeIdentity = null;

        function emitFrame(frame) {
            node.send([{
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
            }, null]);
            inbox.markEmitted(frame.message_id);
        }

        function emitScreenshot(message) {
            node.send([null, {
                _msgid: message.request_id,
                topic: message.type,
                payload: message,
                aiban: {
                    request_id: message.request_id,
                    group_id: message.group_id,
                    source_id: message.source_id,
                },
            }]);
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
                    bridgeIdentity = identity;
                    const body = parts[parts.length - 1];
                    try {
                        const receivedAtMs = Date.now();
                        const persistStarted = process.hrtime.bigint();
                        const envelope = JSON.parse(body.toString("utf8"));
                        if (envelope.type !== "frame_envelope") {
                            if (!protocol.isScreenshotResponse(envelope)) {
                                throw new Error("invalid control message");
                            }
                            emitScreenshot(envelope);
                            continue;
                        }
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
                        frame.node_received_at = beijingNowISO(receivedAtMs);
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
                                // 管道式延迟: SDK转换 → Python→Node(含网络) → Node落盘 = 总计
                                const sdkConvert = frame._timing.sdk_convert_ms.toFixed(2);
                                const pyToNode = receiveTotalMs?.toFixed(2) ?? "-";
                                const wire = (wireMs !== null && wireMs !== undefined)
                                    ? wireMs.toFixed(2) : "-";
                                const nodePersist = frame._timing.node_inbox_persist_ms.toFixed(2);
                                const totalDiff = frame.receive_diff_ms?.toFixed(2) ?? "-";
                                const time = frame.node_received_at.slice(11, 19); // 只取 HH:MM:SS
                                node.warn(
                                    `[Node] #${String(frame.frame_seq).padEnd(5)}`
                                    + ` g${frame.group_id}/s${frame.source_id} │`
                                    + ` SDK ${sdkConvert.padStart(6)}ms →`
                                    + ` Py→Node ${pyToNode.padStart(6)}ms`
                                    + ` (网络 ${wire.padStart(5)}ms) →`
                                    + ` 落盘 ${nodePersist.padStart(6)}ms │`
                                    + ` ∑ ${totalDiff.padStart(6)}ms │`
                                    + ` ${frame.label_summary || "-"} │`
                                    + ` ${time}`
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

        node.on("input", function onInput(msg, send, done) {
            try {
                if (!socket || !bridgeIdentity) {
                    throw new Error("AiBan bridge 尚未连接，暂时无法发送截图请求");
                }
                const payload = msg.payload || msg;
                const groupId = Number(payload.group_id ?? payload.groupId);
                const sourceId = Number(payload.source_id ?? payload.sourceId);
                if (!Number.isInteger(groupId) || !Number.isInteger(sourceId)) {
                    throw new Error("截图请求必须包含整数 group_id 和 source_id");
                }
                const request = protocol.makeScreenshotRequest(
                    groupId,
                    sourceId,
                    Boolean(payload.save_roi ?? payload.saveRoi),
                    typeof payload.request_id === "string" ? payload.request_id : ""
                );
                socket.send([
                    bridgeIdentity,
                    Buffer.from(JSON.stringify(request), "utf8"),
                ]).then(() => {
                    node.status({
                        fill: "blue",
                        shape: "dot",
                        text: `截图请求 ${request.request_id}`,
                    });
                    if (done) done();
                }).catch((error) => {
                    if (done) done(error);
                    else node.error(error, msg);
                });
            } catch (error) {
                if (done) done(error);
                else node.error(error, msg);
            }
        });

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
