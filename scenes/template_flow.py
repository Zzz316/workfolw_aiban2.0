"""
Python 流程模板（python mode 节点）
====================================

适用场景：现场已经有大段纯 py 业务代码（例如 ning_bo.py 风格的
"几百个 self.xxx / xxxing / noxxxing 帧计数器 + if-else"），想接入
工作流引擎而不改写原代码。

接入步骤
--------
1. 复制本文件为 scenes/<your_scene>_flow.py，按需改类名。
2. 把原 _process_camera_data 的内容粘进 on_frame，原 __init__ 里
   的 self.xxx 初始化粘进本类 __init__（self 仍然可用，每摄像头一个
   实例，状态天然隔离）。
3. 业务里的报警 / 写库改为：
       self.ctx.alarm(msg, alarm_type="ng", cooldown=5, save_image=True)
       self.ctx.save_db("icamera_data.icam_alarm_data", { ... })
   注意：不要在 handler 里直连 pymysql、不要自己实例化报警队列，
   全部走 ctx，享受引擎的冷却 / 占位符 / db_cfg 配置。
4. 在 workflows/ 下放一个 JSON：
       {
         "name": "your_scene",
         "mode": "python",
         "group_id": 1,
         "handler": "scenes.your_scene_flow:YourSceneFlow",
         "params": { "alarm_cooldown": 5, "model_id": 1 },
         "db": {
           "host": "127.0.0.1", "port": 3306,
           "user": "root", "password": "***",
           "alarm_table": "icamera_data.icam_alarm_data"
         }
       }

约束 / 边界
-----------
- 进程级服务（MQTT、TCP server、subprocess、Modbus 设备连接、
  定时线程）不要写在 handler 里。每个摄像头会实例化一次 handler，
  这些副作用会被重复触发。把它们留在 video_logic.py 的主进程初始化。
- on_frame 必须尽快返回，不要 sleep / 不要阻塞 IO。
- handler 内部 self.xxx 状态按摄像头隔离，无需自己按 sourceid 分支。

ctx 提供的能力
--------------
- ctx.params           dict   JSON 里 params 字段，传业务参数用
- ctx.camera_key       str    "camera_<sourceid>"
- ctx.group_id         int    JSON 里 group_id（已自动过滤帧）
- ctx.sourceid         int    当前帧的摄像头 id（每帧由引擎刷新）
- ctx.metadata         obj    当前帧 metadata（每帧由引擎刷新）
- ctx.region_name()    str    懒加载区域名称
- ctx.get_boxes(mid)   list   便捷取一阶推理框
- ctx.save_image()     str?   主动落盘当前帧，返回路径
- ctx.alarm(msg, ...)         发送报警（冷却 / 可选 saveImage）
- ctx.save_db(table, fields)  写库（支持 $now / $sourceid / $image_path 等占位符）
"""

from core.infra import global_sys_logger
from core.workflow_engine import PythonNodeContext


class TemplateFlow:
    """复制本类并改名，把原 py 业务逻辑搬进来。"""

    def __init__(self, ctx: PythonNodeContext):
        self.ctx = ctx

        # ─ 从 JSON params 读业务参数（带默认值，方便现场不改 JSON 也能跑） ─
        self.alarm_cooldown = float(ctx.params.get("alarm_cooldown", 5))
        self.model_id = int(ctx.params.get("model_id", 1))
        self.required_frames = int(ctx.params.get("required_frames", 10))
        self.target_label = ctx.params.get("target_label", "person")
        self.target_conf = float(ctx.params.get("target_conf", 0.5))

        # ─ 原 ning_bo.py / aiban_video_py.py 里几百个 self.xxx 直接搬到这里 ─
        # 帧计数器三件套示例：xxx / xxxing / noxxxing
        self.target_hit = 0          # 是否已触发（0/1 标志位）
        self.target_hiting = 0       # 连续命中帧数
        self.no_target_hiting = 0    # 连续未命中帧数

        global_sys_logger.info(
            "[%s] TemplateFlow init: cooldown=%.1fs frames=%d label=%s",
            self.ctx.camera_key, self.alarm_cooldown, self.required_frames, self.target_label
        )

    # ────────────────────────────────────────────
    # 每帧入口：原 _process_camera_data 的逻辑搬到这里
    # ────────────────────────────────────────────
    def on_frame(self, groupid, sourceid, metadata):
        boxes = self.ctx.get_boxes(self.model_id)
        detected = self._has_target(boxes)

        # 帧计数器三件套 —— 现场代码里最常见的写法
        if detected:
            self.target_hiting += 1
            self.no_target_hiting = 0
        else:
            self.no_target_hiting += 1
            self.target_hiting = 0

        # 连续 N 帧命中 → 首次触发
        if self.target_hiting >= self.required_frames and not self.target_hit:
            self.target_hit = 1
            global_sys_logger.info("[%s] 目标 %s 连续 %d 帧命中",
                                   self.ctx.camera_key, self.target_label, self.required_frames)
            self.ctx.alarm(
                msg=f"目标出现：{self.target_label}",
                alarm_type="ng",
                cooldown=self.alarm_cooldown,
                save_image=True,
            )
            self.ctx.save_db(
                table="icamera_data.icam_alarm_data",
                fields={
                    "day":           "$date",
                    "time":          "$time",
                    "time_division": "$time_division",
                    "time_month":    "$time_month",
                    "week":          "$week",
                    "region":        "$region",
                    "group_id":      groupid,
                    "camera_id":     "$camera_id",
                    "alarm_content": f"目标出现：{self.target_label}",
                    "img_path":      "$image_path",
                    "timedate":      "$datetime",
                },
            )

        # 连续 N 帧缺失 → 复位，允许下次再触发
        if self.no_target_hiting >= self.required_frames and self.target_hit:
            self.target_hit = 0
            global_sys_logger.info("[%s] 目标 %s 离开，状态复位",
                                   self.ctx.camera_key, self.target_label)

    # ────────────────────────────────────────────
    # 业务私有方法：随便写，不受引擎约束
    # ────────────────────────────────────────────
    def _has_target(self, boxes) -> bool:
        for b in boxes:
            if b.getLabelName() == self.target_label and b.getConfidence() >= self.target_conf:
                return True
        return False
