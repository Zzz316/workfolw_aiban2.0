"""Asynchronous local transmission audit log for SDK bridge diagnostics."""

from __future__ import annotations

import json
import queue
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


class TransmissionAuditLogger:
    """Write JSONL and readable text without blocking the SDK callback thread."""

    def __init__(self, directory: str, run_id: str):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        safe_run_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in run_id)
        self.jsonl_path = self.directory / "transmission-{}.jsonl".format(safe_run_id)
        self.text_path = self.directory / "transmission-{}.log".format(safe_run_id)
        self._queue: "queue.SimpleQueue[Optional[Dict[str, Any]]]" = queue.SimpleQueue()
        self._thread = threading.Thread(
            target=self._writer_loop,
            name="frame-transmission-audit",
            daemon=True,
        )
        self._thread.start()

    def record(self, event: str, **fields: Any) -> None:
        self._queue.put(
            {
                "audit_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "event": event,
                **fields,
            }
        )

    def close(self, timeout: float = 5.0) -> None:
        self._queue.put(None)
        self._thread.join(timeout)

    def _writer_loop(self) -> None:
        with self.jsonl_path.open("a", encoding="utf-8") as jsonl, self.text_path.open(
            "a", encoding="utf-8"
        ) as text:
            while True:
                item = self._queue.get()
                if item is None:
                    jsonl.flush()
                    text.flush()
                    return
                jsonl.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
                text.write(self._format_text(item) + "\n")
                jsonl.flush()
                text.flush()

    @staticmethod
    def _format_text(item: Dict[str, Any]) -> str:
        ordered = [
            "audit_at",
            "event",
            "message_id",
            "stream_id",
            "frame_seq",
            "labels",
            "sdk_convert_ms",
            "outbox_persist_ms",
            "queue_wait_ms",
            "send_count",
            "ack_rtt_ms",
            "delivery_ms",
            "node_receive_diff_ms",
            "node_inbox_persist_ms",
        ]
        parts = []
        for key in ordered:
            if key in item and item[key] is not None:
                value = item[key]
                if isinstance(value, (dict, list)):
                    value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                parts.append("{}={}".format(key, value))
        for key in sorted(set(item) - set(ordered)):
            value = item[key]
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            parts.append("{}={}".format(key, value))
        return " | ".join(parts)
