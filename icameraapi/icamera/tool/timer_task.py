import time
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
from icamera.common.mysql_operate import db
from icamera.tool.yaml_groupget import main_get

def is_time_in_ranges(timer_str):
    if timer_str == 'MANUAL_ON': return True
    if timer_str == 'MANUAL_OFF': return False
    if not timer_str or timer_str.strip() in ['', 'null', 'None']: return True
        
    now = datetime.now().time()
    ranges = str(timer_str).split(';')
    for r in ranges:
        if '-' in r:
            start_str, end_str = r.split('-')
            try:
                start_time = datetime.strptime(start_str.strip(), "%H:%M").time()
                end_time = datetime.strptime(end_str.strip(), "%H:%M").time()
                if start_time <= now <= end_time: return True
            except Exception:
                continue
    return False

def check_and_update_status():
    """
    同时巡检 推理状态(group_enable) 和 报警状态(alarm_enable)
    """
    sql = "SELECT id, group_enable, infer_timer, alarm_enable, alarm_timer FROM icamera_data.icam_scene_new_data"
    df = db.select_db(sql)
    if df is None or df.empty: return

    need_yaml_update = False

    for index, row in df.iterrows():
        scene_id = str(row['id'])
        
        # 1. ===== 检查推理状态 (Infer) =====
        raw_infer_enable = str(row['group_enable']).strip().lower()
        current_infer_status = (raw_infer_enable == 'true' or raw_infer_enable == '1')
        expected_infer_status = is_time_in_ranges(str(row['infer_timer']))
        
        if current_infer_status != expected_infer_status:
            new_infer_val = "True" if expected_infer_status else "False"
            db.execute_db(f"UPDATE icamera_data.icam_scene_new_data SET group_enable = '{new_infer_val}' WHERE id = '{scene_id}'")
            need_yaml_update = True # 推理状态变了，必须刷新 YAML
            print(f"场景 {scene_id} 推理状态变更: {current_infer_status} -> {expected_infer_status}")

        # 2. ===== 检查报警状态 (Alarm) =====
        raw_alarm_enable = str(row['alarm_enable']).strip().lower()
        current_alarm_status = (raw_alarm_enable == 'true' or raw_alarm_enable == '1')
        expected_alarm_status = is_time_in_ranges(str(row['alarm_timer']))
        
        if current_alarm_status != expected_alarm_status:
            new_alarm_val = "True" if expected_alarm_status else "False"
            db.execute_db(f"UPDATE icamera_data.icam_scene_new_data SET alarm_enable = '{new_alarm_val}' WHERE id = '{scene_id}'")
            # 报警状态变了，不需要刷新 YAML
            print(f"场景 {scene_id} 报警状态变更: {current_alarm_status} -> {expected_alarm_status}")

    if need_yaml_update:
        print("====== 定时任务触发: 重新生成 main-flow.yaml ======")
        main_get()

def init_scheduler():
    scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
    scheduler.add_job(check_and_update_status, 'interval', seconds=30)
    scheduler.start()