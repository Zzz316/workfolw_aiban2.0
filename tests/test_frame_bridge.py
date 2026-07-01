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
        self.assertTrue(first["sdk_received_at"].endswith("+08:00"),
                        msg="sdk_received_at should use Beijing time (+08:00), got: {}".format(
                            first["sdk_received_at"]))
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
    _ack_count: int = 0

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
    def test_audit_writes_text_log(self):
        with tempfile.TemporaryDirectory() as directory:
            audit = TransmissionAuditLogger(directory, "test-run")
            audit.record(
                "sdk_received",
                message_id="m1",
                stream_id="group-1/source-1",
                frame_seq=1,
                sdk_received_at="2026-07-01T10:00:00.000+08:00",
                sdk_convert_ms=1.2,
                labels=[{"label": "person", "confidence": 0.9}],
            )
            audit.record(
                "outbox_persisted",
                message_id="m1",
                stream_id="group-1/source-1",
                frame_seq=1,
                queue_wait_ms=2.3,
                outbox_persist_ms=0.8,
            )
            audit.record(
                "transport_sent",
                message_id="m1",
                stream_id="group-1/source-1",
                frame_seq=1,
                send_count=1,
            )
            audit.record(
                "node_ack_received",
                message_id="m1",
                stream_id="group-1/source-1",
                frame_seq=1,
                node_received_at="2026-07-01T10:00:00.010+08:00",
                node_receive_diff_ms=10,
                node_inbox_persist_ms=0.7,
                ack_rtt_ms=4,
                delivery_ms=12,
                send_count=1,
            )
            audit.close()
            text_data = Path(audit.text_path).read_text(encoding="utf-8")
            summary_data = Path(audit.summary_path).read_text(encoding="utf-8-sig")
            self.assertIn("[SDK]", text_data)
            self.assertIn("person", text_data)
            self.assertIn("完整投递(ms)", summary_data)
            self.assertIn("优秀", summary_data)


class ScreenshotManagerTests(unittest.TestCase):
    def test_enqueue_and_dequeue_pending(self):
        from core.frame_bridge.screenshot_service import ScreenshotManager
        mgr = ScreenshotManager()
        mgr.enqueue_request("req-1", 1, 2, save_roi=False)
        self.assertTrue(mgr.has_pending(1, 2))
        self.assertFalse(mgr.has_pending(1, 3))
        pending = mgr.dequeue_pending(1, 2)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].request_id, "req-1")
        self.assertFalse(mgr.has_pending(1, 2))

    def test_fifo_matching_on_complete(self):
        from core.frame_bridge.screenshot_service import ScreenshotManager
        mgr = ScreenshotManager()
        mgr.enqueue_request("req-a", 1, 1)
        mgr.enqueue_request("req-b", 1, 1)
        pending = mgr.dequeue_pending(1, 1)
        self.assertEqual(len(pending), 2)
        # complete in order
        rid1 = mgr.complete(1, 1, "/tmp/a.jpg")
        rid2 = mgr.complete(1, 1, "/tmp/b.jpg")
        self.assertEqual(rid1, "req-a")
        self.assertEqual(rid2, "req-b")

    def test_timeout_expires_in_flight(self):
        from core.frame_bridge.screenshot_service import ScreenshotManager
        import time as time_module
        mgr = ScreenshotManager(request_ttl_seconds=0.1)
        mgr.enqueue_request("req-t", 1, 1)
        mgr.dequeue_pending(1, 1)  # moves to in_flight
        time_module.sleep(0.3)  # well past TTL
        expired = mgr.check_timeouts()
        self.assertEqual(len(expired), 1)
        self.assertEqual(expired[0][0], "req-t")

    def test_complete_with_no_in_flight_returns_none(self):
        from core.frame_bridge.screenshot_service import ScreenshotManager
        mgr = ScreenshotManager()
        self.assertIsNone(mgr.complete(1, 1, "/tmp/x.jpg"))

    def test_stats_reflects_state(self):
        from core.frame_bridge.screenshot_service import ScreenshotManager
        mgr = ScreenshotManager()
        mgr.enqueue_request("r1", 1, 1)
        mgr.enqueue_request("r2", 1, 2)
        stats = mgr.stats()
        self.assertEqual(stats["pending"], 2)
        self.assertEqual(stats["in_flight"], 0)
        mgr.dequeue_pending(1, 1)
        stats = mgr.stats()
        self.assertEqual(stats["pending"], 1)
        self.assertEqual(stats["in_flight"], 1)
        mgr.complete(1, 1, "/tmp/x.jpg")
        stats = mgr.stats()
        self.assertEqual(stats["completed"], 1)

    def test_record_error_fifo_matching(self):
        from core.frame_bridge.screenshot_service import ScreenshotManager
        mgr = ScreenshotManager()
        mgr.enqueue_request("req-err", 1, 1)
        mgr.dequeue_pending(1, 1)
        rid = mgr.record_error(1, 1)
        self.assertEqual(rid, "req-err")
        self.assertEqual(mgr.stats()["errors"], 1)


class FrameBridgeStatsFileTests(unittest.TestCase):
    def test_stats_file_is_written(self):
        import json
        import tempfile
        import time as time_module
        from pathlib import Path
        from core.frame_bridge.bridge import FrameBridge, FrameBridgeConfig

        with tempfile.TemporaryDirectory() as directory:
            stats_path = str(Path(directory) / "stats.json")
            bridge = FrameBridge(
                FrameBridgeConfig(
                    enabled=True,
                    outbox_path=str(Path(directory) / "outbox.db"),
                    high_watermark=100,
                    low_watermark=1,
                    stats_file=stats_path,
                ),
            )
            bridge.transport = FakeTransport()
            bridge.start()
            deadline = time_module.time() + 3
            found = False
            while time_module.time() < deadline:
                if Path(stats_path).exists():
                    found = True
                    break
                time_module.sleep(0.1)
            bridge.stop()
            self.assertTrue(found, "stats file should be written within 3 seconds")
            data = json.loads(Path(stats_path).read_text(encoding="utf-8"))
            self.assertIn("session_id", data)
            self.assertIn("uptime_seconds", data)
            self.assertIn("ingress", data)
            self.assertIn("outbox", data)
            self.assertIn("transport", data)
            self.assertIn("disk", data)
            self.assertIn("screenshot", data)
            self.assertIn("updated_at", data)


class FrameBridgeDiskMonitorTests(unittest.TestCase):
    def test_disk_check_is_non_fatal_on_missing_path(self):
        from core.frame_bridge.bridge import FrameBridge, FrameBridgeConfig
        bridge = FrameBridge(
            FrameBridgeConfig(
                enabled=True,
                outbox_path="/nonexistent/path/should/not/crash/outbox.db",
                high_watermark=100,
                low_watermark=1,
                disk_emergency_percent=0,  # always trigger
            ),
        )
        bridge.transport = FakeTransport()
        # should not raise
        bridge._check_disk()
        # with nonexistent path, disk_stats should be empty (caught by OSError)
        # or have emergency info if the path partially resolves
        self.assertIsInstance(bridge._disk_stats, dict)


class ProtocolScreenshotTests(unittest.TestCase):
    def test_screenshot_result_is_checksummed(self):
        from core.frame_bridge.protocol import (
            make_screenshot_result,
            make_screenshot_timeout,
            verify_message,
        )
        result = make_screenshot_result("rid", 1, 2, True, "/tmp/x.jpg")
        self.assertTrue(verify_message(result))
        self.assertEqual(result["type"], "screenshot_result")
        self.assertEqual(result["request_id"], "rid")

        timeout_msg = make_screenshot_timeout("rid", 1, 2)
        self.assertTrue(verify_message(timeout_msg))
        self.assertEqual(timeout_msg["type"], "screenshot_timeout")


if __name__ == "__main__":
    unittest.main()
