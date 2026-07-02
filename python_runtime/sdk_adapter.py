"""AiBan SDK Adapter — wraps SDK calls and manages callback registration.

Supports two modes:
  - real: Uses the actual AiBan SDK (libAiBanVideoPy3_9).
  - mock: Uses MockAibanSDK for development/testing without hardware.

All SDK metadata access happens inside callbacks and is converted to plain
Python dicts before leaving the callback scope (per SDK constraints).
"""

import logging
import sys
import time
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


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
        """Return (err, [boxes]) for a given model."""
        import random
        if model_id not in self._model_ids:
            return (0, [])
        boxes = []
        for idx, label in enumerate(self._labels):
            # Cycle through labels so each frame has some variety
            if (self._counter + idx) % len(self._labels) == self._counter % len(self._labels):
                boxes.append(MockBox(
                    label=label,
                    label_index=idx,
                    confidence=0.7 + random.random() * 0.25,
                    tracker_id=self._counter * 100 + idx,
                    polygon=[[0, 0], [100, 0], [100, 100], [0, 100]],
                ))
        return (0, boxes)

    def getAllModelInferBoxes(self):
        """Return {model_id: (err, [boxes])} for all models."""
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

    def getConfidence(self) -> float:
        return self._confidence

    def getPolygon(self) -> list:
        return self._polygon

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
        self._frame_handler: Optional[FrameCallback] = None
        self._event_handler: Optional[EventCallback] = None
        self._pipeline_started = False

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
            # Import the real SDK — it's typically on sys.path via sdk_home
            import importlib
            try:
                aiban = importlib.import_module("AiBanVideoPy")
                return aiban.aibanVideoGetInstance()
            except ImportError:
                # Fallback: try adding sdk_home to path
                import os
                if self._sdk_home and os.path.isdir(self._sdk_home):
                    sys.path.insert(0, self._sdk_home)
                    aiban = importlib.import_module("AiBanVideoPy")
                    return aiban.aibanVideoGetInstance()
                raise RuntimeError(
                    "Cannot import AiBanVideoPy. "
                    "Set use_mock=True for testing or verify sdk_home path."
                )

    # ------------------------------------------------------------------
    # Callback registration
    # ------------------------------------------------------------------

    def _on_frame(self, err: int, group_id: int, source_id: int, metadata) -> None:
        """SDK frame callback — extract all data within callback scope."""
        if err != 0:
            logger.error("SDK frame callback error: err=%d", err)
            return
        if not self._frame_handler:
            return

        try:
            frame_data = _extract_frame_data(group_id, source_id, metadata)
            self._frame_handler(group_id, source_id, frame_data)
        except Exception:
            logger.exception("Error in frame callback extraction")

    def _on_sdk_event(self, level: str, message: str) -> None:
        """SDK event callback."""
        if self._event_handler:
            try:
                self._event_handler(level, message)
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
        if not result:
            logger.error("SDK checkAllConfig failed for %s", yaml_path)
        return result

    def build_pipeline(self) -> None:
        """Start the SDK pipeline (blocking call in real SDK, non-blocking in mock)."""
        if self._use_mock:
            # Mock SDK runs pipeline in background thread
            self._sdk.buildPipline()
        else:
            # Real SDK — buildPipline is blocking, so we run it in a thread
            import threading
            self._pipeline_thread = threading.Thread(
                target=self._sdk.buildPipline, daemon=True
            )
            self._pipeline_thread.start()
            # Give it a moment to start
            self._pipeline_thread.join(timeout=1.0)
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

    def do_screenshot(self, group_id: int, source_id: int) -> Optional[str]:
        """Take a screenshot and return the saved image path."""
        if not self._sdk:
            return None
        metadata = None
        # For mock SDK, we need a metadata... but we don't have one in static context.
        # Real SDK screenshots happen inside the frame callback where metadata exists.
        # This method is a best-effort wrapper; in practice, screenshots are
        # requested via command, and the actual saveImage is triggered on the
        # next frame callback for the specified source.
        logger.info("Screenshot requested for group=%d source=%d", group_id, source_id)
        return None  # Actual path comes from next frame callback


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
    for model_id, (err, boxes) in all_models.items():
        if err != 0:
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
        "label_index": 0,  # getLabelIndex not always available
        "confidence": round(float(box.getConfidence()), 4),
        "polygon": polygon,
        "mask_contours": [],
        "tracker_id": tracker_id,
        "sub_models": sub_models,
    }
