"""Wire protocol helpers shared by the reliable frame bridge."""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from typing import Any, Dict

SCHEMA_VERSION = 1


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def payload_checksum(message_without_checksum: Dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(message_without_checksum).encode("utf-8")).hexdigest()


def finalize_message(message: Dict[str, Any]) -> Dict[str, Any]:
    value = dict(message)
    value.pop("checksum", None)
    value["checksum"] = payload_checksum(value)
    return value


def verify_message(message: Dict[str, Any]) -> bool:
    checksum = message.get("checksum")
    if not isinstance(checksum, str):
        return False
    value = dict(message)
    value.pop("checksum", None)
    return checksum == payload_checksum(value)


def encode_message(message: Dict[str, Any]) -> bytes:
    return canonical_json(message).encode("utf-8")


def decode_message(data: bytes) -> Dict[str, Any]:
    value = json.loads(data.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("protocol message must be a JSON object")
    return value


def make_envelope(payload_text: str, sent_at_ms: int = None) -> Dict[str, Any]:
    """Wrap exact JSON text so receivers can verify bytes without re-encoding floats."""
    envelope = {
        "type": "frame_envelope",
        "schema_version": SCHEMA_VERSION,
        "payload": payload_text,
        "checksum": hashlib.sha256(payload_text.encode("utf-8")).hexdigest(),
    }
    envelope["sent_at_ms"] = int(sent_at_ms if sent_at_ms is not None else time.time() * 1000)
    return envelope


def make_ack(frame: Dict[str, Any]) -> Dict[str, Any]:
    return finalize_message(
        {
            "type": "ack",
            "schema_version": SCHEMA_VERSION,
            "message_id": frame["message_id"],
            "session_id": frame["session_id"],
            "stream_id": frame["stream_id"],
            "frame_seq": frame["frame_seq"],
            "persisted_at": utc_now_iso(),
        }
    )
