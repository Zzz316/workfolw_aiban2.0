"""Real AiBan SDK Closed-Loop Verification Script (T16).

Spawns ``aiban_runner.py`` and drives it through the stdin/stdout JSONL
protocol to verify the Runtime and Frame layers of the 2.0 data chain.

Usage::

    # Mock mode (for testing the verifier itself)
    python tools/verify_real_sdk.py --mock --output report.json

    # Real SDK mode (run on production machine)
    python tools/verify_real_sdk.py \
        --sdk-home D:/product/AiBanWorkSpace \
        --pipeline-config D:/product/AiBanWorkSpace/abvideo/main-flow.yaml \
        --output report-t16.json

Output::

    A JSON report written to --output with structured pass/fail/blocked
    results for each verification step.
"""

import argparse
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Project root
# ---------------------------------------------------------------------------

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

_BEIJING_TZ = timezone(timedelta(hours=8))

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def _setup_logging(verbose: bool = False) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )


logger = logging.getLogger("verify_real_sdk")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

RUNNER_MODULE = "python_runtime.aiban_runner"
DEFAULT_MAX_FRAMES = 30
DEFAULT_STARTUP_TIMEOUT = 60.0
DEFAULT_FRAME_TIMEOUT = 30.0
DEFAULT_STOP_TIMEOUT = 15.0
DEFAULT_HEARTBEAT_INTERVAL = 3.0

# Required frame fields (from the Mock contract)
REQUIRED_FRAME_PAYLOAD_FIELDS = {
    "group_id": int,
    "source_id": int,
    "stream_id": str,
    "captured_at": str,
    "models": dict,
}

# Required runtime_ready payload fields
REQUIRED_READY_PAYLOAD_FIELDS = {
    "groups",
    "sources_per_group",
    "models_loaded",
    "models",
}

# Expected lifecycle event sequence for a clean start→stop
LIFECYCLE_EVENTS = [
    "runtime_starting",
    "runtime_ready",
    "runtime_stopping",
    "runtime_stopped",
]


# ---------------------------------------------------------------------------
# Report accumulator
# ---------------------------------------------------------------------------


class VerificationReport:
    """Collects verification results and writes a structured JSON report."""

    def __init__(self):
        self.started_at = datetime.now(_BEIJING_TZ).isoformat()
        self.environment: Dict[str, str] = {}
        self.steps: List[Dict[str, Any]] = []
        self.summary = {"total": 0, "pass": 0, "fail": 0, "blocked": 0}
        self.evidence: Dict[str, Any] = {}

    def add_step(
        self,
        name: str,
        status: str,  # "pass", "fail", "blocked"
        detail: str = "",
        evidence: Any = None,
    ) -> None:
        entry = {
            "step": name,
            "status": status,
            "detail": detail,
            "timestamp": datetime.now(_BEIJING_TZ).isoformat(),
        }
        if evidence is not None:
            entry["evidence"] = evidence
        self.steps.append(entry)
        self.summary["total"] += 1
        self.summary[status] += 1

    def set_evidence(self, key: str, value: Any) -> None:
        self.evidence[key] = value

    def to_dict(self) -> Dict[str, Any]:
        return {
            "report_version": "t16/v1",
            "started_at": self.started_at,
            "finished_at": datetime.now(_BEIJING_TZ).isoformat(),
            "environment": self.environment,
            "summary": self.summary,
            "steps": self.steps,
            "evidence": self.evidence,
        }

    def write(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=2, ensure_ascii=False, default=str)
        logger.info("Report written to %s", path)


# ---------------------------------------------------------------------------
# Event reader thread
# ---------------------------------------------------------------------------


class EventReader:
    """Reads JSONL events from the runner's stdout in a background thread."""

    def __init__(self, stdout):
        self._stdout = stdout
        self._queue: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._event = threading.Event()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._errors: List[str] = []

    def start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="event-reader")
        self._thread.start()

    def stop(self) -> None:
        self._running = False
        with self._condition:
            self._condition.notify_all()

    def _run(self) -> None:
        """Read lines from stdout and parse as JSON."""
        while self._running:
            try:
                line = self._stdout.readline()
                if not line:
                    # EOF
                    self._running = False
                    break

                line = line.strip()
                if not line:
                    continue

                try:
                    obj = json.loads(line)
                except json.JSONDecodeError as exc:
                    self._errors.append(f"JSON parse error: {exc} (line: {line[:200]})")
                    continue

                if not isinstance(obj, dict):
                    self._errors.append(f"Non-object JSON: {type(obj).__name__}")
                    continue

                with self._condition:
                    self._queue.append(obj)
                    self._condition.notify_all()
                self._event.set()

            except Exception:
                logger.exception("Event reader error")
                self._running = False
                break

    def get_events(self, timeout: float = 5.0) -> List[Dict[str, Any]]:
        """Get all pending events, waiting up to timeout for at least one."""
        if not self._queue:
            self._event.wait(timeout=timeout)
            self._event.clear()

        with self._lock:
            events = list(self._queue)
            self._queue.clear()
        return events

    def wait_for_event_type(
        self,
        event_type: str,
        timeout: float = 30.0,
        request_id: Optional[str] = None,
        command: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Wait for and remove one match without discarding other events."""
        deadline = time.monotonic() + timeout
        with self._condition:
            while True:
                for index, event in enumerate(self._queue):
                    if event.get("type") != event_type:
                        continue
                    payload = event.get("payload", {})
                    if request_id is not None and payload.get("request_id") != request_id:
                        continue
                    if command is not None and payload.get("command") != command:
                        continue
                    return self._queue.pop(index)
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self._running:
                    break
                self._condition.wait(timeout=remaining)
        return None

    def wait_for_match(self, predicate, timeout: float = 30.0) -> Optional[Dict[str, Any]]:
        """Wait for and remove the first event accepted by *predicate*."""
        deadline = time.monotonic() + timeout
        with self._condition:
            while True:
                for index, event in enumerate(self._queue):
                    if predicate(event):
                        return self._queue.pop(index)
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self._running:
                    return None
                self._condition.wait(timeout=remaining)

    def collect_events(
        self,
        event_types: List[str],
        timeout: float = 30.0,
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Collect events of given types until timeout, return grouped."""
        collected: Dict[str, List[Dict[str, Any]]] = {t: [] for t in event_types}
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = max(0.1, deadline - time.monotonic())
            events = self.get_events(timeout=min(remaining, 1.0))
            for event in events:
                et = event.get("type", "")
                if et in collected:
                    collected[et].append(event)
            if not self._running:
                break
        return collected

    @property
    def errors(self) -> List[str]:
        with self._lock:
            return list(self._errors)


# ---------------------------------------------------------------------------
# Frame validation
# ---------------------------------------------------------------------------


def validate_frame_structure(frame_event: Dict[str, Any]) -> List[str]:
    """Validate a frame event's structure against the mock contract.

    Returns a list of validation error messages (empty = valid).
    """
    errors: List[str] = []

    # Top-level envelope
    for field in ("session_id", "event_id", "event_seq", "type", "emitted_at"):
        if field not in frame_event:
            errors.append(f"Missing envelope field: {field}")

    if frame_event.get("type") != "frame":
        errors.append(f"Expected type=frame, got {frame_event.get('type')}")

    schema = frame_event.get("schema_version")
    if schema is None:
        errors.append("Missing schema_version")

    # Payload
    payload = frame_event.get("payload")
    if not isinstance(payload, dict):
        errors.append("Missing or non-object payload")
        return errors

    for field, expected_type in REQUIRED_FRAME_PAYLOAD_FIELDS.items():
        if field not in payload:
            errors.append(f"Missing payload field: {field}")
        elif not isinstance(payload[field], expected_type):
            errors.append(
                f"Wrong type for {field}: expected {expected_type.__name__}, "
                f"got {type(payload[field]).__name__}"
            )

    # Models
    models = payload.get("models", {})
    if isinstance(models, dict):
        for model_id, model_data in models.items():
            if not isinstance(model_data, dict):
                errors.append(f"models.{model_id}: expected dict")
                continue
            if "ok" not in model_data:
                errors.append(f"models.{model_id}: missing 'ok'")
            boxes = model_data.get("boxes", [])
            if isinstance(boxes, list):
                for idx, box in enumerate(boxes):
                    if not isinstance(box, dict):
                        errors.append(f"models.{model_id}.boxes[{idx}]: expected dict")
                        continue
                    for box_field in ("label", "confidence", "polygon"):
                        if box_field not in box:
                            errors.append(
                                f"models.{model_id}.boxes[{idx}]: missing '{box_field}'"
                            )

    return errors


def extract_frame_summary(frame_event: Dict[str, Any]) -> Dict[str, Any]:
    """Extract a lightweight summary from a frame event for the report."""
    payload = frame_event.get("payload", {})
    models = payload.get("models", {})
    labels_found: List[str] = []
    for model_id, model_data in models.items():
        if not isinstance(model_data, dict):
            continue
        for box in model_data.get("boxes", []) or []:
            label = box.get("label", "?")
            conf = box.get("confidence", 0)
            labels_found.append(f"m{model_id}:{label}({conf:.3f})")

    return {
        "event_seq": frame_event.get("event_seq"),
        "group_id": payload.get("group_id"),
        "source_id": payload.get("source_id"),
        "stream_id": payload.get("stream_id"),
        "model_count": len(models),
        "labels": labels_found[:10],  # cap for report size
    }


# ---------------------------------------------------------------------------
# Orphan check
# ---------------------------------------------------------------------------


def check_orphan_processes() -> Tuple[int, List[str]]:
    """Check for orphaned aiban_runner.py processes.

    Returns (count, [descriptions]).
    """
    orphans: List[str] = []
    try:
        import subprocess as sp

        result = sp.run(
            [
                "powershell",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                os.path.join(_PROJECT_ROOT, "tools", "check-orphan-python.ps1"),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        output = result.stdout + result.stderr
        for line in output.splitlines():
            if "ORPHANED" in line or "AiBan runner procs:" in line:
                orphans.append(line.strip())
        # Count from output
        count = output.count("ORPHANED")
        return count, orphans
    except Exception as exc:
        logger.warning("Orphan check failed: %s", exc)
        return -1, [f"Orphan check error: {exc}"]


# ---------------------------------------------------------------------------
# Main verifier
# ---------------------------------------------------------------------------


class RealSdkVerifier:
    """Drives aiban_runner.py and verifies the protocol exchange."""

    def __init__(
        self,
        sdk_home: str = "",
        pipeline_config: str = "",
        working_directory: str = "",
        use_mock: bool = False,
        mock_labels: str = "A,B,C",
        max_frames: int = DEFAULT_MAX_FRAMES,
        startup_timeout: float = DEFAULT_STARTUP_TIMEOUT,
        frame_timeout: float = DEFAULT_FRAME_TIMEOUT,
        stop_timeout: float = DEFAULT_STOP_TIMEOUT,
    ):
        self._sdk_home = sdk_home
        self._pipeline_config = pipeline_config
        self._working_directory = working_directory or _PROJECT_ROOT
        self._use_mock = use_mock
        self._mock_labels = mock_labels
        self._max_frames = max_frames
        self._startup_timeout = startup_timeout
        self._frame_timeout = frame_timeout
        self._stop_timeout = stop_timeout

        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[EventReader] = None
        self._report = VerificationReport()
        self._session_id: Optional[str] = None
        self._pid: Optional[int] = None
        self._primary_source: Tuple[int, int] = (1, 1)
        self._secondary_source: Optional[Tuple[int, int]] = None
        self._stderr_lines: List[str] = []
        self._stderr_thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Environment capture
    # ------------------------------------------------------------------

    def _capture_environment(self) -> None:
        """Record environment info."""
        import platform

        self._report.environment = {
            "hostname": platform.node(),
            "os": f"{platform.system()} {platform.release()}",
            "python_version": sys.version.split()[0],
            "python_executable": sys.executable,
            "sdk_home": self._sdk_home if not self._use_mock else "(mock)",
            "pipeline_config": self._pipeline_config if not self._use_mock else "(mock)",
            "working_directory": self._working_directory,
            "use_mock": str(self._use_mock),
            "max_frames": str(self._max_frames),
            "timestamp": datetime.now(_BEIJING_TZ).isoformat(),
        }

        # Try to get git commit
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                cwd=_PROJECT_ROOT,
                timeout=10,
            )
            if result.returncode == 0:
                self._report.environment["git_commit"] = result.stdout.strip()
        except Exception:
            pass

        logger.info("Environment captured: %s", json.dumps(self._report.environment, indent=2))

    # ------------------------------------------------------------------
    # Spawn
    # ------------------------------------------------------------------

    def _spawn_runner(self) -> bool:
        """Spawn aiban_runner.py as a subprocess."""
        python_exe = sys.executable

        args = [
            python_exe,
            "-u",  # unbuffered stdout
            "-m",
            RUNNER_MODULE,
            "--heartbeat-interval",
            str(DEFAULT_HEARTBEAT_INTERVAL),
        ]

        if self._use_mock:
            args.extend(["--mock", "--labels", self._mock_labels])
            args.extend(["--num-groups", "1", "--num-sources", "2"])
        else:
            if self._sdk_home:
                args.extend(["--sdk-home", self._sdk_home])
            if self._pipeline_config:
                args.extend(["--pipeline-config", self._pipeline_config])
            if self._working_directory:
                args.extend(["--working-directory", self._working_directory])

        logger.info("Spawning: %s", " ".join(args))

        try:
            child_env = os.environ.copy()
            existing_pythonpath = child_env.get("PYTHONPATH", "")
            child_env["PYTHONPATH"] = os.pathsep.join(
                part for part in (_PROJECT_ROOT, existing_pythonpath) if part
            )
            self._proc = subprocess.Popen(
                args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=self._working_directory,
                env=child_env,
            )
            self._pid = self._proc.pid
            self._report.set_evidence("runner_pid", self._pid)
            logger.info("Runner spawned: PID=%d", self._pid)

            # Start event reader
            self._reader = EventReader(self._proc.stdout)
            self._reader.start()
            self._stderr_thread = threading.Thread(
                target=self._read_stderr,
                daemon=True,
                name="stderr-reader",
            )
            self._stderr_thread.start()

            return True
        except Exception as exc:
            logger.exception("Failed to spawn runner")
            self._report.add_step("spawn_runner", "fail", f"Failed to spawn: {exc}")
            return False

    def _read_stderr(self) -> None:
        """Drain stderr continuously so native/Python logs cannot block startup."""
        if not self._proc or not self._proc.stderr:
            return
        for line in self._proc.stderr:
            text = line.rstrip()
            if not text:
                continue
            logger.debug("runner stderr: %s", text)
            self._stderr_lines.append(text)
            if len(self._stderr_lines) > 2000:
                del self._stderr_lines[:500]

    def _record_stderr_evidence(self) -> None:
        if self._stderr_thread and self._stderr_thread.is_alive() and self._proc:
            if self._proc.poll() is not None:
                self._stderr_thread.join(timeout=1.0)
        if self._stderr_lines:
            self._report.set_evidence("runner_stderr_tail", self._stderr_lines[-100:])

    # ------------------------------------------------------------------
    # Send command
    # ------------------------------------------------------------------

    def _send_command(self, command: str, params: Optional[Dict[str, Any]] = None) -> str:
        """Send a JSONL command to the runner's stdin. Returns request_id."""
        request_id = str(uuid.uuid4())
        cmd = json.dumps({
            "schema_version": 1,
            "command": command,
            "request_id": request_id,
            "params": params or {},
        })
        if self._proc and self._proc.stdin:
            self._proc.stdin.write(cmd + "\n")
            self._proc.stdin.flush()
            logger.debug("Sent command: %s (req=%s)", command, request_id)
        return request_id

    # ------------------------------------------------------------------
    # Phase 1: Startup
    # ------------------------------------------------------------------

    def _verify_startup(self) -> bool:
        """Send 'start' command and verify runtime_starting → runtime_ready."""
        logger.info("=== Phase 1: Startup Verification ===")

        request_id = self._send_command("start")

        # Wait for runtime_starting
        event = self._reader.wait_for_event_type("runtime_starting", timeout=self._startup_timeout)
        if event is None:
            self._report.add_step(
                "startup_runtime_starting",
                "fail",
                "Did not receive runtime_starting event",
            )
            return False

        payload = event.get("payload", {})
        self._report.add_step(
            "startup_runtime_starting",
            "pass",
            f"Received runtime_starting: python={payload.get('python_version')}, "
            f"runner={payload.get('runner_version')}",
            {
                "event_seq": event.get("event_seq"),
                "python_version": payload.get("python_version"),
                "runner_version": payload.get("runner_version"),
            },
        )
        self._session_id = event.get("session_id")
        self._report.set_evidence("session_id", self._session_id)

        # Wait for runtime_ready
        event = self._reader.wait_for_match(
            lambda item: item.get("type") == "runtime_ready" or (
                item.get("type") == "command_result"
                and item.get("payload", {}).get("request_id") == request_id
                and item.get("payload", {}).get("ok") is False
            ),
            timeout=self._startup_timeout,
        )
        if event is not None and event.get("type") == "command_result":
            error = event.get("payload", {}).get("error") or "start command failed"
            self._report.add_step(
                "startup_runtime_ready", "fail", f"SDK startup failed: {error}"
            )
            return False
        if event is None:
            self._report.add_step(
                "startup_runtime_ready",
                "fail",
                "Did not receive runtime_ready event within timeout",
            )
            return False

        payload = event.get("payload", {})
        # Validate metadata
        missing_fields = REQUIRED_READY_PAYLOAD_FIELDS - set(payload.keys())
        if missing_fields:
            self._report.add_step(
                "startup_ready_metadata",
                "fail",
                f"runtime_ready payload missing fields: {missing_fields}",
                list(payload.keys()),
            )
            return False

        groups = payload.get("groups", [])
        sources = payload.get("sources_per_group", {})
        models = payload.get("models_loaded", [])

        self._report.add_step(
            "startup_runtime_ready",
            "pass",
            f"Received runtime_ready: {len(groups)} groups, "
            f"sources_per_group={sources}, models_loaded={models}",
            {
                "event_seq": event.get("event_seq"),
                "session_id": event.get("session_id"),
                "group_count": len(groups),
                "groups": [
                    {
                        "group_id": g.get("group_id"),
                        "name": g.get("name"),
                        "enabled": g.get("enabled"),
                        "source_count": len(g.get("sources", [])),
                        "model_ids": g.get("model_ids"),
                    }
                    for g in groups
                ],
                "sources_per_group": sources,
                "models_loaded": models,
            },
        )
        self._report.set_evidence("ready_metadata", {
            "groups": groups,
            "sources_per_group": sources,
            "models_loaded": models,
        })

        available_sources: List[Tuple[int, int]] = []
        for group in groups:
            if not isinstance(group, dict) or group.get("enabled") is False:
                continue
            group_id = int(group.get("group_id", 0))
            for source in group.get("sources", []):
                if not isinstance(source, dict) or source.get("enabled") is False:
                    continue
                available_sources.append((group_id, int(source.get("source_id", 0))))
        if available_sources:
            self._primary_source = available_sources[0]
        if len(available_sources) > 1:
            self._secondary_source = available_sources[1]
        self._report.set_evidence("source_control_targets", {
            "primary": list(self._primary_source),
            "secondary": list(self._secondary_source) if self._secondary_source else None,
        })

        # Verify session_id matches
        if event.get("session_id") != self._session_id:
            self._report.add_step(
                "startup_session_consistency",
                "fail",
                f"Session ID mismatch: {self._session_id} vs {event.get('session_id')}",
            )
        else:
            self._report.add_step(
                "startup_session_consistency",
                "pass",
                f"Session ID consistent: {self._session_id}",
            )

        return True

    # ------------------------------------------------------------------
    # Phase 2: Frame verification
    # ------------------------------------------------------------------

    def _verify_frames(self) -> bool:
        """Collect and validate frame events."""
        logger.info("=== Phase 2: Frame Verification ===")

        frames: List[Dict[str, Any]] = []
        validation_errors: List[str] = []
        seq_numbers: List[int] = []
        deadline = time.monotonic() + self._frame_timeout

        while len(frames) < self._max_frames and time.monotonic() < deadline:
            remaining = min(1.0, deadline - time.monotonic())
            if remaining <= 0:
                break
            events = self._reader.get_events(timeout=remaining)
            for event in events:
                if event.get("type") == "frame":
                    frames.append(event)
                    seq_numbers.append(event.get("event_seq", -1))

        if not frames:
            self._report.add_step(
                "frames_received",
                "fail",
                f"No frames received within {self._frame_timeout}s",
            )
            return False

        self._report.add_step(
            "frames_received",
            "pass",
            f"Received {len(frames)} frames",
            {"frame_count": len(frames), "max_frames_target": self._max_frames},
        )

        # Validate each frame
        for frame in frames:
            errors = validate_frame_structure(frame)
            if errors:
                validation_errors.extend(
                    [f"Frame seq={frame.get('event_seq')}: {e}" for e in errors]
                )

        if validation_errors:
            self._report.add_step(
                "frames_structure",
                "fail",
                f"{len(validation_errors)} validation errors in {len(frames)} frames",
                validation_errors[:20],
            )
        else:
            self._report.add_step(
                "frames_structure",
                "pass",
                f"All {len(frames)} frames match the mock contract structure",
            )

        # Check monotonic event_seq
        gaps = []
        for i in range(1, len(seq_numbers)):
            if seq_numbers[i] != seq_numbers[i - 1] + 1 and seq_numbers[i] > 0 and seq_numbers[i - 1] > 0:
                gaps.append(f"seq {seq_numbers[i-1]} → {seq_numbers[i]}")

        if gaps:
            self._report.add_step(
                "frames_sequence_monotonic",
                "fail",
                f"Non-monotonic event_seq gaps: {gaps[:5]}",
                {"gaps": gaps, "seq_range": [min(seq_numbers), max(seq_numbers)]},
            )
        else:
            self._report.add_step(
                "frames_sequence_monotonic",
                "pass",
                f"event_seq monotonic from {min(seq_numbers)} to {max(seq_numbers)}",
            )

        # Sample frame summaries
        frame_summaries = [extract_frame_summary(f) for f in frames[:5]]
        self._report.set_evidence("frame_samples", frame_summaries)

        # Extract unique labels
        all_labels: set = set()
        for f in frames:
            payload = f.get("payload", {})
            for model_id, model_data in payload.get("models", {}).items():
                if not isinstance(model_data, dict):
                    continue
                for box in model_data.get("boxes", []) or []:
                    all_labels.add(box.get("label", "?"))

        self._report.set_evidence("labels_detected", sorted(all_labels))
        self._report.add_step(
            "frames_labels",
            "pass",
            f"Labels detected: {sorted(all_labels)}",
            sorted(all_labels),
        )

        return len(validation_errors) == 0

    # ------------------------------------------------------------------
    # Phase 3: Health check
    # ------------------------------------------------------------------

    def _verify_health(self) -> bool:
        """Send health command and verify response."""
        logger.info("=== Phase 3: Health Check ===")

        request_id = self._send_command("health")

        event = self._reader.wait_for_event_type(
            "command_result", timeout=10.0, request_id=request_id, command="health"
        )
        if event is None:
            self._report.add_step("health_check", "fail", "No command_result for health")
            return False

        payload = event.get("payload", {})
        result = payload.get("result", {})
        ok = payload.get("ok", False)

        if not ok:
            self._report.add_step(
                "health_check",
                "fail",
                f"Health command failed: {payload.get('error')}",
            )
            return False

        state = result.get("state", "unknown")
        uptime = result.get("uptime_seconds", 0)
        frames = result.get("frames_emitted", 0)

        if state != "ready":
            self._report.add_step(
                "health_check_state",
                "fail",
                f"Expected state=ready, got state={state}",
            )
            return False

        self._report.add_step(
            "health_check",
            "pass",
            f"Health OK: state={state}, uptime={uptime:.1f}s, frames={frames}",
            {"state": state, "uptime_seconds": uptime, "frames_emitted": frames},
        )
        return True

    # ------------------------------------------------------------------
    # Phase 4: Source pause/resume
    # ------------------------------------------------------------------

    def _verify_source_control(self) -> bool:
        """Test pause_source and resume_source commands."""
        logger.info("=== Phase 4: Source Pause/Resume ===")

        group_id, source_id = self._primary_source
        request_id = self._send_command(
            "pause_source", {"group_id": group_id, "source_id": source_id}
        )
        event = self._reader.wait_for_event_type(
            "command_result", timeout=10.0,
            request_id=request_id, command="pause_source",
        )
        if event is None:
            self._report.add_step("source_pause", "fail", "No response to pause_source")
            return False

        payload = event.get("payload", {})
        if not payload.get("ok"):
            self._report.add_step(
                "source_pause",
                "fail",
                f"pause_source failed: {payload.get('error')}",
            )
        else:
            self._report.add_step(
                "source_pause",
                "pass",
                f"Source paused: {payload.get('result', {})}",
            )

        # Let an in-flight callback settle, drain pre-ack frames, and then
        # observe that only the selected source stopped.  A second source is
        # used when the Pipeline exposes one.
        time.sleep(0.25)
        self._reader.get_events(timeout=0.05)
        observed = self._reader.collect_events(["frame"], timeout=1.0)["frame"]
        primary_frames = [
            frame for frame in observed
            if int(frame.get("payload", {}).get("group_id", -1)) == group_id
            and int(frame.get("payload", {}).get("source_id", -1)) == source_id
        ]
        secondary_frames: List[Dict[str, Any]] = []
        if self._secondary_source:
            secondary_group, secondary_source = self._secondary_source
            secondary_frames = [
                frame for frame in observed
                if int(frame.get("payload", {}).get("group_id", -1)) == secondary_group
                and int(frame.get("payload", {}).get("source_id", -1)) == secondary_source
            ]
        isolation_ok = len(primary_frames) == 0 and (
            self._secondary_source is None or len(secondary_frames) > 0
        )
        self._report.add_step(
            "source_pause_isolation",
            "pass" if isolation_ok else "fail",
            f"paused g={group_id}/s={source_id}: primary_frames={len(primary_frames)}, "
            f"secondary_frames={len(secondary_frames)}",
            {
                "primary": [group_id, source_id],
                "primary_frames": len(primary_frames),
                "secondary": list(self._secondary_source) if self._secondary_source else None,
                "secondary_frames": len(secondary_frames),
            },
        )

        request_id = self._send_command(
            "resume_source", {"group_id": group_id, "source_id": source_id}
        )
        event = self._reader.wait_for_event_type(
            "command_result", timeout=10.0,
            request_id=request_id, command="resume_source",
        )
        if event is None:
            self._report.add_step("source_resume", "fail", "No response to resume_source")
            return False

        payload = event.get("payload", {})
        if not payload.get("ok"):
            self._report.add_step(
                "source_resume",
                "fail",
                f"resume_source failed: {payload.get('error')}",
            )
        else:
            self._report.add_step(
                "source_resume",
                "pass",
                f"Source resumed: {payload.get('result', {})}",
            )

        resumed = self._reader.collect_events(
            ["frame"], timeout=min(max(self._frame_timeout, 1.0), 5.0)
        )["frame"]
        resumed_primary = [
            frame for frame in resumed
            if int(frame.get("payload", {}).get("group_id", -1)) == group_id
            and int(frame.get("payload", {}).get("source_id", -1)) == source_id
        ]
        self._report.add_step(
            "source_resume_frames",
            "pass" if resumed_primary else "fail",
            f"received {len(resumed_primary)} frame(s) after resume for g={group_id}/s={source_id}",
        )

        return isolation_ok and bool(resumed_primary)

    # ------------------------------------------------------------------
    # Phase 5: Screenshot
    # ------------------------------------------------------------------

    def _verify_screenshot(self) -> bool:
        """Test screenshot command."""
        logger.info("=== Phase 5: Screenshot ===")

        group_id, source_id = self._primary_source
        request_id = self._send_command(
            "screenshot", {"group_id": group_id, "source_id": source_id}
        )

        cmd_event = self._reader.wait_for_event_type(
            "command_result", timeout=10.0,
            request_id=request_id, command="screenshot",
        )
        ss_event = self._reader.wait_for_event_type(
            "screenshot_result", timeout=10.0, request_id=request_id,
        )

        if cmd_event is None:
            self._report.add_step("screenshot_command", "fail", "No command_result for screenshot")
            return False

        cmd_payload = cmd_event.get("payload", {})
        if not cmd_payload.get("ok"):
            self._report.add_step(
                "screenshot_command",
                "fail",
                f"Screenshot command failed: {cmd_payload.get('error')}",
            )

        if ss_event is None:
            self._report.add_step(
                "screenshot_result",
                "fail",
                "No screenshot_result event (may be expected in mock mode with fast timing)",
            )
            return False

        ss_payload = ss_event.get("payload", {})
        image_path = ss_payload.get("image_path", "")
        ok = ss_payload.get("ok", False)

        if ok and image_path:
            self._report.add_step(
                "screenshot",
                "pass",
                f"Screenshot captured: {image_path}",
                {"image_path": image_path},
            )
        elif ok and not image_path:
            self._report.add_step(
                "screenshot",
                "pass",
                "Screenshot accepted but empty path (may be expected if no frame arrived)",
                {"image_path": image_path},
            )
        else:
            self._report.add_step(
                "screenshot",
                "fail",
                f"Screenshot failed: {ss_payload.get('error')}",
            )

        return True

    # ------------------------------------------------------------------
    # Phase 6: Graceful stop
    # ------------------------------------------------------------------

    def _verify_stop(self) -> bool:
        """Send stop command and verify clean shutdown."""
        logger.info("=== Phase 6: Stop Verification ===")

        self._send_command("stop")

        # Wait for runtime_stopping
        event = self._reader.wait_for_event_type("runtime_stopping", timeout=self._stop_timeout)
        if event is None:
            # Try runtime_stopped directly (stop may be fast)
            event = self._reader.wait_for_event_type("runtime_stopped", timeout=5.0)
            if event is None:
                self._report.add_step(
                    "stop_events",
                    "fail",
                    "Did not receive runtime_stopping or runtime_stopped",
                )
                return False
            self._report.add_step(
                "stop_runtime_stopping",
                "pass",
                "runtime_stopped received (stopping was immediate)",
            )
        else:
            self._report.add_step(
                "stop_runtime_stopping",
                "pass",
                f"Received runtime_stopping: frames_emitted={event.get('payload', {}).get('frames_emitted')}",
            )

        # Wait for runtime_stopped if not already seen
        if event is None or event.get("type") != "runtime_stopped":
            event = self._reader.wait_for_event_type("runtime_stopped", timeout=self._stop_timeout)
            if event is None:
                self._report.add_step(
                    "stop_runtime_stopped",
                    "fail",
                    "Did not receive runtime_stopped",
                )
                return False

        payload = event.get("payload", {}) if event else {}
        self._report.add_step(
            "stop_runtime_stopped",
            "pass",
            f"Received runtime_stopped: exit_code={payload.get('exit_code')}",
            {
                "exit_code": payload.get("exit_code"),
                "reason": payload.get("reason"),
                "frames_emitted": payload.get("frames_emitted"),
            },
        )

        # Wait for process exit
        try:
            returncode = self._proc.wait(timeout=self._stop_timeout)
            if returncode == 0:
                self._report.add_step(
                    "stop_process_exit",
                    "pass",
                    f"Process exited with code {returncode}",
                    {"exit_code": returncode},
                )
            else:
                self._report.add_step(
                    "stop_process_exit",
                    "fail",
                    f"Process exited with non-zero code: {returncode}",
                    {"exit_code": returncode},
                )
        except subprocess.TimeoutExpired:
            self._report.add_step(
                "stop_process_exit",
                "fail",
                "Process did not exit within timeout, sending SIGTERM",
            )
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5.0)
                self._report.add_step(
                    "stop_process_kill",
                    "pass",
                    "Process terminated after SIGTERM",
                )
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._report.add_step(
                    "stop_process_kill",
                    "fail",
                    "Process required SIGKILL",
                )

        return True

    # ------------------------------------------------------------------
    # Phase 7: Orphan check
    # ------------------------------------------------------------------

    def _verify_orphans(self) -> bool:
        """Check for orphan processes."""
        logger.info("=== Phase 7: Orphan Process Check ===")

        count, details = check_orphan_processes()

        if count == 0:
            self._report.add_step(
                "orphan_check",
                "pass",
                "No orphan AiBan Runner processes found",
                {"count": count},
            )
            return True
        elif count > 0:
            self._report.add_step(
                "orphan_check",
                "fail",
                f"Found {count} orphan process(es)",
                {"count": count, "details": details},
            )
            return False
        else:
            self._report.add_step(
                "orphan_check",
                "blocked",
                "Could not run orphan check",
                {"details": details},
            )
            return True  # Not a hard failure

    # ------------------------------------------------------------------
    # Main run
    # ------------------------------------------------------------------

    def run(self, output_path: str) -> int:
        """Run all verification phases and write the report.

        Returns:
            0 if all phases pass, 1 if any fail, 2 if blocked.
        """
        logger.info("=" * 60)
        logger.info("AiBan Real SDK Verification (T16)")
        logger.info("=" * 60)

        # Environment
        self._capture_environment()

        # Spawn
        if not self._spawn_runner():
            self._report.write(output_path)
            return 1

        try:
            # Phase 1: Startup
            if not self._verify_startup():
                self._cleanup()
                self._report.write(output_path)
                return 1

            # Phase 2: Frames
            frames_ok = self._verify_frames()

            # Phase 3: Health
            self._verify_health()

            # Phase 4: Source control
            self._verify_source_control()

            # Phase 5: Screenshot
            self._verify_screenshot()

            # Phase 6: Stop
            stop_ok = self._verify_stop()

            # Phase 7: Orphans
            orphan_ok = self._verify_orphans()

        except Exception as exc:
            logger.exception("Verification failed with exception")
            self._report.add_step("unhandled_error", "fail", str(exc))
            self._cleanup()
            self._report.write(output_path)
            return 1

        # Collect reader errors
        if self._reader and self._reader.errors:
            self._report.add_step(
                "protocol_errors",
                "fail",
                f"{len(self._reader.errors)} protocol parse errors",
                self._reader.errors[:10],
            )

        # Final summary
        self._record_stderr_evidence()
        self._report.write(output_path)

        summary = self._report.summary
        logger.info(
            "Verification complete: %d pass, %d fail, %d blocked (of %d steps)",
            summary["pass"], summary["fail"], summary["blocked"], summary["total"],
        )

        if summary["fail"] > 0:
            return 1
        if summary["blocked"] > 0:
            return 2
        return 0

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def _cleanup(self) -> None:
        """Force cleanup of the runner process."""
        if self._reader:
            self._reader.stop()
        if self._proc and self._proc.poll() is None:
            logger.warning("Force-terminating runner process PID=%d", self._proc.pid)
            try:
                self._proc.terminate()
                self._proc.wait(timeout=5.0)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        self._record_stderr_evidence()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="AiBan Real SDK Closed-Loop Verification (T16)",
    )
    parser.add_argument("--sdk-home", default="", help="AiBan SDK directory")
    parser.add_argument("--pipeline-config", default="", help="Pipeline YAML path")
    parser.add_argument("--working-directory", default="", help="Working directory")
    parser.add_argument("--mock", action="store_true", help="Use mock SDK (for testing the verifier)")
    parser.add_argument("--mock-labels", default="A,B,C", help="[Mock] Comma-separated labels")
    parser.add_argument("--max-frames", type=int, default=DEFAULT_MAX_FRAMES, help="Max frames to collect")
    parser.add_argument("--startup-timeout", type=float, default=DEFAULT_STARTUP_TIMEOUT, help="Startup timeout seconds")
    parser.add_argument("--frame-timeout", type=float, default=DEFAULT_FRAME_TIMEOUT, help="Frame collection timeout seconds")
    parser.add_argument("--stop-timeout", type=float, default=DEFAULT_STOP_TIMEOUT, help="Stop timeout seconds")
    parser.add_argument("--output", "-o", default="report-t16.json", help="Output report path")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")

    args = parser.parse_args()
    _setup_logging(verbose=args.verbose)

    # Validate: either --mock or --sdk-home + --pipeline-config
    if not args.mock:
        if not args.sdk_home:
            logger.warning("No --sdk-home provided; real SDK may fail to load")
        if not args.pipeline_config:
            logger.warning("No --pipeline-config provided; real SDK may fail to start")

    verifier = RealSdkVerifier(
        sdk_home=args.sdk_home,
        pipeline_config=args.pipeline_config,
        working_directory=args.working_directory,
        use_mock=args.mock,
        mock_labels=args.mock_labels,
        max_frames=args.max_frames,
        startup_timeout=args.startup_timeout,
        frame_timeout=args.frame_timeout,
        stop_timeout=args.stop_timeout,
    )

    exit_code = verifier.run(args.output)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
