import os
import threading
import time
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from icameraapi.icamera.tool.regionname import regionname

sys_path_appended = False
try:
    import sys
    # sys.path.append(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "AiBanWorkSpace"))
    sys.path.append("D:/product/AiBanWorkSpace/")
    import libAiBanVideoPy3_9 as AiBanVideoPy
    import libAiBanLitePy3_9 as AiBanLitePy
    
    sys_path_appended = True
except Exception:
    pass

from core.infra import global_sys_logger, alam_msg, api_trigger_logger
from core.workflow_engine import WorkflowEngine

# workflows/ 目录位于项目根
_WORKFLOWS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "workflows")


class AibanVideoProcess:
    def __init__(self, msgqueue, toolqueue, userconfig, piplieconfig):
        self.videoinstance = AiBanVideoPy.aibanVideoGetInstance()
        self.userconfig = userconfig
        self.piplieconfig = piplieconfig

        self.alarm_queue = msgqueue
        self._region_name = None
        self._region_name_loading = False

        self.engine = WorkflowEngine(
            alarm_fn=self._engine_alarm,
            save_db_fn=self._engine_save_db,
            region_fn=self.region_name,
        )
        self._load_workflows()

        self._watcher_stop = threading.Event()
        self._stopped = False
        self._api_server = None
        self._api_server_thread = None
        self._api_server_address = None
        self._start_api_server_if_needed()
        self._watcher = threading.Thread(target=self._workflow_watcher, name="workflow-watcher", daemon=True)
        self._watcher.start()

        global_sys_logger.info('vidoe process init ok, pid=%d', os.getpid())

    def _load_workflows(self):
        self.engine.load_dir(_WORKFLOWS_DIR)

    def _workflow_watcher(self, interval=5):
        while not self._watcher_stop.wait(interval):
            try:
                reloaded = self.engine.load_dir(_WORKFLOWS_DIR)
                if reloaded:
                    global_sys_logger.info("workflow-watcher: 工作流已变更并重载")
                    self._restart_api_server_if_changed()
            except Exception as e:
                global_sys_logger.error("workflow-watcher error: %s", e)

    def _start_api_server_if_needed(self):
        cfg = self.engine.get_api_server_config()
        if not cfg:
            return
        host = cfg.get("host", "0.0.0.0")
        port = int(cfg.get("port", 18080))
        max_body = int(cfg.get("max_body_bytes", 1048576))
        engine = self.engine

        class ApiHandler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                api_trigger_logger.info("API trigger: " + fmt, *args)

            def _handle(self):
                try:
                    length = int(self.headers.get("Content-Length", "0") or 0)
                    if length > max_body:
                        self._write_json(413, {"status": "999", "errmsg": "Request body too large"})
                        return
                    raw_body = self.rfile.read(length) if length > 0 else b""
                    result = engine.handle_api_request(self.command, self.path, dict(self.headers), raw_body)
                    self._write_json(result.get("status", 200), result.get("body", {}), result.get("headers", {}))
                except Exception as e:
                    global_sys_logger.exception("API trigger request error: %s", e)
                    self._write_json(500, {"status": "999", "errmsg": "Internal error"})

            def _write_json(self, status, body, headers=None):
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                for key, value in (headers or {}).items():
                    if key.lower() in ("content-type", "content-length"):
                        continue
                    self.send_header(key, str(value))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._handle()

            def do_POST(self):
                self._handle()

            def do_PUT(self):
                self._handle()

            def do_PATCH(self):
                self._handle()

        try:
            self._api_server = ThreadingHTTPServer((host, port), ApiHandler)
            self._api_server_thread = threading.Thread(
                target=self._api_server.serve_forever,
                name="api-trigger-server",
                daemon=True,
            )
            self._api_server_thread.start()
            self._api_server_address = (host, port)
            global_sys_logger.info("API trigger server listening on %s:%s", host, port)
        except Exception as e:
            self._api_server = None
            self._api_server_thread = None
            self._api_server_address = None
            global_sys_logger.error("API trigger server start failed: %s", e)

    def _stop_api_server(self):
        if not self._api_server:
            return
        try:
            self._api_server.shutdown()
            self._api_server.server_close()
            global_sys_logger.info("API trigger server stopped")
        except Exception as e:
            global_sys_logger.warning("API trigger server stop failed: %s", e)
        finally:
            self._api_server = None
            self._api_server_thread = None
            self._api_server_address = None

    def _restart_api_server_if_changed(self):
        cfg = self.engine.get_api_server_config()
        desired = None
        if cfg:
            desired = (cfg.get("host", "0.0.0.0"), int(cfg.get("port", 18080)))
        if desired == self._api_server_address:
            return
        self._stop_api_server()
        self._start_api_server_if_needed()

    def run(self):
        global_sys_logger.info("Video process running")
        self.videoinstance.registerVideoResultFunc(self.aibanvideometadataresult_callback)
        try:
            self.videoinstance.registerVideoMsgEventFunc(self._video_msg_event_callback)
        except Exception as ee:
            global_sys_logger.warning("registerVideoMsgEventFunc 不可用: %s", ee)
        self.videoinstance.checkAllConfig(self.piplieconfig)
        self.videoinstance.buildPipline()

    def stop(self):
        """通知 SDK 停止 pipeline 并停掉热重载线程，多次调用安全。"""
        if self._stopped:
            return
        self._stopped = True
        self._watcher_stop.set()
        self._stop_api_server()
        try:
            self.videoinstance.stopPipline()
            global_sys_logger.info("Video pipeline stopped")
        except Exception as ee:
            global_sys_logger.exception("stopPipline 调用失败: %s", ee)
        if self._watcher.is_alive():
            self._watcher.join(timeout=1)

    def region_name(self):
        """懒加载区域名称，避免阻塞初始化"""
        global _region_name, _region_name_loading
        if self._region_name is None and not self._region_name_loading:
            try:
                self._region_name_loading = True
                result = regionname(0)
                self._region_name = result[0] if isinstance(result, list) else list(result.values())[0]
                global_sys_logger.info(f'Region name loaded: {self._region_name}')
            except Exception as e:
                global_sys_logger.error(f'Failed to load region name: {e}')
                self._region_name = "未知区域"  # 降级处理
            finally:
                self._region_name_loading = False
        return self._region_name or "未知区域"

    # ── 引擎回调 ──────────────────────────────────────────────
    def _engine_alarm(self, groupid, sourceid, alarm_type, msg, image_path=None, alarm_table=None, speak=None):
        try:
            alarm_msg = alam_msg(
                groupid, sourceid, alarm_type,
                None, speak, self.region_name(), msg, image_path, alarm_table
            )
            self.alarm_queue.put(alarm_msg)
        except Exception as ee:
            global_sys_logger.exception(ee)

    def _engine_save_db(self, table, fields, db_cfg=None):
        """兜底：仅在 JSON 未配置 db 块时触发，打日志提示"""
        global_sys_logger.warning("[DB] 未配置 db 连接，save_db 被忽略 table=%s fields=%s", table, fields)

    # ── 视频回调入口 ───────────────────────────────────────────

    def aibanvideometadataresult_callback(self, err: bool, groupid: int, sourceid: int, metadata: AiBanVideoPy.IAibanVideoMetaData):
        try:
            if not err:
                camera_key = f"camera_{sourceid}"
                self.engine.on_frame(camera_key, groupid, sourceid, metadata)
        except Exception as ee:
            global_sys_logger.exception(ee)

    def _video_msg_event_callback(self, msg_type, status: bool, msg):
        """SDK 事件回调：内部异常 / 解码 / 模型加载等事件统一打到系统日志。"""
        try:
            # 跳过周期性授权成功日志，仅在授权失败时输出
            if "accredit" in str(msg_type) and status:
                return
            text = " | ".join(msg) if isinstance(msg, (list, tuple)) else str(msg)
            if status:
                global_sys_logger.info("[AiBanVideo] type=%s status=%s msg=%s", msg_type, status, text)
            else:
                global_sys_logger.warning("[AiBanVideo] type=%s status=%s msg=%s", msg_type, status, text)
        except Exception as ee:
            global_sys_logger.exception("video msg event handler error: %s", ee)
