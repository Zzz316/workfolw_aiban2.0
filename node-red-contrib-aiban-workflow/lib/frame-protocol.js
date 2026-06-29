"use strict";

const crypto = require("node:crypto");
const SCHEMA_VERSION = 1;

function canonicalize(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonicalize(value[key])}`
        ).join(",")}}`;
    }
    return JSON.stringify(value);
}

function checksum(message) {
    const copy = { ...message };
    delete copy.checksum;
    return crypto.createHash("sha256").update(canonicalize(copy), "utf8").digest("hex");
}

function verify(message) {
    return Boolean(message && typeof message === "object"
        && typeof message.checksum === "string"
        && message.checksum === checksum(message));
}

function finalize(message) {
    const result = { ...message };
    delete result.checksum;
    result.checksum = checksum(result);
    return result;
}

function makeAck(frame) {
    return finalize({
        type: "ack",
        schema_version: SCHEMA_VERSION,
        message_id: frame.message_id,
        session_id: frame.session_id,
        stream_id: frame.stream_id,
        frame_seq: frame.frame_seq,
        persisted_at: new Date().toISOString(),
    });
}

function unpackEnvelope(envelope) {
    if (!envelope || envelope.type !== "frame_envelope"
        || envelope.schema_version !== SCHEMA_VERSION
        || typeof envelope.payload !== "string"
        || typeof envelope.checksum !== "string") {
        throw new Error("invalid frame envelope");
    }
    const actual = crypto.createHash("sha256").update(envelope.payload, "utf8").digest("hex");
    if (actual !== envelope.checksum) throw new Error("invalid frame envelope checksum");
    return JSON.parse(envelope.payload);
}

module.exports = {
    SCHEMA_VERSION, canonicalize, checksum, finalize, makeAck, unpackEnvelope, verify
};
