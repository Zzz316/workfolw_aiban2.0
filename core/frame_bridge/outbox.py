"""SQLite WAL backed durable frame outbox."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from .protocol import canonical_json


class DurableOutbox:
    def __init__(self, path: str):
        self.path = str(Path(path))
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False, timeout=10)
        self._db.row_factory = sqlite3.Row
        with self._db:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=FULL")
            self._db.execute(
                """
                CREATE TABLE IF NOT EXISTS frame_outbox (
                    message_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    stream_id TEXT NOT NULL,
                    frame_seq INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    send_count INTEGER NOT NULL DEFAULT 0,
                    last_sent_at REAL,
                    acked_at REAL
                )
                """
            )
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS idx_outbox_pending "
                "ON frame_outbox(acked_at, stream_id, frame_seq)"
            )

    def enqueue(self, message: Dict) -> bool:
        with self._lock, self._db:
            cursor = self._db.execute(
                """
                INSERT OR IGNORE INTO frame_outbox
                (message_id, session_id, stream_id, frame_seq, payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    message["message_id"],
                    message["session_id"],
                    message["stream_id"],
                    int(message["frame_seq"]),
                    canonical_json(message),
                    time.time(),
                ),
            )
            return cursor.rowcount == 1

    def pending(self, limit: int = 100, retry_after: float = 0.0) -> List[Dict]:
        cutoff = time.time() - max(0.0, retry_after)
        with self._lock:
            rows = self._db.execute(
                """
                SELECT * FROM frame_outbox
                WHERE acked_at IS NULL
                  AND (last_sent_at IS NULL OR last_sent_at <= ?)
                ORDER BY stream_id, frame_seq
                LIMIT ?
                """,
                (cutoff, int(limit)),
            ).fetchall()
            return [dict(row) for row in rows]

    def mark_sent(self, message_id: str) -> None:
        with self._lock, self._db:
            self._db.execute(
                """
                UPDATE frame_outbox
                SET send_count = send_count + 1, last_sent_at = ?
                WHERE message_id = ? AND acked_at IS NULL
                """,
                (time.time(), message_id),
            )

    def acknowledge(self, message_id: str) -> bool:
        with self._lock, self._db:
            cursor = self._db.execute(
                """
                UPDATE frame_outbox SET acked_at = ?
                WHERE message_id = ? AND acked_at IS NULL
                """,
                (time.time(), message_id),
            )
            return cursor.rowcount == 1

    def counts(self) -> Dict[str, int]:
        with self._lock:
            row = self._db.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN acked_at IS NULL THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN acked_at IS NOT NULL THEN 1 ELSE 0 END) AS acked
                FROM frame_outbox
                """
            ).fetchone()
            return {
                "total": int(row["total"] or 0),
                "pending": int(row["pending"] or 0),
                "acked": int(row["acked"] or 0),
            }

    def prune_acked(self, older_than_seconds: float) -> int:
        cutoff = time.time() - max(0.0, older_than_seconds)
        with self._lock, self._db:
            cursor = self._db.execute(
                "DELETE FROM frame_outbox WHERE acked_at IS NOT NULL AND acked_at <= ?",
                (cutoff,),
            )
            return cursor.rowcount

    def close(self) -> None:
        with self._lock:
            self._db.close()
