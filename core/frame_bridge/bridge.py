"""High-level bridge that keeps SDK callbacks non-blocking."""

from __future__ import annotations

import os
import threading
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, Dict, Optional, Tuple

from .adapter import FrameAdapter
from .outbox import DurableOutbox
from .transport import ZmqDealerTransport


@dataclass
class FrameBridgeConfig:
    enabled: bool = False
    endpoint: str = "tcp://127.0.0.1:5557"
    outbox_path: str = "data/frame_bridge/outbox.db"
    high_watermark: int = 5000
    low_watermark: int = 1000
    retry_seconds: float = 1.0
    batch_size: int = 100
    log_every: int = 1
    console_latency: bool = True

    @classmethod
    def from_env(cls, project_root: str) -> "FrameBridgeConfig":
        raw_path = os.getenv("AIBAN_FRAME_OUTBOX", "data/frame_bridge/outbox.db")
        path = raw_path if os.path.isabs(raw_path) else os.path.join(project_root, raw_path)
        return cls(
            enabled=os.getenv("AIBAN_V2_BRIDGE_ENABLED", "0").strip().lower()
            in {"1", "true", "yes", "on"},
            endpoint=os.getenv("AIBAN_FRAME_ENDPOINT", "tcp://127.0.0.1:5557"),
            outbox_path=path,
            high_watermark=int(os.getenv("AIBAN_FRAME_HIGH_WATERMARK", "5000")),
            low_watermark=int(os.getenv("AIBAN_FRAME_LOW_WATERMARK", "1000")),
            retry_seconds=float(os.getenv("AIBAN_FRAME_RETRY_SECONDS", "1.0")),
            batch_size=int(os.getenv("AIBAN_FRAME_BATCH_SIZE", "100")),
            log_every=int(os.getenv("AIBAN_FRAME_LOG_EVERY", "1")),
            console_latency=os.getenv(
                "AIBAN_FRAME_CONSOLE_LATENCY", "1"
            ).strip().lower() in {"1", "true", "yes", "on"},
        )


class FrameBridge:
    def __init__(
        self,
        config: FrameBridgeConfig,
        source_control: Optional[Callable[[int, int, bool], bool]] = None,
        logger=None,
    ):
        self.config = config
        self.source_control = source_control
        self.logger = logger
        self.adapter = FrameAdapter()
        self.outbox = DurableOutbox(config.outbox_path)
        self.transport = ZmqDealerTransport(
            config.endpoint,
            self.outbox,
            identity="aiban-{}".format(self.adapter.session_id),
            retry_seconds=config.retry_seconds,
            batch_size=config.batch_size,
            log_every=config.log_every,
            console_latency=config.console_latency,
            logger=logger,
        )
        self._queue: Deque[Tuple[Dict, int, int]] = deque()
        self._condition = threading.Condition()
        self._stop = False
        self._paused = set()
        self._pause_requests = set()
        self._active_sources = set()
        self._writer = threading.Thread(target=self._writer_loop, name="frame-outbox-writer", daemon=True)
        self._controller = threading.Thread(
            target=self._control_loop, name="frame-backpressure-controller", daemon=True
        )

    def start(self) -> None:
        self._writer.start()
        self._controller.start()
        self.transport.start()

    def submit_metadata(self, group_id: int, source_id: int, metadata) -> Dict:
        message = self.adapter.from_metadata(group_id, source_id, metadata)
        key = (int(group_id), int(source_id))
        with self._condition:
            self._active_sources.add(key)
            self._queue.append((message, key[0], key[1]))
            depth = len(self._queue)
            if depth >= self.config.high_watermark:
                self._pause_requests.add(key)
            self._condition.notify()
        return message

    def stats(self) -> Dict:
        with self._condition:
            ingress = len(self._queue)
        return {
            "session_id": self.adapter.session_id,
            "ingress_pending": ingress,
            "paused_sources": sorted("{}/{}".format(g, s) for g, s in self._paused),
            "outbox": self.outbox.counts(),
        }

    def stop(self, timeout: float = 5.0) -> None:
        with self._condition:
            self._stop = True
            self._condition.notify_all()
        self._writer.join(timeout)
        self._controller.join(timeout)
        self.transport.stop(timeout)
        self.outbox.close()

    def _writer_loop(self) -> None:
        while True:
            with self._condition:
                while not self._queue and not self._stop:
                    self._condition.wait(0.5)
                if not self._queue and self._stop:
                    return
                message, group_id, source_id = self._queue.popleft()
            try:
                self.outbox.enqueue(message)
            except Exception:
                with self._condition:
                    self._queue.appendleft((message, group_id, source_id))
                self._pause_source(group_id, source_id)
                if self.logger:
                    self.logger.exception("frame outbox write failed")
                threading.Event().wait(0.2)
                continue

    def _control_loop(self) -> None:
        while True:
            with self._condition:
                if self._stop:
                    return
                ingress_depth = len(self._queue)
                pause_requests = set(self._pause_requests)
                self._pause_requests.clear()
                active_sources = list(self._active_sources)
            outbox_pending = self.outbox.counts()["pending"]
            if outbox_pending >= self.config.high_watermark:
                pause_requests.update(active_sources)
            for key in pause_requests:
                self._pause_source(*key)
            if (
                ingress_depth <= self.config.low_watermark
                and outbox_pending <= self.config.low_watermark
            ):
                self._resume_sources()
            threading.Event().wait(0.2)

    def _pause_source(self, group_id: int, source_id: int) -> None:
        key = (int(group_id), int(source_id))
        if key in self._paused:
            return
        self._paused.add(key)
        if self.source_control:
            try:
                self.source_control(key[0], key[1], False)
            except Exception:
                if self.logger:
                    self.logger.exception("failed to pause overloaded video source %s/%s", *key)

    def _resume_sources(self) -> None:
        for key in list(self._paused):
            if self.source_control:
                try:
                    self.source_control(key[0], key[1], True)
                except Exception:
                    if self.logger:
                        self.logger.exception("failed to resume video source %s/%s", *key)
                    continue
            self._paused.discard(key)
