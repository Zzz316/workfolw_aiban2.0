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
        log_every: int = 1,
        console_latency: bool = False,
        logger=None,
    ):
        self.endpoint = endpoint
        self.outbox = outbox
        self.identity = identity
        self.retry_seconds = max(0.1, float(retry_seconds))
        self.batch_size = max(1, int(batch_size))
        self.log_every = max(0, int(log_every))
        self.console_latency = bool(console_latency)
        self.logger = logger
        self._ack_count = 0
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
                            details = self.outbox.acknowledge_details(ack["message_id"])
                            if details:
                                self._ack_count += 1
                                if self.log_every and self._ack_count % self.log_every == 0:
                                    text = (
                                        "[FrameBridge延迟] message={} ACK往返={:.3f}ms "
                                        "总投递={:.3f}ms 重发次数={}"
                                    ).format(
                                        details["message_id"],
                                        details["ack_rtt_ms"] or 0.0,
                                        details["delivery_ms"],
                                        max(0, details["send_count"] - 1),
                                    )
                                    if self.console_latency:
                                        print(text, flush=True)
                                    self._log(
                                        "info",
                                        "%s",
                                        text,
                                    )
                    except Exception as exc:
                        self._log("warning", "invalid frame ACK: %s", exc)
        finally:
            socket.close(0)

    def _log(self, level: str, message: str, *args) -> None:
        if self.logger is not None:
            getattr(self.logger, level)(message, *args)
