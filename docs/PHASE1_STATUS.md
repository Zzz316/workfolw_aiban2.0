# Phase 1 Status - Reliable AiBan to Node-RED Frame Channel

Date: 2026-06-29

## Completed in the first implementation increment

- Standard frame identity, sequence, timestamp and model/box schema.
- Conversion of SDK metadata to pure Python values inside the callback lifetime.
- Exact-payload SHA-256 transport envelope.
- Python SQLite WAL durable outbox.
- ZeroMQ DEALER sender with ACK validation and retry.
- Non-blocking ingress deque and separate persistence worker.
- Backpressure controller that invokes `sourceControl` outside the SDK callback.
- Node-RED `aiban-frame-input` ROUTER node.
- Node.js SQLite WAL inbox with `message_id` deduplication.
- ACK only after inbox persistence.
- Restart/replay and duplicate-delivery tests.
- Real Python-to-Node ZeroMQ integration test.
- Environment switches for legacy shadow execution.

## Current test result

```text
Python unit/integration tests: 7 passed
Node.js tests:               3 passed
```

The integration test starts a real Node ZeroMQ ROUTER, sends a persisted frame
from the Python DEALER, stores it in the Node inbox, returns ACK and verifies
that the Python outbox transitions to acknowledged.

## Still required before Phase 1 is accepted

- Run with the real AiBan SDK and real metadata objects.
- Add frame-gap and latency metrics to an operations endpoint.
- Add disk free-space emergency threshold.
- Add sustained outage and multi-camera load tests.
- Add Node-RED runtime loading/deploy test.
- Add screenshot request/result correlation.
- Run the 24-hour stability test on target hardware.

## Business database

Business actions will use MySQL:

```text
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWD=root
MYSQL_DB=icamera_data
```

SQLite databases in this phase are internal transport journals only.
