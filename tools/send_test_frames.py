"""Send synthetic Workflow 2.0 frames to a running Node-RED frame input node."""

import argparse
import sys
import tempfile
import time
import uuid
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.frame_bridge.outbox import DurableOutbox
from core.frame_bridge.protocol import SCHEMA_VERSION, finalize_message, beijing_now_iso
from core.frame_bridge.transport import ZmqDealerTransport


def build_frame(session_id, sequence):
    stream_id = "group-1/source-1"
    return finalize_message(
        {
            "type": "frame",
            "schema_version": SCHEMA_VERSION,
            "session_id": session_id,
            "stream_id": stream_id,
            "frame_seq": sequence,
            "message_id": "{}:{}:{}".format(session_id, stream_id, sequence),
            "captured_at": beijing_now_iso(),
            "captured_monotonic_ns": time.monotonic_ns(),
            "group_id": 1,
            "source_id": 1,
            "models": {
                "1": {
                    "ok": True,
                    "boxes": [
                        {
                            "label": "test_person",
                            "label_index": 0,
                            "confidence": 0.95,
                            "polygon": [[10, 10], [100, 10], [100, 200], [10, 200]],
                            "tracker_id": sequence,
                            "mask_contours": [],
                        }
                    ],
                }
            },
        }
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="tcp://127.0.0.1:5557")
    parser.add_argument("--count", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="aiban-test-sender-") as directory:
        outbox = DurableOutbox(str(Path(directory) / "outbox.db"))
        session_id = "manual-test-{}".format(uuid.uuid4())
        for sequence in range(1, args.count + 1):
            outbox.enqueue(build_frame(session_id, sequence))

        transport = ZmqDealerTransport(
            args.endpoint,
            outbox,
            identity=session_id,
            retry_seconds=0.2,
        )
        transport.start()
        deadline = time.time() + args.timeout
        while time.time() < deadline:
            counts = outbox.counts()
            print(
                "\r发送总数={total} 待确认={pending} 已确认={acked}".format(**counts),
                end="",
                flush=True,
            )
            if counts["pending"] == 0:
                print("\n测试成功：Node-RED 已持久化并确认全部测试帧。")
                transport.stop()
                outbox.close()
                return 0
            time.sleep(0.2)

        print("\n测试失败：等待 ACK 超时，请检查 Node-RED 节点和 5557 端口。")
        transport.stop()
        outbox.close()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
