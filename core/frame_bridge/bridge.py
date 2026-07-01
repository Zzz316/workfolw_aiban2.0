"""High-level bridge that keeps SDK callbacks non-blocking."""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Deque, Dict, Optional, Tuple

from .adapter import FrameAdapter
from .outbox import DurableOutbox
from .protocol import beijing_now_iso
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
    disk_emergency_percent: int = 95
    screenshot_timeout_seconds: float = 30.0
    stats_file: str = ""

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
            disk_emergency_percent=int(
                os.getenv("AIBAN_FRAME_DISK_EMERGENCY_PERCENT", "95")
            ),
            screenshot_timeout_seconds=float(
                os.getenv("AIBAN_FRAME_SCREENSHOT_TIMEOUT", "30.0")
            ),
            stats_file=os.getenv("AIBAN_FRAME_STATS_FILE", ""),
        )


class FrameBridge:
    def __init__(
        self,
        config: FrameBridgeConfig,
        source_control: Optional[Callable[[int, int, bool], bool]] = None,
        audit_callback: Optional[Callable[..., None]] = None,
        logger=None,
        screenshot_manager=None,
    ):
        self.config = config
        self.source_control = source_control
        self.audit_callback = audit_callback
        self.logger = logger
        self.screenshot_manager = screenshot_manager
        self._start_time = time.monotonic()
        self._disk_stats: Dict[str, Any] = {}
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
            audit_callback=audit_callback,
            logger=logger,
            on_message=self._handle_control_message if screenshot_manager else None,
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
        self._audit(
            "sdk_received",
            message_id=message["message_id"],
            stream_id=message["stream_id"],
            frame_seq=message["frame_seq"],
            sdk_received_at=message["sdk_received_at"],
            sdk_received_at_ms=message["sdk_received_at_ms"],
            sdk_convert_ms=message["sdk_convert_ms"],
            labels=self._labels(message),
            ingress_depth=depth,
        )
        return message

    def stats(self) -> Dict:
        with self._condition:
            ingress = len(self._queue)
            paused = sorted("{}/{}".format(g, s) for g, s in self._paused)
        return {
            "session_id": self.adapter.session_id,
            "uptime_seconds": round(time.monotonic() - self._start_time, 1),
            "ingress": {
                "pending": ingress,
                "paused_sources": paused,
            },
            "outbox": self.outbox.counts(),
            "transport": {
                "endpoint": self.config.endpoint,
                "acks_received": self.transport._ack_count,
            },
            "disk": dict(self._disk_stats),
            "screenshot": (
                self.screenshot_manager.stats() if self.screenshot_manager else {}
            ),
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
                persist_started_ns = time.perf_counter_ns()
                self.outbox.enqueue(message)
                persist_ms = (
                    time.perf_counter_ns() - persist_started_ns
                ) / 1_000_000
                self._audit(
                    "outbox_persisted",
                    message_id=message["message_id"],
                    stream_id=message["stream_id"],
                    frame_seq=message["frame_seq"],
                    outbox_persist_ms=round(persist_ms, 3),
                    queue_wait_ms=round(
                        time.time() * 1000
                        - float(message["bridge_created_at_ms"]),
                        3,
                    ),
                )
            except Exception:
                with self._condition:
                    self._queue.appendleft((message, group_id, source_id))
                self._pause_source(group_id, source_id)
                if self.logger:
                    self.logger.exception("frame outbox write failed")
                threading.Event().wait(0.2)
                continue

    def _control_loop(self) -> None:
        iteration = 0
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

            iteration += 1
            # disk check every ~2 seconds (10 iterations)
            if iteration % 10 == 0:
                self._check_disk()
                if self._disk_stats.get("emergency"):
                    with self._condition:
                        all_sources = list(self._active_sources)
                    for key in all_sources:
                        self._pause_source(*key)

            # screenshot timeout check
            if self.screenshot_manager:
                timed_out = self.screenshot_manager.check_timeouts()
                for request_id, gid, sid in timed_out:
                    try:
                        from .protocol import make_screenshot_timeout
                        self.transport.send_message(
                            make_screenshot_timeout(request_id, gid, sid)
                        )
                    except Exception:
                        if self.logger:
                            self.logger.exception(
                                "failed to send screenshot timeout for %s", request_id
                            )

            # stats file write every ~1 second (5 iterations)
            if self.config.stats_file and iteration % 5 == 0:
                try:
                    stats_path = Path(self.config.stats_file)
                    stats_path.parent.mkdir(parents=True, exist_ok=True)
                    data = self.stats()
                    data["updated_at"] = beijing_now_iso()
                    tmp_path = stats_path.with_suffix(".tmp")
                    tmp_path.write_text(
                        json.dumps(data, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                    tmp_path.replace(stats_path)
                except Exception:
                    pass  # never let stats writing crash the bridge

            threading.Event().wait(0.2)

    def _audit(self, event: str, **fields) -> None:
        if self.audit_callback:
            try:
                self.audit_callback(event, **fields)
            except Exception:
                if self.logger:
                    self.logger.exception("frame transmission audit callback failed")

    @staticmethod
    def _labels(message: Dict) -> list:
        labels = []
        for model_id, result in (message.get("models") or {}).items():
            for box in (result or {}).get("boxes", []):
                labels.append(
                    {
                        "model_id": str(model_id),
                        "label": str(box.get("label", "")),
                        "confidence": float(box.get("confidence", 0.0) or 0.0),
                    }
                )
        return labels

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

    def _check_disk(self) -> None:
        """Check disk usage on the filesystem containing the outbox."""
        try:
            outbox_dir = os.path.dirname(self.config.outbox_path) or "."
            usage = shutil.disk_usage(outbox_dir)
            percent_used = (usage.total - usage.free) / usage.total * 100.0
            self._disk_stats = {
                "path": outbox_dir,
                "total_bytes": usage.total,
                "used_bytes": usage.used,
                "free_bytes": usage.free,
                "percent_used": round(percent_used, 2),
                "emergency": percent_used >= self.config.disk_emergency_percent,
            }
            if self._disk_stats["emergency"]:
                if self.logger:
                    self.logger.error(
                        "disk emergency: %.1f%% used (threshold %d%%), "
                        "pausing all sources",
                        percent_used,
                        self.config.disk_emergency_percent,
                    )
        except OSError as exc:
            if self.logger:
                self.logger.warning("disk check failed: %s", exc)

    def _handle_control_message(self, msg: Dict) -> None:
        """Dispatch incoming control messages from Node-RED (non-ACK)."""
        if (
            msg.get("type") == "screenshot_request"
            and self.screenshot_manager
            and isinstance(msg.get("request_id"), str)
        ):
            self.screenshot_manager.enqueue_request(
                request_id=msg["request_id"],
                group_id=int(msg.get("group_id", 0)),
                source_id=int(msg.get("source_id", 0)),
                save_roi=bool(msg.get("save_roi", False)),
            )
