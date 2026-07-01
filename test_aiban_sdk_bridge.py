"""Real AiBan SDK -> reliable frame bridge diagnostic runner.

Run Node-RED with an ``aiban-frame-input`` node first, then execute this file.
It does not start Flask, alarm processing, MySQL, or the legacy workflow engine.
"""

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

BEIJING_TZ = timezone(timedelta(hours=8))


class BeijingFormatter(logging.Formatter):
    """Formatter that converts log record time to Beijing time (UTC+8)."""

    def formatTime(self, record, datefmt=None):
        ct = datetime.fromtimestamp(record.created, BEIJING_TZ)
        if datefmt:
            return ct.strftime(datefmt)
        return ct.isoformat(timespec="milliseconds")

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR if (SCRIPT_DIR / "core").is_dir() else SCRIPT_DIR.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.frame_bridge import FrameBridge, FrameBridgeConfig, TransmissionAuditLogger


def collect_labels(message):
    labels = []
    for model_id, result in (message.get("models") or {}).items():
        for box in (result or {}).get("boxes", []):
            labels.append(
                "m{}:{}({:.3f})".format(
                    model_id,
                    box.get("label", ""),
                    float(box.get("confidence", 0.0) or 0.0),
                )
            )
    return labels


def parse_args():
    parser = argparse.ArgumentParser(description="测试真实 AiBan SDK 帧接入与耗时")
    parser.add_argument(
        "--sdk-home",
        default=os.getenv("AIBAN_SDK_HOME", "D:/product/AiBanWorkSpace"),
    )
    parser.add_argument(
        "--pipeline-config",
        default=os.getenv(
            "AIBAN_PIPELINE_CONFIG",
            "D:/product/AiBanWorkSpace/abvideo/main-flow.yaml",
        ),
    )
    parser.add_argument(
        "--endpoint",
        default=os.getenv("AIBAN_FRAME_ENDPOINT", "tcp://127.0.0.1:5557"),
    )
    parser.add_argument(
        "--outbox",
        default="",
        help="测试outbox路径；默认按本次进程创建独立数据库",
    )
    parser.add_argument("--print-every", type=int, default=1)
    return parser.parse_args()


def main():
    args = parse_args()
    print("当前Python解释器：{}".format(sys.executable), flush=True)
    try:
        import zmq
        print("pyzmq版本：{}".format(zmq.__version__), flush=True)
    except ImportError:
        print(
            "缺少pyzmq，请执行：{} -m pip install pyzmq==26.4.0".format(
                sys.executable
            ),
            flush=True,
        )
        return 3
    sdk_home = str(Path(args.sdk_home))
    if sdk_home not in sys.path:
        sys.path.append(sdk_home)

    try:
        import libAiBanVideoPy3_9 as AiBanVideoPy
        import libAiBanLitePy3_9 as AiBanLitePy
    except ImportError as error:
        print("无法导入 libAiBanVideoPy3_9，请检查 --sdk-home：{}".format(sdk_home))
        print(error)
        return 2

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    # 确保所有 handler 使用北京时区格式化
    for handler in logging.root.handlers:
        handler.setFormatter(
            BeijingFormatter(
                fmt="%(asctime)s %(levelname)s %(message)s",
                datefmt="%Y-%m-%dT%H:%M:%S",
            )
        )
    logger = logging.getLogger("aiban-sdk-bridge-test")
    engine = AiBanVideoPy.aibanVideoGetInstance()
    run_id = "{}-{}".format(datetime.now().strftime("%Y%m%d-%H%M%S"), os.getpid())
    audit = TransmissionAuditLogger(
        str(PROJECT_ROOT / "logs" / "frame_bridge"),
        run_id,
    )
    outbox_path = (
        Path(args.outbox)
        if args.outbox
        else PROJECT_ROOT
        / "data"
        / "frame_bridge"
        / "sdk-test-{}.db".format(os.getpid())
    )
    config = FrameBridgeConfig(
        enabled=True,
        endpoint=args.endpoint,
        outbox_path=str(outbox_path),
        high_watermark=5000,
        low_watermark=1000,
        retry_seconds=0.5,
        batch_size=100,
        log_every=max(1, args.print_every),
        console_latency=True,
    )
    bridge = FrameBridge(
        config,
        source_control=engine.sourceControl,
        audit_callback=audit.record,
        logger=logger,
    )
    frame_count = 0
    # 延迟统计
    stats = {"sdk_convert": [], "callback": []}

    def _now_beijing() -> str:
        return datetime.now(BEIJING_TZ).strftime("%H:%M:%S")

    def on_result(err, group_id, source_id, metadata):
        nonlocal frame_count
        callback_started = time.perf_counter_ns()
        if err:
            print("[SDK回调错误] group={} source={}".format(group_id, source_id), flush=True)
            return
        try:
            message = bridge.submit_metadata(group_id, source_id, metadata)
            frame_count += 1
            callback_ms = (time.perf_counter_ns() - callback_started) / 1_000_000
            sdk_convert = message.get("sdk_convert_ms", 0)
            queue_part = callback_ms - sdk_convert
            stats["sdk_convert"].append(sdk_convert)
            stats["callback"].append(callback_ms)

            if frame_count % max(1, args.print_every) == 0:
                labels = collect_labels(message)
                label_str = ", ".join(labels) if labels else "-"
                # 管道式输出: AiBan SDK → Python Bridge
                print(
                    "[SDK] #{:<5} g{}/s{} │ SDK转换 {:>6.2f}ms → 入队 {:>6.2f}ms │ "
                    "∑ {:>6.2f}ms │ {} │ {}".format(
                        message["frame_seq"],
                        group_id,
                        source_id,
                        sdk_convert,
                        queue_part,
                        callback_ms,
                        label_str,
                        _now_beijing(),
                    ),
                    flush=True,
                )
        except Exception:
            logger.exception("SDK metadata 转换失败")

    def on_event(msg_type, status, messages):
        print(
            "[SDK事件] type={} status={} msg={}".format(msg_type, status, messages),
            flush=True,
        )

    engine.registerVideoResultFunc(on_result)
    try:
        engine.registerVideoMsgEventFunc(on_event)
    except Exception:
        logger.exception("registerVideoMsgEventFunc failed")

    bridge.start()
    print("Node-RED endpoint：{}".format(args.endpoint), flush=True)
    print("本次测试outbox：{}".format(outbox_path), flush=True)
    print("详细文本日志：{}".format(audit.text_path), flush=True)
    print("逐帧耗时汇总：{}".format(audit.summary_path), flush=True)
    print("SDK pipeline：{}".format(args.pipeline_config), flush=True)
    # 打印延迟列说明
    print(
        "┌──────────┬─────────────────────────────────┬───────────┬──────────────────┐",
        flush=True,
    )
    print(
        "│ 帧号     │ AiBan SDK → Python Bridge       │ 累计耗时   │ 标签             │",
        flush=True,
    )
    print(
        "│          │ 转换耗时 → 入队等待             │ 总计       │                  │",
        flush=True,
    )
    print(
        "├──────────┼─────────────────────────────────┼───────────┼──────────────────┤",
        flush=True,
    )
    print("按 Ctrl+C 停止，停止后自动打印延迟统计。", flush=True)

    config_result = engine.checkAllConfig(args.pipeline_config)
    print("checkAllConfig 返回：{}".format(config_result), flush=True)
    build_result = engine.buildPipline()
    print("buildPipline 返回：{}".format(build_result), flush=True)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n正在停止...", flush=True)
    finally:
        engine.stopPipline()
        bridge.stop()
        audit.close()

        # ── 延迟统计摘要 ──
        print("", flush=True)
        print("=" * 65, flush=True)
        print("  延迟统计摘要 (共 {} 帧)".format(frame_count), flush=True)
        print("=" * 65, flush=True)
        if stats["sdk_convert"]:
            sc = stats["sdk_convert"]
            cb = stats["callback"]
            print(
                "  AiBan SDK 转换 :  min {:>6.2f}ms   avg {:>6.2f}ms   max {:>6.2f}ms".format(
                    min(sc), sum(sc) / len(sc), max(sc)
                ),
                flush=True,
            )
            print(
                "  Python 回调入队 :  min {:>6.2f}ms   avg {:>6.2f}ms   max {:>6.2f}ms".format(
                    min(cb), sum(cb) / len(cb), max(cb)
                ),
                flush=True,
            )
            total_py = sum(cb)
            print(
                "  Python 侧总耗时  :  sum {:.0f}ms ({:.1f}s)  over {} frames".format(
                    total_py, total_py / 1000, frame_count
                ),
                flush=True,
            )
        else:
            print("  (无数据)", flush=True)
        print("=" * 65, flush=True)
        print("\n已停止。", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
