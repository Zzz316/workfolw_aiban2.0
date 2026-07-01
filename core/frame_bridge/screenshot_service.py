"""Async screenshot request/response manager.

The AiBan SDK's ``saveImage()`` is asynchronous -- the call initiates a save
inside the ``videoResultFunc`` callback, but the result arrives later on the
separate ``videoSaveImageFunc`` callback which carries no ``request_id``.

This module tracks pending and in-flight requests so that Node-RED screenshot
requests can be matched to their results, using FIFO ordering per video source.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, namedtuple
from typing import Any, Dict, List, Optional, Tuple

PendingRequest = namedtuple(
    "PendingRequest", ["request_id", "save_roi", "created_at"]
)
InFlightRequest = namedtuple(
    "InFlightRequest", ["request_id", "save_roi", "started_at", "group_id", "source_id"]
)


class ScreenshotManager:
    """Track screenshot requests across the async SDK save boundary."""

    def __init__(self, request_ttl_seconds: float = 30.0, logger=None):
        self.request_ttl_seconds = max(0.1, float(request_ttl_seconds))
        self.logger = logger
        self._lock = threading.Lock()
        # (group_id, source_id) -> [PendingRequest, ...]
        self._pending: Dict[Tuple[int, int], List[PendingRequest]] = defaultdict(list)
        # request_id -> InFlightRequest
        self._in_flight: Dict[str, InFlightRequest] = {}
        # counters for stats
        self._completed_count: int = 0
        self._timed_out_count: int = 0
        self._error_count: int = 0

    # ── called from transport thread ──────────────────────────────────────

    def enqueue_request(
        self, request_id: str, group_id: int, source_id: int, save_roi: bool = False
    ) -> None:
        """Node-RED has requested a screenshot. Queue it for the next frame."""
        key = (int(group_id), int(source_id))
        with self._lock:
            self._pending[key].append(
                PendingRequest(
                    request_id=str(request_id),
                    save_roi=bool(save_roi),
                    created_at=time.monotonic(),
                )
            )

    # ── called from SDK callback thread ───────────────────────────────────

    def has_pending(self, group_id: int, source_id: int) -> bool:
        """Fast check: are there outstanding screenshot requests for this source?"""
        key = (int(group_id), int(source_id))
        with self._lock:
            return bool(self._pending.get(key))

    def dequeue_pending(
        self, group_id: int, source_id: int
    ) -> List[PendingRequest]:
        """Atomically move pending requests to in-flight and return them.

        The caller must call ``metadata.saveImage(req.save_roi)`` for each
        returned request -- all inside the current SDK callback.
        """
        key = (int(group_id), int(source_id))
        with self._lock:
            requests = self._pending.pop(key, [])
            now = time.monotonic()
            for req in requests:
                self._in_flight[req.request_id] = InFlightRequest(
                    request_id=req.request_id,
                    save_roi=req.save_roi,
                    started_at=now,
                    group_id=int(group_id),
                    source_id=int(source_id),
                )
            return requests

    # ── called from videoSaveImageFunc callback ───────────────────────────

    def complete(
        self, group_id: int, source_id: int, filepath: str
    ) -> Optional[str]:
        """Match a completed save to the oldest in-flight request for this source.

        Returns the matched ``request_id``, or ``None`` if nothing was in flight.
        """
        key = (int(group_id), int(source_id))
        with self._lock:
            # find the oldest in-flight for this source (FIFO)
            oldest: Optional[InFlightRequest] = None
            for req in self._in_flight.values():
                if req.group_id == key[0] and req.source_id == key[1]:
                    if oldest is None or req.started_at < oldest.started_at:
                        oldest = req
            if oldest is None:
                return None
            del self._in_flight[oldest.request_id]
            self._completed_count += 1
            return oldest.request_id

    def record_error(self, group_id: int, source_id: int) -> Optional[str]:
        """Record a failed save for the oldest in-flight request.

        Used when the save path is empty or the image is known to have failed.
        """
        key = (int(group_id), int(source_id))
        with self._lock:
            oldest: Optional[InFlightRequest] = None
            for req in self._in_flight.values():
                if req.group_id == key[0] and req.source_id == key[1]:
                    if oldest is None or req.started_at < oldest.started_at:
                        oldest = req
            if oldest is None:
                return None
            del self._in_flight[oldest.request_id]
            self._error_count += 1
            return oldest.request_id

    # ── called periodically from bridge controller thread ─────────────────

    def check_timeouts(self) -> List[Tuple[str, int, int]]:
        """Return (request_id, group_id, source_id) for expired in-flight requests.

        The caller should send ``screenshot_timeout`` notifications for each.
        """
        now = time.monotonic()
        expired: List[Tuple[str, int, int]] = []
        with self._lock:
            for req_id, req in list(self._in_flight.items()):
                if now - req.started_at >= self.request_ttl_seconds:
                    del self._in_flight[req_id]
                    self._timed_out_count += 1
                    expired.append((req_id, req.group_id, req.source_id))
        return expired

    # ── diagnostics ───────────────────────────────────────────────────────

    def stats(self) -> Dict[str, Any]:
        """Return current snapshot for bridge stats."""
        with self._lock:
            return {
                "pending": sum(len(v) for v in self._pending.values()),
                "in_flight": len(self._in_flight),
                "completed": self._completed_count,
                "timed_out": self._timed_out_count,
                "errors": self._error_count,
                "ttl_seconds": self.request_ttl_seconds,
            }
