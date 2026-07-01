"""Optional ZeroMQ DEALER transport with application-level ACK handling."""

from __future__ import annotations

import json
import queue
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from .outbox import DurableOutbox
from .protocol import BEIJING_TZ, canonical_json, make_envelope, verify_message


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
        audit_callback: Optional[Callable[..., None]] = None,
        logger=None,
        on_message: Optional[Callable[..., None]] = None,
    ):
        self.endpoint = endpoint
        self.outbox = outbox
        self.identity = identity
        self.retry_seconds = max(0.1, float(retry_seconds))
        self.batch_size = max(1, int(batch_size))
        self.log_every = max(0, int(log_every))
        self.console_latency = bool(console_latency)
        self.audit_callback = audit_callback
        self.logger = logger
        self.on_message = on_message
        self._ack_count = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._send_queue: queue.SimpleQueue = queue.SimpleQueue()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        try:
            import zmq  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                "当前Python解释器未安装pyzmq，请执行: "
                "{} -m pip install pyzmq==26.4.0".format(__import__("sys").executable)
            ) from exc
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="frame-zmq-sender", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)

    def send_message(self, message: dict) -> None:
        """Enqueue an outbound control message (e.g. screenshot result).

        Thread-safe -- may be called from any thread.
        """
        self._send_queue.put(canonical_json(message).encode("utf-8"))

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
                    self._audit(
                        "transport_sent",
                        message_id=row["message_id"],
                        stream_id=row["stream_id"],
                        frame_seq=row["frame_seq"],
                        sent_at_ms=envelope["sent_at_ms"],
                        send_count=int(row["send_count"] or 0) + 1,
                    )

                # drain outgoing control messages (screenshot results, etc.)
                while True:
                    try:
                        data = self._send_queue.get_nowait()
                        socket.send(data)
                    except queue.Empty:
                        break

                events = dict(poller.poll(100))
                if socket in events:
                    try:
                        raw = socket.recv()
                        msg = json.loads(raw.decode("utf-8"))
                        if (
                            msg.get("type") == "ack"
                            and verify_message(msg)
                            and isinstance(msg.get("message_id"), str)
                        ):
                            details = self.outbox.acknowledge_details(msg["message_id"])
                            if details:
                                self._audit(
                                    "node_ack_received",
                                    **details,
                                    stream_id=msg.get("stream_id"),
                                    frame_seq=msg.get("frame_seq"),
                                    node_received_at=msg.get("node_received_at"),
                                    node_received_at_ms=msg.get("node_received_at_ms"),
                                    node_receive_diff_ms=msg.get("node_receive_diff_ms"),
                                    node_inbox_persist_ms=msg.get("node_inbox_persist_ms"),
                                    node_persisted_at=msg.get("persisted_at"),
                                )
                                self._ack_count += 1
                                if self.log_every and self._ack_count % self.log_every == 0:
                                    # 管道式延迟: Python处理 → 网络往返 → Node落盘 → 端到端总计
                                    delivery = details["delivery_ms"]
                                    ack_rtt = details.get("ack_rtt_ms") or 0.0
                                    node_persist = (
                                        float(msg.get("node_inbox_persist_ms", 0) or 0)
                                    )
                                    py_side = max(0, delivery - ack_rtt - node_persist)
                                    node_diff = msg.get("node_receive_diff_ms")
                                    resend = max(0, details["send_count"] - 1)
                                    seq = msg.get("frame_seq", "?")
                                    stream = msg.get("stream_id", "?")
                                    now_beijing = datetime.now(BEIJING_TZ).strftime(
                                        "%H:%M:%S"
                                    )

                                    chain = (
                                        "Py处理 {:>6.2f}ms → 网络往返 {:>6.2f}ms"
                                        " → Node落盘 {:>6.2f}ms".format(
                                            py_side, ack_rtt, node_persist
                                        )
                                    )
                                    extra = ""
                                    if node_diff is not None:
                                        extra += " | SDK→Node {:.2f}ms".format(
                                            float(node_diff)
                                        )
                                    if resend:
                                        extra += " | 重发 {}".format(resend)

                                    text = (
                                        "[ACK] #{:<5} {} │ {} │ 端到端 {:>6.2f}ms{} │ {}".format(
                                            seq,
                                            stream,
                                            chain,
                                            delivery,
                                            extra,
                                            now_beijing,
                                        )
                                    )
                                    if self.console_latency:
                                        print(text, flush=True)
                                    self._log("info", "%s", text)
                        elif self.on_message is not None:
                            # dispatch control messages (screenshot_request, etc.)
                            self.on_message(msg)
                    except Exception as exc:
                        self._log("warning", "invalid frame ACK: %s", exc)
        finally:
            socket.close(0)

    def _log(self, level: str, message: str, *args) -> None:
        if self.logger is not None:
            getattr(self.logger, level)(message, *args)

    def _audit(self, event: str, **fields) -> None:
        if self.audit_callback:
            try:
                self.audit_callback(event, **fields)
            except Exception as exc:
                self._log("warning", "frame transmission audit failed: %s", exc)
