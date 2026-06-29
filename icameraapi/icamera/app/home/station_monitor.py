from flask import make_response, request, Blueprint, Response
from icamera.common.mysql_operate import db
from datetime import datetime
import pandas as pd
import json
import time

station_monitor_blueprint = Blueprint('station_monitor', __name__, template_folder='templates')

# ==========================================================
# ---------- 以下為新版看板核心業務表自動初始化 ----------
# ==========================================================

def init_station_monitor_tables():
    """自動初始化創建看板需要的兩張核心數據表"""
    create_cycle_table_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.production_cycle_record (
        id INT NOT NULL AUTO_INCREMENT COMMENT '週期/任務ID',
        camera_id INT NOT NULL COMMENT '關聯的攝像頭ID',
        result_status INT DEFAULT 0 COMMENT '整個週期判定結果 (0:生產中, 1:OK, 2:NG)',
        start_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '週期開始時間',
        end_time DATETIME DEFAULT NULL COMMENT '週期結束時間',
        create_date DATE DEFAULT (CURRENT_DATE) COMMENT '歸屬日期(用於每日統計)',
        PRIMARY KEY (id),
        INDEX idx_camera_date (camera_id, create_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='生產週期總表';
    """

    create_log_table_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.step_execution_log (
        id INT NOT NULL AUTO_INCREMENT COMMENT '流水ID',
        camera_id INT NOT NULL COMMENT '關聯的攝像頭ID',
        cycle_id INT NOT NULL COMMENT '關聯的生產週期ID(對應總表ID)',
        step_config_id VARCHAR(50) NOT NULL COMMENT '關聯的工序代號(如D1, D2)',
        start_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '工序開始時間',
        end_time DATETIME DEFAULT NULL COMMENT '工序結束時間',
        duration INT DEFAULT 0 COMMENT '工序耗時(秒)',
        step_result INT DEFAULT 0 COMMENT '步驟判定結果 (0:進行中, 1:OK, 2:NG)',
        PRIMARY KEY (id),
        INDEX idx_cycle_id (cycle_id),
        INDEX idx_camera_step (camera_id, step_config_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工序執行流水表';
    """
    try:
        db.execute_db(create_cycle_table_sql)
        db.execute_db(create_log_table_sql)
        print("====== 表 production_cycle_record & step_execution_log 初始化成功 ======")
    except Exception as e:
        print(f"====== 初始化看板核心業務表失敗: {e} ======")

init_station_monitor_tables()


# ==========================================================
# ---------- 核心：SSE 服務端事件主動推流接口 ----------
# ==========================================================

def fetch_latest_dashboard_payload(camera_id, today_str):
    """提取核心看板數據的內部封裝函數"""
    # 1. 看板當日聚合統計
    stats_sql = f"""
        SELECT id, result_status FROM icamera_data.production_cycle_record 
        WHERE camera_id = '{camera_id}' 
          AND (DATE(start_time) = '{today_str}' OR DATE(end_time) = '{today_str}' OR create_date = '{today_str}')
    """
    df_stats = db.select_db(stats_sql)
    total_count, ok_count, ng_count = 0, 0, 0
    success_rate = "0%"
    if df_stats is not None and not df_stats.empty:
        total_count = len(df_stats)
        ok_count = len(df_stats[df_stats['result_status'] == 1])
        ng_count = len(df_stats[df_stats['result_status'] == 2])
        if total_count > 0:
            success_rate = f"{round((ok_count / total_count) * 100)}%"

    # 2. 最新產品週期 ID
    cycle_sql = f"SELECT id FROM icamera_data.production_cycle_record WHERE camera_id = '{camera_id}' ORDER BY id DESC LIMIT 1"
    df_cycle = db.select_db(cycle_sql)
    current_cycle_id = df_cycle.iloc[0]['id'] if (df_cycle is not None and not df_cycle.empty) else None

    # 3. 組裝左下角步驟點亮狀態
    config_sql = f"SELECT step_code, step_name FROM icamera_data.icam_camera_step_config WHERE camera_id = '{camera_id}' AND is_active = 1 ORDER BY sort_order ASC"
    df_config = db.select_db(config_sql)
    process_list = []
    if df_config is not None and not df_config.empty:
        log_dict = {}
        if current_cycle_id:
            log_sql = f"SELECT step_config_id, step_result FROM icamera_data.step_execution_log WHERE cycle_id = '{current_cycle_id}'"
            df_logs = db.select_db(log_sql)
            if df_logs is not None and not df_logs.empty:
                log_dict = dict(zip(df_logs['step_config_id'].astype(str), df_logs['step_result']))
        
        for item in df_config.to_dict('records'):
            status = log_dict.get(str(item.get('step_code')), -1)
            process_list.append({
                "id": item.get('step_code'),
                "name": item.get('step_name'),
                "status": int(status) if status is not None else -1
            })

    # 4. 右下角反序表格數據
    history_sql = f"""
        SELECT l.id as log_id, c.step_code as step_code, c.step_name as name,
               DATE_FORMAT(l.start_time, '%H:%M:%S') as startTime, DATE_FORMAT(l.end_time, '%H:%M:%S') as endTime,
               l.duration as duration, l.step_result as stepResult
        FROM icamera_data.step_execution_log l
        JOIN icamera_data.icam_camera_step_config c ON l.step_config_id = c.step_code AND l.camera_id = c.camera_id
        WHERE l.camera_id = '{camera_id}' AND DATE(l.start_time) = '{today_str}'
        ORDER BY l.start_time DESC
    """
    df_history = db.select_db(history_sql)
    table_data = df_history.fillna('-').to_dict('records') if (df_history is not None and not df_history.empty) else []

    return {
        "summary": {"total": total_count, "rate": success_rate, "ok": ok_count, "ng": ng_count},
        "processList": process_list,
        "tableData": table_data
    }


@station_monitor_blueprint.route('/camera_api/iot/monitor/dashboardStream', methods=['GET'])
def dashboard_stream():
    """SSE長連接推流通道：當且僅當底層生產流水變化時，向前端主動泵送Event數據"""
    camera_id = request.args.get('camera_id')
    if not camera_id:
        return make_response({"success": False, "code": 400, "msg": "缺少攝像頭ID"})

    def generate():
        today_str = datetime.now().strftime('%Y-%m-%d')
        last_log_id = 0
        last_total_count = -1
        
        # 首次連接，無條件先推送一次基礎配置架構
        try:
            payload = fetch_latest_dashboard_payload(camera_id, today_str)
            if payload["tableData"]:
                last_log_id = payload["tableData"][0].get('log_id', 0)
            last_total_count = payload["summary"]["total"]
            yield f"data: {json.dumps({'success': True, 'data': payload})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'success': False, 'msg': str(e)})}\n\n"

        # 進入事件監聽回環
        while True:
            time.sleep(1) # 後台線程每秒做一次輕量級心跳數據差分判定
            try:
                # 查出當前最新的一條記錄ID以及今日總產量數
                check_sql = f"""
                    SELECT MAX(id) as max_id, COUNT(*) as total_cnt 
                    FROM icamera_data.step_execution_log 
                    WHERE camera_id = '{camera_id}' AND DATE(start_time) = '{today_str}'
                """
                df_check = db.select_db(check_sql)
                
                current_max_id = 0
                current_total_cnt = 0
                if df_check is not None and not df_check.empty:
                    current_max_id = df_check.iloc[0]['max_id'] if pd.notna(df_check.iloc[0]['max_id']) else 0
                    current_total_cnt = df_check.iloc[0]['total_cnt']
                
                # 🌟 如果最新流水ID變化了，或者發生跨週期變動，證明有新事件產生，立即下發主動推流
                if current_max_id != last_log_id or current_total_cnt != last_total_count:
                    payload = fetch_latest_dashboard_payload(camera_id, today_str)
                    last_log_id = current_max_id
                    last_total_count = current_total_cnt
                    yield f"data: {json.dumps({'success': True, 'data': payload})}\n\n"
            except Exception as e:
                print(f"SSE推流回環檢測異常: {e}")
                
    return Response(generate(), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'  # 禁用Nginx緩存，確保即時送達
    })


# 1. 报警记录分页查询接口
@station_monitor_blueprint.route('/camera_api/iot/alarm/list', methods=['POST'])
def get_alarm_list():
    req = request.json
    page = int(req.get('pageNum', 1))
    limit = int(req.get('pageSize', 10))
    
    # 获取查询条件 (去掉了区域，直接用摄像头ID过滤)
    camera_ids = req.get('camera_ids', []) 
    status = req.get('status', '')         
    start_time = req.get('start_time', '')
    end_time = req.get('end_time', '')
    
    # ✨ 核心：基础 SQL 使用 LEFT JOIN 关联摄像头配置表
    base_sql = """
        FROM icamera_data.icam_alarm_data a
        LEFT JOIN icamera_data.icam_camera_new_data c ON a.camera_id = c.id
        WHERE 1=1
    """
    
    # 拼接条件 (注意加上表别名 a.)
    if camera_ids:
        ids_str = ",".join([f"'{str(cid)}'" for cid in camera_ids])
        base_sql += f" AND a.camera_id IN ({ids_str})"
    
    if status:
        base_sql += f" AND a.alarm_status = '{status}'"
        
    if start_time and end_time:
        base_sql += f" AND a.timedate BETWEEN '{start_time} 00:00:00' AND '{end_time} 23:59:59'"
        
    # 查询总数
    count_sql = f"SELECT COUNT(1) as total {base_sql}"
    df_count = db.select_db(count_sql)
    total = int(df_count.iloc[0]['total']) if (df_count is not None and not df_count.empty) else 0
    
    # ✨ 分页查询数据 (额外 Select 出 c.camera_name)
    offset = (page - 1) * limit
    data_sql = f"""
        SELECT a.*, c.camera_name 
        {base_sql} 
        ORDER BY a.timedate DESC 
        LIMIT {limit} OFFSET {offset}
    """
    df_data = db.select_db(data_sql)
    
    data_list = []
    if df_data is not None and not df_data.empty:
        # 将 datetime 转为字符串，避免 JSON 序列化报错
        df_data['timedate'] = df_data['timedate'].astype(str)
        data_list = df_data.fillna('').to_dict('records')
        
    return make_response({
        "success": True,
        "code": 200,
        "msg": "查询成功",
        "data": {
            "list": data_list,
            "total": total
        }
    })

# 2. 修改报警判定结果接口
@station_monitor_blueprint.route('/camera_api/iot/alarm/update', methods=['POST'])
def update_alarm_status():
    req = request.json
    record_id = req.get('id')
    new_status = req.get('alarm_status')
    new_content = req.get('alarm_content', '')
    
    if not record_id or not new_status:
        return make_response({"success": False, "code": 400, "msg": "缺少必填参数"})
        
    try:
        # 如果改成了 OK，默认修改内容为人为修改
        if new_status.upper() == 'OK':
            new_content = "人为修改"
            
        update_sql = f"""
            UPDATE icamera_data.icam_alarm_data 
            SET alarm_status = '{new_status}', alarm_content = '{new_content}'
            WHERE id = '{record_id}'
        """
        db.execute_db(update_sql)
        
        return make_response({"success": True, "code": 200, "msg": "修改成功", "data": True})
    except Exception as e:
        return make_response({"success": False, "code": 500, "msg": f"修改失败: {str(e)}"})