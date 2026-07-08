"""AiBan Python Runner — main entry point.

Managed by Node-RED aiban-runtime node via child_process.spawn().
Communicates via stdin/stdout JSON Lines protocol.

Usage:
    python -m python_runtime.aiban_runner [--mock] [--sdk-home PATH] [--pipeline-config YAML]
    python aiban_runner.py --mock  (from within this directory)

The --mock flag enables Mock SDK mode for development/testing without hardware.
"""

import argparse
import logging
import os
import signal
import sys
import threading
from typing import Any, Dict, Optional

# Ensure the project root is on sys.path so that `python_runtime` imports work
# when this file is run directly (python aiban_runner.py) rather than as a module.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from python_runtime.protocol import (
    make_envelope,
    encode_event,
    now_iso,
)
from python_runtime.lifecycle import (
    BoundedOutputQueue,
    LifecycleManager,
    LifecycleState,
    DEFAULT_QUEUE_CAPACITY,
)
from python_runtime.sdk_adapter import SdkAdapter
from python_runtime.command_loop import CommandLoop

# ---------------------------------------------------------------------------
# Logging setup — all logs go to stderr
# ---------------------------------------------------------------------------

def _setup_logging(level: int = logging.INFO) -> None:
    """Configure logging to stderr only (stdout is reserved for protocol)."""
    root = logging.getLogger()
    root.setLevel(level)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter(
        "[%(asctime)s] %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    ))
    root.handlers.clear()
    root.addHandler(handler)


# ---------------------------------------------------------------------------
# Output writer thread
# ---------------------------------------------------------------------------

class OutputWriter:
    """Thread-safe stdout writer running in a dedicated thread.

    Reads events from the bounded output queue and writes them to stdout
    as JSON Lines. This ensures that SDK callbacks (which run on internal
    threads) never block on stdout I/O.
    """

    def __init__(self, queue: BoundedOutputQueue, on_event: Optional[callable] = None):
        self._queue = queue
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._on_event = on_event

    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="stdout-writer")
        self._thread.start()

    def stop(self) -> None:
        self._running = False

    def join(self, timeout: float = 5.0) -> None:
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def _run(self) -> None:
        """Main loop: dequeue events and write to stdout."""
        import time
        while self._running:
            event = self._queue.get(timeout=0.5)
            if event is None:
                continue
            try:
                if event.get("type") == "frame":
                    payload = event.get("payload") or {}
                    stdout_at_ms = time.time_ns() / 1_000_000
                    payload["python_stdout_at_ms"] = round(stdout_at_ms, 3)
                    enqueued_at_ms = payload.get("python_enqueued_at_ms")
                    if enqueued_at_ms is not None:
                        payload["python_queue_ms"] = round(
                            max(0, stdout_at_ms - float(enqueued_at_ms)),
                            3,
                        )
                data = encode_event(event)
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
                if self._on_event:
                    self._on_event(event)
            except (BrokenPipeError, OSError):
                # stdout closed — Node-RED has stopped reading
                logging.getLogger(__name__).warning("stdout pipe broken, stopping writer")
                self._running = False
            except Exception:
                logging.getLogger(__name__).exception("Error writing to stdout")
            finally:
                self._queue.task_done()


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

class AibanRunner:
    """Main runner orchestrating SDK adapter, lifecycle, and I/O."""

    def __init__(
        self,
        python_path: str = "",
        sdk_home: str = "",
        pipeline_config: str = "",
        working_directory: str = "",
        use_mock: bool = False,
        mock_config: Optional[Dict[str, Any]] = None,
        queue_capacity: int = DEFAULT_QUEUE_CAPACITY,
        heartbeat_interval: float = 5.0,
    ):
        self._python_path = python_path or sys.executable
        self._sdk_home = sdk_home
        self._pipeline_config = pipeline_config
        self._working_directory = working_directory
        self._use_mock = use_mock
        self._mock_config = mock_config or {}

        # Components (initialized in start())
        self._output_queue = BoundedOutputQueue(capacity=queue_capacity)
        self._lifecycle = LifecycleManager(
            self._output_queue, heartbeat_interval=heartbeat_interval
        )
        self._sdk_adapter = SdkAdapter(
            sdk_home=sdk_home, use_mock=use_mock, mock_config=self._mock_config,
        )
        self._command_loop = CommandLoop(
            self._output_queue,
            session_id=self._lifecycle.session_id,
            get_next_seq=self._lifecycle.next_seq,
            on_eof=self._on_stdin_eof,
        )
        self._writer = OutputWriter(
            self._output_queue,
            on_event=self._on_event_written,
        )

        self._runner_version = "1.0.0"
        self._shutdown_event = threading.Event()

        # Stats tracking per source for watermark-based pause/resume
        self._source_frame_counts: Dict[str, int] = {}

    # ------------------------------------------------------------------
    # Event tracking
    # ------------------------------------------------------------------

    def _on_event_written(self, event: Dict[str, Any]) -> None:
        """Called after an event is successfully written to stdout."""
        event_type = event.get("type", "")
        if event_type == "frame":
            self._lifecycle.increment_frames()

    # ------------------------------------------------------------------
    # Frame handler (called from SDK callback thread)
    # ------------------------------------------------------------------

    def _handle_frame(self, group_id: int, source_id: int, frame_data: Dict[str, Any]) -> None:
        """Enqueue a frame event onto the output queue.

        Called from the SDK callback thread. This must be fast —
        just copy data into the queue and return.
        """
        if not self._lifecycle.is_ready():
            return

        # Pre-check: if next frame would hit high watermark, pause the
        # busiest source BEFORE enqueuing to avoid filling the queue.
        if self._output_queue.would_exceed_high_watermark():
            self._check_watermarks_pre_put()

        import time
        frame_data["python_enqueued_at_ms"] = round(
            time.time_ns() / 1_000_000, 3
        )
        event = make_envelope(
            event_type="frame",
            session_id=self._lifecycle.session_id,
            event_seq=self._lifecycle.next_seq(),
            payload=frame_data,
        )

        ok = self._output_queue.put(event)
        if not ok:
            # Queue is full — pause was not fast enough.  Emit an
            # observable error; the frame is rejected, not silently dropped.
            logging.getLogger(__name__).error(
                "Frame REJECTED: queue full (depth=%d/%d, overflow=%d)",
                self._output_queue.depth,
                self._output_queue.capacity,
                self._output_queue.overflow_count,
            )
            # Emit overflow error event so Node-RED can see it
            err_event = make_envelope(
                event_type="runtime_error",
                session_id=self._lifecycle.session_id,
                event_seq=self._lifecycle.next_seq(),
                payload={
                    "error_code": "QUEUE_OVERFLOW",
                    "message": (
                        f"Queue full ({self._output_queue.depth}/"
                        f"{self._output_queue.capacity}), frame rejected"
                    ),
                    "details": {
                        "queue_depth": self._output_queue.depth,
                        "capacity": self._output_queue.capacity,
                        "overflow_count": self._output_queue.overflow_count,
                    },
                },
            )
            self._output_queue.put(err_event)
            return

        # Track per-source frame counts for watermark management
        stream_id = frame_data.get("stream_id", f"group-{group_id}/source-{source_id}")
        self._source_frame_counts[stream_id] = (
            self._source_frame_counts.get(stream_id, 0) + 1
        )

        # Post-check watermarks and pause/resume sources
        self._check_watermarks()

    # ------------------------------------------------------------------
    # SDK event handler
    # ------------------------------------------------------------------

    def _handle_sdk_event(self, level: str, message: str) -> None:
        """Enqueue an SDK event."""
        event = make_envelope(
            event_type="sdk_event",
            session_id=self._lifecycle.session_id,
            event_seq=self._lifecycle.next_seq(),
            payload={
                "level": level,
                "message": message,
                "sdk_timestamp": now_iso(),
            },
        )
        self._output_queue.put(event)

    # ------------------------------------------------------------------
    # stdin EOF handler
    # ------------------------------------------------------------------

    def _on_stdin_eof(self) -> None:
        """Called when stdin is closed (Node-RED process exited)."""
        logger = logging.getLogger(__name__)
        logger.info("stdin closed, initiating graceful shutdown")
        # Trigger the same shutdown sequence as a stop command
        if self._lifecycle.state == LifecycleState.READY:
            self._lifecycle.transition_to(LifecycleState.STOPPING)
            try:
                self._sdk_adapter.stop_pipeline()
            except Exception:
                pass
        self._shutdown_event.set()

    # ------------------------------------------------------------------
    # Watermark management
    # ------------------------------------------------------------------

    def _pause_busiest_source(self) -> None:
        """Pause the video source with the most pending frames in the queue.

        Called pre-emptively when the queue is about to hit the high watermark.
        Safe to call multiple times — already-paused sources are skipped.
        """
        logger = logging.getLogger(__name__)
        if not self._source_frame_counts:
            return
        busiest = max(self._source_frame_counts, key=self._source_frame_counts.get)
        if busiest in self._lifecycle.paused_sources:
            return
        logger.warning(
            "Queue at high watermark (%d/%d), pausing %s",
            self._output_queue.depth, self._output_queue.capacity, busiest,
        )
        self._lifecycle.add_paused_source(busiest)
        parts = busiest.split("/")
        if len(parts) == 2:
            try:
                gid = int(parts[0].split("-")[1])
                sid = int(parts[1].split("-")[1])
                self._sdk_adapter.source_control(gid, sid, False)
            except (IndexError, ValueError):
                pass

    def _check_watermarks_pre_put(self) -> None:
        """Pre-emptive check: pause the busiest source BEFORE the queue fills.

        Called when would_exceed_high_watermark() returns True.
        """
        self._pause_busiest_source()

    def _check_watermarks(self) -> None:
        """Check queue watermarks and pause/resume sources accordingly.

        Post-put check: pause if above high watermark, resume if below low.
        """
        logger = logging.getLogger(__name__)

        if self._output_queue.is_above_high_watermark():
            self._pause_busiest_source()

            # Emit warning event
            event = make_envelope(
                event_type="runtime_error",
                session_id=self._lifecycle.session_id,
                event_seq=self._lifecycle.next_seq(),
                payload={
                    "error_code": "QUEUE_HIGH_WATERMARK",
                    "message": f"Queue depth {self._output_queue.depth} >= {self._output_queue.high_watermark}",
                    "details": {
                        "queue_depth": self._output_queue.depth,
                        "capacity": self._output_queue.capacity,
                        "threshold": self._output_queue.high_watermark,
                    },
                },
            )
            self._output_queue.put(event)

        elif self._output_queue.is_below_low_watermark():
            # Resume all paused sources
            for stream_id in list(self._lifecycle.paused_sources):
                logger.info("Queue at low watermark, resuming %s", stream_id)
                parts = stream_id.split("/")
                if len(parts) == 2:
                    try:
                        gid = int(parts[0].split("-")[1])
                        sid = int(parts[1].split("-")[1])
                        self._sdk_adapter.source_control(gid, sid, True)
                    except (IndexError, ValueError):
                        pass
                self._lifecycle.remove_paused_source(stream_id)

    # ------------------------------------------------------------------
    # Command handlers
    # ------------------------------------------------------------------

    def _cmd_start(self, command: str, request_id: str, params: dict) -> dict:
        """Handle 'start' command — initialize SDK and build pipeline."""
        if self._lifecycle.state == LifecycleState.READY:
            return {"message": "Already running"}

        self._lifecycle.transition_to(LifecycleState.STARTING)

        # Emit runtime_starting
        event = make_envelope(
            event_type="runtime_starting",
            session_id=self._lifecycle.session_id,
            event_seq=self._lifecycle.next_seq(),
            payload={
                "python_version": sys.version.split()[0],
                "runner_version": self._runner_version,
                "sdk_home": self._sdk_home,
                "pipeline_config": self._pipeline_config,
            },
        )
        self._output_queue.put(event)

        # Check config
        try:
            ok = self._sdk_adapter.check_config(self._pipeline_config)
            if not ok:
                raise RuntimeError("checkAllConfig returned false")
        except Exception as exc:
            self._lifecycle.transition_to(LifecycleState.ERROR)
            raise RuntimeError(f"Config check failed: {exc}") from exc

        # Build pipeline
        try:
            self._sdk_adapter.build_pipeline()
        except Exception as exc:
            self._lifecycle.transition_to(LifecycleState.ERROR)
            raise RuntimeError(f"Pipeline build failed: {exc}") from exc

        self._lifecycle.transition_to(LifecycleState.READY)

        # Emit runtime_ready
        event = make_envelope(
            event_type="runtime_ready",
            session_id=self._lifecycle.session_id,
            event_seq=self._lifecycle.next_seq(),
            payload={
                "groups": [1],  # FIXME: extract from YAML
                "sources_per_group": {"1": list(range(1, self._mock_config.get("num_sources", 1) + 1))},
                "models_loaded": [str(m) for m in self._mock_config.get("model_ids", [1])],
            },
        )
        self._output_queue.put(event)

        return {"message": "Pipeline started"}

    def _cmd_stop(self, command: str, request_id: str, params: dict) -> dict:
        """Handle 'stop' command — gracefully stop pipeline."""
        force = params.get("force", False)

        self._lifecycle.transition_to(LifecycleState.STOPPING)

        # Emit runtime_stopping
        event = make_envelope(
            event_type="runtime_stopping",
            session_id=self._lifecycle.session_id,
            event_seq=self._lifecycle.next_seq(),
            payload={
                "reason": "command",
                "frames_emitted": self._lifecycle.frames_emitted,
            },
        )
        self._output_queue.put(event)

        # Stop SDK pipeline
        try:
            self._sdk_adapter.stop_pipeline()
        except Exception:
            if not force:
                raise

        self._lifecycle.transition_to(LifecycleState.STOPPED)
        self._shutdown_event.set()

        # Emit runtime_stopped
        event = make_envelope(
            event_type="runtime_stopped",
            session_id=self._lifecycle.session_id,
            event_seq=self._lifecycle.next_seq(),
            payload={
                "exit_code": 0,
                "reason": "normal",
                "frames_emitted": self._lifecycle.frames_emitted,
            },
        )
        # Put directly — queue may have been drained
        try:
            self._output_queue.put(event)
        except Exception:
            pass

        return {"message": "Pipeline stopped"}

    def _cmd_restart(self, command: str, request_id: str, params: dict) -> dict:
        """Handle 'restart' command."""
        self._cmd_stop("stop", request_id + "-stop", {})
        # Wait a moment for cleanup
        import time
        time.sleep(0.5)
        self._lifecycle._event_seq = 0  # Reset sequence
        self._lifecycle._state = LifecycleState.CREATED
        self._lifecycle._frames_emitted = 0
        return self._cmd_start("start", request_id + "-start", {})

    def _cmd_health(self, command: str, request_id: str, params: dict) -> dict:
        """Handle 'health' command."""
        return {
            "state": self._lifecycle.state,
            "uptime_seconds": round(self._lifecycle.uptime_seconds, 1),
            "frames_emitted": self._lifecycle.frames_emitted,
            "queue_depth": self._output_queue.depth,
            "queue_capacity": self._output_queue.capacity,
            "queue_drops": self._output_queue.drops,
            "paused_sources": self._lifecycle.paused_sources,
        }

    def _cmd_pause_source(self, command: str, request_id: str, params: dict) -> dict:
        """Handle 'pause_source' command."""
        group_id = params["group_id"]
        source_id = params["source_id"]
        stream_id = f"group-{group_id}/source-{source_id}"
        self._sdk_adapter.source_control(group_id, source_id, False)
        self._lifecycle.add_paused_source(stream_id)
        return {"stream_id": stream_id, "paused": True}

    def _cmd_resume_source(self, command: str, request_id: str, params: dict) -> dict:
        """Handle 'resume_source' command."""
        group_id = params["group_id"]
        source_id = params["source_id"]
        stream_id = f"group-{group_id}/source-{source_id}"
        self._sdk_adapter.source_control(group_id, source_id, True)
        self._lifecycle.remove_paused_source(stream_id)
        return {"stream_id": stream_id, "paused": False}

    def _cmd_screenshot(self, command: str, request_id: str, params: dict) -> dict:
        """Handle 'screenshot' command — returns accepted + async result event.

        The command_result carries a basic accepted response (so Node-RED's
        requestScreenshot() promise resolves quickly), while the real
        image_path arrives via a separate screenshot_result event.

        Mock mode: screenshot_result is emitted immediately after return.
        Real SDK: do_screenshot blocks until next frame callback, so
        screenshot_result is emitted synchronously after saveImage."""
        group_id = params["group_id"]
        source_id = params["source_id"]
        image_path = self._sdk_adapter.do_screenshot(group_id, source_id)

        # Emit async screenshot_result event for protocol compatibility
        # with V1 behaviour and the Phase 1 test suite (tests 8, 22).
        event = make_envelope(
            event_type="screenshot_result",
            session_id=self._lifecycle.session_id,
            event_seq=self._lifecycle.next_seq(),
            payload={
                "request_id": request_id,
                "group_id": group_id,
                "source_id": source_id,
                "image_path": image_path or "",
                "ok": True,
                "error": None,
            },
        )
        self._output_queue.put(event)

        return {
            "image_path": image_path or "",
            "group_id": group_id,
            "source_id": source_id,
        }

    # ------------------------------------------------------------------
    # Startup / shutdown
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the runner: wire components, start I/O threads, register handlers."""
        logger = logging.getLogger(__name__)
        logger.info("AiBan Runner %s starting", self._runner_version)
        logger.info("Session ID: %s", self._lifecycle.session_id)
        logger.info("Mock mode: %s", self._use_mock)

        # Wire frame handler
        self._sdk_adapter.set_frame_handler(self._handle_frame)
        self._sdk_adapter.set_event_handler(self._handle_sdk_event)

        # Register command handlers
        self._command_loop.register("start", self._cmd_start)
        self._command_loop.register("stop", self._cmd_stop)
        self._command_loop.register("restart", self._cmd_restart)
        self._command_loop.register("health", self._cmd_health)
        self._command_loop.register("pause_source", self._cmd_pause_source)
        self._command_loop.register("resume_source", self._cmd_resume_source)
        self._command_loop.register("screenshot", self._cmd_screenshot)

        # Start I/O
        self._writer.start()
        self._command_loop.start()

        logger.info("Runner started, waiting for 'start' command")

    def wait(self) -> int:
        """Wait for shutdown signal and return exit code."""
        self._shutdown_event.wait()

        # Drain remaining events
        logger = logging.getLogger(__name__)
        logger.info("Shutting down...")
        self._command_loop.stop()
        self._writer.stop()

        # Wait for threads
        self._writer.join(timeout=5.0)
        self._command_loop.join(timeout=5.0)
        self._lifecycle.shutdown()

        logger.info("Runner exited")
        return 0

    def stop(self) -> None:
        """Signal the runner to stop."""
        self._shutdown_event.set()


# ---------------------------------------------------------------------------
# Signal handlers
# ---------------------------------------------------------------------------

_runner_instance: Optional[AibanRunner] = None


def _signal_handler(signum, frame):
    """Handle SIGTERM/SIGINT by triggering graceful shutdown."""
    global _runner_instance
    logger = logging.getLogger(__name__)
    logger.info("Received signal %d, initiating graceful shutdown", signum)
    if _runner_instance:
        _runner_instance.stop()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    """CLI entry point for aiban_runner."""
    global _runner_instance

    parser = argparse.ArgumentParser(
        description="AiBan Python Runner — Node-RED managed SDK adapter",
    )
    parser.add_argument("--mock", action="store_true", help="Use Mock SDK (no hardware)")
    parser.add_argument("--sdk-home", default="", help="AiBan SDK directory")
    parser.add_argument("--pipeline-config", default="", help="Pipeline YAML path")
    parser.add_argument("--working-directory", default="", help="Working directory")
    parser.add_argument("--num-groups", type=int, default=1, help="[Mock] Number of groups")
    parser.add_argument("--num-sources", type=int, default=1, help="[Mock] Number of sources")
    parser.add_argument("--labels", default="A,B,C", help="[Mock] Comma-separated labels")
    parser.add_argument("--frame-interval", type=int, default=200, help="[Mock] Frame interval ms")
    parser.add_argument("--queue-capacity", type=int, default=DEFAULT_QUEUE_CAPACITY,
                        help="Output queue capacity")
    parser.add_argument("--heartbeat-interval", type=float, default=5.0,
                        help="Heartbeat interval seconds")
    parser.add_argument("--fail-config-check", action="store_true",
                        help="[Mock] Simulate config check failure")
    parser.add_argument("--fail-build-pipeline", action="store_true",
                        help="[Mock] Simulate pipeline build failure")

    args = parser.parse_args()

    # Setup logging
    _setup_logging(logging.INFO)

    # Build mock config
    mock_config = {
        "frame_interval_ms": args.frame_interval,
        "num_groups": args.num_groups,
        "num_sources": args.num_sources,
        "model_ids": [1],
        "labels": [l.strip() for l in args.labels.split(",")],
        "fail_config_check": args.fail_config_check,
        "fail_build_pipeline": args.fail_build_pipeline,
    }

    # Create runner
    _runner_instance = AibanRunner(
        sdk_home=args.sdk_home,
        pipeline_config=args.pipeline_config,
        working_directory=args.working_directory,
        use_mock=args.mock,
        mock_config=mock_config,
        queue_capacity=args.queue_capacity,
        heartbeat_interval=args.heartbeat_interval,
    )

    # Register signal handlers
    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)
    try:
        signal.signal(signal.SIGBREAK, _signal_handler)  # Windows
    except AttributeError:
        pass

    # Run
    _runner_instance.start()
    exit_code = _runner_instance.wait()
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
