import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from core.frame_bridge.adapter import FrameAdapter
from core.frame_bridge.audit import TransmissionAuditLogger
from core.frame_bridge.bridge import FrameBridge, FrameBridgeConfig
from core.frame_bridge.outbox import DurableOutbox
from core.frame_bridge.protocol import (
    canonical_json,
    make_ack,
    make_envelope,
    verify_message,
)


class FakePoint:
    def __init__(self, x, y):
        self.x = x
        self.y = y


class FakeBox:
    def getLabelName(self):
        return "person"

    def getLabelIndex(self):
        return 3

    def getConfidence(self):
        return 0.95

    def getPolygon(self):
        return [FakePoint(1, 2), FakePoint(3, 4)]

    def getTrackerId(self):
        return 27

    def getMaskRegionContoursPoints(self):
        return []


class FakeMetadata:
    def getAllModelInferBoxes(self):
        return {1: (True, [FakeBox()]), 2: (False, [FakeBox()])}

    def getTimeFlagDatetime(self):
        return "2026-06-29 12:00:00.123"


class FrameAdapterTests(unittest.TestCase):
    def test_metadata_is_converted_and_sequences_are_per_stream(self):
        adapter = FrameAdapter("session-test")
        first = adapter.from_metadata(1, 2, FakeMetadata())
        second = adapter.from_metadata(1, 2, FakeMetadata())
        other = adapter.from_metadata(1, 3, FakeMetadata())

        self.assertEqual(first["frame_seq"], 1)
        self.assertEqual(second["frame_seq"], 2)
        self.assertEqual(other["frame_seq"], 1)
        self.assertEqual(first["models"]["1"]["boxes"][0]["tracker_id"], 27)
        self.assertEqual(first["models"]["2"]["boxes"], [])
        self.assertIsInstance(first["bridge_created_at_ms"], int)
        self.assertIsInstance(first["sdk_received_at_ms"], int)
        self.assertTrue(first["sdk_received_at"].endswith("+00:00"))
        self.assertGreaterEqual(first["sdk_convert_ms"], 0)
        self.assertTrue(verify_message(first))

    def test_exact_payload_envelope_detects_corruption(self):
        frame = FrameAdapter("s").from_metadata(1, 1, FakeMetadata())
        payload = canonical_json(frame)
        envelope = make_envelope(payload)
        self.assertEqual(json.loads(envelope["payload"])["message_id"], frame["message_id"])
        self.assertNotEqual(
            make_envelope(payload + " ")["checksum"],
            envelope["checksum"],
        )

    def test_ack_is_checksummed(self):
        frame = FrameAdapter("s").from_metadata(1, 1, FakeMetadata())
        self.assertTrue(verify_message(make_ack(frame)))


class DurableOutboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / "outbox.db")

    def tearDown(self):
        self.temp.cleanup()

    def test_enqueue_is_idempotent_and_ack_survives_restart(self):
        frame = FrameAdapter("session").from_metadata(1, 1, FakeMetadata())
        outbox = DurableOutbox(self.path)
        self.assertTrue(outbox.enqueue(frame))
        self.assertFalse(outbox.enqueue(frame))
        self.assertEqual(outbox.counts(), {"total": 1, "pending": 1, "acked": 0})
        outbox.mark_sent(frame["message_id"])
        row = outbox.pending(limit=1)[0]
        self.assertEqual(row["send_count"], 1)
        self.assertTrue(outbox.acknowledge(frame["message_id"]))
        outbox.close()

        reopened = DurableOutbox(self.path)
        self.assertEqual(reopened.counts(), {"total": 1, "pending": 0, "acked": 1})
        reopened.close()

    def test_unacked_frame_is_replayed_after_restart(self):
        frame = FrameAdapter("session").from_metadata(1, 1, FakeMetadata())
        first = DurableOutbox(self.path)
        first.enqueue(frame)
        first.mark_sent(frame["message_id"])
        first.close()

        reopened = DurableOutbox(self.path)
        pending = reopened.pending(limit=10, retry_after=0)
        self.assertEqual([row["message_id"] for row in pending], [frame["message_id"]])
        reopened.close()


class FakeTransport:
    def start(self):
        pass

    def stop(self, timeout=5):
        pass


class FrameBridgeBackpressureTests(unittest.TestCase):
    def test_source_control_never_runs_in_sdk_submit_call(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []

            def source_control(group_id, source_id, running):
                calls.append((group_id, source_id, running, threading.current_thread().name))
                return True

            bridge = FrameBridge(
                FrameBridgeConfig(
                    enabled=True,
                    outbox_path=str(Path(directory) / "outbox.db"),
                    high_watermark=1,
                    low_watermark=0,
                ),
                source_control=source_control,
            )
            bridge.transport = FakeTransport()
            bridge.submit_metadata(1, 1, FakeMetadata())
            self.assertEqual(calls, [])
            bridge.start()

            deadline = time.time() + 3
            while time.time() < deadline and not calls:
                time.sleep(0.02)
            self.assertTrue(calls)
            self.assertEqual(calls[0][:3], (1, 1, False))
            self.assertEqual(calls[0][3], "frame-backpressure-controller")

            for row in bridge.outbox.pending():
                bridge.outbox.acknowledge(row["message_id"])
            deadline = time.time() + 3
            while time.time() < deadline and not any(call[2] for call in calls):
                time.sleep(0.02)
            self.assertTrue(any(call[2] for call in calls))
            bridge.stop()


class TransmissionAuditTests(unittest.TestCase):
    def test_audit_writes_jsonl_and_text(self):
        with tempfile.TemporaryDirectory() as directory:
            audit = TransmissionAuditLogger(directory, "test-run")
            audit.record(
                "sdk_received",
                message_id="m1",
                frame_seq=1,
                labels=[{"label": "person", "confidence": 0.9}],
            )
            audit.close()
            json_data = json.loads(Path(audit.jsonl_path).read_text(encoding="utf-8"))
            text_data = Path(audit.text_path).read_text(encoding="utf-8")
            self.assertEqual(json_data["event"], "sdk_received")
            self.assertIn("message_id=m1", text_data)


if __name__ == "__main__":
    unittest.main()
