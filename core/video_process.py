import sys
import os
import glob
import json
import threading
import time

from core.infra import global_sys_logger, reconfigure_loggers_for_child_process
from core.video_logic import AibanVideoProcess
from core.alarm_db import AibanVideoAlarm

_WORKFLOWS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "workflows")

# socket_cfg 文件签名缓存（用于热加载检测）
_socket_cfg_signatures = {}


def _load_socket_cfg():
    """扫描 workflows/*.json，合并 socket_server（取第一个）、socket_clients 和 api_outputs。"""
    server = None
    clients = []
    api_outputs = []
    for path in sorted(glob.glob(os.path.join(_WORKFLOWS_DIR, "*.json"))):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if server is None and data.get("socket_server"):
                server = data["socket_server"]
            clients.extend(data.get("socket_clients", []))
            api_outputs.extend(data.get("api_outputs", []))
        except Exception as e:
            global_sys_logger.warning("socket cfg load error %s: %s", path, e)
    if server or clients or api_outputs:
        return {"socket_server": server, "socket_clients": clients, "api_outputs": api_outputs}
    return None


def _load_socket_cfg_if_changed():
    """检测 workflows/*.json 文件是否变更，如有变更则重新加载 socket_cfg。"""
    global _socket_cfg_signatures
    new_sigs = {}
    for path in sorted(glob.glob(os.path.join(_WORKFLOWS_DIR, "*.json"))):
        try:
            stat = os.stat(path)
            new_sigs[path] = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            pass
    if new_sigs == _socket_cfg_signatures:
        return None  # 无变更
    _socket_cfg_signatures = new_sigs
    return _load_socket_cfg()


def videowork(p, msgqueue, toolqueue, logqueue, userconfig, piplieconfig):
    reconfigure_loggers_for_child_process(logqueue)  # 日志统一走 multiprocessing.Queue 转发主进程
    videointerface = None
    try:
        finished = False
        videointerface = AibanVideoProcess(msgqueue, toolqueue, userconfig, piplieconfig)
        videointerface.run()
        while not finished:
            try:
                run = p.recv()
                global_sys_logger.info('videowork receive run single %s', run)
                if run:
                    finished = True
            except EOFError:
                p.close()
                global_sys_logger.info('videowork aiban_vedio_run_p EOFError')
                break
        global_sys_logger.info('videowork video process exit')
    except Exception as ee:
        global_sys_logger.exception(ee)
    finally:
        if videointerface is not None:
            videointerface.stop()


def videoalarm(p, msgqueue, toolqueue, logqueue):
    reconfigure_loggers_for_child_process(logqueue)  # 日志统一走 multiprocessing.Queue 转发主进程
    try:
        finished = False
        socket_cfg = _load_socket_cfg()
        videointerface_alarm = AibanVideoAlarm(msgqueue, toolqueue, socket_cfg=socket_cfg)
        videointerface_alarm.run()

        # ── socket_cfg 热加载线程：每 5 秒检测 JSON 变更，自动更新喇叭/API 配置 ──
        _stop_watcher = threading.Event()

        def _socket_cfg_watcher():
            while not _stop_watcher.wait(5):
                try:
                    new_cfg = _load_socket_cfg_if_changed()
                    if new_cfg is not None:
                        videointerface_alarm.reload_socket_config(new_cfg)
                        global_sys_logger.info("videoalarm: socket_cfg 已热更新")
                except Exception as e:
                    global_sys_logger.error("socket_cfg watcher error: %s", e)

        threading.Thread(target=_socket_cfg_watcher, name="socket-cfg-watcher", daemon=True).start()

        while not finished:
            try:
                run = p.recv()
                global_sys_logger.info('videoalarm receive run single %s', run)
                if run:
                    finished = True
            except EOFError:
                p.close()
                break
        _stop_watcher.set()
        global_sys_logger.info('videoalarm video process exit')
    except Exception as ee:
        global_sys_logger.exception(ee)
