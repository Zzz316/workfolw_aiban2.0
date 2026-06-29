import os
import socket
import datetime
import threading
import json
import hashlib
import pymysql
from pymysql.err import OperationalError

try:
    import requests
    _REQUESTS_OK = True
except ImportError:
    _REQUESTS_OK = False

from core.infra import global_sys_logger


class AibanVideoAlarm:
    def __init__(self, msqu=None, ioqu=None, socket_cfg=None):
        self.alarm_queue = msqu
        self._con = None
        self._cur = None

        # ── socket 配置 ──────────────────────────────────────
        self._server_address = None
        self._default_encoding = 'gbk'
        self._socket_clients = {}       # sourceid -> {host, port, commands, encoding}
        self._connected_clients = {}    # (host, port) -> socket
        self._server_socket = None

        # ── API 输出（报警附加输出）─────────────────────────────
        # api_outputs 单条: {sourceid?(可选), appid, appsecret, url}
        #   填了 sourceid → 只对该摄像头报警推送；留空 → 对所有报警推送。
        self._api_outputs = []          # 绑定了 sourceid 的输出（按 sourceid 过滤）
        self._api_outputs_global = []   # 未绑定 sourceid 的输出（全部报警都推送）

        if socket_cfg:
            srv = socket_cfg.get('socket_server') or {}
            if srv.get('host') and srv.get('port'):
                self._server_address = (srv['host'], int(srv['port']))
                self._default_encoding = srv.get('encoding', 'gbk')
            for c in socket_cfg.get('socket_clients', []):
                sid = c.get('sourceid')
                if sid is not None:
                    self._socket_clients[sid] = {
                        'host': c['host'],
                        'port': int(c['port']),
                        'commands': c.get('commands', {}),
                        'encoding': c.get('encoding', self._default_encoding),
                    }
            for o in socket_cfg.get('api_outputs', []):
                if not o.get('url') or not o.get('appid'):
                    continue
                sid = o.get('sourceid')
                if sid is None or str(sid) == '':
                    self._api_outputs_global.append(o)
                else:
                    self._api_outputs.append(o)

        global_sys_logger.info('alarm parameters is ok, pid=%d', os.getpid())

    def reload_socket_config(self, socket_cfg: dict):
        """热加载 socket_clients / api_outputs 配置（JSON 变更时调用）。

        仅更新 socket_clients 和 api_outputs，不动 socket_server。
        调用方负责保证线程安全（alam_process 在 daemon 线程中运行）。
        """
        if not socket_cfg:
            return
        new_clients = {}
        default_enc = socket_cfg.get('socket_server', {}).get('encoding', self._default_encoding)
        for c in socket_cfg.get('socket_clients', []):
            sid = c.get('sourceid')
            if sid is not None:
                new_clients[sid] = {
                    'host': c['host'],
                    'port': int(c['port']),
                    'commands': c.get('commands', {}),
                    'encoding': c.get('encoding', default_enc),
                }
        if new_clients != self._socket_clients:
            global_sys_logger.info(
                "alarm_db: socket_clients 已热更新 sourceids=%s", list(new_clients.keys())
            )
            self._socket_clients = new_clients

        new_outputs = []
        new_outputs_global = []
        for o in socket_cfg.get('api_outputs', []):
            if not o.get('url') or not o.get('appid'):
                continue
            sid = o.get('sourceid')
            if sid is None or str(sid) == '':
                new_outputs_global.append(o)
            else:
                new_outputs.append(o)
        self._api_outputs = new_outputs
        self._api_outputs_global = new_outputs_global

    def run(self):
        # daemon 线程：进程退出时自动结束，不阻塞 Pipe 信号接收
        if self._server_address:
            threading.Thread(target=self._start_server, daemon=True).start()
        t = threading.Thread(target=self.alam_process, daemon=True)
        t.start()

    # ── socket 服务器 ─────────────────────────────────────────

    def _start_server(self):
        try:
            self._server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self._server_socket.bind(self._server_address)
            self._server_socket.listen(10)
            global_sys_logger.info("socket server listening on %s:%s", *self._server_address)
            while True:
                client_sock, client_addr = self._server_socket.accept()
                threading.Thread(
                    target=self._handle_client,
                    args=(client_sock, client_addr),
                    daemon=True,
                ).start()
        except Exception as e:
            global_sys_logger.error("socket server error: %s", e)

    def _handle_client(self, client_sock, client_addr):
        global_sys_logger.info("socket client connected: %s", client_addr)
        self._connected_clients[client_addr] = client_sock
        try:
            while True:
                data = client_sock.recv(1024)
                if not data:
                    break
        except Exception:
            pass
        finally:
            global_sys_logger.info("socket client disconnected: %s", client_addr)
            self._connected_clients.pop(client_addr, None)
            client_sock.close()

    def _send_command(self, target_addr, data: bytes):
        sock = self._connected_clients.get(target_addr)
        if sock:
            try:
                sock.sendall(data)
            except Exception as e:
                global_sys_logger.warning("socket send failed to %s: %s", target_addr, e)
        else:
            global_sys_logger.warning("socket client not connected: %s", target_addr)

    def _send_hex_or_tts(self, target_addr, cmd_def: dict, encoding: str):
        if 'hex' in cmd_def:
            self._send_command(target_addr, bytes.fromhex(cmd_def['hex']))
        if 'tts' in cmd_def:
            self._send_command(target_addr, cmd_def['tts'].encode(encoding))

    # ── API 输出（报警附加输出，格式同 api.py）────────────────

    def _send_api_output(self, groupid, sourceid, ngcode, ngarea):
        """报警发生时，对匹配的 api_outputs 配置发起签名 POST（在后台线程里发，不阻塞报警消费）。
        匹配规则：group_id 一致（未配置 group_id 的视为通配）；留空 sourceid 的对该 group 全部报警生效，
        否则要求 sourceid 一致。"""
        def _group_ok(o):
            g = o.get('group_id')
            return g is None or str(g) == str(groupid)

        targets = [o for o in self._api_outputs_global if _group_ok(o)]
        for o in self._api_outputs:
            if _group_ok(o) and str(o.get('sourceid')) == str(sourceid):
                targets.append(o)
        if not targets:
            return
        if not _REQUESTS_OK:
            global_sys_logger.error("requests 未安装，无法推送 API 输出")
            return
        for o in targets:
            threading.Thread(
                target=self._post_api_output,
                args=(o, ngcode, ngarea),
                daemon=True,
            ).start()

    @staticmethod
    def _post_api_output(cfg: dict, ngcode, ngarea):
        try:
            url = cfg['url']
            appid = str(cfg.get('appid', ''))
            appsecret = str(cfg.get('appsecret', ''))
            timestamp = str(datetime.datetime.now())
            appsign = hashlib.md5((appid + timestamp + appsecret).encode('UTF-8')).hexdigest()

            headers = {
                "version": "2", "appid": appid, "timestamp": timestamp, "appsign": appsign,
                "content-type": "application/json; charset=UTF-8",
            }
            params = {
                "channelCode": appid,
                "args": {"address": ngarea, "code": ngcode},
            }
            resp = requests.post(url, headers=headers, data=json.dumps(params), timeout=5)
            global_sys_logger.info("API 输出已推送 appid=%s code=%s address=%s resp=%s",
                                   appid, ngcode, ngarea, resp.text[:200])
        except Exception as e:
            global_sys_logger.warning("API 输出推送失败 url=%s: %s", cfg.get('url'), e)

    # ── DB 连接（懒连接 + 断线重连）──────────────────────────

    def _ensure_connection(self):
        if self._con is None:
            self._connect()

    def _connect(self):
        self._con = pymysql.connect(
            host="127.0.0.1", user="root", password="root",
            charset='GB2312', autocommit=False
        )
        self._cur = self._con.cursor()
        global_sys_logger.info("alarm DB connected")

    def _close(self):
        try:
            if self._cur:
                self._cur.close()
            if self._con:
                self._con.close()
        except Exception:
            pass
        self._con = None
        self._cur = None

    def _save_db(self, data, table=None):
        """data: tuple, table: 表名（可选，默认 icamera_data.icam_alarm_data）"""
        if table is None:
            table = "icamera_data.icam_alarm_data"

        for attempt in (1, 2):
            try:
                self._ensure_connection()
                sql = (
                    f"INSERT INTO {table} "
                    "(day, time, time_division, time_month, week, region, "
                    "group_id, camera_id, alarm_content, img_path, timedate, alarm_status) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
                )
                self._cur.execute(sql, data)
                self._con.commit()
                return
            except OperationalError:
                global_sys_logger.warning("alarm DB connection lost, reconnecting...")
                self._close()
        global_sys_logger.error("alarm DB write failed after retry, data dropped: %s", data)

    # ── 报警消费主循环 ────────────────────────────────────────

    def alam_process(self):
        try:
            while True:
                # 阻塞等待，有消息才唤醒，不占 CPU
                alarm_info = self.alarm_queue.get()

                sourceid = alarm_info.sourceid
                groupid  = alarm_info.groupid
                who      = alarm_info.who
                msg1     = alarm_info.msg1
                msg2     = alarm_info.msg2
                msg3     = alarm_info.msg3
                table    = alarm_info.table
                speak    = alarm_info.speak

                # ── 手动触发测试：跳过 DB 写库，仅发喇叭指令并记录日志 ──
                is_manual_test = (who == "manual_test")

                if msg1 is None and msg2 is None:
                    continue

                imgpath = msg3[10:] if isinstance(msg3, str) and len(msg3) > 10 else (msg3 or '')
                now = datetime.datetime.now()

                if not is_manual_test:
                    data = (
                        now.strftime('%Y-%m-%d'),
                        now.strftime('%H:%M:%S'),
                        now.strftime('%H:%M'),
                        now.strftime('%m'),
                        now.isocalendar()[1],
                        msg1,
                        groupid,
                        sourceid,
                        msg2,
                        imgpath,
                        now,
                        'NG',
                    )
                    self._save_db(data, table)

                client_cfg = self._socket_clients.get(sourceid)
                tag = "[手动触发]" if is_manual_test else "[语音播报]"
                if client_cfg:
                    target_addr = (client_cfg['host'], client_cfg['port'])
                    commands = client_cfg.get('commands', {})
                    encoding = client_cfg.get('encoding', self._default_encoding)
                    if speak == 1 and 'speak_on' in commands:
                        cmd_def = commands['speak_on']
                        cmd_info = cmd_def.get('tts') or cmd_def.get('hex') or str(cmd_def)
                        global_sys_logger.info(
                            "%s sourceid=%s 播报开启 alarm=%s target=%s:%s cmd=%s",
                            tag, sourceid, msg2,
                            client_cfg['host'], client_cfg['port'],
                            cmd_info[:80]
                        )
                        self._send_hex_or_tts(target_addr, commands['speak_on'], encoding)
                        global_sys_logger.info(
                            "%s sourceid=%s 语音指令已发送", tag, sourceid
                        )
                    elif speak == 0 and 'speak_off' in commands:
                        global_sys_logger.info(
                            "%s sourceid=%s 播报关闭 target=%s:%s",
                            tag, sourceid, client_cfg['host'], client_cfg['port']
                        )
                        self._send_hex_or_tts(target_addr, commands['speak_off'], encoding)
                        global_sys_logger.info(
                            "%s sourceid=%s 关闭指令已发送", tag, sourceid
                        )
                else:
                    global_sys_logger.warning(
                        "%s sourceid=%s 未找到 socket 客户端配置，无法发送喇叭指令",
                        tag, sourceid
                    )

                # API 输出：ngcode=报警内容(msg2)，ngarea=区域(msg1)
                if not is_manual_test:
                    self._send_api_output(groupid, sourceid, msg2, msg1)

        except Exception as ee:
            global_sys_logger.exception(ee)
        finally:
            self._close()
