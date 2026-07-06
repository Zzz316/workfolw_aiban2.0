"""Lifecycle management for the AiBan Runner.

Manages:
  - Session identity (UUID v4)
  - Monotonic event sequence counter
  - Heartbeat generation
  - Startup / shutdown state machine
  - Bounded output queue with watermark monitoring
"""

import logging
import queue
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Queue watermark thresholds
# ---------------------------------------------------------------------------

HIGH_WATERMARK_RATIO = 0.8
LOW_WATERMARK_RATIO = 0.5
DEFAULT_QUEUE_CAPACITY = 1024


# ---------------------------------------------------------------------------
# Lifecycle states
# ---------------------------------------------------------------------------

class LifecycleState:
    CREATED = "created"
    STARTING = "starting"
    READY = "ready"
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"


# ---------------------------------------------------------------------------
# Output queue
# ---------------------------------------------------------------------------

class BoundedOutputQueue:
    """Thread-safe bounded queue for stdout events.

    Supports:
      - Capacity limit
      - High/low watermark tracking
      - Overflow detection (rejects new frames when full — never evicts)
      - Queue depth statistics

    Design invariant:
      - High watermark triggers source pause → prevents queue from filling.
      - If queue still reaches capacity (pause didn't take effect in time),
        the frame is REJECTED and overflow_count increments — no silent drops.
    """

    def __init__(self, capacity: int = DEFAULT_QUEUE_CAPACITY):
        self._queue: queue.Queue = queue.Queue(maxsize=capacity)
        self._capacity = capacity
        self._high_watermark = int(capacity * HIGH_WATERMARK_RATIO)
        self._low_watermark = int(capacity * LOW_WATERMARK_RATIO)
        self._drops = 0
        self._overflow_count = 0
        self._enqueued = 0
        self._lock = threading.Lock()

    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def depth(self) -> int:
        return self._queue.qsize()

    @property
    def drops(self) -> int:
        """Total frames evicted (kept for backward compat; always 0 now)."""
        with self._lock:
            return self._drops

    @property
    def overflow_count(self) -> int:
        """Number of frames rejected because the queue was full."""
        with self._lock:
            return self._overflow_count

    @property
    def enqueued(self) -> int:
        with self._lock:
            return self._enqueued

    @property
    def is_full(self) -> bool:
        return self._queue.full()

    @property
    def high_watermark(self) -> int:
        return self._high_watermark

    @property
    def low_watermark(self) -> int:
        return self._low_watermark

    def is_above_high_watermark(self) -> bool:
        return self.depth >= self._high_watermark

    def is_below_low_watermark(self) -> bool:
        return self.depth <= self._low_watermark

    def would_exceed_high_watermark(self) -> bool:
        """Check if the NEXT enqueue would reach or exceed the high watermark.

        Call this BEFORE enqueuing to trigger a pre-emptive source pause.
        """
        return (self.depth + 1) >= self._high_watermark

    def put(self, event: Dict[str, Any]) -> bool:
        """Put an event onto the queue.

        Returns:
            True if the event was enqueued, False if the queue is full.
            When False, the caller MUST handle the rejection — the frame
            is NOT silently dropped and no existing frames are evicted.
        """
        try:
            self._queue.put_nowait(event)
            with self._lock:
                self._enqueued += 1
            return True
        except queue.Full:
            with self._lock:
                self._overflow_count += 1
            return False

    def get(self, timeout: float = 1.0) -> Optional[Dict[str, Any]]:
        """Get an event from the queue, blocking up to timeout seconds.

        Returns:
            Event dict, or None if timeout expired.
        """
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def task_done(self) -> None:
        """Mark a previously retrieved item as processed."""
        self._queue.task_done()


# ---------------------------------------------------------------------------
# Lifecycle manager
# ---------------------------------------------------------------------------

class LifecycleManager:
    """Manages the runner's lifecycle state, session identity, and heartbeat."""

    def __init__(
        self,
        output_queue: BoundedOutputQueue,
        session_id: Optional[str] = None,
        heartbeat_interval: float = 5.0,
    ):
        self._output_queue = output_queue
        self._session_id = session_id or str(uuid.uuid4())
        self._event_seq = 0
        self._state = LifecycleState.CREATED
        self._started_at: Optional[float] = None
        self._heartbeat_interval = heartbeat_interval
        self._heartbeat_timer: Optional[threading.Timer] = None
        self._frames_emitted = 0
        self._paused_sources: List[str] = []

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def state(self) -> str:
        return self._state

    @property
    def event_seq(self) -> int:
        return self._event_seq

    @property
    def frames_emitted(self) -> int:
        return self._frames_emitted

    @property
    def uptime_seconds(self) -> float:
        if self._started_at is None:
            return 0.0
        return time.monotonic() - self._started_at

    @property
    def paused_sources(self) -> List[str]:
        return list(self._paused_sources)

    # ------------------------------------------------------------------
    # Sequence management
    # ------------------------------------------------------------------

    def next_seq(self) -> int:
        seq = self._event_seq
        self._event_seq += 1
        return seq

    def increment_frames(self) -> None:
        self._frames_emitted += 1

    # ------------------------------------------------------------------
    # State transitions
    # ------------------------------------------------------------------

    def transition_to(self, new_state: str) -> None:
        old = self._state
        self._state = new_state
        logger.info("Lifecycle: %s → %s", old, new_state)
        if new_state == LifecycleState.READY:
            self._started_at = time.monotonic()
            self._start_heartbeat()

    def is_ready(self) -> bool:
        return self._state == LifecycleState.READY

    def is_stopping_or_stopped(self) -> bool:
        return self._state in (LifecycleState.STOPPING, LifecycleState.STOPPED)

    # ------------------------------------------------------------------
    # Paused sources
    # ------------------------------------------------------------------

    def add_paused_source(self, stream_id: str) -> None:
        if stream_id not in self._paused_sources:
            self._paused_sources.append(stream_id)

    def remove_paused_source(self, stream_id: str) -> None:
        if stream_id in self._paused_sources:
            self._paused_sources.remove(stream_id)

    # ------------------------------------------------------------------
    # Heartbeat
    # ------------------------------------------------------------------

    def _start_heartbeat(self) -> None:
        self._schedule_heartbeat()

    def _schedule_heartbeat(self) -> None:
        if self._state != LifecycleState.READY:
            return

        def _beat():
            if self._state != LifecycleState.READY:
                return
            try:
                from python_runtime.protocol import make_envelope

                event = make_envelope(
                    event_type="heartbeat",
                    session_id=self._session_id,
                    event_seq=self.next_seq(),
                    payload={
                        "uptime_seconds": round(self.uptime_seconds, 1),
                        "frames_emitted": self._frames_emitted,
                        "queue_depth": self._output_queue.depth,
                        "queue_capacity": self._output_queue.capacity,
                        "queue_overflow_count": self._output_queue.overflow_count,
                        "queue_is_full": self._output_queue.is_full,
                        "paused_sources": self.paused_sources,
                    },
                )
                self._output_queue.put(event)
            except Exception:
                logger.exception("Error generating heartbeat")
            finally:
                self._schedule_heartbeat()

        self._heartbeat_timer = threading.Timer(self._heartbeat_interval, _beat)
        self._heartbeat_timer.daemon = True
        self._heartbeat_timer.start()

    def stop_heartbeat(self) -> None:
        if self._heartbeat_timer:
            self._heartbeat_timer.cancel()
            self._heartbeat_timer = None

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def shutdown(self) -> None:
        self.stop_heartbeat()
        self.transition_to(LifecycleState.STOPPED)
