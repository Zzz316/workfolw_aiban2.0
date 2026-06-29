import datetime
import pandas as pd
from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
from icamera.tool.camname import camname

#blueprin
visual_dashboard_blueprint = Blueprint('visual_dashboard', __name__,template_folder='templates')

#route
@visual_dashboard_blueprint.route('/camera_api/iot/camera/card_data',  methods=['GET'])
def card_data():
    data = []
    today = datetime.datetime.now().strftime('%Y-%m-%d')

    li_list = "SELECT * FROM icam_line_data"
    li_list = db.select_db(li_list)
    for i in range(len(li_list)):
        title = li_list['title'].values[i]
        standardCycle = (li_list['standardCycle'].values[i])
        demandCycle = li_list['demandCycle'].values[i]
        targetProduction = li_list['targetProduction'].values[i]
        sort = li_list['sort'].values[i]
        camid = li_list['camid'].values[i]
        camUrlList = "SELECT url FROM icam_camera_data WHERE id = %s"
        camUrlList = db.select_db(camUrlList, (camid))
        if camUrlList is not None and not camUrlList.empty:
            cameraFlag = True if camUrlList['url'].values[0] else False    
        else:
            cameraFlag = False
        
        # 修复：检查camid是否为None或空字符串，并且可以转换为整数
        if camid and pd.notna(camid):
            try:
                camid_int = int(camid)
                # 获取相机名称列表
                cam_list = camname(0)
                # 检查索引是否有效
                if 0 < camid_int <= len(cam_list):
                    cam = cam_list[camid_int - 1]
                    sql = """SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND camname = %s"""
                    df = db.select_db(sql, (today, cam))
                    if df is not None and not df.empty:
                        logo = cameraFlag
                        # 读取process的值
                        process_numeric = pd.to_numeric(df['calculate_process'], errors='coerce')
                        # 求process平均值
                        mean_value = process_numeric.mean()
                        process_avg = 0 if pd.isna(mean_value) else int(mean_value)
                        todayProduction = len(df)
                        efficiency = int((standardCycle / process_avg) * 100) if process_avg > 0 else 0
                        progress = int((todayProduction / targetProduction) * 100) if targetProduction > 0 else 0
                    else:
                        logo = cameraFlag  # 即使没有数据，也应该设置logo为cameraFlag
                        process_avg = 0
                        todayProduction = 0
                        efficiency = 0
                        progress = 0
                else:
                    # camid超出有效范围，使用默认值
                    logo = cameraFlag  # 即使camid无效，也应该设置logo为cameraFlag
                    process_avg = 0
                    todayProduction = 0
                    efficiency = 0
                    progress = 0
            except (ValueError, TypeError):
                # camid无法转换为整数，使用默认值
                logo = cameraFlag  # 即使转换失败，也应该设置logo为cameraFlag
                process_avg = 0
                todayProduction = 0
                efficiency = 0
                progress = 0
        else:
            logo = False
            process_avg = li_list['actualCycle'].values[i]
            todayProduction = li_list['todayProduction'].values[i]
            efficiency = int((standardCycle / process_avg) * 100) if process_avg > 0 else 0
            progress = int((todayProduction / targetProduction) * 100) if targetProduction > 0 else 0

        data_list = {
            'title': title,
            'status': "normal",
            'statusText': "正常运行",
            'logo': logo,  # 使用前面分支中设置的logo值，而不是硬编码为True
            'standardCycle': str(standardCycle),
            'actualCycle': str(process_avg),
            'unit': "s/个",
            'todayProduction': str(todayProduction),
            'targetProduction': str(targetProduction),
            'hourlyOutput': "12",
            'efficiency': str(efficiency),
            'progress': str(progress),
            'icon': "user",
            'demandCycle': str(demandCycle),
            "sort":str(sort)
        }
        data.append(data_list)

    res = {
        "success": False,
        "code": 47,
        "msg": "in",
        "data": data
    }
    return make_response(res)

@visual_dashboard_blueprint.route('/camera_api/iot/camera/beat_analysis',  methods=['GET'])
def beat_analysis():
    data = []
    timeslot = request.args.get('timeslot')
    today = datetime.datetime.now().strftime('%Y-%m-%d')

    # 更新五个时间段定义
    shift_times = {
        'morningshift': [('06:30:00', '15:00:00')],
        'noonshift': [('15:00:00', '23:30:00')],
        'nightshift': [('23:30:00', '06:30:00')],  # 跨天到第二天
        'dayshift': [('08:15:00', '16:45:00')],
        'day': [('06:30:00', '06:30:00')]  # 从今天6:30到第二天6:30
    }

    # 获取相机列表，用于根据camid查找相机名称
    cam_list = camname(0)
    
    # 先从数据库获取所有icam_line_data数据，并按照sort字段排序
    li_list = "SELECT * FROM icam_line_data ORDER BY sort ASC"
    li_list = db.select_db(li_list)
    
    # 遍历排序后的icam_line_data数据
    for i in range(len(li_list)):
        title = li_list['title'].values[i]
        camid = li_list['camid'].values[i]
        targetProduction = li_list['demandCycle'].values[i]
        
        # 检查camid是否有效
        process_avg = 0
        cam = None
        valid_cam = False
        if camid and pd.notna(camid):
            try:
                camid_int = int(camid)
                if 0 < camid_int <= len(cam_list):
                    cam = cam_list[camid_int - 1]
                    valid_cam = True
            except (ValueError, TypeError):
                cam = None
        
        # 只有当cam有效时才查询数据，否则使用默认值
        if valid_cam and timeslot in shift_times:
            if timeslot == 'day':
                # 查询从今天上午6:30到第二天上午6:30的数据
                # 第一天6:30到23:59:59
                sql1 = """SELECT calculate_process FROM icam_process_timing_siemens
                             WHERE DATE(daytime) = %s 
                             AND TIME(daytime) >= %s 
                             AND camname = %s"""
                df1 = db.select_db(sql1, (today, '06:30:00', cam))

                # 第二天00:00到06:30
                sql2 = """SELECT calculate_process FROM icam_process_timing_siemens 
                             WHERE DATE(daytime) = DATE_ADD(%s, INTERVAL 1 DAY)
                             AND TIME(daytime) <= %s 
                             AND camname = %s"""
                df2 = db.select_db(sql2, (today, '06:30:00', cam))

                # 合并两天数据
                dfs = []
                if df1 is not None and not df1.empty:
                    dfs.append(df1)
                if df2 is not None and not df2.empty:
                    dfs.append(df2)

                if dfs:
                    combined_df = pd.concat(dfs, ignore_index=True)
                    if not combined_df.empty:
                        process_numeric = pd.to_numeric(combined_df['calculate_process'], errors='coerce')
                        process_avg = int(process_numeric.mean())
            elif timeslot == 'nightshift':
                # 晚班跨天处理：从晚上23:30到第二天早上6:30
                # 第一天晚上23:30到23:59:59
                sql1 = """SELECT calculate_process FROM icam_process_timing_siemens 
                             WHERE DATE(daytime) = %s 
                             AND TIME(daytime) >= %s 
                             AND camname = %s"""
                df1 = db.select_db(sql1, (today, '23:30:00', cam))

                # 第二天凌晨00:00到06:30
                sql2 = """SELECT calculate_process FROM icam_process_timing_siemens 
                             WHERE DATE(daytime) = DATE_ADD(%s, INTERVAL 1 DAY)
                             AND TIME(daytime) <= %s 
                             AND camname = %s"""
                df2 = db.select_db(sql2, (today, '06:30:00', cam))

                # 合并两天数据
                dfs = []
                if df1 is not None and not df1.empty:
                    dfs.append(df1)
                if df2 is not None and not df2.empty:
                    dfs.append(df2)

                if dfs:
                    combined_df = pd.concat(dfs, ignore_index=True)
                    if not combined_df.empty:
                        process_numeric = pd.to_numeric(combined_df['calculate_process'], errors='coerce')
                        process_avg = int(process_numeric.mean())
            else:
                # 其他正常班次（早班、中班、白班）
                time_range = shift_times[timeslot][0]
                start_time, end_time = time_range

                sql = """SELECT calculate_process FROM icam_process_timing_siemens 
                            WHERE DATE(daytime) = %s 
                            AND TIME(daytime) BETWEEN %s AND %s
                            AND camname = %s"""
                df = db.select_db(sql, (today, start_time, end_time, cam))

                if df is not None and not df.empty:
                    process_numeric = pd.to_numeric(df['calculate_process'], errors='coerce')
                    process_avg = int(process_numeric.mean())

        # 使用title作为工位名称，确保按照sort字段排序
        station_name = title
        
        # 如果找到了有效的cam，使用cam作为工位名称
        if cam:
            station_name = cam
        
        data_list = {
            'title': station_name,
            'currentCycleion': int(targetProduction) if targetProduction is not None and pd.notna(targetProduction) else 0,
            'actualCycle': str(process_avg) if pd.notna(process_avg) and process_avg > 0 else '0'
        }
        data.append(data_list)

    # 只考虑有效数据（actualCycle > 0 的相机）
    actual_cycles = [float(item['actualCycle']) for item in data if float(item['actualCycle']) > 0]
    max_actual_cycle = max(actual_cycles) if actual_cycles else 0
    sum_actual_cycles = sum(actual_cycles) if actual_cycles else 0
    valid_cam_count = len(actual_cycles)
    
    if sum_actual_cycles > 0 and max_actual_cycle > 0 and valid_cam_count > 0:
        result = int((sum_actual_cycles / (max_actual_cycle * valid_cam_count)) * 100)
    else:
        result = 0

    res = {
        "success": True,
        "code": 200,
        "msg": "success",
        "production":result,
        "data": data
    }
    return make_response(res)

@visual_dashboard_blueprint.route('/camera_api/iot/camera/workstation_data',  methods=['GET'])
def workstation_data():
    camid = request.args.get('camid')
    camid_int = int(camid) if camid else 1
    cam = camname(0)[camid_int - 1]
    today = datetime.datetime.now().strftime('%Y-%m-%d')

    sql = """SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND camname = %s"""
    df = db.select_db(sql, (today, cam))
    workSql = """SELECT * FROM icam_line_data WHERE title = %s"""
    workdf = db.select_db(workSql, (cam))
    
    # 初始化workdf相关变量
    standardCycle = 50  # 默认值
    targetProduction = 150  # 默认值
    imgPath = ""  # 默认值
    
    # 从workdf获取数据，如果workdf不为空
    if workdf is not None and not workdf.empty:
        standardCycle = int(workdf['standardCycle'].values[0]) if pd.notna(workdf['standardCycle'].values[0]) else 50
        targetProduction = workdf['targetProduction'].values[0] if pd.notna(workdf['targetProduction'].values[0]) else 150
        imgPath = workdf['imgPath'].values[0] if pd.notna(workdf['imgPath'].values[0]) else ""
    
    if df is not None and not df.empty:
        process_numeric = pd.to_numeric(df['calculate_process'], errors='coerce')
        process_avg = int(process_numeric.mean())
        efficiency = int((standardCycle / process_avg) * 100) if process_avg > 0 else 0
        
        # 确定状态
        if standardCycle > process_avg:
            status = "正常运行"
        elif process_avg > standardCycle:
            status = "待改善"
        else:
            status = "正常运行"
            
        data_list = {
            'status': status,
            'standardCycle': standardCycle,
            'actualCycle': str(process_avg),
            'actualproduction': str(len(df)),
            'Standardoutput': str(targetProduction),
            'efficiency': str(efficiency),
            'imgPath': imgPath
        }

    else:
        # data_list = {
        #     'status': "瓶颈",
        #     'standardCycle': str(standardCycle),
        #     'actualCycle': '0',
        #     'actualproduction': '0',
        #     'Standardoutput': str(targetProduction),
        #     'efficiency': '0',
        #     'imgPath': imgPath
        # }
        data_list = {
            'status': "正常运行",
            'standardCycle': str(standardCycle),
            'actualCycle': '0',
            'actualproduction': '0',
            'Standardoutput': str(targetProduction),
            'efficiency': '0',
            'imgPath': imgPath
        }

    res = {
        "success": False,
        "code": 47,
        "msg": "in",
        "data": data_list
    }
    return make_response(res)



