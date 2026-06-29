import datetime
import threading
import multiprocessing
import os
import pandas as pd
from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
from icamera.tool.alarmname import alarmname
from icamera.tool.video_processing import find_and_sort_videos, merge_and_clean

#blueprin
history_data_blueprint = Blueprint('history_data', __name__,template_folder='templates')

#route
video_merge_locks = {}
lock_dict_lock = threading.Lock()

def merge_videos_process(video_paths, output_path):
    """在新进程中执行视频合并的包装函数"""
    try:
        result = merge_and_clean(video_paths, output_path)
        return result
    except Exception as e:
        raise e

def get_video_merge_lock(key):
    """获取特定视频合并任务的锁"""
    with lock_dict_lock:
        if key not in video_merge_locks:
            video_merge_locks[key] = threading.Lock()
        return video_merge_locks[key]


def get_alarm_name_by_id(alarm_id):
    """根据告警ID获取告警名称"""
    alarm_list = alarmname(0)
    if alarm_list and len(alarm_list) > alarm_id:
        return alarm_list[alarm_id]
    return None

#route
@history_data_blueprint.route('/camera_api/iot/camera/get-historical-alarm',  methods=['GET'])
def getHistoricalalarm():
    alarm_new = []
    try:
        starttime = request.args.get('start')
        endtime = request.args.get('end')
        camid_param = request.args.get('camid', '')
        alarm_param = request.args.get('alarm', '')
        
        # 参数验证
        if not starttime or not endtime:
            res = {
                "success": False,
                "code": 400,
                "msg": "缺少必要参数",
                "data": [],
                "total": 0
            }
            return make_response(res)
        
        day = datetime.datetime.now().strftime('%Y-%m-%d')
        date_start = datetime.datetime.strptime(starttime, '%Y-%m-%d %H:%M:%S')
        date_end = datetime.datetime.strptime(endtime, '%Y-%m-%d %H:%M:%S')
        
        if not camid_param or camid_param.strip() == '':
            # 没有 camid 参数，查询当天所有数据
            sql = "SELECT * FROM icam_alarm_data where day='"+ day +"'"
            df = db.select_db(sql)
            if df is not None and not df.empty:
                df = df.sort_index(ascending=False)
                df = df[(df['timedate'] >= date_start) & (df['timedate'] <= date_end)]
                df = df.reset_index(drop=True)
                for i in range(len(df)):
                    realtime = df['day'][i] + " " + df['time'][i]
                    realregion = df['region'][i]
                    realmatter = df['alarm_content'][i]
                    # 处理 camera_id
                    camname_val = df['camera_id'][i]
                    camname = int(camname_val) if camname_val is not None and not pd.isna(camname_val) else 0
                    imgpathlist = df['img_path'][i]
                    # 处理 standard
                    standard_val = df['standard'][i]
                    standard = int(standard_val) if standard_val is not None and not pd.isna(standard_val) else 0
                    # 处理 process
                    if 'process' in df.columns and df['process'][i] is not None and not pd.isna(df['process'][i]):
                        process = int(df['process'][i])
                    else:
                        process = 0
                    date = {"time": realtime, "region": realregion, "matter": realmatter, "camera": camname,"path": imgpathlist, "standardCycle": standard, "actualCycle": process}
                    alarm_new.append(date)
        else:
            camid = camid_param.split(",")
            alarm = alarm_param.split(",") if alarm_param else []
            
            # 构建 SQL 查询
            sql_parts = ["SELECT * FROM icam_alarm_data WHERE camera_id IN {}".format(tuple(camid))]
            
            # 处理 alarm 参数
            if alarm and len(alarm) > 0 and alarm[0].strip():
                alarm_names = []
                for x in alarm:
                    if x.strip().isdigit():
                        alarm_id = int(x)
                        alarm_name = get_alarm_name_by_id(alarm_id)
                        if alarm_name:
                            alarm_names.append(alarm_name)
                if alarm_names:
                    if len(alarm_names) > 1:
                        sql_parts.append("alarm_content IN {}".format(tuple(alarm_names)))
                    else:
                        sql_parts.append("alarm_content = '{}'".format(alarm_names[0]))
            
            sql = " AND ".join(sql_parts)
            df = db.select_db(sql)
            
            if df is not None and not df.empty:
                df = df.sort_index(ascending=False)
                df = df[(df['timedate'] >= date_start) & (df['timedate'] <= date_end)]
                df = df.reset_index(drop=True)
                for i in range(len(df)):
                    realtime = df['day'][i] + " " + df['time'][i]
                    realregion = df['region'][i]
                    realmatter = df['alarm_content'][i]
                    # 处理 camera_id
                    camname_val = df['camera_id'][i]
                    camname = int(camname_val) if camname_val is not None and not pd.isna(camname_val) else 0
                    imgpathlist = df['img_path'][i]
                    # 处理 standard
                    standard_val = df['standard'][i]
                    standard = int(standard_val) if standard_val is not None and not pd.isna(standard_val) else 0
                    # 处理 process
                    if 'process' in df.columns and df['process'][i] is not None and not pd.isna(df['process'][i]):
                        process = int(df['process'][i])
                    else:
                        process = 0
                    date = {"time": realtime, "region": realregion, "matter": realmatter, "camera": camname,"path": imgpathlist,"standardCycle": standard,"actualCycle": process}
                    alarm_new.append(date)

    except Exception as e:
        print(f"查询历史告警数据时出错: {e}")
        alarm_new = []
        res = {
            "success": False,
            "code": 500,
            "msg": f"查询失败: {str(e)}",
            "data": [],
            "total": 0
        }
        return make_response(res)

    # 处理分页
    try:
        size = int(request.args.get('size', 10))
        current = int(request.args.get('current', 1))
    except:
        size = 10
        current = 1

    total = len(alarm_new)
    start_idx = (current - 1) * size
    end_idx = start_idx + size
    paginated_data = alarm_new[start_idx:end_idx]

    res = {
        "success": True,
        "code": 200,
        "msg": "查询成功",
        "data": paginated_data,
        "total": total
    }
    return make_response(res)

@history_data_blueprint.route('/camera_api/iot/camera/historical-alarm/upload',  methods=['POST'])
def document_upload():
    alarm_new = []
    starttime = request.json.get('start')
    endtime = request.json.get('end')
    alarm = request.json.get('alarm').split(",")
    alarm_list = [alarmname(0)[int(x)] for x in alarm]
    date_start = datetime.datetime.strptime(starttime, '%Y-%m-%d %H:%M:%S')
    date_end = datetime.datetime.strptime(endtime, '%Y-%m-%d %H:%M:%S')
    if len(alarm_list) > 1:
        sql = "SELECT * FROM icam_alarm_data where alarm_content in{}".format(tuple(alarm_list)) + ""
        df = db.select_db(sql)
        df = df.sort_index(ascending=False)
        df = df[(df['timedate'] >= date_start) & (df['timedate'] <= date_end)]
        df = df.reset_index(drop=True)
        for i in range(len(df)):
            realtime = df['day'][i] + " " + df['time'][i]
            realregion = df['region'][i]
            realmatter = df['alarm_content'][i]
            camname = int(df['camera_id'][i])
            imgpathlist = df['img_path'][i]
            if 'process' in df.columns and df['process'][i] != None:
                if 'process' in df.columns and df['process'][i] != None:
                    process = df['process'][i]
                else:
                    process = 0
            else:
                process = 0
            date = {"time": realtime, "region": realregion, "matter": realmatter, "camera": camname,
                    "path": imgpathlist,"standardCycle": "20","actualCycle": process}
            alarm_new.append(date)

    if len(alarm_list) == 1:
        sql = "SELECT * FROM icam_alarm_data where alarm_content ='" + alarm_list[0] + "'"
        df = db.select_db(sql)
        df = df.sort_index(ascending=False)
        df = df[(df['timedate'] >= date_start) & (df['timedate'] <= date_end)]
        df = df.reset_index(drop=True)
        for i in range(len(df)):
            realtime = df['day'][i] + " " + df['time'][i]
            realregion = df['region'][i]
            realmatter = df['alarm_content'][i]
            camname = int(df['camera_id'][i])
            imgpathlist = df['img_path'][i]
            process = df['process'][i]
            date = {"time": realtime, "region": realregion, "matter": realmatter, "camera": camname,
                    "path": imgpathlist,"standardCycle": "20","actualCycle": process}
            alarm_new.append(date)

    res = {
        "success": False,
        "code": 47,
        "msg": "in",
        "data": alarm_new
    }
    return make_response(res)

@history_data_blueprint.route('/camera_api/iot/camera/alarm-playback', methods=['POST'])
def alarm_playback():
    record_id = request.json.get('id')
    
    if not record_id:
        return make_response({"success": False, "code": 400, "msg": "缺少记录ID"})

    # 1. 直接用 id 查出这条报警记录的所有关键信息
    sql = f"SELECT timedate, camera_id, group_id, video_path FROM icamera_data.icam_alarm_data WHERE id = '{record_id}'"
    df = db.select_db(sql)
    
    if df is None or df.empty:
        return make_response({"success": False, "code": 404, "msg": "找不到该报警记录"})

    row = df.iloc[0]
    file = row['video_path']
    alarm_time = str(row['timedate'])  # 例如："2026-03-12 13:59:36"
    camera_id = str(row['camera_id'])
    groupid = str(row['group_id'])
    
    # 2. 判断是否已经存在合成好的视频 (处理 Pandas 中的 Null / None)
    if pd.isna(file) or file is None or str(file).strip() == '' or str(file).lower() == 'null':
        # 拆分时间用于构建路径
        day_str = alarm_time[:10]   # "2026-03-12"
        time_str = alarm_time[11:]  # "13:59:36"
        new_time_str = time_str.replace(":", "-") # "13-59-36"

        source_folder = f'D:/product/AiBanWorkSpace/abstream/video/record/live/{groupid}/{camera_id}/{day_str}/'
        target_folder = f'D:/product/AiBanWorkSpace/abstream/video/ngvideo/{day_str}/{camera_id}/'

        try:
            # 调用你原有的寻找与合并逻辑
            input_videos = find_and_sort_videos(time_str, source_folder, target_folder)
            
            process = multiprocessing.Process(
                target=merge_videos_process,
                args=(input_videos, target_folder + new_time_str + '.mp4')
            )
            process.start()
            process.join()  # 等待进程完成
            
            result_path = target_folder + new_time_str + '.mp4'
            if os.path.exists(result_path):
                # 截取相对路径 (保留你原有的 41 位截取逻辑)
                file = result_path[41:].replace('\\', '/')
                
                # 3. 合成成功后，用唯一 id 精准更新数据库
                sql1 = f"UPDATE icamera_data.icam_alarm_data SET video_path = '{file}' WHERE id = '{record_id}'"
                db.execute_db(sql1)
            else:
                raise Exception("进程执行完毕，但未在目标目录找到合成文件")
                
        except Exception as e:
            return make_response({"success": False, "code": 500, "msg": f"视频合成失败: {str(e)}"})

    # 4. 返回最终的视频相对路径
    res = {
        "success": True,
        "code": 200,
        "msg": "success",
        "data": True,
        "file": file
    }
    return make_response(res)
