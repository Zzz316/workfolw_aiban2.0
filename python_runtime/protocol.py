"""JSON Lines protocol encoding and decoding.

stdout rules:
  - One complete JSON object per line, terminated by \\n (LF only, no CR).
  - No plain text on stdout. All logs go to stderr.

stdin rules:
  - One complete JSON object per line.
  - Unknown commands → return error via command_result.
"""

import json
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

# Beijing timezone for emitted_at / captured_at timestamps
_BEIJING_TZ = timezone(timedelta(hours=8))

SCHEMA_VERSION = 1
MAX_MESSAGE_BYTES = 1_048_576  # 1 MB


def now_iso() -> str:
    """Return current Beijing time as ISO 8601 string."""
    return datetime.now(_BEIJING_TZ).isoformat()


def new_event_id() -> str:
    """Generate a new UUID v4 event ID."""
    return str(uuid.uuid4())


def make_envelope(
    event_type: str,
    session_id: str,
    event_seq: int,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    """Build a standard protocol envelope.

    Args:
        event_type: One of the defined event types (frame, runtime_ready, ...).
        session_id: Runner session UUID.
        event_seq: Monotonic sequence number.
        payload: Event-type-specific payload dict.

    Returns:
        Complete event dict ready to be serialized to JSON.
    """
    return {
        "schema_version": SCHEMA_VERSION,
        "type": event_type,
        "session_id": session_id,
        "event_id": new_event_id(),
        "event_seq": event_seq,
        "emitted_at": now_iso(),
        "payload": payload,
    }


def encode_event(event: Dict[str, Any]) -> bytes:
    """Serialize an event dict to a JSON Line (UTF-8 bytes with LF).

    Raises:
        ValueError: If the encoded message exceeds MAX_MESSAGE_BYTES.
    """
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    # Ensure no embedded newlines in the JSON string itself
    if "\n" in line or "\r" in line:
        raise ValueError("Event JSON must not contain embedded newlines")
    data = (line + "\n").encode("utf-8")
    if len(data) > MAX_MESSAGE_BYTES:
        raise ValueError(
            f"Encoded event exceeds {MAX_MESSAGE_BYTES} bytes ({len(data)} bytes)"
        )
    return data


def decode_line(line: str) -> Optional[Dict[str, Any]]:
    """Parse a single line from stdin/stdout into a dict.

    Returns:
        Parsed dict, or None if the line is empty/whitespace-only.

    Raises:
        ValueError: If the line is not valid JSON.
    """
    stripped = line.strip()
    if not stripped:
        return None
    try:
        obj = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise ValueError("JSON value must be an object")
    return obj


def decode_command(line: str) -> Dict[str, Any]:
    """Parse a control command from stdin.

    Returns:
        Command dict with at least 'command' and 'request_id' keys.

    Raises:
        ValueError: If the line is not a valid command.
    """
    obj = decode_line(line)
    if obj is None:
        raise ValueError("Empty command line")
    if "command" not in obj:
        raise ValueError("Missing 'command' field")
    if "request_id" not in obj:
        raise ValueError("Missing 'request_id' field")
    schema = obj.get("schema_version")
    if schema is not None and schema != SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported schema_version: {schema} (expected {SCHEMA_VERSION})"
        )
    return obj


def make_command_result(
    request_id: str,
    command: str,
    ok: bool,
    result: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
    session_id: str = "",
    event_seq: int = 0,
) -> Dict[str, Any]:
    """Build a command_result event envelope."""
    return make_envelope(
        event_type="command_result",
        session_id=session_id,
        event_seq=event_seq,
        payload={
            "request_id": request_id,
            "ok": ok,
            "command": command,
            "result": result or {},
            "error": error,
        },
    )
