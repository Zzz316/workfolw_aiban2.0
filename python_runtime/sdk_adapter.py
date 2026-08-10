"""AiBan SDK Adapter — wraps SDK calls and manages callback registration.

Supports two modes:
  - real: Uses the actual AiBan SDK (libAiBanVideoPy3_9).
  - mock: Uses MockAibanSDK for development/testing without hardware.

All SDK metadata access happens inside callbacks and is converted to plain
Python dicts before leaving the callback scope (per SDK constraints).
"""

import logging
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


def _is_sdk_success(result: Any) -> bool:
    """Accept AiBan success values across wrapper/extension variants."""
    if result is True:
        return True
    if getattr(result, "name", None) == "aSUCCESS":
        return True
    value = getattr(result, "value", result)
    if isinstance(value, tuple) and value:
        value = value[0]
    return value == 0


# ---------------------------------------------------------------------------
# Type aliases
# ---------------------------------------------------------------------------

FrameCallback = Callable[[int, int, Dict[str, Any]], None]
EventCallback = Callable[[str, str], None]


# ---------------------------------------------------------------------------
# Mock SDK
# ---------------------------------------------------------------------------

class MockAibanSDK:
    """Mock AiBan SDK for development and testing.

    Produces synthetic detection frames at a configurable rate using a
    background thread. No hardware or real SDK required.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self._config = config or {}
        self._running = False
        self._frame_cb: Optional[FrameCallback] = None
        self._event_cb: Optional[EventCallback] = None
        self._save_image_cb: Optional[Callable] = None
        self._thread = None

        # Configurable test parameters
        self.frame_interval_ms = self._config.get("frame_interval_ms", 200)
        self.num_groups = self._config.get("num_groups", 1)
        self.num_sources = self._config.get("num_sources", 1)
        self.model_ids = self._config.get("model_ids", [1])
        self.labels = self._config.get("labels", ["A", "B", "C"])
        self.fail_config_check = self._config.get("fail_config_check", False)
        self.fail_build_pipeline = self._config.get("fail_build_pipeline", False)
        self.sdk_event_messages = self._config.get("sdk_event_messages", [])
        self._paused_sources = set()
        self._pause_lock = threading.Lock()

    def registerVideoResultFunc(self, cb: FrameCallback) -> None:
        self._frame_cb = cb

    def registerVideoMsgEventFunc(self, cb: EventCallback) -> None:
        self._event_cb = cb

    def registerVideoSaveImageFunc(self, cb: Callable) -> None:
        self._save_image_cb = cb

    def checkAllConfig(self, yaml_path: str) -> bool:
        if self.fail_config_check:
            logger.error("Mock SDK: checkAllConfig failed (configured to fail)")
            return False
        logger.info("Mock SDK: checkAllConfig(%s) OK", yaml_path)
        return True

    def buildPipline(self) -> None:
        if self.fail_build_pipeline:
            raise RuntimeError("Mock SDK: buildPipline failed (configured to fail)")
        logger.info("Mock SDK: buildPipline OK, starting frame generation")
        self._running = True
        import threading

        self._thread = threading.Thread(target=self._generate_frames, daemon=True)
        self._thread.start()

    def stopPipline(self) -> None:
        self._running = False
        if self._thread:
            self._thread.join(timeout=5.0)
        logger.info("Mock SDK: stopPipline OK")

    def sourceControl(self, group_id: int, source_id: int, b_run: bool) -> None:
        key = (int(group_id), int(source_id))
        with self._pause_lock:
            if b_run:
                self._paused_sources.discard(key)
            else:
                self._paused_sources.add(key)
        logger.info(
            "Mock SDK: sourceControl group=%d source=%d run=%s",
            group_id, source_id, b_run,
        )

    def _generate_frames(self) -> None:
        """Background thread: emit synthetic frames at frame_interval_ms."""
        import random

        counter = 0
        while self._running:
            if self._frame_cb:
                for group_id in range(1, self.num_groups + 1):
                    for source_id in range(1, self.num_sources + 1):
                        with self._pause_lock:
                            if (group_id, source_id) in self._paused_sources:
                                continue
                        metadata = MockMetadata(
                            group_id, source_id,
                            self.model_ids, self.labels, counter,
                        )
                        try:
                            self._frame_cb(0, group_id, source_id, metadata)
                        except Exception:
                            logger.exception("Error in frame callback")
                counter += 1
            time.sleep(self.frame_interval_ms / 1000.0)

            # Emit any configured SDK events
            if self._event_cb and self.sdk_event_messages:
                for msg in self.sdk_event_messages:
                    self._event_cb("info", msg)


class MockMetadata:
    """Simulates AiBan SDK metadata object for a single frame."""

    def __init__(self, group_id, source_id, model_ids, labels, counter):
        self._group_id = group_id
        self._source_id = source_id
        self._model_ids = model_ids
        self._labels = labels
        self._counter = counter
        self._time_flag = None
        import datetime
        self._datetime = datetime.datetime.now()

    def getModelInferBoxs(self, model_id: int):
        """Return (ok, [boxes]) for a given model."""
        import random
        if model_id not in self._model_ids:
            return (False, [])
        boxes = []
        for idx, label in enumerate(self._labels):
            # Emit one deterministic label per frame and cycle through the
            # configured sequence.  The previous expression simplified to
            # ``idx % len(labels) == 0`` and therefore emitted only the first
            # label forever, which made the T16 mock path incapable of
            # exercising an A -> B -> C closed loop.
            if idx == self._counter % len(self._labels):
                boxes.append(MockBox(
                    label=label,
                    label_index=idx,
                    confidence=0.7 + random.random() * 0.25,
                    tracker_id=self._counter * 100 + idx,
                    polygon=[[0, 0], [100, 0], [100, 100], [0, 100]],
                ))
        return (True, boxes)

    def getAllModelInferBoxes(self):
        """Return {model_id: (ok, [boxes])} for all models."""
        result = {}
        for mid in self._model_ids:
            result[str(mid)] = self.getModelInferBoxs(mid)
        return result

    def saveImage(self, flag: int = 0) -> bool:
        return True

    def getSaveImagePath(self) -> str:
        import os, tempfile
        return os.path.join(tempfile.gettempdir(), f"mock_capture_{self._counter}.jpg")

    def getTimeFlagDatetime(self):
        return self._datetime


class MockBox:
    """Simulates an AiBan SDK inference box."""

    def __init__(self, label, label_index, confidence, tracker_id=-1, polygon=None):
        self._label = label
        self._label_index = label_index
        self._confidence = confidence
        self._tracker_id = tracker_id
        self._polygon = polygon or []

    def getLabelName(self) -> str:
        return self._label

    def getLabelIndex(self) -> int:
        return self._label_index

    def getConfidence(self) -> float:
        return self._confidence

    def getPolygon(self) -> list:
        return self._polygon

    def getTrackerId(self) -> int:
        return self._tracker_id

    def getInferBoxWithModelID(self, sub_id: int):
        """Return (err, [sub_boxes]). No sub-models in mock by default."""
        return (0, [])


# ---------------------------------------------------------------------------
# SDK Adapter
# ---------------------------------------------------------------------------

class SdkAdapter:
    """Wraps the AiBan SDK (or Mock) and manages callback lifecycle.

    All SDK metadata is read inside callbacks and converted to plain Python
    dicts before being passed to the output queue. This satisfies the SDK
    constraint that metadata is only valid during the callback's execution.
    """

    def __init__(
        self,
        sdk_home: str = "",
        use_mock: bool = False,
        mock_config: Optional[Dict[str, Any]] = None,
    ):
        self._sdk_home = sdk_home
        self._use_mock = use_mock
        self._mock_config = mock_config or {}
        self._sdk = None
        self._sdk_module = None
        self._lite_sdk_module = None
        self._dll_directory = None
        self._frame_handler: Optional[FrameCallback] = None
        self._event_handler: Optional[EventCallback] = None
        self._pipeline_started = False

        # On-demand screenshot support.  For the real SDK, saveImage()
        # / getSaveImagePath() are only valid inside the frame callback.
        # Pending requests wait here; _on_frame signals them.
        self._screenshot_lock = threading.Lock()
        # (group_id, source_id) → (threading.Event, [image_path])
        self._screenshot_requests: Dict[
            Tuple[int, int], tuple
        ] = {}

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def pipeline_started(self) -> bool:
        return self._pipeline_started

    # ------------------------------------------------------------------
    # SDK factory
    # ------------------------------------------------------------------

    def _create_sdk(self):
        """Create the SDK instance (real or mock)."""
        if self._use_mock:
            logger.info("SdkAdapter: using Mock SDK")
            return MockAibanSDK(self._mock_config)
        else:
            logger.info("SdkAdapter: loading real AiBan SDK from %s", self._sdk_home)
            # The deployed SDK exposes version-specific extension modules.
            import importlib
            import os
            if self._sdk_home and os.path.isdir(self._sdk_home):
                if self._sdk_home not in sys.path:
                    sys.path.append(self._sdk_home)
                if hasattr(os, "add_dll_directory"):
                    self._dll_directory = os.add_dll_directory(self._sdk_home)

            video_module_name = "libAiBanVideoPy{}_{}".format(
                sys.version_info.major, sys.version_info.minor
            )
            lite_module_name = "libAiBanLitePy{}_{}".format(
                sys.version_info.major, sys.version_info.minor
            )
            try:
                self._sdk_module = importlib.import_module(video_module_name)
                self._lite_sdk_module = importlib.import_module(lite_module_name)
                return self._sdk_module.aibanVideoGetInstance()
            except ImportError as exc:
                raise RuntimeError(
                    "Cannot import {} / {} from {}: {}".format(
                        video_module_name, lite_module_name, self._sdk_home, exc
                    )
                ) from exc

    # ------------------------------------------------------------------
    # Callback registration
    # ------------------------------------------------------------------

    def _on_frame(self, err: int, group_id: int, source_id: int, metadata) -> None:
        """SDK frame callback — extract all data within callback scope."""
        import time
        callback_started_ns = time.perf_counter_ns()
        sdk_received_at_ms = time.time_ns() / 1_000_000
        if err != 0:
            logger.error("SDK frame callback error: err=%d", err)
            return
        if not self._frame_handler:
            return

        # ── On-demand screenshot ──────────────────────────────────────
        # If a screenshot was requested for this source, save the image
        # now while the metadata is still valid, then signal the waiter.
        key = (int(group_id), int(source_id))
        with self._screenshot_lock:
            entry = self._screenshot_requests.pop(key, None)
        if entry is not None:
            event, holder = entry
            try:
                metadata.saveImage(False)
                holder[0] = metadata.getSaveImagePath() or ""
            except Exception:
                logger.exception(
                    "Screenshot saveImage failed g=%d s=%d",
                    group_id, source_id,
                )
            event.set()

        try:
            frame_data = _extract_frame_data(group_id, source_id, metadata)
            frame_data["sdk_received_at_ms"] = round(sdk_received_at_ms, 3)
            frame_data["sdk_convert_ms"] = round(
                (time.perf_counter_ns() - callback_started_ns) / 1_000_000, 3
            )
            self._frame_handler(group_id, source_id, frame_data)
        except Exception:
            logger.exception("Error in frame callback extraction")

    def _on_sdk_event(self, *args) -> None:
        """SDK event callback."""
        if self._event_handler:
            try:
                if len(args) >= 3:
                    msg_type, status, messages = args[:3]
                    # AiBan SDK uses True for success. Accreditation success is
                    # emitted periodically, so suppress it just as the legacy
                    # runtime did; otherwise it floods Node-RED every ~20s.
                    if "accredit" in str(msg_type).lower() and bool(status):
                        return
                    level = "info" if bool(status) else "error"
                    message = "type={} status={} message={}".format(
                        msg_type, status, messages
                    )
                elif len(args) == 2:
                    level, message = args
                else:
                    level, message = "info", " ".join(str(item) for item in args)
                self._event_handler(str(level), str(message))
            except Exception:
                logger.exception("Error in SDK event callback")

    def set_frame_handler(self, handler: FrameCallback) -> None:
        """Set the handler for inference frame events (called from output thread)."""
        self._frame_handler = handler

    def set_event_handler(self, handler: EventCallback) -> None:
        """Set the handler for SDK status/log events."""
        self._event_handler = handler

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def check_config(self, yaml_path: str) -> bool:
        """Validate pipeline configuration."""
        if self._sdk is None:
            self._sdk = self._create_sdk()
        self._sdk.registerVideoResultFunc(self._on_frame)
        self._sdk.registerVideoMsgEventFunc(self._on_sdk_event)
        result = self._sdk.checkAllConfig(yaml_path)
        success = result is True if self._use_mock else _is_sdk_success(result)
        if not success:
            logger.error("SDK checkAllConfig failed for %s", yaml_path)
        return success

    def build_pipeline(self) -> None:
        """Start the SDK pipeline (blocking call in real SDK, non-blocking in mock)."""
        result = self._sdk.buildPipline()
        if not self._use_mock and not _is_sdk_success(result):
            raise RuntimeError("buildPipline returned {!r}".format(result))
        self._pipeline_started = True

    def stop_pipeline(self) -> None:
        """Stop the SDK pipeline gracefully."""
        if self._sdk and self._pipeline_started:
            self._sdk.stopPipline()
            self._pipeline_started = False

    def source_control(self, group_id: int, source_id: int, run: bool) -> None:
        """Pause or resume a video source."""
        if self._sdk:
            self._sdk.sourceControl(group_id, source_id, run)

    def do_screenshot(
        self, group_id: int, source_id: int, timeout: float = 5.0
    ) -> Optional[str]:
        """Take a screenshot and return the saved image path.

        Mock mode:
            Returns a V1-format path immediately (no actual file).

        Real SDK:
            Blocks until the next frame callback for this source, calls
            ``metadata.saveImage(False)`` + ``getSaveImagePath()`` inside
            the callback, and returns the path.  Times out after *timeout*
            seconds if no frame arrives.
        """
        if not self._sdk:
            return None

        if self._use_mock:
            import time as _time
            now = _time.time()
            day_str = _time.strftime("%Y-%m-%d", _time.localtime(now))
            time_str = _time.strftime("%H%M%S", _time.localtime(now))
            ms = int((now % 1) * 1000)
            filename = f"{time_str}_{ms:03d}.jpg"
            image_path = (
                f"D:/product/ngimages/group_{group_id}/"
                f"source_{source_id}/{day_str}/{filename}"
            )
            logger.info(
                "Mock screenshot: g=%d s=%d → %s",
                group_id, source_id, image_path,
            )
            return image_path

        # Real SDK — wait for the next frame callback
        key = (int(group_id), int(source_id))
        event = threading.Event()
        holder: list = [""]  # mutable container

        with self._screenshot_lock:
            self._screenshot_requests[key] = (event, holder)

        logger.info(
            "Screenshot queued for g=%d s=%d (waiting for next frame, "
            "timeout=%.0fs)",
            group_id, source_id, timeout,
        )
        if event.wait(timeout=timeout):
            path = holder[0]
            logger.info(
                "Screenshot completed: g=%d s=%d → %s",
                group_id, source_id, path,
            )
            return path
        else:
            with self._screenshot_lock:
                self._screenshot_requests.pop(key, None)
            logger.warning(
                "Screenshot timeout for g=%d s=%d (no frame in %.0fs)",
                group_id, source_id, timeout,
            )
            return ""


# ---------------------------------------------------------------------------
# Metadata extraction helpers
# ---------------------------------------------------------------------------

def _extract_frame_data(group_id: int, source_id: int, metadata) -> Dict[str, Any]:
    """Extract all inference data from SDK metadata into a plain dict.

    MUST be called within the SDK callback scope — metadata is not valid outside.
    """
    from python_runtime.protocol import now_iso

    stream_id = f"group-{group_id}/source-{source_id}"

    # Get all model results
    all_models = metadata.getAllModelInferBoxes()

    models_data = {}
    for model_id, (ok, boxes) in all_models.items():
        if not ok:
            models_data[str(model_id)] = {"ok": False, "boxes": []}
            continue

        boxes_data = []
        for box in boxes:
            box_dict = _extract_box_data(box)
            boxes_data.append(box_dict)

        models_data[str(model_id)] = {"ok": True, "boxes": boxes_data}

    # Get capture timestamp
    captured_at = now_iso()
    dt = metadata.getTimeFlagDatetime()
    if dt is not None:
        # Try to get ISO format from the datetime
        try:
            captured_at = dt.isoformat()
        except Exception:
            pass

    return {
        "group_id": group_id,
        "source_id": source_id,
        "stream_id": stream_id,
        "captured_at": captured_at,
        "models": models_data,
    }


def _extract_box_data(box) -> Dict[str, Any]:
    """Extract a single box's data into a plain dict."""
    # Sub-models (recursive)
    sub_models = {}
    try:
        # sub_models are accessed via getInferBoxWithModelID for each known sub-model ID
        # But we don't know sub-model IDs at extraction time.
        # In real usage, the YAML config tells us which sub-model IDs to query.
        # For now, we leave sub_models empty; the caller can enrich if needed.
        pass
    except Exception:
        pass

    # Polygon
    polygon = []
    try:
        raw = box.getPolygon()
        if raw:
            polygon = [[float(p[0]), float(p[1])] for p in raw]
    except Exception:
        pass

    # Tracker ID
    tracker_id = -1
    try:
        tracker_id = getattr(box, '_tracker_id', -1)
        if hasattr(box, 'getTrackerId'):
            tracker_id = box.getTrackerId()
    except Exception:
        pass

    return {
        "label": box.getLabelName(),
        "label_index": box.getLabelIndex(),
        "confidence": round(float(box.getConfidence()), 4),
        "polygon": polygon,
        "mask_contours": [],
        "tracker_id": tracker_id,
        "sub_models": sub_models,
    }
