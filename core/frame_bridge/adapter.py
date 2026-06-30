"""Convert short-lived AiBan SDK metadata objects into pure Python messages."""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any, Dict, Iterable, Optional

from .protocol import SCHEMA_VERSION, finalize_message, utc_now_iso


def _safe_call(obj: Any, method: str, default: Any = None) -> Any:
    fn = getattr(obj, method, None)
    if not callable(fn):
        return default
    try:
        return fn()
    except Exception:
        return default


def _plain_points(value: Any) -> list:
    if value is None:
        return []
    result = []
    try:
        for point in value:
            if hasattr(point, "x") and hasattr(point, "y"):
                result.append([float(point.x), float(point.y)])
            elif isinstance(point, (list, tuple)) and len(point) >= 2:
                result.append([float(point[0]), float(point[1])])
            else:
                result.append(point)
    except TypeError:
        return []
    return result


class FrameAdapter:
    """Build ordered, checksummed frame messages.

    A single instance is used for one pipeline session. Sequence numbers are
    independent per group/source stream.
    """

    def __init__(self, session_id: Optional[str] = None):
        self.session_id = session_id or str(uuid.uuid4())
        self._sequences: Dict[str, int] = {}
        self._lock = threading.Lock()

    def _next_sequence(self, stream_id: str) -> int:
        with self._lock:
            value = self._sequences.get(stream_id, 0) + 1
            self._sequences[stream_id] = value
            return value

    def from_metadata(self, group_id: int, source_id: int, metadata: Any) -> Dict[str, Any]:
        convert_started_ns = time.perf_counter_ns()
        bridge_created_at_ms = int(time.time() * 1000)
        stream_id = "group-{}/source-{}".format(int(group_id), int(source_id))
        frame_seq = self._next_sequence(stream_id)
        models: Dict[str, Any] = {}

        all_results = metadata.getAllModelInferBoxes()
        for model_id, result in dict(all_results or {}).items():
            ok, boxes = result
            models[str(model_id)] = {
                "ok": bool(ok),
                "boxes": [self._box_to_dict(box) for box in (boxes or [])] if ok else [],
            }

        sdk_time = _safe_call(metadata, "getTimeFlagDatetime")
        message = {
            "type": "frame",
            "schema_version": SCHEMA_VERSION,
            "session_id": self.session_id,
            "stream_id": stream_id,
            "frame_seq": frame_seq,
            "message_id": "{}:{}:{}".format(self.session_id, stream_id, frame_seq),
            "captured_at": str(sdk_time) if sdk_time else utc_now_iso(),
            "captured_monotonic_ns": time.monotonic_ns(),
            "bridge_created_at_ms": bridge_created_at_ms,
            "group_id": int(group_id),
            "source_id": int(source_id),
            "models": models,
        }
        message["sdk_convert_ms"] = round(
            (time.perf_counter_ns() - convert_started_ns) / 1_000_000, 3
        )
        return finalize_message(message)

    @staticmethod
    def _box_to_dict(box: Any) -> Dict[str, Any]:
        contours = _safe_call(box, "getMaskRegionContoursPoints", []) or []
        return {
            "label": str(_safe_call(box, "getLabelName", "") or ""),
            "label_index": _safe_call(box, "getLabelIndex"),
            "confidence": float(_safe_call(box, "getConfidence", 0.0) or 0.0),
            "polygon": _plain_points(_safe_call(box, "getPolygon", [])),
            "tracker_id": _safe_call(box, "getTrackerId"),
            "mask_contours": [_plain_points(contour) for contour in contours],
        }
