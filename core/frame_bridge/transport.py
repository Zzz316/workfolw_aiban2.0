"""Optional ZeroMQ DEALER transport with application-level ACK handling."""

from __future__ import annotations

import json
import threading
import time
from typing import Callable, Optional

from .outbox import DurableOutbox
from .protocol import canonical_json, make_envelope, verify_message


class ZmqDealerTransport:
    def __init__(
        self,
        endpoint: str,
        outbox: DurableOutbox,
        identity: str,
        retry_seconds: float = 1.0,
        batch_size: int = 100,
        logger=None,
    ):
        self.endpoint = endpoint
        self.outbox = outbox
        self.identity = identity
        self.retry_seconds = max(0.1, float(retry_seconds))
        self.batch_size = max(1, int(batch_size))
        self.logger = logger
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="frame-zmq-sender", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)

    def _run(self) -> None:
        try:
            import zmq
        except ImportError:
            self._log("error", "pyzmq is required when the frame bridge is enabled")
            return

        context = zmq.Context.instance()
        socket = context.socket(zmq.DEALER)
        socket.setsockopt(zmq.IDENTITY, self.identity.encode("utf-8"))
        socket.setsockopt(zmq.LINGER, 0)
        socket.connect(self.endpoint)
        poller = zmq.Poller()
        poller.register(socket, zmq.POLLIN)

        try:
            while not self._stop.is_set():
                for row in self.outbox.pending(self.batch_size, self.retry_seconds):
                    envelope = make_envelope(row["payload"])
                    socket.send(canonical_json(envelope).encode("utf-8"))
                    self.outbox.mark_sent(row["message_id"])

                events = dict(poller.poll(100))
                if socket in events:
                    try:
                        ack = json.loads(socket.recv().decode("utf-8"))
                        if (
                            ack.get("type") == "ack"
                            and verify_message(ack)
                            and isinstance(ack.get("message_id"), str)
                        ):
                            self.outbox.acknowledge(ack["message_id"])
                    except Exception as exc:
                        self._log("warning", "invalid frame ACK: %s", exc)
        finally:
            socket.close(0)

    def _log(self, level: str, message: str, *args) -> None:
        if self.logger is not None:
            getattr(self.logger, level)(message, *args)
