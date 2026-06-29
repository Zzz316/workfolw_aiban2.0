import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from core.frame_bridge.adapter import FrameAdapter
from core.frame_bridge.outbox import DurableOutbox
from core.frame_bridge.transport import ZmqDealerTransport
from test_frame_bridge import FakeMetadata


@unittest.skipUnless(shutil.which("node"), "Node.js is required")
class ZmqIntegrationTests(unittest.TestCase):
    def test_node_inbox_acknowledges_python_outbox(self):
        try:
            import zmq  # noqa: F401
        except ImportError:
            self.skipTest("pyzmq is not installed")

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        endpoint = "tcp://127.0.0.1:{}".format(port)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(__file__).resolve().parents[1]
            inbox_path = str(Path(directory) / "inbox.db")
            outbox = DurableOutbox(str(Path(directory) / "outbox.db"))
            frame = FrameAdapter("integration").from_metadata(1, 1, FakeMetadata())
            outbox.enqueue(frame)

            receiver = subprocess.Popen(
                [
                    "node",
                    str(
                        root
                        / "node-red-contrib-aiban-workflow"
                        / "test"
                        / "zmq-receiver-once.js"
                    ),
                    endpoint,
                    inbox_path,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertEqual(receiver.stdout.readline().strip(), "READY")

            transport = ZmqDealerTransport(
                endpoint,
                outbox,
                identity="integration-test",
                retry_seconds=0.1,
            )
            transport.start()
            deadline = time.time() + 5
            while time.time() < deadline and outbox.counts()["acked"] != 1:
                time.sleep(0.05)
            transport.stop()

            stdout, stderr = receiver.communicate(timeout=5)
            self.assertEqual(receiver.returncode, 0, stderr)
            self.assertIn("ACKED", stdout)
            self.assertEqual(outbox.counts(), {"total": 1, "pending": 0, "acked": 1})
            outbox.close()


if __name__ == "__main__":
    unittest.main()
