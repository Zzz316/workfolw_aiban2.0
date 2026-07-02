"""SQLite assertion helper for cross-runtime integration tests."""

import sqlite3


def inbox_total(filename: str) -> int:
    db = sqlite3.connect(filename)
    try:
        row = db.execute("SELECT COUNT(*) FROM frame_inbox").fetchone()
        return int(row[0])
    finally:
        db.close()
