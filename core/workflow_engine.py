"""
Workflow Engine
---------------
加载 JSON 工作流配置，驱动四种业务模式：
  - custom_flow  : 用户自定义流程（兼容旧 state_machine）
  - timer_record : 计时工时（start label→end label→存库）
  - sequence     : 步骤顺序（step1→step2→...→OK）
  - monitor      : 持续监控（出现/缺失帧规则）

每个摄像头独立一个 CameraRunner 实例，引擎本身无业务代码。
"""

import json
import time
import os
import glob
import datetime
import importlib
import threading
import hashlib
import hmac
from urllib.parse import parse_qs, urlsplit
from typing import Callable, Optional
from core.infra import global_sys_logger, api_trigger_logger

try:
    import pymysql
    _PYMYSQL_OK = True
except ImportError:
    _PYMYSQL_OK = False


# ─────────────────────────────────────────────
# 报警 / 存库 占位接口（后续替换真实实现）
# ─────────────────────────────────────────────

def _alarm_stub(groupid, sourceid, alarm_type, msg, image_path=None, alarm_table=None, speak=None):
    """报警占位：打日志，后续接真实报警队列"""
    global_sys_logger.warning(
        "[ALARM] group=%s source=%s type=%s msg=%s image=%s table=%s speak=%s",
        groupid, sourceid, alarm_type, msg, image_path, alarm_table, speak
    )


def _save_db_stub(table, fields, db_cfg=None):
    """存库占位：打日志，后续接真实 DB"""
    global_sys_logger.info("[DB] table=%s fields=%s", table, fields)


def _get_path(source, dotted_path: str):
    """安全 dot-path 取值，支持 dict / list 索引；失败返回 None。"""
    if not dotted_path:
        return None
    cur = source
    for part in dotted_path.split('.'):
        if part == '':
            return None
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
        if cur is None:
            return None
    return cur


# ─────────────────────────────────────────────
# 简易 DB 写入（供引擎内部 save_db 动作使用）
# ─────────────────────────────────────────────

def _db_insert(db_cfg: dict, table: str, fields: dict):
    """用 db_cfg 连接 MySQL，向 table 插入 fields。成功返回自增 ID（lastrowid），失败返回 None。"""
    if not _PYMYSQL_OK:
        global_sys_logger.error("[DB] pymysql 未安装，无法写库")
        return None
    if not db_cfg:
        global_sys_logger.error("[DB] 未配置 db 连接参数，无法写库 table=%s", table)
        return None
    try:
        con = pymysql.connect(
            host=db_cfg.get("host", "127.0.0.1"),
            port=int(db_cfg.get("port", 3306)),
            user=db_cfg.get("user", "root"),
            password=db_cfg.get("password", ""),
            charset=db_cfg.get("charset", "utf8mb4"),
            autocommit=True,
        )
        try:
            cols = ", ".join(fields.keys())
            placeholders = ", ".join(["%s"] * len(fields))
            sql = f"INSERT INTO {table} ({cols}) VALUES ({placeholders})"
            with con.cursor() as cur:
                cur.execute(sql, list(fields.values()))
                last_id = cur.lastrowid
            global_sys_logger.info("[DB] 写库成功 table=%s id=%s", table, last_id)
            return last_id
        finally:
            con.close()
    except Exception as e:
        global_sys_logger.error("[DB] 写库失败 table=%s err=%s", table, e)
        return None


def _db_update(db_cfg: dict, table: str, fields: dict, where: dict):
    """用 db_cfg 连接 MySQL，按 where 条件更新 table 的 fields。

    where 为 {列名: 值} 形式（多个条件 AND）；列名与表名来自配置常量，
    值走参数化占位符，避免 SQL 注入。"""
    if not _PYMYSQL_OK:
        global_sys_logger.error("[DB] pymysql 未安装，无法更新")
        return
    if not db_cfg:
        global_sys_logger.error("[DB] 未配置 db 连接参数，无法更新 table=%s", table)
        return
    if not where:
        global_sys_logger.error("[DB] 缺少 where 条件，拒绝全表更新 table=%s", table)
        return
    try:
        con = pymysql.connect(
            host=db_cfg.get("host", "127.0.0.1"),
            port=int(db_cfg.get("port", 3306)),
            user=db_cfg.get("user", "root"),
            password=db_cfg.get("password", ""),
            charset=db_cfg.get("charset", "utf8mb4"),
            autocommit=True,
        )
        try:
            set_clause = ", ".join(f"{col} = %s" for col in fields.keys())
            where_clause = " AND ".join(f"{col} = %s" for col in where.keys())
            sql = f"UPDATE {table} SET {set_clause} WHERE {where_clause}"
            params = list(fields.values()) + list(where.values())
            with con.cursor() as cur:
                cur.execute(sql, params)
            global_sys_logger.info("[DB] 更新成功 table=%s where=%s", table, where)
        finally:
            con.close()
    except Exception as e:
        global_sys_logger.error("[DB] 更新失败 table=%s err=%s", table, e)


# ─────────────────────────────────────────────
# 变量类型
# ─────────────────────────────────────────────

class CounterVar:
    def __init__(self):
        self.value = 0

    def inc(self):
        self.value += 1

    def reset(self):
        self.value = 0

    def get(self):
        return self.value


class BoolVar:
    def __init__(self, default=False):
        self.value = default

    def set(self, v):
        self.value = bool(v)

    def reset(self):
        self.value = False

    def get(self):
        return self.value


class TimerVar:
    """计时器：支持 start / stop / reset / elapsed / is_running / is_expired"""

    def __init__(self, timeout=None):
        self.timeout = timeout      # 超时秒数，None 表示无超时
        self._start_time = None
        self._stop_time = None
        self.running = False
        self.expired = False

    def start(self):
        if not self.running:
            self._start_time = time.time()
            self._stop_time = None
            self.running = True
            self.expired = False

    def stop(self):
        if self.running:
            self._stop_time = time.time()
            self.running = False

    def reset(self):
        self._start_time = None
        self._stop_time = None
        self.running = False
        self.expired = False

    @property
    def elapsed(self):
        if self._start_time is None:
            return 0.0
        end = self._stop_time if self._stop_time else time.time()
        return end - self._start_time

    @property
    def start_time(self):
        return self._start_time

    def check_expired(self):
        """每帧调用，返回是否刚超时（只触发一次）"""
        if self.running and self.timeout is not None:
            if time.time() - self._start_time >= self.timeout:
                self.running = False
                self.expired = True
                return True
        return False

    def get(self):
        return self


class AccumTimerVar:
    """累积计时器：多次区间累加，支持 start/stop/reset/elapsed"""

    def __init__(self):
        self._accum = 0.0       # 已累积秒数
        self._seg_start = None  # 当前区间开始时间，None 表示未在计时
        self.running = False

    def start(self):
        if not self.running:
            self._seg_start = time.time()
            self.running = True

    def stop(self):
        if self.running:
            self._accum += time.time() - self._seg_start
            self._seg_start = None
            self.running = False

    def reset(self):
        self._accum = 0.0
        self._seg_start = None
        self.running = False

    @property
    def elapsed(self):
        base = self._accum
        if self.running and self._seg_start is not None:
            base += time.time() - self._seg_start
        return base

    def get(self):
        return self


class TrackerVar:
    """位置追踪：累积目标移动距离"""

    def __init__(self):
        self.reset()

    def reset(self):
        self.detecting = False
        self.last_pt = None
        self.start_pt = None
        self.total_movement = 0.0
        self.detected_this_frame = False
        self.was_tracking = False

    def update(self, pt):
        self.detected_this_frame = True
        if not self.detecting:
            self.detecting = True
            self.start_pt = pt
            self.last_pt = pt
            self.total_movement = 0.0
        else:
            if self.last_pt is not None:
                dist = ((pt[0] - self.last_pt[0]) ** 2 +
                        (pt[1] - self.last_pt[1]) ** 2) ** 0.5
                self.total_movement += dist
            self.last_pt = pt

    def frame_begin(self):
        """每帧开始前调用，记录上帧状态"""
        self.was_tracking = self.detecting
        self.detected_this_frame = False

    def get(self):
        return self


def _make_var(decl: dict):
    vtype = decl.get("type", "counter")
    if vtype == "counter":
        return CounterVar()
    if vtype == "bool":
        return BoolVar(decl.get("default", False))
    if vtype == "timer":
        return TimerVar(decl.get("timeout"))
    if vtype == "tracker":
        return TrackerVar()
    raise ValueError(f"Unknown var type: {vtype}")


# ─────────────────────────────────────────────
# 条件表达式求值
# ─────────────────────────────────────────────

class ExprEvaluator:
    """
    支持简单表达式，变量通过 vars_dict 查值。
    支持 var.field 语法（用于 tracker / timer）。
    """

    def __init__(self, vars_dict: dict):
        self._vars = vars_dict

    def _build_ctx(self):
        return _VarProxy(self._vars)

    def eval(self, expr: str) -> bool:
        ctx = self._build_ctx()
        try:
            return bool(eval(expr, {"__builtins__": {}}, {"v": ctx, **ctx._flat()}))
        except Exception as e:
            global_sys_logger.error("ExprEvaluator error expr=%r: %s", expr, e)
            return False


class _VarProxy:
    """将 vars dict 暴露为可点取属性的对象，供 eval 使用"""

    def __init__(self, vars_dict):
        self._vars = vars_dict

    def __getattr__(self, name):
        v = self._vars.get(name)
        if v is None:
            return 0
        raw = v.get() if hasattr(v, "get") else v
        if isinstance(raw, (CounterVar, BoolVar, TimerVar, TrackerVar)):
            return raw
        return raw

    def _flat(self):
        """返回所有变量的扁平化字典，供 eval namespace 使用"""
        return {name: var for name, var in self._vars.items()}


# ─────────────────────────────────────────────
# 动作执行器
# ─────────────────────────────────────────────

class ActionExecutor:
    def __init__(self, vars_: dict, camera_key: str,
                 groupid: int, sourceid: int,
                 alarm_fn: Callable, save_db_fn: Callable,
                 metadata_ref: list,
                 last_alarms: dict,
                 db_cfg: dict = None,
                 region_fn: Callable = None,
                 socket_clients: dict = None,
                 event_ref: list = None):
        self._vars = vars_
        self._camera_key = camera_key
        self._groupid = groupid
        self._sourceid = sourceid
        self._alarm_fn = alarm_fn
        self._save_db_fn = save_db_fn
        self._meta = metadata_ref   # list[metadata]，引用传入便于动态更新
        self._last_alarms = last_alarms
        self._db_cfg = db_cfg or {}
        self._region_fn = region_fn  # () -> str，懒加载区域名称
        self._socket_clients = socket_clients or {}
        self._event_ref = event_ref if event_ref is not None else [None]

    def run(self, actions: list):
        for action in actions:
            self._run_one(action)

    def _run_one(self, action: dict):
        op = list(action.keys())[0]

        if op == "inc":
            self._var(action["inc"]).inc()

        elif op == "set":
            for var_name, val in action["set"].items():
                self._var(var_name).set(val)

        elif op == "reset":
            targets = action["reset"]
            if isinstance(targets, str):
                targets = [targets]
            for name in targets:
                self._var(name).reset()

        elif op == "reset_all":
            for v in self._vars.values():
                v.reset()

        elif op == "start_timer":
            self._var(action["start_timer"]).start()

        elif op == "stop_timer":
            self._var(action["stop_timer"]).stop()

        elif op == "track":
            # 调用方需在动作前把 pt 塞进 action
            var = self._var(action["track"])
            pt = action.get("_pt")
            if pt is not None:
                var.update(pt)

        elif op == "alarm":
            cfg = action["alarm"]
            msg = cfg.get("msg", "")
            alarm_type = cfg.get("type", "ng")
            cooldown = cfg.get("cooldown", 0)
            save_img = cfg.get("save_image", False)
            speak = cfg.get("speak")              # 喇叭/继电器控制: 1=开 0=关 None=不触发
            # 未显式配置 speak 但已配 socket_clients → 自动开启喇叭
            if speak is None:
                if self._sourceid in self._socket_clients:
                    speak = 1
                elif self._socket_clients:
                    # 有 socket_clients 但 sourceid 不匹配 → 记录诊断日志
                    global_sys_logger.warning(
                        "[%s] 报警动作未配置 speak，且 sourceid=%s 不在 socket_clients 中"
                        " (可用 sourceids: %s)，喇叭不会触发。"
                        " 请检查 Node-RED 中 socket-client 节点的 sourceId 是否与摄像头 sourceid 一致。",
                        self._camera_key, self._sourceid, list(self._socket_clients.keys())
                    )

            if cooldown:
                now = time.time()
                last = self._last_alarms.get(msg, 0)
                if now - last < cooldown:
                    global_sys_logger.info("[%s] 报警去重: %s", self._camera_key, msg)
                    return
                self._last_alarms[msg] = now

            image_path = None
            if save_img and self._meta[0] is not None:
                self._meta[0].saveImage(False)
                image_path = self._meta[0].getSaveImagePath()

            self._alarm_fn(self._groupid, self._sourceid, alarm_type, msg, image_path,
                           self._db_cfg.get("alarm_table") if self._db_cfg else None,
                           speak=speak)

        elif op == "save_db":
            cfg = action["save_db"]
            table = cfg["table"]
            raw_fields = cfg.get("fields", {})
            fields = self._resolve_fields(raw_fields)
            if self._db_cfg:
                _db_insert(self._db_cfg, table, fields)
            else:
                self._save_db_fn(table, fields)

        elif op == "log":
            global_sys_logger.info("[%s] %s", self._camera_key, action["log"])

        else:
            global_sys_logger.warning("[%s] 未知动作: %s", self._camera_key, op)

    def _var(self, name: str):
        if name not in self._vars:
            raise KeyError(f"Var '{name}' not declared in workflow vars")
        return self._vars[name]

    def _resolve_fields(self, fields: dict) -> dict:
        """解析 $var 占位符"""
        result = {}
        for k, v in fields.items():
            if isinstance(v, str) and v.startswith("$"):
                ref = v[1:]
                if ref == "now":
                    result[k] = time.time()
                elif ref == "datetime":
                    result[k] = datetime.datetime.now()
                elif ref == "date":
                    result[k] = datetime.datetime.now().strftime('%Y-%m-%d')
                elif ref == "time":
                    result[k] = datetime.datetime.now().strftime('%H:%M:%S')
                elif ref == "time_division":
                    result[k] = datetime.datetime.now().strftime('%H:%M')
                elif ref == "time_month":
                    result[k] = datetime.datetime.now().strftime('%m')
                elif ref == "week":
                    result[k] = datetime.datetime.now().isocalendar()[1]
                elif ref == "sourceid":
                    result[k] = self._sourceid
                elif ref == "camera_id":
                    result[k] = self._camera_key
                elif ref == "region":
                    result[k] = self._region_fn() if self._region_fn else ""
                elif ref.startswith("event."):
                    event_payload = self._event_ref[0] or {}
                    result[k] = _get_path({"event": event_payload}, ref)
                elif ref == "image_path":
                    if self._meta[0] is not None:
                        self._meta[0].saveImage(False)
                        image_path = self._meta[0].getSaveImagePath().replace("\\", "/")
                        result[k] = image_path.replace("D:/product", "", 1)
                    else:
                        result[k] = ""
                elif "." in ref:
                    var_name, attr = ref.split(".", 1)
                    var_obj = self._vars.get(var_name)
                    result[k] = getattr(var_obj, attr, None) if var_obj else None
                else:
                    var_obj = self._vars.get(ref)
                    result[k] = var_obj.get() if var_obj else None
            else:
                result[k] = v
        return result


# ─────────────────────────────────────────────
# 多模型 / 二阶子模型 通用 helper
# ─────────────────────────────────────────────

def _resolve_boxes(metadata, model_id, cache: dict) -> list:
    """每帧一个 cache，避免对同一 model_id 重复调 getModelInferBoxs。"""
    if model_id in cache:
        return cache[model_id]
    _, boxes = metadata.getModelInferBoxs(model_id)
    boxes = boxes or []
    cache[model_id] = boxes
    return boxes


def _normalize_sub_models(cfg: dict) -> list:
    """
    把规则配置归一为 sub_models 列表：
      [{"model_id": int, "labels": [{"name": str, "confidence": float}, ...]}, ...]

    兼容三种旧写法：
      1) sub_models 数组（新写法，直接使用）
      2) sub_model_id + sub_label (dict) → 单 sub_model 单 label
      3) sub_model_id + sub_scan (list) → 单 sub_model 多 label（从 sub_scan 提取）
    """
    new_list = cfg.get("sub_models")
    if isinstance(new_list, list) and new_list:
        seen = {}
        for sm in new_list:
            mid = sm.get("model_id")
            if mid is None:
                continue
            if mid not in seen:
                seen[mid] = {"model_id": mid, "labels": list(sm.get("labels", []))}
            else:
                seen[mid]["labels"].extend(sm.get("labels", []))
        return list(seen.values())

    sm = cfg.get("sub_model_id")
    if not sm:
        return []

    sub_label = cfg.get("sub_label")
    if isinstance(sub_label, dict) and sub_label.get("name"):
        return [{
            "model_id": sm,
            "labels": [{
                "name": sub_label.get("name"),
                "confidence": sub_label.get("confidence", 0.0),
            }],
        }]

    sub_scan = cfg.get("sub_scan")
    if isinstance(sub_scan, list) and sub_scan:
        labels = [{
            "name": s.get("label"),
            "confidence": s.get("confidence", 0.0),
        } for s in sub_scan if s.get("label")]
        if labels:
            return [{"model_id": sm, "labels": labels}]

    return []


def _match_sub_models(parent_box, sub_models_cfg: list) -> bool:
    """
    AND-of-OR：每个 sub_model 必须命中至少一个 label（labels 内 any-of）。
    空配置直接通过。
    """
    if not sub_models_cfg:
        return True
    for sm in sub_models_cfg:
        mid = sm.get("model_id")
        if mid is None:
            continue
        _, sub_boxes = parent_box.getInferBoxWithModelID(mid)
        sub_boxes = sub_boxes or []
        wanted = sm.get("labels", [])
        if not wanted:
            return False
        hit = False
        for b in sub_boxes:
            bname = b.getLabelName()
            bconf = b.getConfidence()
            for w in wanted:
                if bname == w.get("name") and bconf >= w.get("confidence", 0.0):
                    hit = True
                    break
            if hit:
                break
        if not hit:
            return False
    return True


# ─────────────────────────────────────────────
# 三种模式 Runner
# ─────────────────────────────────────────────

def _run_scan(executor, scan_rules: list, metadata, boxes_cache: dict, wf_default_model):
    """
    通用扫描函数：遍历 boxes，按 scan_rules 匹配 label。
    支持：
      - 每条 scan 用 scan["model_id"] 覆盖一阶模型；缺省走 wf_default_model。
      - 二阶子模型：
          a) scan 有 sub_scan (旧写法) → 走旧分支，sub_scan 内可携带 on_found/on_absent 触发子动作。
          b) scan 有 sub_models (新写法) → 走 _match_sub_models 作"父框是否通过"判定，子动作能力交由父 on_found。
    返回本次扫描到的一阶 label 集合（按 (model_id, label) 元组，用于 on_absent 判断）。
    """
    found_keys = set()

    for scan in scan_rules:
        mid = scan.get("model_id", wf_default_model)
        boxes = _resolve_boxes(metadata, mid, boxes_cache)
        scan_label = scan["label"]
        min_conf = scan.get("confidence", 0.0)

        sub_mid_legacy = scan.get("sub_model_id")
        sub_scan_legacy = scan.get("sub_scan")
        use_legacy_sub = bool(sub_mid_legacy and isinstance(sub_scan_legacy, list))
        sub_models = _normalize_sub_models(scan) if not use_legacy_sub else []

        for box in boxes:
            label = box.getLabelName()
            confidence = box.getConfidence()
            if label != scan_label or confidence < min_conf:
                continue
            pt = box.getPolygon()[0] if box.getPolygon() else None
            found_keys.add((mid, scan_label))

            if use_legacy_sub:
                # ── 旧二阶：在父框内取子框，按 sub_scan 逐条触发 on_found / on_absent ──
                _, sub_boxes = box.getInferBoxWithModelID(sub_mid_legacy)
                sub_boxes = sub_boxes or []
                sub_found = set()
                for sub_box in sub_boxes:
                    sub_label = sub_box.getLabelName()
                    sub_conf = sub_box.getConfidence()
                    sub_pt = sub_box.getPolygon()[0] if sub_box.getPolygon() else None
                    sub_found.add(sub_label)
                    for sub_rule in sub_scan_legacy:
                        if sub_rule["label"] == sub_label and sub_conf >= sub_rule.get("confidence", 0.0):
                            acts = StateMachineRunner._inject_pt(sub_rule.get("on_found", []), sub_pt)
                            executor.run(acts)
                for sub_rule in sub_scan_legacy:
                    if sub_rule["label"] not in sub_found:
                        executor.run(sub_rule.get("on_absent", []))
            else:
                # ── 一阶（含可选 sub_models 过滤） ──
                if not _match_sub_models(box, sub_models):
                    continue
                acts = StateMachineRunner._inject_pt(scan.get("on_found", []), pt)
                executor.run(acts)

    return found_keys

class StateMachineRunner:
    """模式：custom_flow（兼容旧 state_machine）"""

    def __init__(self, wf: dict, camera_key: str,
                 alarm_fn: Callable, save_db_fn: Callable,
                 db_cfg: dict = None,
                 region_fn: Callable = None,
                 socket_clients: dict = None):
        self._wf = wf
        self._camera_key = camera_key
        self._alarm_fn = alarm_fn
        self._save_db_fn = save_db_fn

        self._vars = {k: _make_var(v) for k, v in wf.get("vars", {}).items()}
        # 计时器单独也注册进 vars
        for k, v in wf.get("timers", {}).items():
            self._vars[k] = TimerVar(v.get("timeout"))

        self._states = {s["id"]: s for s in wf["states"]}
        self._current_state = wf["states"][0]["id"]
        self._meta_ref = [None]
        self._last_alarms = {}
        self._executor = ActionExecutor(
            self._vars, camera_key,
            wf.get("group_id", 0), 0,
            alarm_fn, save_db_fn,
            self._meta_ref, self._last_alarms,
            db_cfg, region_fn,
            socket_clients=socket_clients
        )
        self._evaluator = ExprEvaluator(self._vars)

    def on_frame(self, groupid, sourceid, metadata):
        if groupid != self._wf.get("group_id", groupid):
            return

        self._meta_ref[0] = metadata
        self._executor._sourceid = sourceid
        state_def = self._states.get(self._current_state)
        if not state_def:
            return

        # 1. tracker frame_begin
        for v in self._vars.values():
            if isinstance(v, TrackerVar):
                v.frame_begin()

        # 2. 扫描 labels（每条 scan 自带 model_id 与可选二阶）
        boxes_cache: dict = {}
        wf_default_model = self._wf.get("model_id", 1)

        found_keys = _run_scan(self._executor, state_def.get("scan", []),
                               metadata, boxes_cache, wf_default_model)

        # 3. on_absent：scan 中声明的 (model_id, label) 本帧未出现
        for scan in state_def.get("scan", []):
            mid = scan.get("model_id", wf_default_model)
            if (mid, scan["label"]) not in found_keys:
                self._executor.run(scan.get("on_absent", []))

        # 4. 计时器超时检查
        for timer_name, timer_var in self._vars.items():
            if isinstance(timer_var, TimerVar) and timer_var.check_expired():
                expire_cfg = state_def.get("on_timer_expire", {})
                if expire_cfg.get("timer") == timer_name:
                    self._run_checks(expire_cfg.get("checks", []))
                    self._executor.run(expire_cfg.get("actions", []))

        # 5. 状态转移
        for trans in state_def.get("transitions", []):
            if self._evaluator.eval(trans["when"]):
                self._executor.run(trans.get("actions", []))
                if "log" in trans:
                    global_sys_logger.info("[%s] %s", self._camera_key, trans["log"])
                if "alarm" in trans:
                    self._executor.run([{"alarm": trans["alarm"]}])
                new_state = trans.get("goto")
                if new_state:
                    global_sys_logger.info("[%s] state: %s → %s",
                                           self._camera_key, self._current_state, new_state)
                    self._current_state = new_state
                break   # 每帧只执行第一个匹配的转移

    def _run_checks(self, checks: list):
        for check in checks:
            if self._evaluator.eval(check["when"]):
                self._executor.run(check.get("actions", []))
                if "log" in check:
                    global_sys_logger.info("[%s] %s", self._camera_key, check["log"])
                if "alarm" in check:
                    self._executor.run([{"alarm": check["alarm"]}])

    @staticmethod
    def _inject_pt(actions: list, pt) -> list:
        result = []
        for a in actions:
            if "track" in a:
                a = dict(a, _pt=pt)
            result.append(a)
        return result


class TimerRecordRunner:
    """模式：timer_record — 识别 start/end label，计时并存库"""

    def __init__(self, wf: dict, camera_key: str,
                 alarm_fn: Callable, save_db_fn: Callable,
                 db_cfg: dict = None,
                 region_fn: Callable = None,
                 socket_clients: dict = None):
        self._wf = wf
        self._camera_key = camera_key

        self._vars = {}
        for k, v in wf.get("timers", {}).items():
            self._vars[k] = TimerVar(v.get("timeout"))

        # ── 离岗追踪 ──────────────────────────────────────────────
        # absence_tracking: { "enabled": true, "person_label": "person",
        #                      "confidence": 0.5, "require_timer_running": "work_timer",
        #                      "accum_var": "absence_timer" }
        at_cfg = wf.get("absence_tracking", {})
        self._at_enabled = at_cfg.get("enabled", False)
        self._at_label = at_cfg.get("person_label", "person")
        self._at_conf = at_cfg.get("confidence", 0.5)
        self._at_guard = at_cfg.get("require_timer_running")
        self._at_var_name = at_cfg.get("accum_var", "absence_timer")
        if self._at_enabled:
            self._vars[self._at_var_name] = AccumTimerVar()
        # ─────────────────────────────────────────────────────────

        self._meta_ref = [None]
        self._last_alarms = {}
        self._executor = ActionExecutor(
            self._vars, camera_key,
            wf.get("group_id", 0), 0,
            alarm_fn, save_db_fn,
            self._meta_ref, self._last_alarms,
            db_cfg, region_fn,
            socket_clients=socket_clients
        )

    def on_frame(self, groupid, sourceid, metadata):
        if groupid != self._wf.get("group_id", groupid):
            return

        self._meta_ref[0] = metadata
        self._executor._sourceid = sourceid

        boxes_cache: dict = {}
        wf_default_model = self._wf.get("model_id", 1)
        # absence_tracking 沿用顶层默认 model_id 的一阶框
        boxes = _resolve_boxes(metadata, wf_default_model, boxes_cache)

        # ── 离岗追踪逻辑 ──────────────────────────────────────────
        if self._at_enabled:
            # 判断守卫：只有指定计时器运行中才追踪离岗
            guard_ok = True
            if self._at_guard:
                guard_timer = self._vars.get(self._at_guard)
                guard_ok = guard_timer is not None and guard_timer.running

            absence_var = self._vars[self._at_var_name]
            if guard_ok:
                # 检查 person label 是否出现（满足置信度）
                person_present = any(
                    b.getLabelName() == self._at_label and b.getConfidence() >= self._at_conf
                    for b in boxes
                )
                if person_present:
                    # 人在岗：停止离岗计时
                    if absence_var.running:
                        absence_var.stop()
                        global_sys_logger.info("[%s] 人员回岗，离岗累计=%.1fs",
                                               self._camera_key, absence_var.elapsed)
                else:
                    # 人离岗：启动离岗计时
                    if not absence_var.running:
                        absence_var.start()
                        global_sys_logger.info("[%s] 人员离岗，开始计时", self._camera_key)
            else:
                # 守卫不满足（工位计时未运行）：停止并重置离岗计时
                if absence_var.running:
                    absence_var.stop()
                if absence_var.elapsed > 0:
                    global_sys_logger.info("[%s] 工位结束，离岗累计=%.1fs",
                                           self._camera_key, absence_var.elapsed)
                    absence_var.reset()
        # ─────────────────────────────────────────────────────────

        for rule in self._wf.get("rules", []):
            label_cfg = rule.get("on_label", {})
            label_name = label_cfg.get("name")
            min_conf = label_cfg.get("confidence", 0.0)

            mid = rule.get("model_id", wf_default_model)
            rule_boxes = _resolve_boxes(metadata, mid, boxes_cache)
            sub_models = _normalize_sub_models(label_cfg)

            for box in rule_boxes:
                if box.getLabelName() != label_name:
                    continue
                if box.getConfidence() < min_conf:
                    continue

                # require_timer_running 守卫
                guard = rule.get("require_timer_running")
                if guard:
                    timer = self._vars.get(guard)
                    if timer is None or not timer.running:
                        continue

                if not _match_sub_models(box, sub_models):
                    continue

                self._executor.run(rule.get("actions", []))
                break   # 同一 rule 每帧只触发一次


class SequenceRunner:
    """模式：sequence — 步骤顺序检测"""

    def __init__(self, wf: dict, camera_key: str,
                 alarm_fn: Callable, save_db_fn: Callable,
                 db_cfg: dict = None,
                 region_fn: Callable = None,
                 socket_clients: dict = None):
        self._wf = wf
        self._camera_key = camera_key

        seq_cfg = wf["sequence"]
        self._steps = seq_cfg["steps"]
        self._ordered = seq_cfg.get("ordered", True)
        self._current_idx = 0           # 顺序模式下当前期待的步骤下标
        self._completed = set()         # 无序模式下已完成的 step id
        self._count_max = {}            # 无序模式 count 步骤已输出的最大值
        self._waiting_clear = False     # 重置后等待画面清空

        self._vars = {}
        timeout_timer_name = seq_cfg.get("timeout_timer")
        if timeout_timer_name:
            timeout_cfg = wf.get("timers", {}).get(timeout_timer_name, {})
            self._vars[timeout_timer_name] = TimerVar(timeout_cfg.get("timeout"))
            self._timeout_timer_name = timeout_timer_name
        else:
            self._timeout_timer_name = None

        self._count_error = None        # 记录计数错误信息，到 end 时才报警
        self._duration_starts = {}       # step_id -> 连续检测开始时间
        self._active = False             # 任意 trigger 步骤出现后进入本轮流程
        self._flow_start_time = None
        self._seq_cfg = seq_cfg
        self._meta_ref = [None]
        self._last_alarms = {}
        self._external_hits = {}         # step_id -> hit dict
        self._external_wait_logged = set()  # 已记录"未收到外部事件"日志的 step_id
        self._event_ref = [None]         # 当前事件 payload，供动作占位符使用
        self._executor = ActionExecutor(
            self._vars, camera_key,
            wf.get("group_id", 0), 0,
            alarm_fn, save_db_fn,
            self._meta_ref, self._last_alarms,
            db_cfg, region_fn,
            socket_clients=socket_clients,
            event_ref=self._event_ref,
        )

        # ── 生产周期主子表写库（数据状态 + 每步骤启停时间）──────────
        # cycle_record: { "enabled": true,
        #                 "master_table": "icamera_data.production_cycle_record",
        #                 "detail_table": "icamera_data.step_execution_log" }
        cr_cfg = wf.get("cycle_record", {}) or {}
        self._cycle_enabled = bool(cr_cfg.get("enabled", False))
        self._cycle_master_table = cr_cfg.get("master_table", "icamera_data.production_cycle_record")
        self._cycle_detail_table = cr_cfg.get("detail_table", "icamera_data.step_execution_log")
        self._cycle_db_cfg = db_cfg
        self._sourceid = 0               # 每帧由 on_frame 刷新，供周期写库使用
        self._step_by_id = {s["id"]: s for s in self._steps}
        self._cycle_id = None            # 当前主表自增 ID，None 表示无活动周期
        self._step_first_seen = {}       # step_id -> 首次检测到的时刻（步骤 start_time）
        self._open_child_id = None       # 上一条已插入未补齐 end_time 的子表行 ID
        self._open_child_start = None    # 上一条子表行的 start_time，用于算 duration
        # ─────────────────────────────────────────────────────────

        # ── 人员在场检测 ──────────────────────────────────────────────
        # presence_tracking: { "enabled": true, "person_label": "person",
        #                      "confidence": 0.5, "alarm_name": "人员离岗",
        #                      "absence_duration": 30 }
        pt_cfg = wf.get("presence_tracking", {})
        self._pt_enabled = pt_cfg.get("enabled", False)
        self._pt_label = pt_cfg.get("person_label", "person")
        self._pt_conf = pt_cfg.get("confidence", 0.5)
        self._pt_alarm_name = pt_cfg.get("alarm_name", "人员离岗")
        self._pt_absence_duration = float(pt_cfg.get("absence_duration", 30))  # 离岗持续时间阈值（秒）
        self._pt_absence_start_time = None   # 离岗开始时刻（None=人在场）
        self._pt_last_alarm_time = 0         # 上次报警时间（冷却）
        self._pt_cooldown = 10               # 报警冷却秒数
        # ─────────────────────────────────────────────────────────

        # ── 循环模式 ──────────────────────────────────────────────────
        # loop_mode: { "enabled": true,
        #              "segments": [{"step_id": "stepA", "loop_count": 3}, ...],
        #              "out_of_order_alarm_name": "动作顺序错误",
        #              "out_of_order_cooldown": 10 }
        lm_cfg = wf.get("loop_mode", {})
        self._lm_enabled = lm_cfg.get("enabled", False)
        self._lm_segments = lm_cfg.get("segments", [])
        self._lm_current_segment = 0       # 当前段下标
        self._lm_disappear_count = 0       # 当前段已完成"出现→消失"次数
        self._lm_step_was_present = {}     # dict[str,bool] — 每个 step_id 上一帧是否在场
        self._lm_cycle_count = 0           # 完整周期计数
        self._lm_out_of_order_alarm_name = lm_cfg.get("out_of_order_alarm_name", "动作顺序错误")
        self._lm_out_of_order_cooldown = float(lm_cfg.get("out_of_order_cooldown", 10))
        self._lm_last_out_of_order_alarm = 0.0

        # ── 循环模式 v2：段激活标志 + guard 验证状态 ──
        self._lm_segment_started = False       # 当前段是否已激活（至少检测到过一次本段步骤）
        self._lm_in_guard = False              # 是否处于 guard 验证阶段
        self._lm_post_transition = False       # 是否处于过渡后监控状态（B出现后，等待C清空或A报警）
        self._lm_guard_step_ids = []           # 当前段的验证步骤 ID 列表
        self._lm_repeat_alarm_name = ""        # 重复报警名
        self._lm_repeat_alarm_cooldown = 10.0  # 重复报警冷却
        self._lm_last_repeat_alarm = 0.0       # 上次重复报警时间
        self._lm_transition_alarm_name = ""       # 过渡步骤报警名（非空=B报警模式，A不报警）
        self._lm_transition_alarm_cooldown = 10.0 # 过渡报警冷却
        self._lm_last_transition_alarm = 0.0      # 上次过渡报警时间

        # 预填充段中各 step_id 的在场状态
        for seg in self._lm_segments:
            sid = seg.get("step_id", "")
            if sid and sid not in self._lm_step_was_present:
                self._lm_step_was_present[sid] = False
        # ─────────────────────────────────────────────────────────

    def on_event(self, groupid, sourceid, event: dict):
        if groupid != self._wf.get("group_id", groupid):
            return
        if event.get("type") != "step_hit":
            return
        event_source = event.get("sourceid")
        if event_source is not None and int(event_source) != int(sourceid):
            return
        step_id = event.get("step_id") or event.get("target_step_id")
        if not step_id or not any(s.get("id") == step_id for s in self._steps):
            global_sys_logger.warning("[%s] sequence 外部事件 step 不存在: %s", self._camera_key, step_id)
            return
        ttl = float(event.get("ttl_seconds", 5) or 5)
        payload = dict(event.get("payload") or {})
        payload.update({
            "trigger_id": event.get("trigger_id", ""),
            "step_id": step_id,
            "sourceid": sourceid,
        })
        self._external_hits[step_id] = {
            "step_id": step_id,
            "sourceid": sourceid,
            "count": int(event.get("count", 1) or 1),
            "payload": payload,
            "expires_at": time.time() + ttl,
            "trigger_id": event.get("trigger_id", ""),
        }
        global_sys_logger.info("[%s] sequence 收到外部步骤事件: step=%s source=%s", self._camera_key, step_id, sourceid)

    def on_frame(self, groupid, sourceid, metadata):
        if groupid != self._wf.get("group_id", groupid):
            return

        self._meta_ref[0] = metadata
        self._executor._sourceid = sourceid
        self._sourceid = sourceid

        # 计时器超时检查
        if self._timeout_timer_name:
            timer = self._vars[self._timeout_timer_name]
            if timer.check_expired():
                global_sys_logger.warning("[%s] 步骤超时", self._camera_key)
                self._executor.run(self._seq_cfg.get("on_timeout", []))
                self._reset()
                return

        # 每个 step 用自己的 model_id 取一阶 boxes（缓存，同 model_id 不重复查）
        boxes_cache: dict = {}
        wf_default_model = self._wf.get("model_id", 1)
        step_boxes = {
            s["id"]: _resolve_boxes(metadata, s.get("model_id", wf_default_model), boxes_cache)
            for s in self._steps
        }

        # 重置后等待任意 trigger step 出现才开始新流程
        if self._waiting_clear:
            if self._any_trigger_step_present(step_boxes):
                self._waiting_clear = False
                global_sys_logger.info("[%s] 检测到步骤标签，新流程开始", self._camera_key)
                # 不 return，继续处理这一帧
            else:
                return

        if not self._active:
            if self._any_trigger_step_present(step_boxes):
                self._active = True
                self._flow_start_time = time.time()
                if self._timeout_timer_name:
                    self._vars[self._timeout_timer_name].start()
                self._cycle_begin()
                global_sys_logger.info("[%s] sequence 流程开始", self._camera_key)
            else:
                return

        self._update_duration_steps(step_boxes)

        # ── 循环模式逻辑 ──────────────────────────────────────────────
        # 循环模式独立运行，不依赖流程激活状态，持续监控
        # 新设计：多段序列 + 边沿触发计数（出现→消失 = 1次循环）
        # v2: 段激活追踪 + guard 验证子模式
        if self._lm_enabled and self._lm_segments:
            current_seg = self._lm_segments[self._lm_current_segment]

            # ---- 1. 扫描：记录各段步骤（含备选）本帧是否出现 ----
            step_present_this_frame = {}

            def _scan_one_sid(sid_to_scan):
                """扫描单个 step_id 并写入 step_present_this_frame（幂等）"""
                if not sid_to_scan or sid_to_scan in step_present_this_frame:
                    return
                step_def = next((s for s in self._steps if s["id"] == sid_to_scan), None)
                step_present_this_frame[sid_to_scan] = (
                    self._step_match_present(step_def, step_boxes) if step_def else False
                )
                # 预填在场追踪（首次出现时）
                if sid_to_scan not in self._lm_step_was_present:
                    self._lm_step_was_present[sid_to_scan] = False

            for seg in self._lm_segments:
                _scan_one_sid(seg.get("step_id", ""))
                for alt_sid in seg.get("alt_step_ids", []):
                    _scan_one_sid(alt_sid)

            # 如果当前段有 guard_step_ids，也扫描它们
            guard_sids = current_seg.get("guard_step_ids", [])
            if guard_sids:
                for gsid in guard_sids:
                    _scan_one_sid(gsid)

            # 如果当前段有 transition_step_ids（过渡步骤），也扫描它们
            transition_sids = current_seg.get("transition_step_ids", [])
            if transition_sids:
                for tsid in transition_sids:
                    _scan_one_sid(tsid)

            # ---- 当前段参数 ----
            current_sids = [current_seg.get("step_id", "")] + current_seg.get("alt_step_ids", [])
            current_sids = [sid for sid in current_sids if sid]  # 过滤空字符串
            required_count = int(current_seg.get("loop_count", 1))

            if current_sids:
                # 当前段任一匹配步骤上一帧在场？
                was_any = any(self._lm_step_was_present.get(sid, False) for sid in current_sids)
                # 当前段任一匹配步骤本帧在场？
                is_any = any(step_present_this_frame.get(sid, False) for sid in current_sids)

                # ── 段激活追踪：首次检测到本段步骤时标记已激活 ──
                if is_any and not self._lm_segment_started:
                    self._lm_segment_started = True
                    global_sys_logger.info(
                        "[%s] 循环模式 段%d(%s) 激活（首次检测到）",
                        self._camera_key, self._lm_current_segment + 1,
                        current_seg.get("step_id", "")
                    )

                # ── Guard 模式：验证阶段（三阶段状态机）──
                # 状态: normal_guard → (过渡步骤出现) → post_transition → (reset步骤出现) → 重置
                #   normal_guard: 主步骤再次出现→报警; 过渡步骤(B)出现→无报警进入post_transition; guard步骤(C)出现→重置
                #   post_transition: 主步骤(A)再出现→不报警; guard步骤(C)出现→清空A计数并重置
                if self._lm_in_guard:
                    # 检查各类步骤是否出现
                    guard_present = any(
                        step_present_this_frame.get(gsid, False)
                        for gsid in guard_sids
                    ) if guard_sids else False

                    transition_present = any(
                        step_present_this_frame.get(tsid, False)
                        for tsid in transition_sids
                    ) if transition_sids else False

                    # ── 过渡后监控模式：B已出现，等待C清空（A再出现不报警）──
                    if self._lm_post_transition:
                        if guard_present:
                            # guard/reset 步骤(C)出现：重置本段计数，退出所有状态
                            self._lm_disappear_count = 0
                            self._lm_segment_started = False
                            self._lm_in_guard = False
                            self._lm_post_transition = False
                            self._lm_guard_step_ids = []
                            global_sys_logger.info(
                                "[%s] 循环模式 guard 验证步骤出现(过渡后)，段%d(%s) 计数重置",
                                self._camera_key, self._lm_current_segment + 1,
                                current_seg.get("step_id", "")
                            )
                        else:
                            # 过渡后 A 再出现不报警，仅追踪在场状态
                            for sid in current_sids:
                                self._lm_step_was_present[sid] = step_present_this_frame.get(sid, False)

                    # ── 正常 guard 模式：等待过渡步骤(B)或重置步骤(C) ──
                    # 若配置了 transition_alarm_name → "B报警模式"：B报警、A不报警、C清除
                    # 未配置 → 旧行为：B静默过渡、A重复报警、C清除
                    elif transition_present:
                        if self._lm_transition_alarm_name:
                            # B报警模式：过渡步骤(B)出现 → 触发报警（带冷却），保持在 guard
                            now = time.time()
                            if now - self._lm_last_transition_alarm >= self._lm_transition_alarm_cooldown:
                                alarm_msg = self._lm_transition_alarm_name
                                global_sys_logger.warning(
                                    "[%s] 循环模式 过渡步骤报警: %s (段%d:%s)",
                                    self._camera_key, alarm_msg,
                                    self._lm_current_segment + 1,
                                    current_seg.get("step_id", "")
                                )
                                self._executor.run([{"alarm": {
                                    "msg": alarm_msg,
                                    "type": "ng",
                                    "save_image": True,
                                    "cooldown": self._lm_transition_alarm_cooldown
                                }}])
                                self._lm_last_transition_alarm = now
                        else:
                            # 旧行为：过渡步骤(B)出现：不报警、不重置，进入过渡后监控状态
                            self._lm_post_transition = True
                            global_sys_logger.info(
                                "[%s] 循环模式 过渡步骤出现(无报警)，段%d(%s) 进入过渡后监控",
                                self._camera_key, self._lm_current_segment + 1,
                                current_seg.get("step_id", "")
                            )
                    elif guard_present:
                        # guard 步骤(C)出现：重置本段计数，退出 guard
                        self._lm_disappear_count = 0
                        self._lm_segment_started = False
                        self._lm_in_guard = False
                        self._lm_guard_step_ids = []
                        global_sys_logger.info(
                            "[%s] 循环模式 guard 验证步骤出现，段%d(%s) 计数重置",
                            self._camera_key, self._lm_current_segment + 1,
                            current_seg.get("step_id", "")
                        )
                    else:
                        # 检查本段步骤是否再次出现（上升沿）
                        if not was_any and is_any:
                            if self._lm_transition_alarm_name:
                                # B报警模式：A 再出现不报警（仅日志记录）
                                global_sys_logger.info(
                                    "[%s] 循环模式 guard 主步骤再次出现(无报警-B报警模式)，段%d(%s)",
                                    self._camera_key, self._lm_current_segment + 1,
                                    current_seg.get("step_id", "")
                                )
                            else:
                                # 旧行为：A 再出现 → 触发 repeat_alarm
                                now = time.time()
                                if now - self._lm_last_repeat_alarm >= self._lm_repeat_alarm_cooldown:
                                    alarm_msg = self._lm_repeat_alarm_name or "步骤重复出现"
                                    global_sys_logger.warning(
                                        "[%s] 循环模式 guard 重复报警: %s (段%d:%s)",
                                        self._camera_key, alarm_msg,
                                        self._lm_current_segment + 1,
                                        current_seg.get("step_id", "")
                                    )
                                    self._executor.run([{"alarm": {
                                        "msg": alarm_msg,
                                        "type": "ng",
                                        "save_image": True,
                                        "cooldown": self._lm_repeat_alarm_cooldown
                                    }}])
                                    self._lm_last_repeat_alarm = now

                        # 更新在场追踪（供下帧上升沿判断）
                        for sid in current_sids:
                            self._lm_step_was_present[sid] = step_present_this_frame.get(sid, False)

                    # guard 模式下跳过正常边沿计数和越序检测，直接 continue
                else:
                    # ── 正常计数模式 ──
                    if was_any and not is_any:
                        # 边沿：全部离场，完成一次"出现→消失"
                        self._lm_disappear_count += 1
                        global_sys_logger.info(
                            "[%s] 循环模式 段%d(%s) 出现→消失 计数: %d/%d",
                            self._camera_key, self._lm_current_segment + 1,
                            current_seg.get("step_id", ""), self._lm_disappear_count, required_count
                        )

                        if self._lm_disappear_count >= required_count:
                            # 检查是否需要进入 guard 模式（有 guard_step_ids 或 transition_step_ids 时进入）
                            if guard_sids or transition_sids:
                                # 进入 guard 验证阶段（不推进段）
                                self._lm_in_guard = True
                                self._lm_post_transition = False  # 重置过渡状态
                                self._lm_guard_step_ids = list(guard_sids) if guard_sids else []
                                self._lm_repeat_alarm_name = current_seg.get("repeat_alarm_name", "")
                                self._lm_repeat_alarm_cooldown = float(
                                    current_seg.get("repeat_alarm_cooldown",
                                                    self._lm_out_of_order_cooldown)
                                )
                                self._lm_transition_alarm_name = current_seg.get("transition_alarm_name", "")
                                self._lm_transition_alarm_cooldown = float(
                                    current_seg.get("transition_alarm_cooldown",
                                                    self._lm_out_of_order_cooldown)
                                )
                                self._lm_segment_started = False  # guard 阶段重新追踪上升沿
                                global_sys_logger.info(
                                    "[%s] 循环模式 段%d(%s) 计数完成，进入 guard 验证 (guard_steps=%s, transition_steps=%s)",
                                    self._camera_key, self._lm_current_segment + 1,
                                    current_seg.get("step_id", ""), guard_sids, transition_sids
                                )
                            elif self._lm_current_segment + 1 < len(self._lm_segments):
                                # 推进到下一段
                                self._lm_current_segment += 1
                                self._lm_disappear_count = 0
                                self._lm_segment_started = False
                                ns = self._lm_segments[self._lm_current_segment]
                                global_sys_logger.info(
                                    "[%s] 循环模式 段完成，进入段%d(%s)",
                                    self._camera_key, self._lm_current_segment + 1,
                                    ns.get("step_id", "")
                                )
                            else:
                                # 周期完成，回到第一段
                                self._lm_cycle_count += 1
                                self._lm_current_segment = 0
                                self._lm_disappear_count = 0
                                self._lm_segment_started = False
                                global_sys_logger.info(
                                    "[%s] 循环模式 完整周期完成(第%d周期)，重置到段1(%s)",
                                    self._camera_key, self._lm_cycle_count,
                                    self._lm_segments[0].get("step_id", "")
                                )

                    # 更新在场追踪（当前段所有匹配步骤）
                    for sid in current_sids:
                        self._lm_step_was_present[sid] = step_present_this_frame.get(sid, False)

                    # ---- 3. 越序检测：后序段步骤提前出现 → 报警 ----
                    # 仅当本段已激活（至少检测到过一次）时才触发越序报警
                    if self._lm_segment_started:
                        # 当前段自身的备选步骤不视为越序
                        current_own_sids = set(current_sids)
                        for future_idx in range(self._lm_current_segment + 1, len(self._lm_segments)):
                            future_seg = self._lm_segments[future_idx]
                            future_sids = [future_seg.get("step_id", "")] + future_seg.get("alt_step_ids", [])
                            future_sids = [sid for sid in future_sids if sid and sid not in current_own_sids]

                            triggered_sid = None
                            for fsid in future_sids:
                                if step_present_this_frame.get(fsid, False):
                                    triggered_sid = fsid
                                    break

                            if triggered_sid:
                                now = time.time()
                                if now - self._lm_last_out_of_order_alarm >= self._lm_out_of_order_cooldown:
                                    alarm_detail = (
                                        f"(当前段{self._lm_current_segment + 1}, "
                                        f"提前检测到段{future_idx + 1}的步骤{triggered_sid})"
                                    )
                                    global_sys_logger.warning(
                                        "[%s] 循环模式越序报警: %s%s", self._camera_key,
                                        self._lm_out_of_order_alarm_name, alarm_detail
                                    )
                                    self._executor.run([{"alarm": {
                                        "msg": self._lm_out_of_order_alarm_name,
                                        "type": "ng",
                                        "save_image": True,
                                        "cooldown": self._lm_out_of_order_cooldown
                                    }}])
                                    self._lm_last_out_of_order_alarm = now
                                break   # 每帧只触发一次越序报警
        # ─────────────────────────────────────────────────────────

        # ── 人员在场检测逻辑（基于持续时间）──────────────────────────
        if self._pt_enabled and self._active:
            # 使用顶层默认模型检测人员标签
            person_boxes = _resolve_boxes(metadata, wf_default_model, boxes_cache)
            person_present = any(
                b.getLabelName() == self._pt_label and b.getConfidence() >= self._pt_conf
                for b in person_boxes
            )
            now = time.time()
            if person_present:
                # 人在场：重置离岗计时
                if self._pt_absence_start_time is not None:
                    global_sys_logger.info("[%s] 人员回岗，离岗计时重置", self._camera_key)
                self._pt_absence_start_time = None
            else:
                # 人离岗：记录开始时刻，超时触发报警
                if self._pt_absence_start_time is None:
                    self._pt_absence_start_time = now
                elif now - self._pt_absence_start_time >= self._pt_absence_duration:
                    # 离岗超过设定时长，触发报警（带冷却）
                    if now - self._pt_last_alarm_time >= self._pt_cooldown:
                        global_sys_logger.warning(
                            "[%s] 人员离岗报警: %s (离岗 %.1f 秒)",
                            self._camera_key, self._pt_alarm_name,
                            now - self._pt_absence_start_time
                        )
                        self._executor.run([{"alarm": {
                            "msg": self._pt_alarm_name,
                            "type": "ng",
                            "save_image": True,
                            "cooldown": self._pt_cooldown
                        }}])
                        self._pt_last_alarm_time = now
                        # 报警后重置计时，下次需重新累计达到阈值才再报警
                        self._pt_absence_start_time = None
        # ─────────────────────────────────────────────────────────

        # 当前期待步骤若为 count 类型，做帧级数量统计
        if self._ordered and self._current_idx < len(self._steps):
            expected = self._steps[self._current_idx]
            if expected.get("count") is not None:
                self._check_count_step(expected, step_boxes)
                return

        # 无序模式：先处理 count 步骤（帧级统计），再处理普通步骤
        if not self._ordered:
            for step in self._steps:
                if step.get("count") is None:
                    continue
                if step["id"] in self._completed:
                    continue
                required = step["count"]
                actual = self._step_match_count(step, step_boxes)
                if actual > 0 and actual > self._count_max.get(step["id"], 0):
                    self._count_max[step["id"]] = actual
                    global_sys_logger.info("[%s] 计数步骤检测: %s 当前=%d 期望=%d",
                                           self._camera_key, step["id"], actual, required)
                if actual == required:
                    self._completed.add(step["id"])
                    self._consume_external_hit(step["id"])
                    self._count_error = None  # 清除之前可能残留的计数错误
                    self._complete_step(step["id"])
                    global_sys_logger.info("[%s] 计数步骤完成: %s 数量=%d (%d/%d)",
                                           self._camera_key, step["id"], actual,
                                           len(self._completed), len(self._steps))
                elif actual != 0:
                    self._count_error = (step["id"], required, actual)
                    self._consume_external_hit(step["id"])

        self._check_step(step_boxes)

    # ── step 匹配辅助 ──
    def _purge_external_hits(self):
        now = time.time()
        for step_id in list(self._external_hits.keys()):
            if self._external_hits[step_id].get("expires_at", 0) <= now:
                self._external_hits.pop(step_id, None)

    def _get_external_hit(self, step_id: str):
        self._purge_external_hits()
        return self._external_hits.get(step_id)

    def _set_event_ref_from_hit(self, hit: dict):
        if hit:
            self._event_ref[0] = hit.get("payload") or {}

    def _consume_external_hit(self, step_id: str):
        hit = self._external_hits.pop(step_id, None)
        self._set_event_ref_from_hit(hit)
        return hit

    def _step_match_present(self, step: dict, step_boxes: dict) -> bool:
        """step 在自己的 boxes 视图里是否至少出现一次（含 confidence 与二阶过滤）"""
        hit = self._get_external_hit(step["id"])
        if hit:
            global_sys_logger.info("[%s] 步骤 %s 匹配到外部事件: %s", self._camera_key, step["id"], hit)
            self._set_event_ref_from_hit(hit)
            self._mark_step_seen(step["id"])
            self._external_wait_logged.discard(step["id"])
            return True
        if step.get("external"):
            if step["id"] not in self._external_wait_logged:
                global_sys_logger.debug("[%s] 步骤 %s 标记为 external，但未收到外部事件", self._camera_key, step["id"])
                self._external_wait_logged.add(step["id"])
            return False
        label = step["label"]
        min_conf = step.get("confidence", 0.0)
        sub_models = _normalize_sub_models(step)
        for b in step_boxes.get(step["id"], []):
            if b.getLabelName() != label:
                continue
            if b.getConfidence() < min_conf:
                continue
            if not _match_sub_models(b, sub_models):
                continue
            self._mark_step_seen(step["id"])
            return True
        return False

    def _step_match_count(self, step: dict, step_boxes: dict) -> int:
        """统计 step 在自己 boxes 视图里满足 label/conf/二阶过滤的 box 个数"""
        hit = self._get_external_hit(step["id"])
        if hit:
            self._set_event_ref_from_hit(hit)
            self._mark_step_seen(step["id"])
            return int(hit.get("count", 1) or 1)
        if step.get("external"):
            return 0
        label = step["label"]
        min_conf = step.get("confidence", 0.0)
        sub_models = _normalize_sub_models(step)
        n = 0
        for b in step_boxes.get(step["id"], []):
            if b.getLabelName() != label:
                continue
            if b.getConfidence() < min_conf:
                continue
            if not _match_sub_models(b, sub_models):
                continue
            n += 1
        if n > 0:
            self._mark_step_seen(step["id"])
        return n

    def _any_trigger_step_present(self, step_boxes: dict) -> bool:
        for s in self._steps:
            if s.get("end") or not s.get("trigger", True):
                continue
            if s.get("external") and s.get("trigger") is not True:
                continue
            if self._step_match_present(s, step_boxes):
                return True
        return False

    def _update_duration_steps(self, step_boxes: dict):
        now = time.time()
        for step in self._steps:
            required_seconds = step.get("duration")
            if required_seconds is None or step.get("end"):
                continue
            step_id = step["id"]
            if step_id in self._completed:
                continue
            if self._step_match_present(step, step_boxes):
                if step_id not in self._duration_starts:
                    self._duration_starts[step_id] = now
                elapsed = now - self._duration_starts[step_id]
                if elapsed >= float(required_seconds):
                    self._completed.add(step_id)
                    self._consume_external_hit(step_id)
                    self._complete_step(step_id)
                    global_sys_logger.info("[%s] 持续步骤完成: %s %.2fs/%.2fs (%d/%d)",
                                           self._camera_key, step_id, elapsed, float(required_seconds),
                                           len(self._completed), self._required_step_count())
            else:
                self._duration_starts.pop(step_id, None)

    def _required_step_count(self):
        return sum(1 for s in self._steps if not s.get("end"))

    def _missing_steps(self):
        return [s for s in self._steps if not s.get("end") and s["id"] not in self._completed]

    @staticmethod
    def _format_missing_steps(missing_steps: list):
        return ",".join(s.get("label") or s.get("id", "") for s in missing_steps)

    def _inject_sequence_info(self, actions: list, status: str, missing_steps: list = None) -> list:
        missing_steps = missing_steps or []
        missing_text = self._format_missing_steps(missing_steps)
        now = time.time()
        duration = now - self._flow_start_time if self._flow_start_time else 0.0
        result = []
        for action in actions:
            if "alarm_each_missing" in action:
                cfg = action["alarm_each_missing"]
                for step in missing_steps:
                    msg = step.get("alarm_name") or step.get("label") or step.get("id", "")
                    alarm_action = {
                        "msg": msg,
                        "type": cfg.get("type", "ng"),
                        "save_image": cfg.get("save_image", False),
                        "cooldown": cfg.get("cooldown", 0)
                    }
                    # 透传 speak 字段（喇叭/继电器控制）
                    if "speak" in cfg:
                        alarm_action["speak"] = cfg["speak"]
                    result.append({"alarm": alarm_action})
            elif "save_db_each_missing" in action:
                cfg = action["save_db_each_missing"]
                for step in missing_steps:
                    fields = self._replace_sequence_placeholders(
                        dict(cfg.get("fields", {})), status, missing_text, duration, step
                    )
                    result.append({"save_db": {"table": cfg["table"], "fields": fields}})
            elif "alarm" in action:
                cfg = dict(action["alarm"])
                cfg["msg"] = self._replace_sequence_text(cfg.get("msg", ""), status, missing_text, duration, None)
                result.append({"alarm": cfg})
            elif "log" in action:
                result.append({"log": self._replace_sequence_text(action["log"], status, missing_text, duration, None)})
            elif "save_db" in action:
                cfg = action["save_db"]
                fields = self._replace_sequence_placeholders(
                    dict(cfg.get("fields", {})), status, missing_text, duration, None
                )
                result.append({"save_db": {"table": cfg["table"], "fields": fields}})
            else:
                result.append(action)
        return result

    def _replace_sequence_placeholders(self, fields: dict, status: str, missing_text: str, duration: float, step: dict = None):
        for key, value in list(fields.items()):
            if isinstance(value, str):
                fields[key] = self._replace_sequence_text(value, status, missing_text, duration, step)
        return fields

    @staticmethod
    def _replace_sequence_text(value: str, status: str, missing_text: str, duration: float, step: dict = None):
        step = step or {}
        return (value
                .replace("{status}", status)
                .replace("{missing_steps}", missing_text)
                .replace("{duration}", f"{duration:.2f}")
                .replace("{step_id}", str(step.get("id", "")))
                .replace("{step_label}", str(step.get("label", "")))
                .replace("{step_alarm_name}", str(step.get("alarm_name") or step.get("label", ""))))

    def _check_count_step(self, step: dict, step_boxes: dict):
        """帧级 count 步骤：统计本帧 label 出现的 box 数量，达到要求才通过；
        同时检测后续步骤 label，若出现则记录当前计数错误并推进"""
        required = step["count"]
        actual = self._step_match_count(step, step_boxes)

        # 检查是否出现了后续步骤的 label（如 end），若出现则用当前计数判断
        for i in range(self._current_idx + 1, len(self._steps)):
            next_step = self._steps[i]
            if self._step_match_present(next_step, step_boxes):
                # 后续步骤出现了，用当前 actual 判断计数
                if actual != required:
                    global_sys_logger.warning("[%s] 计数步骤数量不对: %s 期望=%d 实际=%d",
                                              self._camera_key, step["id"], required, actual)
                    self._count_error = (step["id"], required, actual)
                else:
                    global_sys_logger.info("[%s] 计数步骤完成: %s 数量=%d",
                                           self._camera_key, step["id"], actual)
                    self._consume_external_hit(step["id"])
                    self._complete_step(step["id"])
                self._consume_external_hit(next_step["id"])
                if self._current_idx == 0 and self._timeout_timer_name:
                    self._vars[self._timeout_timer_name].start()
                self._current_idx = i + 1
                if self._current_idx >= len(self._steps):
                    self._on_complete()
                return

        if actual == 0:
            return
        if actual == required:
            global_sys_logger.info("[%s] 计数步骤完成: %s 数量=%d (%d/%d)",
                                   self._camera_key, step["id"],
                                   actual, self._current_idx + 1, len(self._steps))
            if self._current_idx == 0 and self._timeout_timer_name:
                self._vars[self._timeout_timer_name].start()
            self._consume_external_hit(step["id"])
            self._complete_step(step["id"])
            self._current_idx += 1
            if self._current_idx == len(self._steps):
                self._on_complete()
        else:
            # 数量不对，继续等待，不推进
            global_sys_logger.info("[%s] 计数步骤等待: %s 当前=%d 期望=%d",
                                   self._camera_key, step["id"], actual, required)

    def _inject_count_info(actions: list, step_id: str, expected: int, actual: int, step: dict = None) -> list:
        step = step or {}
        result = []
        for a in actions:
            if "alarm" in a:
                cfg = dict(a["alarm"])
                cfg["msg"] = (cfg.get("msg", "")
                              .replace("{step_id}", step_id)
                              .replace("{step_label}", str(step.get("label", "")))
                              .replace("{step_alarm_name}", str(step.get("alarm_name") or step.get("label", "")))
                              .replace("{expected_count}", str(expected))
                              .replace("{actual_count}", str(actual)))
                a = {"alarm": cfg}
            elif "save_db" in a:
                cfg = a["save_db"]
                fields = dict(cfg.get("fields", {}))
                for key, value in list(fields.items()):
                    if isinstance(value, str):
                        fields[key] = (value
                                       .replace("{step_id}", step_id)
                                       .replace("{step_label}", str(step.get("label", "")))
                                       .replace("{step_alarm_name}", str(step.get("alarm_name") or step.get("label", "")))
                                       .replace("{expected_count}", str(expected))
                                       .replace("{actual_count}", str(actual)))
                a = {"save_db": {"table": cfg["table"], "fields": fields}}
            elif "log" in a:
                a = {"log": a["log"]
                     .replace("{step_id}", step_id)
                     .replace("{step_label}", str(step.get("label", "")))
                     .replace("{step_alarm_name}", str(step.get("alarm_name") or step.get("label", "")))
                     .replace("{expected_count}", str(expected))
                     .replace("{actual_count}", str(actual))}
            result.append(a)
        return result

    def _check_step(self, step_boxes: dict):
        if self._ordered:
            if self._current_idx >= len(self._steps):
                return
            expected = self._steps[self._current_idx]
            if self._step_match_present(expected, step_boxes):
                global_sys_logger.info("[%s] 步骤完成: %s (%d/%d)",
                                       self._camera_key, expected["id"],
                                       self._current_idx + 1, len(self._steps))
                # 启动超时计时器（第一步触发时）
                if self._current_idx == 0 and self._timeout_timer_name:
                    self._vars[self._timeout_timer_name].start()

                self._consume_external_hit(expected["id"])
                self._completed.add(expected["id"])
                self._complete_step(expected["id"])
                self._current_idx += 1
                if self._current_idx == len(self._steps):
                    self._on_complete()
            else:
                # 检测到其他步骤的 label → 跳步
                for i, step in enumerate(self._steps):
                    if i <= self._current_idx:
                        continue
                    if self._step_match_present(step, step_boxes):
                        skipped = self._steps[self._current_idx]["id"]
                        global_sys_logger.warning("[%s] 跳步: 跳过了 %s", self._camera_key, skipped)
                        on_skip = self._seq_cfg.get("on_skip", [])
                        # 注入 skipped_step 变量
                        on_skip = [{**a, "log": a.get("log", "").replace("{skipped_step}", skipped)}
                                   if "log" in a else a for a in on_skip]
                        self._consume_external_hit(step["id"])
                        self._executor.run(on_skip)
                        self._reset()
                        break
        else:
            # 无序模式：只要都出现就算完成（count 步骤已在 on_frame 里处理，这里跳过）
            for step in self._steps:
                if step.get("count") is not None:
                    continue
                if not self._step_match_present(step, step_boxes):
                    continue
                if step.get("duration") is not None and not step.get("end"):
                    continue
                if step.get("end"):
                    # end 步骤：直接结束流程，不要求其他步骤完成
                    global_sys_logger.info("[%s] 检测到 end，流程结束", self._camera_key)
                    self._consume_external_hit(step["id"])
                    self._complete_step(step["id"])
                    self._on_complete()
                    return
                if step["id"] not in self._completed:
                    self._completed.add(step["id"])
                    global_sys_logger.info("[%s] 步骤检测到: %s (%d/%d)",
                                           self._camera_key, step["id"],
                                           len(self._completed), len(self._steps))
                    self._consume_external_hit(step["id"])
                    self._complete_step(step["id"])
            if len(self._completed) == len(self._steps):
                self._on_complete()

    def _on_complete(self):
        missing_steps = self._missing_steps()
        if missing_steps:
            missing_text = self._format_missing_steps(missing_steps)
            global_sys_logger.warning("[%s] 流程结束，缺少步骤: %s", self._camera_key, missing_text)
            on_incomplete = self._seq_cfg.get("on_incomplete") or self._seq_cfg.get("on_skip", [])
            self._executor.run(self._inject_sequence_info(on_incomplete, "NG", missing_steps))
            self._cycle_end("NG")
        elif self._count_error:
            step_id, expected, actual = self._count_error
            global_sys_logger.warning("[%s] 流程结束，计数错误: %s 期望=%d 实际=%d",
                                      self._camera_key, step_id, expected, actual)
            on_wrong = self._seq_cfg.get("on_wrong_count", [])
            step = next((s for s in self._steps if s.get("id") == step_id), {})
            on_wrong = self._inject_count_info(on_wrong, step_id, expected, actual, step)
            self._executor.run(self._inject_sequence_info(on_wrong, "NG"))
            self._cycle_end("NG")
        else:
            global_sys_logger.info("[%s] 所有步骤完成，OK", self._camera_key)
            self._executor.run(self._inject_sequence_info(self._seq_cfg.get("on_complete", []), "OK"))
            self._cycle_end("OK")
        self._reset()

    def _reset(self):
        self._current_idx = 0
        self._completed.clear()
        self._count_error = None
        self._count_max.clear()
        self._duration_starts.clear()
        self._active = False
        self._flow_start_time = None
        self._waiting_clear = True
        self._cycle_id = None
        self._step_first_seen.clear()
        self._open_child_id = None
        self._open_child_start = None
        for v in self._vars.values():
            v.reset()
        # 循环模式状态不随流程重置，保持持续监控

    # ── 生产周期主子表写库 ──────────────────────────────────────
    def _mark_step_seen(self, step_id: str):
        """步骤首次被检测到时记录时刻，作为子表 start_time"""
        if self._cycle_enabled and step_id not in self._step_first_seen:
            self._step_first_seen[step_id] = datetime.datetime.now()

    def _cycle_begin(self):
        """流程开始：主表插入一条新周期（result_status=0 生产中），记录 cycle_id"""
        if not self._cycle_enabled:
            return
        now = datetime.datetime.now()
        self._cycle_id = _db_insert(self._cycle_db_cfg, self._cycle_master_table, {
            "camera_id": self._sourceid,
            "result_status": 0,
            "start_time": now,
            "create_date": now.strftime("%Y-%m-%d"),
        })
        global_sys_logger.info("[%s] 生产周期开始 cycle_id=%s", self._camera_key, self._cycle_id)

    def _complete_step(self, step_id: str):
        """步骤完成：补齐上一子表行耗时，再插入本步骤子表流水"""
        if not self._cycle_enabled or self._cycle_id is None:
            return
        step = self._step_by_id.get(step_id, {})
        now = datetime.datetime.now()

        # 补齐上一条子表行的 end_time / duration（UPDATE 优化）
        self._close_open_child(now)

        step_code = step.get("step_code") or step_id
        start_time = self._step_first_seen.get(step_id, now)
        self._open_child_id = _db_insert(self._cycle_db_cfg, self._cycle_detail_table, {
            "camera_id": self._sourceid,
            "cycle_id": self._cycle_id,
            "step_config_id": step_code,
            "start_time": start_time,
            "step_result": 1,
        })
        self._open_child_start = start_time

    def _close_open_child(self, now: datetime.datetime):
        """把上一条已插入的子表行补齐 end_time 和 duration（秒）"""
        if self._open_child_id is None:
            return
        duration = None
        if self._open_child_start is not None:
            duration = round((now - self._open_child_start).total_seconds(), 2)
        _db_update(self._cycle_db_cfg, self._cycle_detail_table,
                   {"end_time": now, "duration": duration}, {"id": self._open_child_id})
        self._open_child_id = None
        self._open_child_start = None

    def _cycle_end(self, status: str):
        """流程结束：补齐最后一条子表行，更新主表 result_status 与 end_time"""
        if not self._cycle_enabled or self._cycle_id is None:
            return
        now = datetime.datetime.now()
        self._close_open_child(now)
        result_status = 1 if status == "OK" else 2
        _db_update(self._cycle_db_cfg, self._cycle_master_table,
                   {"end_time": now, "result_status": result_status},
                   {"id": self._cycle_id})
        global_sys_logger.info("[%s] 生产周期结束 cycle_id=%s status=%s",
                               self._camera_key, self._cycle_id, status)



# ─────────────────────────────────────────────
# 模式四：monitor（安环持续监控）
# ─────────────────────────────────────────────

class MonitorRunner:
    """
    模式：monitor — 安环持续监控
    每条规则独立计帧，满足帧数阈值后报警并重置，互不干扰。

    规则类型：
      - on_present : label 持续出现 N 帧 → 报警（如玩手机）
      - on_absent  : label 持续缺失 N 帧 → 报警（如未戴安全帽）
    """

    def __init__(self, wf: dict, camera_key: str,
                 alarm_fn: Callable, save_db_fn: Callable,
                 db_cfg: dict = None,
                 region_fn: Callable = None,
                 socket_clients: dict = None):
        self._wf = wf
        self._camera_key = camera_key
        # 每条规则独立维护一个帧计数器 {rule_id: int}
        self._counters: dict[str, int] = {}
        for rule in wf.get("rules", []):
            self._counters[rule["id"]] = 0

        self._meta_ref = [None]
        self._last_alarms = {}
        self._executor = ActionExecutor(
            {}, camera_key,
            wf.get("group_id", 0), 0,
            alarm_fn, save_db_fn,
            self._meta_ref, self._last_alarms,
            db_cfg, region_fn,
            socket_clients=socket_clients
        )

    def on_frame(self, groupid, sourceid, metadata):
        if groupid != self._wf.get("group_id", groupid):
            return

        self._meta_ref[0] = metadata
        self._executor._sourceid = sourceid

        boxes_cache: dict = {}
        wf_default_model = self._wf.get("model_id", 1)

        for rule in self._wf.get("rules", []):
            rid = rule["id"]
            label = rule["label"]
            min_conf = rule.get("confidence", 0.5)
            threshold = rule.get("frames", 10)
            rule_type = rule.get("type", "on_present")  # on_present | on_absent

            mid = rule.get("model_id", wf_default_model)
            boxes = _resolve_boxes(metadata, mid, boxes_cache)
            sub_models = _normalize_sub_models(rule)

            # 判断本帧是否检测到该 label（满足置信度，可选二阶子框过滤）
            detected = False
            for b in boxes:
                if b.getLabelName() != label or b.getConfidence() < min_conf:
                    continue
                if not _match_sub_models(b, sub_models):
                    continue
                detected = True
                break

            if rule_type == "on_present":
                # 持续出现计帧，消失则重置
                if detected:
                    self._counters[rid] += 1
                else:
                    self._counters[rid] = 0

            elif rule_type == "on_absent":
                # 持续缺失计帧，出现则重置
                if not detected:
                    self._counters[rid] += 1
                else:
                    self._counters[rid] = 0

            # 达到阈值 → 执行 actions，重置计数
            if self._counters[rid] >= threshold:
                global_sys_logger.info("[%s] monitor 触发: rule=%s type=%s frames=%d",
                                       self._camera_key, rid, rule_type, self._counters[rid])
                self._executor.run(rule.get("actions", []))
                self._counters[rid] = 0


# ─────────────────────────────────────────────
# 模式五：python（容纳一整段 py 业务代码）
# ─────────────────────────────────────────────

class PythonNodeContext:
    """
    传给 Python handler 的上下文：把引擎的"基础设施"以最小接口暴露。
    handler 内部任意 py 逻辑都可以调这些方法，享受冷却/占位符/db_cfg。
    """

    def __init__(self, wf: dict, camera_key: str,
                 alarm_fn: Callable, save_db_fn: Callable,
                 db_cfg: dict = None,
                 region_fn: Callable = None,
                 socket_clients: dict = None):
        self._wf = wf
        self.camera_key = camera_key
        self.params = wf.get("params", {}) or {}
        self.group_id = wf.get("group_id", 0)
        self._alarm_fn = alarm_fn
        self._save_db_fn = save_db_fn
        self._db_cfg = db_cfg or {}
        self._region_fn = region_fn
        self._socket_clients = socket_clients or {}
        self._last_alarms: dict = {}
        # 由 PythonRunner 每帧刷新，handler 内部不要手动赋值
        self.metadata = None
        self.sourceid = 0

    def region_name(self) -> str:
        return self._region_fn() if self._region_fn else ""

    def alarm(self, msg: str, alarm_type: str = "ng",
              cooldown: float = 0, save_image: bool = False, speak=None):
        """报警：与 ActionExecutor.alarm 同语义（冷却 + 可选 saveImage + 可选 speak 喇叭控制）"""
        # 未显式传 speak 但已配 socket_clients → 自动开启喇叭
        if speak is None:
            if self.sourceid in self._socket_clients:
                speak = 1
            elif self._socket_clients:
                global_sys_logger.warning(
                    "[%s] PythonRunner.alarm speak 未配置，且 sourceid=%s 不在 socket_clients 中"
                    " (可用 sourceids: %s)，喇叭不会触发。",
                    self.camera_key, self.sourceid, list(self._socket_clients.keys())
                )
        if cooldown:
            now = time.time()
            last = self._last_alarms.get(msg, 0)
            if now - last < cooldown:
                global_sys_logger.info("[%s] 报警去重: %s", self.camera_key, msg)
                return
            self._last_alarms[msg] = now

        image_path = None
        if save_image and self.metadata is not None:
            self.metadata.saveImage(False)
            image_path = self.metadata.getSaveImagePath()

        alarm_table = self._db_cfg.get("alarm_table") if self._db_cfg else None
        self._alarm_fn(self.group_id, self.sourceid, alarm_type, msg, image_path, alarm_table,
                       speak=speak)

    def save_db(self, table: str, fields: dict):
        """写库：handler 内部无需关心连接参数，db_cfg 在 JSON 顶层配置"""
        resolved = self._resolve_fields(fields)
        if self._db_cfg:
            _db_insert(self._db_cfg, table, resolved)
        else:
            self._save_db_fn(table, resolved)

    def save_image(self) -> Optional[str]:
        """让 handler 主动落盘当前帧图片，返回路径（失败返回 None）"""
        if self.metadata is None:
            return None
        try:
            self.metadata.saveImage(False)
            return self.metadata.getSaveImagePath()
        except Exception as e:
            global_sys_logger.warning("[%s] save_image failed: %s", self.camera_key, e)
            return None

    def get_boxes(self, model_id: int) -> list:
        """便捷取一阶推理框，handler 也可直接走 metadata.getModelInferBoxs"""
        if self.metadata is None:
            return []
        try:
            _, boxes = self.metadata.getModelInferBoxs(model_id)
            return boxes or []
        except Exception:
            return []

    def _resolve_fields(self, fields: dict) -> dict:
        """复用 ActionExecutor 的占位符语义：$now / $date / $sourceid / $image_path …"""
        result = {}
        for k, v in fields.items():
            if not (isinstance(v, str) and v.startswith("$")):
                result[k] = v
                continue
            ref = v[1:]
            if ref == "now":
                result[k] = time.time()
            elif ref == "datetime":
                result[k] = datetime.datetime.now()
            elif ref == "date":
                result[k] = datetime.datetime.now().strftime('%Y-%m-%d')
            elif ref == "time":
                result[k] = datetime.datetime.now().strftime('%H:%M:%S')
            elif ref == "time_division":
                result[k] = datetime.datetime.now().strftime('%H:%M')
            elif ref == "time_month":
                result[k] = datetime.datetime.now().strftime('%m')
            elif ref == "week":
                result[k] = datetime.datetime.now().isocalendar()[1]
            elif ref == "sourceid":
                result[k] = self.sourceid
            elif ref == "camera_id":
                result[k] = self.camera_key
            elif ref == "region":
                result[k] = self.region_name()
            elif ref == "image_path":
                p = self.save_image()
                if p:
                    p = p.replace("\\", "/").replace("D:/product", "", 1)
                result[k] = p or ""
            else:
                result[k] = v
        return result


class PythonRunner:
    """
    模式：python — 由 JSON 指定一个 Python 类作为本工作流的处理器。

    JSON 形态：
      {
        "mode": "python",
        "name": "...",
        "group_id": 1,
        "handler": "scenes.demo.flow:DemoFlow",   # module:ClassName
        "params": { ... },                         # 任意 dict，handler 自取
        "db": { ... }                              # 顶层 db（同其它 mode）
      }

    Handler 契约：
      class DemoFlow:
          def __init__(self, ctx: PythonNodeContext): ...
          def on_frame(self, groupid, sourceid, metadata): ...
    """

    def __init__(self, wf: dict, camera_key: str,
                 alarm_fn: Callable, save_db_fn: Callable,
                 db_cfg: dict = None,
                 region_fn: Callable = None,
                 socket_clients: dict = None):
        self._wf = wf
        self._camera_key = camera_key
        self._ctx = PythonNodeContext(wf, camera_key, alarm_fn, save_db_fn, db_cfg, region_fn, socket_clients)

        handler_path = wf.get("handler")
        if not handler_path:
            raise ValueError(f"[{camera_key}] python mode 缺少 handler 字段")

        self._handler = self._load_handler(handler_path)(self._ctx)
        global_sys_logger.info("[%s] PythonRunner 已加载 handler=%s", camera_key, handler_path)

    @staticmethod
    def _load_handler(handler_path: str):
        if ":" in handler_path:
            module_name, cls_name = handler_path.split(":", 1)
        else:
            module_name, _, cls_name = handler_path.rpartition(".")
        if not module_name or not cls_name:
            raise ValueError(f"非法 handler 路径: {handler_path!r}（期望 module:ClassName 或 module.ClassName）")
        module = importlib.import_module(module_name)
        cls = getattr(module, cls_name, None)
        if cls is None:
            raise AttributeError(f"模块 {module_name} 不包含类 {cls_name}")
        return cls

    def on_frame(self, groupid, sourceid, metadata):
        if groupid != self._wf.get("group_id", groupid):
            return
        self._ctx.metadata = metadata
        self._ctx.sourceid = sourceid
        self._handler.on_frame(groupid, sourceid, metadata)


# ─────────────────────────────────────────────
# 工作流引擎入口
# ─────────────────────────────────────────────

_MODE_MAP = {
    "custom_flow":   StateMachineRunner,
    "state_machine": StateMachineRunner,
    "timer_record":  TimerRecordRunner,
    "sequence":      SequenceRunner,
    "monitor":       MonitorRunner,
    "python":        PythonRunner,
}


class WorkflowEngine:
    """
    用法：
        engine = WorkflowEngine()
        engine.load("workflows/pressing.json")
        engine.load("workflows/workhours.json")

        # 在 aibanvideometadataresult_callback 中：
        engine.on_frame(camera_key, groupid, sourceid, metadata)
    """

    def __init__(self,
                 alarm_fn: Optional[Callable] = None,
                 save_db_fn: Optional[Callable] = None,
                 region_fn: Optional[Callable] = None):
        self._alarm_fn = alarm_fn or _alarm_stub
        self._save_db_fn = save_db_fn or _save_db_stub
        self._region_fn = region_fn
        # camera_key → list[runner]（一个摄像头可跑多个工作流）
        self._runners: dict[str, list] = {}
        # (wf_def, db_cfg) 列表，用于给新摄像头初始化 runner
        self._workflow_defs: list[tuple] = []
        self._api_triggers: list[dict] = []
        self._api_server: dict = {}
        self._workflow_files: dict[str, tuple[int, int]] = {}
        self._socket_clients: dict = {}  # sourceid → {host, port, commands, encoding}
        self._lock = threading.RLock()

    @staticmethod
    def _file_signature(path: str):
        stat = os.stat(path)
        return stat.st_mtime_ns, stat.st_size

    def load_dir(self, workflows_dir: str) -> bool:
        pattern = os.path.join(workflows_dir, "*.json")
        files = sorted(glob.glob(pattern))
        signatures = {}
        for path in files:
            try:
                signatures[path] = self._file_signature(path)
            except OSError as e:
                global_sys_logger.warning("WorkflowEngine: 工作流文件状态读取失败 %s: %s", path, e)

        with self._lock:
            if signatures == self._workflow_files:
                return False

            workflow_defs = []
            api_triggers = []
            api_server = {}
            socket_clients = {}
            for path in files:
                try:
                    defs, server_cfg, trigger_cfgs, sc_list = self._read_workflow_file(path)
                    workflow_defs.extend(defs)
                    if server_cfg and server_cfg.get("enabled", True):
                        api_server = server_cfg
                    api_triggers.extend(trigger_cfgs)
                    for sc in sc_list:
                        sid = sc.get("sourceid")
                        if sid is not None:
                            socket_clients[sid] = sc
                except Exception as e:
                    global_sys_logger.warning("WorkflowEngine: 工作流加载失败 %s: %s", path, e)

            self._workflow_defs = workflow_defs
            self._api_server = api_server
            self._api_triggers = api_triggers
            self._socket_clients = socket_clients
            self._workflow_files = signatures
            self._runners.clear()

        if not files:
            global_sys_logger.warning("workflows/ 目录下没有找到任何 JSON 工作流")
        else:
            global_sys_logger.info("WorkflowEngine: 工作流已重载，文件数=%d 工作流数=%d", len(files), len(workflow_defs))
        return True

    def _read_workflow_file(self, json_path: str):
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        db_cfg = data.get("db") if isinstance(data, dict) else None
        api_server = data.get("api_server", {}) if isinstance(data, dict) else {}
        api_triggers = data.get("api_triggers", []) if isinstance(data, dict) else []
        socket_clients = data.get("socket_clients", []) if isinstance(data, dict) else []
        wf_list = data.get("workflows") if isinstance(data, dict) and "workflows" in data else [data]

        result = []
        for wf in wf_list:
            if not isinstance(wf, dict) or not wf.get("mode"):
                continue
            result.append((wf, db_cfg))
            global_sys_logger.info("WorkflowEngine: 已加载工作流 '%s' 模式=%s db=%s",
                                   wf.get("name"), wf.get("mode"),
                                   db_cfg.get("host") if db_cfg else "无")
        for trigger in api_triggers:
            if isinstance(trigger, dict) and trigger.get("enabled", True):
                global_sys_logger.info("WorkflowEngine: 已加载 API 触发器 '%s' path=%s",
                                       trigger.get("id"), trigger.get("path"))
        return result, api_server, api_triggers, socket_clients

    def _read_workflow_defs(self, json_path: str):
        defs, _, _, _ = self._read_workflow_file(json_path)
        return defs

    def load(self, json_path: str):
        """加载工作流 JSON 文件，支持单个 workflow 对象或 workflows 数组"""
        with self._lock:
            defs, server_cfg, trigger_cfgs, sc_list = self._read_workflow_file(json_path)
            self._workflow_defs.extend(defs)
            if server_cfg and server_cfg.get("enabled", True):
                self._api_server = server_cfg
            self._api_triggers.extend(trigger_cfgs)
            for sc in sc_list:
                sid = sc.get("sourceid")
                if sid is not None:
                    self._socket_clients[sid] = sc
            try:
                self._workflow_files[json_path] = self._file_signature(json_path)
            except OSError:
                pass
            self._runners.clear()

    def get_api_server_config(self) -> dict:
        with self._lock:
            if not self._api_triggers:
                return {}
            cfg = dict(self._api_server or {})
            if not cfg or not cfg.get("enabled", True):
                return {}
            cfg.setdefault("host", "0.0.0.0")
            cfg.setdefault("port", 18080)
            cfg.setdefault("max_body_bytes", 1048576)
            return cfg

    def _target_step_exists(self, groupid: int, step_id: str) -> bool:
        """检查 step_id 是否存在于该 group_id 下某个 sequence 工作流的步骤中。"""
        with self._lock:
            for wf, _ in self._workflow_defs:
                if int(wf.get("group_id", 0)) != int(groupid):
                    continue
                steps = (wf.get("sequence") or {}).get("steps", [])
                if any(s.get("id") == step_id for s in steps):
                    return True
        return False

    def handle_api_request(self, method: str, path: str, headers: dict, raw_body: bytes):
        method = (method or "").upper()
        request_path = urlsplit(path or "").path
        query = {k: v[-1] if v else "" for k, v in parse_qs(urlsplit(path or "").query).items()}

        # 记录接收到的请求信息（写入 API 触发器专用日志 log/apitriggerlogs/api_trigger.log）
        api_trigger_logger.info("[API Trigger] 收到请求: method=%s path=%s query=%s", method, request_path, query)
        api_trigger_logger.info("[API Trigger] 请求头: %s", headers)
        if raw_body:
            try:
                body_preview = raw_body.decode("utf-8", errors="ignore")
                if len(body_preview) > 500:
                    body_preview = body_preview[:500] + "... (truncated)"
                api_trigger_logger.info("[API Trigger] 请求体: %s", body_preview)
            except Exception:
                api_trigger_logger.info("[API Trigger] 请求体: (binary data, length=%d)", len(raw_body))

        with self._lock:
            trigger = next((t for t in self._api_triggers
                            if t.get("enabled", True)
                            and (t.get("method", "POST").upper() == method)
                            and t.get("path") == request_path), None)
        if not trigger:
            api_trigger_logger.warning("[API Trigger] 未找到匹配的触发器: method=%s path=%s", method, request_path)
            return {"status": 404, "body": {"status": "999", "errmsg": "API trigger not found"}}

        api_trigger_logger.info("[API Trigger] 匹配到触发器: id=%s", trigger.get("id"))

        auth_error = self._check_api_auth(trigger, headers)
        if auth_error:
            api_trigger_logger.warning("[API Trigger] 认证失败: trigger_id=%s", trigger.get("id"))
            return {"status": 401, "body": {"status": "999", "errmsg": "Unauthorized"}}

        req_cfg = trigger.get("request") or {}
        body_obj = None
        if raw_body:
            if req_cfg.get("content_type", "json") == "json":
                try:
                    body_obj = json.loads(raw_body.decode("utf-8"))
                    api_trigger_logger.info("[API Trigger] 解析 JSON body: %s", body_obj)
                except Exception as e:
                    api_trigger_logger.error("[API Trigger] JSON 解析失败: %s", e)
                    return {"status": 400, "body": {"status": "999", "errmsg": "Invalid JSON"}}
            else:
                body_obj = {k: v[-1] if v else "" for k, v in parse_qs(raw_body.decode("utf-8", errors="ignore")).items()}
                api_trigger_logger.info("[API Trigger] 解析 form body: %s", body_obj)
        else:
            body_obj = {}
            api_trigger_logger.info("[API Trigger] 请求体为空")

        lowered_headers = {str(k).lower(): v for k, v in (headers or {}).items()}
        source_doc = {
            "body": body_obj,
            "query": query,
            "headers": lowered_headers,
        }
        payload = {}
        for key, src_path in (req_cfg.get("payload_mappings") or {}).items():
            value = _get_path(source_doc, str(src_path).lower() if str(src_path).startswith("headers.") else str(src_path))
            if value is not None:
                payload[key] = value

        api_trigger_logger.info("[API Trigger] 字段映射结果: payload=%s", payload)

        sourceid = trigger.get("sourceid")
        if req_cfg.get("sourceid_path"):
            mapped_sourceid = _get_path(source_doc, req_cfg.get("sourceid_path"))
            if mapped_sourceid is not None:
                sourceid = mapped_sourceid
                api_trigger_logger.info("[API Trigger] 动态 sourceid: %s (from %s)", sourceid, req_cfg.get("sourceid_path"))
        if sourceid is None or str(sourceid) == "":
            api_trigger_logger.error("[API Trigger] sourceid 为空，触发器配置: %s", trigger.get("id"))
            return {"status": 400, "body": {"status": "999", "errmsg": "sourceid required"}}
        try:
            sourceid = int(sourceid)
        except (TypeError, ValueError):
            api_trigger_logger.error("[API Trigger] sourceid 格式错误: %s", sourceid)
            return {"status": 400, "body": {"status": "999", "errmsg": "invalid sourceid"}}

        api_trigger_logger.info("[API Trigger] 最终 sourceid: %d", sourceid)

        event_cfg = trigger.get("event") or {}
        step_id = event_cfg.get("target_step_id") or trigger.get("id")
        if req_cfg.get("target_step_id_path"):
            mapped_step = _get_path(source_doc, req_cfg.get("target_step_id_path"))
            if mapped_step:
                step_id = mapped_step
                api_trigger_logger.info("[API Trigger] 动态 step_id: %s (from %s)", step_id, req_cfg.get("target_step_id_path"))

        try:
            groupid = int(trigger.get("group_id") if trigger.get("group_id") is not None else 0)
        except (TypeError, ValueError):
            api_trigger_logger.warning("[API Trigger] group_id 非法，按 0 处理: trigger_id=%s group_id=%r",
                                       trigger.get("id"), trigger.get("group_id"))
            groupid = 0
        # 校验 target_step_id 是否真实存在于某个工作流的 sequence 中，避免事件被 runner 静默丢弃
        if not self._target_step_exists(groupid, str(step_id)):
            api_trigger_logger.warning(
                "[API Trigger] 目标步骤在 group_id=%d 的工作流中不存在，事件不会推进任何流程: step_id=%s",
                groupid, step_id)
        event = {
            "type": event_cfg.get("type", "step_hit"),
            "trigger_id": trigger.get("id", ""),
            "step_id": str(step_id),
            "sourceid": sourceid,
            "payload": payload,
            "count": int(event_cfg.get("count", 1) or 1),
            "ttl_seconds": float(event_cfg.get("ttl_seconds", 5) or 5),
            "received_at": time.time(),
        }
        api_trigger_logger.info("[API Trigger] 分发事件: camera_%s group_id=%d step_id=%s payload=%s",
                                sourceid, groupid, step_id, payload)
        self.on_event(f"camera_{sourceid}", groupid, sourceid, event)

        resp_cfg = trigger.get("response") or {}
        return {
            "status": int(resp_cfg.get("status", 200) or 200),
            "body": resp_cfg.get("body", {"status": "200", "errmsg": ""}),
            "headers": {"Content-Type": "application/json"},
        }

    @staticmethod
    def _check_api_auth(trigger: dict, headers: dict) -> bool:
        auth = trigger.get("auth") or {"type": "none"}
        if auth.get("type") in (None, "", "none"):
            return False
        if auth.get("type") != "bearer_sha256":
            return True
        header_name = (auth.get("header") or "Authorization").lower()
        header_map = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
        provided = header_map.get(header_name, "")
        prefix = auth.get("prefix", "Bearer ")
        if prefix and provided.startswith(prefix):
            provided = provided[len(prefix):]
        digest = hashlib.sha256(provided.encode("utf-8")).hexdigest()
        return not hmac.compare_digest(digest, auth.get("token_sha256", ""))

    def on_event(self, camera_key: str, groupid: int, sourceid: int, event: dict):
        with self._lock:
            if camera_key not in self._runners:
                self._init_runners(camera_key)
            runners = list(self._runners[camera_key])

        for runner in runners:
            if not hasattr(runner, "on_event"):
                continue
            try:
                runner.on_event(groupid, sourceid, event)
            except Exception as e:
                global_sys_logger.exception("[%s] event runner error: %s", camera_key, e)

    def on_frame(self, camera_key: str, groupid: int, sourceid: int, metadata):
        """每帧调用入口，分发给该摄像头的所有 runner"""
        with self._lock:
            if camera_key not in self._runners:
                self._init_runners(camera_key)
            runners = list(self._runners[camera_key])

        for runner in runners:
            try:
                runner.on_frame(groupid, sourceid, metadata)
            except Exception as e:
                global_sys_logger.exception("[%s] runner error: %s", camera_key, e)

    def _init_runners(self, camera_key: str):
        runners = []
        sc = self._socket_clients
        for wf, db_cfg in self._workflow_defs:
            mode = wf.get("mode")
            cls = _MODE_MAP.get(mode)
            if cls is None:
                global_sys_logger.error("未知工作流模式: %s", mode)
                continue
            try:
                runner = cls(wf, camera_key, self._alarm_fn, self._save_db_fn, db_cfg, self._region_fn, sc)
            except Exception as e:
                global_sys_logger.exception("[%s] runner 初始化失败 wf=%s mode=%s: %s",
                                            camera_key, wf.get("name"), mode, e)
                continue
            runners.append(runner)
            global_sys_logger.info("[%s] 初始化 runner: %s (%s)",
                                   camera_key, wf.get("name"), mode)
        self._runners[camera_key] = runners
