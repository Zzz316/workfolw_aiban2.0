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
    assert.deepEqual(protocol.unpackEnvelope(envelope).frame, frame());
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
    const value = frame();
    value.node_received_at = "2026-06-30T02:00:00.123Z";
    value.node_received_at_ms = 1782784800123;
    value.receive_diff_ms = 5;
    value._timing = { node_inbox_persist_ms: 0.75 };
    const ack = protocol.makeAck(value);
    assert.equal(protocol.verify(ack), true);
    assert.equal(ack.node_receive_diff_ms, 5);
    assert.equal(ack.node_inbox_persist_ms, 0.75);
});

test("screenshot request and responses use verified control messages", () => {
    const request = protocol.makeScreenshotRequest(2, 3, true, "request-1");
    assert.equal(protocol.verify(request), true);
    assert.equal(request.type, "screenshot_request");
    assert.equal(request.group_id, 2);
    assert.equal(request.source_id, 3);
    assert.equal(request.save_roi, true);

    const result = protocol.finalize({
        type: "screenshot_result",
        schema_version: 1,
        request_id: "request-1",
        group_id: 2,
        source_id: 3,
        success: true,
    });
    assert.equal(protocol.isScreenshotResponse(result), true);
    result.success = false;
    assert.equal(protocol.isScreenshotResponse(result), false);
});
