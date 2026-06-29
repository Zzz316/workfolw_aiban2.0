"""
系统统一启动入口
-----------------
  python main.py

进程模型：
  主进程
  ├── Process: videowork   — 视频推理
  ├── Process: videoalarm  — 报警写库
  └── Thread:  Flask       — Web API (icameraapi)
"""

import sys
import os
import time
import logging
import threading
import json
from logging.handlers import TimedRotatingFileHandler
from multiprocessing import Process, Queue, Pipe

# ── 路径设置（必须在所有 import 之前）───────────────────────
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ICAMERAAPI_DIR = os.path.join(BASE_DIR, "icameraapi")

sys.path.insert(0, BASE_DIR)
sys.path.insert(0, ICAMERAAPI_DIR)

# ── 业务模块 import ──────────────────────────────────────────
from core.infra import mylog_helper, global_sys_logger, alam_msg
from core.video_process import videowork, videoalarm

# ── 模块级 alarm_queue 引用（供 Flask 手动触发喇叭用）────────
_alarm_queue_ref = None


def setup_flask_logging():
    log_dir = os.path.join(BASE_DIR, 'log', 'flasklogs')
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)

    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)

    for handler in root_logger.handlers:
        if getattr(handler, '_aiban_flask_handler', False):
            return logging.getLogger('icamera.flask')

    file_handler = TimedRotatingFileHandler(
        filename=os.path.join(log_dir, 'app.log'),
        when='midnight',
        interval=1,
        backupCount=30,
        encoding='utf-8'
    )
    file_handler.setLevel(logging.INFO)
    file_handler._aiban_flask_handler = True
    file_handler.setFormatter(logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s'
    ))

    class FlaskLogFilter(logging.Filter):
        def filter(self, record):
            return record.name.startswith(('icamera', 'werkzeug', 'flask'))

    file_handler.addFilter(FlaskLogFilter())
    root_logger.addHandler(file_handler)
    return logging.getLogger('icamera.flask')


def start_flask():
    try:
        flask_logger = setup_flask_logging()
        from icameraapi.icamera.config.setting import SERVER_HOST, SERVER_PORT
        from icameraapi.icamera import app

        # ── 手动触发喇叭测试接口 ──────────────────────────────
        @app.route('/aiban/speaker/test', methods=['POST'])
        def speaker_test():
            """Node-RED 手动触发喇叭测试。
            接收 JSON: {sourceid, group_id?, speak_type?}
            speak_type: "on"(默认) | "off"
            将测试消息放入 alarm_queue，由 videoalarm 进程发送喇叭指令。
            """
            try:
                data = request.get_json(force=True, silent=True) or {}
            except Exception:
                data = {}
            sourceid = data.get('sourceid')
            groupid = data.get('group_id', 1)
            speak_type = data.get('speak_type', 'on')
            speak_val = 1 if speak_type == 'on' else 0

            if sourceid is None:
                return {'status': '999', 'errmsg': '缺少 sourceid'}, 400

            try:
                sourceid = int(sourceid)
                groupid = int(groupid)
            except (TypeError, ValueError):
                return {'status': '999', 'errmsg': 'sourceid/group_id 必须为整数'}, 400

            if _alarm_queue_ref is None:
                global_sys_logger.error("[手动触发] alarm_queue 未初始化，无法发送测试指令")
                return {'status': '999', 'errmsg': 'alarm_queue 未就绪'}, 503

            global_sys_logger.info(
                "[手动触发] 收到喇叭测试请求: sourceid=%s groupid=%s speak=%s(%s)",
                sourceid, groupid, speak_val, speak_type
            )

            # 构造测试报警消息 — who="manual_test" 标识为手动触发
            test_msg = alam_msg(
                groupid, sourceid, "manual_test",
                None, speak_val,                           # led=None, speak=1/0
                "手动触发测试",                              # msg1
                "喇叭手动测试播报",                           # msg2
                None,                                       # msg3 (无抓图)
                None                                        # table (不写库)
            )
            _alarm_queue_ref.put(test_msg)

            global_sys_logger.info(
                "[手动触发] 测试消息已入队 sourceid=%s speak=%s", sourceid, speak_val
            )
            return {
                'status': '200',
                'errmsg': '',
                'data': {
                    'sourceid': sourceid,
                    'group_id': groupid,
                    'speak': speak_val,
                    'speak_type': speak_type,
                }
            }, 200

        # 需要 request 对象
        from flask import request

        flask_logger.info("Flask starting on %s:%s", SERVER_HOST, SERVER_PORT)
        global_sys_logger.info("Flask starting on %s:%s", SERVER_HOST, SERVER_PORT)
        app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False, threaded=True)
    except Exception as e:
        global_sys_logger.exception("Flask failed to start: %s", e)


def _watch(proc, name):
    proc.join()
    global_sys_logger.warning("Process '%s' (pid=%s) exited with code %s",
                               name, proc.pid, proc.exitcode)


def _shutdown_proc(proc, name, pipe_send_end=None):
    if pipe_send_end is not None:
        try:
            pipe_send_end.send(True)
        except Exception:
            pass

    if proc.is_alive():
        proc.join(timeout=5)

    if proc.is_alive():
        global_sys_logger.warning("%s still alive, terminating...", name)
        proc.terminate()
        proc.join(timeout=2)

    if proc.is_alive():
        global_sys_logger.error("%s failed to terminate, killing...", name)
        proc.kill()

    global_sys_logger.info("%s stopped", name)


def except_hook(cls, exception, traceback):
    sys.__excepthook__(cls, exception, traceback)
    global_sys_logger.error("Uncaught exception: %s", exception)


if __name__ == '__main__':
    from multiprocessing import freeze_support
    freeze_support()
    sys.excepthook = except_hook

    global_sys_logger.info('=' * 60)
    global_sys_logger.info('AiBan System Starting...  pid=%d', os.getpid())
    global_sys_logger.info('=' * 60)

    video_pipe, alarm_pipe = Pipe()
    alarm_queue   = Queue()
    tool_io_queue = Queue()
    log_queue     = Queue()                    # 子进程 → 主进程 日志转发队列

    # 暴露给 Flask 手动触发喇叭接口使用
    _alarm_queue_ref = alarm_queue

    # ── 日志转发线程：将子进程的 log record 统一交由主进程写入文件 ──
    def _log_forwarder():
        """从 multiprocessing.Queue 读取子进程发来的 log record，转交主进程 logger 处理。
        只有主进程持有 TimedRotatingFileHandler，避免多进程轮转冲突。"""
        while True:
            try:
                record = log_queue.get()
                if record is None:            # sentinel — 优雅退出
                    break
                mylog_helper.logger.handle(record)
            except Exception:
                pass

    threading.Thread(target=_log_forwarder, name="log-forwarder", daemon=True).start()

    video_proc = Process(
        target=videowork,
        name="videowork",
        args=(
            video_pipe,
            alarm_queue,
            tool_io_queue,
            log_queue,                        # ← 新增
            'D:/product/AiBanWorkSpace/config.ini',
            'D:/product/AiBanWorkSpace/abvideo/main-flow.yaml'),
    )
    video_proc.start()
    global_sys_logger.info("videowork started, pid=%d", video_proc.pid)

    alarm_proc = Process(
        target=videoalarm,
        name="videoalarm",
        args=(alarm_pipe, alarm_queue, tool_io_queue, log_queue),  # ← 新增
    )
    alarm_proc.start()
    global_sys_logger.info("videoalarm started, pid=%d", alarm_proc.pid)

    flask_thread = threading.Thread(target=start_flask, name="flask", daemon=True)
    flask_thread.start()
    global_sys_logger.info("Flask thread started")

    threading.Thread(target=_watch, args=(video_proc, "videowork"), daemon=True).start()
    threading.Thread(target=_watch, args=(alarm_proc, "videoalarm"), daemon=True).start()

    global_sys_logger.info('All services started')
    global_sys_logger.info('=' * 60)

    try:
        while True:
            if not video_proc.is_alive() or not alarm_proc.is_alive():
                global_sys_logger.warning("A child process exited unexpectedly, shutting down")
                break
            time.sleep(2)

    except KeyboardInterrupt:
        global_sys_logger.info("KeyboardInterrupt received, stopping...")

    except Exception as e:
        global_sys_logger.exception("Main loop error: %s", e)

    finally:
        global_sys_logger.info('=' * 60)
        global_sys_logger.info('AiBan System Stopping...')

        _shutdown_proc(video_proc, "videowork", pipe_send_end=video_pipe)
        _shutdown_proc(alarm_proc, "videoalarm", pipe_send_end=alarm_pipe)

        global_sys_logger.info('AiBan System Stopped')
        global_sys_logger.info('=' * 60)
        log_queue.put(None)               # 通知日志转发线程退出
        mylog_helper.close_log()
