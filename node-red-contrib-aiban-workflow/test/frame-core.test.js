"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const protocol = require("../lib/frame-protocol");
const { FrameInbox } = require("../lib/frame-inbox");

function frame(sequence = 1) {
    return {
        type: "frame",
        schema_version: 1,
        session_id: "session",
        stream_id: "group-1/source-1",
        frame_seq: sequence,
        message_id: `session:group-1/source-1:${sequence}`,
        models: { "1": { ok: true, boxes: [] } },
    };
}

test("frame envelope validates exact payload", () => {
    const payload = JSON.stringify(frame());
    const crypto = require("node:crypto");
    const envelope = {
        type: "frame_envelope",
        schema_version: 1,
        payload,
        checksum: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
    };
    assert.deepEqual(protocol.unpackEnvelope(envelope), frame());
    envelope.payload += " ";
    assert.throws(() => protocol.unpackEnvelope(envelope), /checksum/);
});

test("inbox persists once and preserves pending frames after restart", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aiban-inbox-"));
    const filename = path.join(directory, "inbox.db");
    const inbox = new FrameInbox(filename);
    assert.equal(inbox.persist(frame()), true);
    assert.equal(inbox.persist(frame()), false);
    assert.deepEqual(inbox.counts(), { total: 1, pending: 1 });
    inbox.close();

    const reopened = new FrameInbox(filename);
    assert.equal(reopened.pending()[0].message_id, frame().message_id);
    assert.equal(reopened.markEmitted(frame().message_id), true);
    assert.deepEqual(reopened.counts(), { total: 1, pending: 0 });
    reopened.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

test("ack includes a valid checksum", () => {
    assert.equal(protocol.verify(protocol.makeAck(frame())), true);
});
