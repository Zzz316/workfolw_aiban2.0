# AiBan Workflow 2.0 Frame Protocol

## Transport

- Python uses a ZeroMQ `DEALER`.
- Node-RED `aiban-frame-input` uses a ZeroMQ `ROUTER`.
- Default endpoint: `tcp://127.0.0.1:5557`.
- Delivery semantics: at least once on the wire, exactly once into the Node-RED
  input node through the inbox `message_id` unique key.

## Persistence

- Python writes every normalized frame to a SQLite WAL outbox.
- Node-RED writes every received frame to a SQLite WAL inbox.
- Node-RED sends ACK only after the inbox transaction succeeds.
- Python retains and retries frames until a valid ACK is received.
- Business records continue to use MySQL `icamera_data`; SQLite is transport
  infrastructure only.

Current business MySQL defaults:

```text
host=127.0.0.1
port=3306
user=root
password=root
database=icamera_data
```

Production deployment should inject these values through environment variables
instead of embedding credentials in Node-RED flows.

## Envelope

The transport message wraps the exact serialized frame text:

```json
{
  "type": "frame_envelope",
  "schema_version": 1,
  "payload": "{\"type\":\"frame\", ...}",
  "checksum": "sha256 of exact UTF-8 payload bytes"
}
```

Using the exact payload bytes avoids cross-language floating-point JSON
canonicalization differences.

## Frame identity

```text
session_id:stream_id:frame_seq
```

- `session_id` changes when the Python pipeline process starts.
- `stream_id` is `group-{group_id}/source-{source_id}`.
- `frame_seq` starts at 1 and increments independently per stream.

## ACK

ACK contains the same `message_id`, `session_id`, `stream_id`, and `frame_seq`.
Invalid or mismatched ACK messages do not remove frames from the outbox.

## Backpressure

The SDK callback converts metadata to pure Python data and appends it to an
in-memory ingress deque. A writer thread persists it to SQLite. At the high
watermark Python pauses the affected source with `sourceControl(..., False)`.
After the queue falls to the low watermark it resumes paused sources.

The bridge never uses a ZeroMQ HWM overflow policy as a data-loss mechanism.

## Runtime switches

See `config/frame_bridge.env.example`.

- `AIBAN_V2_BRIDGE_ENABLED=1` enables frame delivery.
- `AIBAN_V1_ENGINE_ENABLED=1` keeps the legacy engine running for shadow
  comparison.

## Screenshot control channel

The `aiban-frame-input` node also acts as the bidirectional control endpoint:

- Send `msg.payload = {group_id, source_id, save_roi?, request_id?}` into the
  node to request a screenshot.
- Output 1 emits persisted video frames.
- Output 2 emits verified `screenshot_result` or `screenshot_timeout` messages.
- Every control message uses the same schema version and canonical SHA-256
  checksum rules as ACK messages. Invalid or modified control messages are
  rejected.
- Requests time out even when the selected source produces no subsequent
  frame.
