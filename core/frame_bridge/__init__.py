"""
LEGACY (legacy-zmq-baseline): Reliable AiBan SDK to Node-RED frame bridge.

This module is part of the old ZMQ-based architecture (Python → ZMQ → Node-RED).
It is NO LONGER part of the v2.0 main data path as of 2026-07-02.

The new architecture uses Node-RED child_process.spawn to manage Python/AiBan
directly via stdin/stdout JSON Lines protocol. See:
  - WORKFLOW_V2_AI_DEVELOPMENT_PLAN.md
  - docs/LEGACY_ZMQ_MIGRATION.md

DO NOT add new features to this module. It is preserved for rollback reference
and will be deleted after Phase 4 acceptance per the migration plan.
"""

from .adapter import FrameAdapter
from .audit import TransmissionAuditLogger
from .bridge import FrameBridge, FrameBridgeConfig
from .outbox import DurableOutbox
from .screenshot_service import ScreenshotManager

__all__ = [
    "DurableOutbox",
    "FrameAdapter",
    "FrameBridge",
    "FrameBridgeConfig",
    "ScreenshotManager",
    "TransmissionAuditLogger",
]
