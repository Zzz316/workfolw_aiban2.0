"""Asynchronous local transmission audit log for SDK bridge diagnostics."""

from __future__ import annotations

import json
import csv
import queue
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

BEIJING_TZ = timezone(timedelta(hours=8))

# ── 列标题（写入日志文件头部） ─────────────────────────────────────────────
LOG_HEADER = (
    "┌──────────┬─────────────────────────────────┬──────────────┬──────────────────┐\n"
    "│ 帧号     │ 事件 / 延迟分解                 │ 累计耗时      │ 标签 / 时间       │\n"
    "├──────────┼─────────────────────────────────┼──────────────┼──────────────────┤"
)


class TransmissionAuditLogger:
    """Write JSONL and readable text without blocking the SDK callback thread."""

    def __init__(self, directory: str, run_id: str):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        safe_run_id = "".join(c if c.isalnum() or c in "-_" else "_" for c in run_id)
        self.text_path = self.directory / "transmission-{}.log".format(safe_run_id)
        self.summary_path = self.directory / "transmission-{}-summary.csv".format(
            safe_run_id
        )
        self._queue: "queue.SimpleQueue[Optional[Dict[str, Any]]]" = queue.SimpleQueue()
        self._first_write = True
        self._frames: Dict[str, Dict[str, Any]] = {}
        self._thread = threading.Thread(
            target=self._writer_loop,
            name="frame-transmission-audit",
            daemon=True,
        )
        self._thread.start()

    def record(self, event: str, **fields: Any) -> None:
        self._queue.put(
            {
                "audit_at": datetime.now(BEIJING_TZ).isoformat(timespec="milliseconds"),
                "event": event,
                **fields,
            }
        )

    def close(self, timeout: float = 5.0) -> None:
        self._queue.put(None)
        self._thread.join(timeout)

    def _writer_loop(self) -> None:
        with self.text_path.open("a", encoding="utf-8") as text:
            # 写入列标题
            if self._first_write:
                text.write(LOG_HEADER + "\n")
                self._first_write = False
            while True:
                item = self._queue.get()
                if item is None:
                    self._write_summary_csv()
                    text.flush()
                    return
                self._update_summary(item)
                text.write(self._format_text(item) + "\n")
                text.flush()

    def _update_summary(self, item: Dict[str, Any]) -> None:
        message_id = item.get("message_id")
        if not message_id:
            return
        row = self._frames.setdefault(
            str(message_id),
            {
                "message_id": str(message_id),
                "stream_id": "",
                "frame_seq": "",
                "labels": "",
                "sdk_received_at": "",
                "node_received_at": "",
                "sdk_convert_ms": "",
                "queue_wait_ms": "",
                "outbox_persist_ms": "",
                "node_receive_diff_ms": "",
                "node_inbox_persist_ms": "",
                "ack_rtt_ms": "",
                "delivery_ms": "",
                "send_count": 0,
                "retransmissions": 0,
                "status": "未确认",
            },
        )
        for key in ("stream_id", "frame_seq"):
            if item.get(key) is not None:
                row[key] = item[key]
        event = item.get("event")
        if event == "sdk_received":
            row["sdk_received_at"] = item.get("sdk_received_at", item.get("audit_at", ""))
            row["sdk_convert_ms"] = item.get("sdk_convert_ms", "")
            row["labels"] = self._fmt_labels(item.get("labels"))
        elif event == "outbox_persisted":
            row["queue_wait_ms"] = item.get("queue_wait_ms", "")
            row["outbox_persist_ms"] = item.get("outbox_persist_ms", "")
        elif event == "transport_sent":
            send_count = int(item.get("send_count", 0) or 0)
            row["send_count"] = max(int(row["send_count"] or 0), send_count)
            row["retransmissions"] = max(0, row["send_count"] - 1)
        elif event == "node_ack_received":
            row["node_received_at"] = item.get("node_received_at", "")
            for key in (
                "node_receive_diff_ms",
                "node_inbox_persist_ms",
                "ack_rtt_ms",
                "delivery_ms",
                "send_count",
            ):
                if item.get(key) is not None:
                    row[key] = item[key]
            row["retransmissions"] = max(0, int(row["send_count"] or 1) - 1)
            row["status"] = self._latency_status(row.get("delivery_ms"))

    @staticmethod
    def _latency_status(delivery_ms: Any) -> str:
        try:
            value = float(delivery_ms)
        except (TypeError, ValueError):
            return "未确认"
        if value <= 20:
            return "优秀"
        if value <= 100:
            return "正常"
        if value <= 300:
            return "警告"
        return "滞后"

    def _write_summary_csv(self) -> None:
        columns = [
            ("message_id", "消息ID"),
            ("stream_id", "视频流"),
            ("frame_seq", "帧号"),
            ("labels", "识别标签"),
            ("sdk_received_at", "SDK接收时间(北京时间)"),
            ("node_received_at", "Node接收时间(北京时间)"),
            ("sdk_convert_ms", "SDK转换(ms)"),
            ("queue_wait_ms", "Python排队(ms)"),
            ("outbox_persist_ms", "Outbox落盘(ms)"),
            ("node_receive_diff_ms", "SDK到Node(ms)"),
            ("node_inbox_persist_ms", "Node落盘(ms)"),
            ("ack_rtt_ms", "ACK往返(ms)"),
            ("delivery_ms", "完整投递(ms)"),
            ("send_count", "发送次数"),
            ("retransmissions", "重传次数"),
            ("status", "评级"),
        ]
        rows = sorted(
            self._frames.values(),
            key=lambda row: (str(row.get("stream_id", "")), int(row.get("frame_seq") or 0)),
        )
        with self.summary_path.open("w", encoding="utf-8-sig", newline="") as output:
            writer = csv.DictWriter(output, fieldnames=[label for _, label in columns])
            writer.writeheader()
            for row in rows:
                writer.writerow({label: row.get(key, "") for key, label in columns})

    # ── 格式化入口 ──────────────────────────────────────────────────────

    @staticmethod
    def _format_text(item: Dict[str, Any]) -> str:
        event = item.get("event", "")
        if event == "sdk_received":
            return _fmt_sdk_received(item)
        if event == "outbox_persisted":
            return _fmt_outbox_persisted(item)
        if event == "transport_sent":
            return _fmt_transport_sent(item)
        if event == "node_ack_received":
            return _fmt_node_ack(item)
        # 兜底：未知事件类型用精简 key=value
        return _fmt_fallback(item)

    # ── 辅助 ────────────────────────────────────────────────────────────

    @staticmethod
    def _short_stream(stream_id: str) -> str:
        """将 'group-1/source-1' 缩写为 'g1/s1'。"""
        return stream_id.replace("group-", "g").replace("source-", "s")

    @staticmethod
    def _fmt_labels(labels) -> str:
        """将标签列表格式化为紧凑字符串。"""
        if not labels:
            return "-"
        parts = []
        for lb in labels:
            if isinstance(lb, dict):
                parts.append(
                    "m{}:{}({:.3f})".format(
                        lb.get("model_id", "?"),
                        lb.get("label", ""),
                        float(lb.get("confidence", 0.0) or 0.0),
                    )
                )
            else:
                parts.append(str(lb))
        return ", ".join(parts) if parts else "-"

    @staticmethod
    def _time_of(item: Dict[str, Any]) -> str:
        """从 audit_at 提取 HH:MM:SS。"""
        at = item.get("audit_at", "")
        # "2026-06-30T16:24:49.903+08:00" → "16:24:49"
        m = re.search(r"T(\d{2}:\d{2}:\d{2})", at)
        return m.group(1) if m else at


# ── 各事件格式化函数 ────────────────────────────────────────────────────


def _fmt_sdk_received(item: Dict[str, Any]) -> str:
    """[SDK] #    3 g1/s1 │ SDK转换   0.04ms │ 标签: m1:person(0.950) │ 16:24:49"""
    seq = item.get("frame_seq", "?")
    stream = TransmissionAuditLogger._short_stream(str(item.get("stream_id", "?")))
    sdk_ms = float(item.get("sdk_convert_ms", 0) or 0)
    labels_str = TransmissionAuditLogger._fmt_labels(item.get("labels"))
    tm = TransmissionAuditLogger._time_of(item)

    return (
        "[SDK] #{:<5} {} │ SDK转换 {:>7.2f}ms │ "
        "标签: {} │ {}".format(
            seq,
            stream,
            sdk_ms,
            labels_str,
            tm,
        )
    )


def _fmt_outbox_persisted(item: Dict[str, Any]) -> str:
    """[OUT] #    3 g1/s1 │ 入队等待   0.08ms  落盘   1.57ms │ 16:24:49"""
    seq = item.get("frame_seq", "?")
    stream = TransmissionAuditLogger._short_stream(str(item.get("stream_id", "?")))
    queue_ms = float(item.get("queue_wait_ms", 0) or 0)
    persist_ms = float(item.get("outbox_persist_ms", 0) or 0)
    tm = TransmissionAuditLogger._time_of(item)

    return (
        "[OUT] #{:<5} {} │ 入队等待 {:>7.2f}ms  落盘 {:>7.2f}ms │ "
        "{}".format(
            seq,
            stream,
            queue_ms,
            persist_ms,
            tm,
        )
    )


def _fmt_transport_sent(item: Dict[str, Any]) -> str:
    """[SEND] #   3 g1/s1 │ 发送次数 1 │ 16:24:49"""
    seq = item.get("frame_seq", "?")
    stream = TransmissionAuditLogger._short_stream(str(item.get("stream_id", "?")))
    count = item.get("send_count", "?")
    tm = TransmissionAuditLogger._time_of(item)

    return (
        "[SEND] #{:<5} {} │ 发送次数 {} │ {}".format(
            seq,
            stream,
            count,
            tm,
        )
    )


def _fmt_node_ack(item: Dict[str, Any]) -> str:
    """[ACK] #    3 g1/s1 │ Py处理   1.23ms → 网络往返   2.34ms → Node落盘   0.56ms │ 端到端   4.13ms │ 16:24:49"""
    seq = item.get("frame_seq", "?")
    stream = TransmissionAuditLogger._short_stream(str(item.get("stream_id", "?")))
    delivery = float(item.get("delivery_ms", 0) or 0)
    ack_rtt = float(item.get("ack_rtt_ms", 0) or 0)
    node_persist = float(item.get("node_inbox_persist_ms", 0) or 0)
    py_side = max(0, delivery - ack_rtt - node_persist)
    node_diff = item.get("node_receive_diff_ms")
    resend = max(0, int(item.get("send_count", 1) or 1) - 1)
    tm = TransmissionAuditLogger._time_of(item)

    chain = "Py处理 {:>7.2f}ms → 网络往返 {:>7.2f}ms → Node落盘 {:>7.2f}ms".format(
        py_side, ack_rtt, node_persist
    )
    extra = ""
    if node_diff is not None:
        extra += " | SDK→Node {:.2f}ms".format(float(node_diff))
    if resend:
        extra += " | 重发 {}".format(resend)

    return (
        "[ACK] #{:<5} {} │ {} │ 端到端 {:>7.2f}ms{} │ {}".format(
            seq,
            stream,
            chain,
            delivery,
            extra,
            tm,
        )
    )


def _fmt_fallback(item: Dict[str, Any]) -> str:
    """兜底：未知事件类型。"""
    event = item.get("event", "?")
    tm = TransmissionAuditLogger._time_of(item)
    parts = ["event={}".format(event)]
    for key, value in sorted(item.items()):
        if key in ("audit_at", "event"):
            continue
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        parts.append("{}={}".format(key, value))
    return "[{}] {} │ {}".format(event[:4].upper(), " | ".join(parts), tm)
