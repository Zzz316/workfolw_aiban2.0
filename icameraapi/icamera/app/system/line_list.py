import datetime
import pandas as pd
from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
from icamera.tool.yaml_camget import camera_get
from icamera.tool.camname import camname

#blueprint
line_list_blueprint = Blueprint('line_list', __name__,template_folder='templates')

#route
@line_list_blueprint.route('/camera_api/iot/camera/line/list', methods=['GET'])
def line_list():
    today = datetime.datetime.now().strftime('%Y-%m-%d')
    linelist = []
    li_list = "SELECT * FROM icam_line_data"
    li_list = db.select_db(li_list)
    for i in range(len(li_list)):
        # 为 id 添加空值检查
        id_val = li_list['id'].values[i]
        id = int(id_val) if id_val is not None and pd.notna(id_val) else 0
        
        title = str(li_list['title'].values[i])
        
        # 为 standardCycle 添加空值检查
        standardCycle_val = li_list['standardCycle'].values[i]
        standardCycle = int(standardCycle_val) if standardCycle_val is not None and pd.notna(standardCycle_val) else 0
        
        # 为 demandCycle 添加空值检查
        demandCycle_val = li_list['demandCycle'].values[i]
        demandCycle = int(demandCycle_val) if demandCycle_val is not None and pd.notna(demandCycle_val) else 0
        
        # 为 maxCycle 添加空值检查
        maxCycle_val = li_list['maxCycle'].values[i]
        maxCycle = int(maxCycle_val) if maxCycle_val is not None and pd.notna(maxCycle_val) else 0
        
        # 为 minCycle 添加空值检查
        minCycle_val = li_list['minCycle'].values[i]
        minCycle = int(minCycle_val) if minCycle_val is not None and pd.notna(minCycle_val) else 0
        
        # 为 targetProduction 添加空值检查
        targetProduction_val = li_list['targetProduction'].values[i]
        targetProduction = int(targetProduction_val) if targetProduction_val is not None and pd.notna(targetProduction_val) else 0
        
        # 为 sort 添加空值检查
        sort_val = li_list['sort'].values[i]
        sort = int(sort_val) if sort_val is not None and pd.notna(sort_val) else 0
        
        camid = li_list['camid'].values[i]
        imgPath = str(li_list['imgPath'].values[i] if pd.notna(li_list['imgPath'].values[i]) else '')

        if camid and camid != '' and pd.notna(camid):
            try:
                cam = camname(0)[int(camid)-1]
                sql = """SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND camname = %s"""
                df = db.select_db(sql, (today, cam))
                process_numeric = pd.to_numeric(df['calculate_process'], errors='coerce')
                mean_value = process_numeric.mean()
                actualCycle = 0 if pd.isna(mean_value) else int(mean_value)
                todayProduction = int(len(df))
                camid = int(camid)
            except (ValueError, IndexError):
                # 如果 camid 无效，使用默认值
                actualCycle = int(li_list['actualCycle'].values[i]) if li_list['actualCycle'].values[i] is not None and pd.notna(li_list['actualCycle'].values[i]) else 0
                todayProduction = int(li_list['todayProduction'].values[i]) if li_list['todayProduction'].values[i] is not None and pd.notna(li_list['todayProduction'].values[i]) else 0
                camid = ''
        else:
            actualCycle = int(li_list['actualCycle'].values[i]) if li_list['actualCycle'].values[i] is not None and pd.notna(li_list['actualCycle'].values[i]) else 0
            todayProduction = int(li_list['todayProduction'].values[i]) if li_list['todayProduction'].values[i] is not None and pd.notna(li_list['todayProduction'].values[i]) else 0
            camid = ''

        line = {
            "id": id,
            "title": title,
            "standardCycle": standardCycle,
            "demandCycle": demandCycle,
            "maxCycle": maxCycle,
            "minCycle": minCycle,
            "targetProduction": targetProduction,
            "sort": sort,
            "camid": camid,
            "imgPath": imgPath,
            "actualCycle": actualCycle,
            "todayProduction":todayProduction
        }
        linelist.append(line)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": linelist
    }
    return make_response(res)

@line_list_blueprint.route('/camera_api/iot/camera/line/del', methods=['POST'])
def line_del():
    id = request.json.get('id')

    sql = "DELETE FROM icam_line_data WHERE id='"+ str(id) +"'"
    db.execute_db(sql)

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":True
    }
    return make_response(res)

@line_list_blueprint.route('/camera_api/iot/camera/line/edit', methods=['POST'])
def line_edit():
    id = str(request.json.get('id'))
    title = str(request.json.get('title'))
    standardCycle = int(request.json.get('standardCycle'))
    demandCycle = int(request.json.get('demandCycle'))
    maxCycle = int(request.json.get('maxCycle'))
    minCycle = int(request.json.get('minCycle'))
    targetProduction = int(request.json.get('targetProduction'))
    sort = int(request.json.get('sort'))
    camid = request.json.get('camid')
    imgPath = str(request.json.get('imgPath'))
    if not camid:
        camid = ''  # 或者设置为 0，取决于业务需求
    else:
        camid = str(camid)
    actualCycle = int(request.json.get('actualCycle'))
    todayProduction = int(request.json.get('todayProduction'))

    sql = "SELECT * FROM icam_line_data"
    df = db.select_db(sql)
    if df.empty:
        line_id = 1
    else:
        line_id = len(df) + 1
    set_up_data = "SELECT * FROM icam_line_data WHERE id='" + id + "'"
    set_up_sql = db.select_db(set_up_data)
    if set_up_sql.empty:
        data = [line_id, title, standardCycle, demandCycle, maxCycle, minCycle, targetProduction, sort, camid, actualCycle, todayProduction, imgPath]
        SQL = f"Insert Into icamera_data.icam_line_data (id, title, standardCycle, demandCycle, maxCycle, minCycle, targetProduction, sort, camid, actualCycle, todayProduction, imgPath) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}','{data[4]}','{data[5]}','{data[6]}','{data[7]}','{data[8]}','{data[9]}','{data[10]}','{data[11]}');"
        db.execute_db(SQL)
    else:
        sql1 = """UPDATE icam_line_data SET 
                  title = %s, standardCycle = %s, demandCycle = %s, maxCycle = %s, minCycle = %s,
                  targetProduction = %s, sort = %s, camid = %s, actualCycle = %s, todayProduction = %s, imgPath = %s
                  WHERE id = %s"""
        params = (title, standardCycle, demandCycle, maxCycle, minCycle,
                  targetProduction, sort, camid, actualCycle, todayProduction, imgPath, id)
        db.execute_db(sql1, params)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

# 获取产线平衡率折线图数据
@line_list_blueprint.route('/camera_api/iot/camera/line/get-line-balance-rate', methods=['GET'])
def line_balance():
    try:
        start = str(request.args.get('startDate'))
        end = str(request.args.get('endDate'))
        timeslog = request.args.get('timeslog')
        cam_list = camname(0)
        # 更新五个时间段定义
        shift_times = {
            'morningshift': [('06:30:00', '15:00:00')],
            'noonshift': [('15:00:00', '23:30:00')],
            'nightshift': [('23:30:00', '06:30:00')],  # 跨天到第二天
            'dayshift': [('08:15:00', '16:45:00')],
            'day': [('06:30:00', '06:30:00')]  # 从今天6:30到第二天6:30
        }
        # 获取日期格式
        start_date = datetime.datetime.strptime(start, '%Y-%m-%d')
        end_date = datetime.datetime.strptime(end, '%Y-%m-%d')
        delta = datetime.timedelta(days=1)
        
        # 结果列表
        result = []
        
        # 按天遍历
        current_date = start_date
        while current_date <= end_date:
            date_str = current_date.strftime('%Y-%m-%d')
            cycle_data = []
            
            # 获取所有相机的数据
            if timeslog and timeslog in shift_times:
                shift_time = shift_times[timeslog][0]  # 每个班次只有一个时间段
                shift_start, shift_end = shift_time
                
                if shift_start < shift_end:  # 当天班次（如早班、中班、白班）
                    # 时间在班次范围内
                    sql = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) BETWEEN %s AND %s"
                    params = (date_str, shift_start, shift_end)
                    df = db.select_db(sql, params)
                else:  # 跨天班次（如夜班、全天）
                    # 构建两个日期的查询条件
                    # 1. 当天：时间大于等于开始时间
                    sql1 = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) >= %s"
                    params1 = (date_str, shift_start)
                    df1 = db.select_db(sql1, params1)
                    
                    # 2. 第二天：时间小于等于结束时间
                    next_date = (current_date + delta).strftime('%Y-%m-%d')
                    sql2 = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) <= %s"
                    params2 = (next_date, shift_end)
                    df2 = db.select_db(sql2, params2)
                    
                    # 合并两天的数据
                    if df1 is not None and not df1.empty:
                        df = df1 if df2 is None or df2.empty else pd.concat([df1, df2])
                    else:
                        df = df2
            else:
                # 没有指定班次或班次无效，查询全天数据
                sql = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s"
                params = (date_str,)
                df = db.select_db(sql, params)
            # 按相机分组计算平均周期
            if df is not None and not df.empty:
                # 按相机分组
                cam_groups = df.groupby('camname')
                for cam, group in cam_groups:
                    process_numeric = pd.to_numeric(group['calculate_process'], errors='coerce')
                    mean_value = process_numeric.mean()
                    actualCycle = 0 if pd.isna(mean_value) else int(mean_value)
                    cycle_data.append(actualCycle)
            else:
                # 没有数据，为每个相机添加0
                for cam in cam_list:
                    cycle_data.append(0)
            
            # 计算平衡率
            actual_cycles = [float(cycle) for cycle in cycle_data if cycle > 0]  # 只考虑有效数据
            max_cycle = max(actual_cycles) if actual_cycles else 0
            sum_cycle = sum(actual_cycles) if actual_cycles else 0
            valid_cam_count = len(actual_cycles)
            if sum_cycle > 0 and valid_cam_count > 0:
                # total_avg = sum_cycle / valid_cam_count
                print("total_avg:",sum_cycle)
                print("max_cycle:",max_cycle)
                print("valid_cam_count:",valid_cam_count)
                balance_rate = int((sum_cycle / (max_cycle * valid_cam_count)) * 100) if max_cycle > 0 else 0
            else:
                balance_rate = 0
            result.append({
                "xLabel": date_str,
                "value": balance_rate,
            })
            current_date += delta
        
        res = {
            "success": True,
            "code": 200,
            "msg": '',
            "data": result
        }
        return make_response(res)
    except Exception as e:
        res = {
            "success": False,
            "code": 500,
            "msg": f"服务器内部错误: {str(e)}",
            "data": []
        }
        return make_response(res)

# 产量达成统计图
@line_list_blueprint.route('/camera_api/iot/camera/line/get-production-achievement', methods=['GET'])
def line_production():
    try:
        start = str(request.args.get('startDate'))
        end = str(request.args.get('endDate'))
        timeslog = request.args.get('timeslog')

        # 更新五个时间段定义
        shift_times = {
            'morningshift': [('06:30:00', '15:00:00')],
            'noonshift': [('15:00:00', '23:30:00')],
            'nightshift': [('23:30:00', '06:30:00')],  # 跨天到第二天
            'dayshift': [('08:15:00', '16:45:00')],
            'day': [('06:30:00', '06:30:00')]  # 从今天6:30到第二天6:30
        }
        
        # 获取日期格式
        start_date = datetime.datetime.strptime(start, '%Y-%m-%d')
        end_date = datetime.datetime.strptime(end, '%Y-%m-%d')
        delta = datetime.timedelta(days=1)
        
        targetP_list = "SELECT targetProduction FROM icam_line_data"
        tdf = db.select_db(targetP_list)
        if tdf.empty:
            targetProduction = 0
        else:
            targetProduction = sum(tdf['targetProduction'])
        

        # 结果列表
        result = []
        
        # 按天遍历
        current_date = start_date
        while current_date <= end_date:
            date_str = current_date.strftime('%Y-%m-%d')
            actualProduction = 0
            
            # 根据班次筛选数据
            if timeslog and timeslog in shift_times:
                shift_time = shift_times[timeslog][0]  # 每个班次只有一个时间段
                shift_start, shift_end = shift_time
                
                if shift_start < shift_end:  # 当天班次（如早班、中班、白班）
                    # 时间在班次范围内
                    sql = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) BETWEEN %s AND %s"
                    params = (date_str, shift_start, shift_end)
                    df = db.select_db(sql, params)
                else:  # 跨天班次（如夜班、全天）
                    # 构建两个日期的查询条件
                    # 1. 当天：时间大于等于开始时间
                    sql1 = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) >= %s"
                    params1 = (date_str, shift_start)
                    df1 = db.select_db(sql1, params1)
                    
                    # 2. 第二天：时间小于等于结束时间
                    next_date = (current_date + delta).strftime('%Y-%m-%d')
                    sql2 = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) <= %s"
                    params2 = (next_date, shift_end)
                    df2 = db.select_db(sql2, params2)
                    
                    # 合并两天的数据
                    if df1 is not None and not df1.empty:
                        df = df1 if df2 is None or df2.empty else pd.concat([df1, df2])
                    else:
                        df = df2
            else:
                # 没有指定班次或班次无效，查询全天数据
                sql = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s"
                params = (date_str,)
                df = db.select_db(sql, params)
            
            if df is not None and not df.empty:
                actualProduction = len(df)
            else:
                actualProduction = 0
            
            result.append({
                "xLabel": date_str,
                "targetP": targetProduction,
                "actualP": actualProduction,
                "rate": int((actualProduction / targetProduction) * 100) if targetProduction > 0 else 0,
            })
            current_date += delta
        
        res = {
            "success": True,
            "code": 200,
            "msg": '',
            "data": result
        }
        return make_response(res)
    except Exception as e:
        res = {
            "success": False,
            "code": 500,
            "msg": f"服务器内部错误: {str(e)}",
            "data": []
        }
        return make_response(res)
# 人员找料折线图
@line_list_blueprint.route('/camera_api/iot/camera/line/get-personnel-finding', methods=['GET'])
def line_personnel():
    try:
        start = str(request.args.get('startDate'))
        end = str(request.args.get('endDate'))
        timeslog = request.args.get('timeslog')
        workstation = request.args.get('workstation')
        # 更新五个时间段定义
        shift_times = {
            'morningshift': [('06:30:00', '15:00:00')],
            'noonshift': [('15:00:00', '23:30:00')],
            'nightshift': [('23:30:00', '06:30:00')],  # 跨天到第二天
            'dayshift': [('08:15:00', '16:45:00')],
            'day': [('06:30:00', '06:30:00')]  # 从今天6:30到第二天6:30
        }
        
        # 先从数据库获取所有icam_line_data数据，并按照sort字段排序，用于工位排序
        line_data = "SELECT * FROM icam_line_data ORDER BY sort ASC"
        line_data_df = db.select_db(line_data)
        
        # 创建一个映射字典，用于存储工位名称和排序值的对应关系
        # 先从icam_line_data表中获取工位名称和sort值
        station_sort_map = {}
        for i in range(len(line_data_df)):
            title = line_data_df['title'].values[i]
            sort = line_data_df['sort'].values[i]
            station_sort_map[title] = sort
        
        # 获取相机列表，用于补充工位名称
        cam_list = camname(0)
        for i, cam in enumerate(cam_list):
            # 如果工位名称不在映射字典中，使用默认排序值（索引+1000，确保在已有工位之后）
            if cam not in station_sort_map:
                station_sort_map[cam] = i + 1000
        
        # 获取日期格式
        start_date = datetime.datetime.strptime(start, '%Y-%m-%d')
        end_date = datetime.datetime.strptime(end, '%Y-%m-%d')
        delta = datetime.timedelta(days=1)
        
        # 结果列表
        result = []
        
        # 按天遍历
        current_date = start_date
        while current_date <= end_date:
            date_str = current_date.strftime('%Y-%m-%d')
            daily_data = []
            
            # 根据班次筛选数据
            if timeslog and timeslog in shift_times:
                shift_time = shift_times[timeslog][0]
                shift_start, shift_end = shift_time
                
                if shift_start < shift_end:  # 当天班次
                    sql = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) BETWEEN %s AND %s"
                    params = (date_str, shift_start, shift_end)
                    df = db.select_db(sql, params)
                else:  # 跨天班次
                    # 当天：时间大于等于开始时间
                    sql1 = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) >= %s"
                    params1 = (date_str, shift_start)
                    df1 = db.select_db(sql1, params1)
                    
                    # 第二天：时间小于等于结束时间
                    next_date = (current_date + delta).strftime('%Y-%m-%d')
                    sql2 = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) <= %s"
                    params2 = (next_date, shift_end)
                    df2 = db.select_db(sql2, params2)
                    
                    # 合并两天的数据
                    if df1 is not None and not df1.empty:
                        df = df1 if df2 is None or df2.empty else pd.concat([df1, df2])
                    else:
                        df = df2
            else:
                # 没有指定班次或班次无效，查询全天数据
                sql = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s"
                params = (date_str,)
                df = db.select_db(sql, params)
            
            # 按工位筛选数据
            workstations = []
            if workstation:
                # 处理多选情况（假设workstation是逗号分隔的字符串）
                workstations = workstation.split(',')
                if df is not None and not df.empty:
                    df = df[df['camname'].isin(workstations)]
            
            # 计算每个工位的平均找料时间和总找料时间
            # 创建一个字典来存储每个工位的数据
            cam_data = {}
            
            if df is not None and not df.empty:
                # 按工位分组
                cam_groups = df.groupby('camname')
                for cam, group in cam_groups:
                    # 转换找料时间为数值
                    per_leaving_numeric = pd.to_numeric(group['per_leaving'], errors='coerce')
                    # 过滤掉无效值
                    per_leaving_valid = per_leaving_numeric.dropna()
                    
                    if not per_leaving_valid.empty:
                        # 计算平均找料时间和总找料时间
                        mean_val = round(float(per_leaving_valid.mean()), 2)
                        sum_val = float(per_leaving_valid.sum())
                    else:
                        mean_val = 0.0
                        sum_val = 0.0
                    
                    # 存储到字典中
                    cam_data[cam] = {
                        "meanVal": mean_val,
                        "sumVal": sum_val
                    }
            
            # 如果有指定工位，确保所有指定的工位都出现在结果中
            if workstations:
                for ws in workstations:
                    if ws not in cam_data:
                        cam_data[ws] = {
                            "meanVal": 0.0,
                            "sumVal": 0.0
                        }
            # 如果没有指定工位，使用查询结果中的所有工位
            else:
                pass  # 已经处理过了
            
            # 将字典转换为列表
            daily_data = []
            for cam, data in cam_data.items():
                daily_data.append({
                    "cameraname": cam,
                    "meanVal": data["meanVal"],
                    "sumVal": data["sumVal"],
                    "sort": station_sort_map.get(cam, 9999)  # 获取排序值，默认9999放在最后
                })
            
            # 按照sort字段排序
            daily_data.sort(key=lambda x: x["sort"])
            
            # 移除sort字段，不返回给前端
            for item in daily_data:
                del item["sort"]
            
            # 添加当天数据到结果列表
            result.append({
                "xlabel": date_str,
                "list": daily_data
            })
            
            # 移动到下一天
            current_date += delta
        
        # 构建响应
        res = {
            "success": True,
            "code": 200,
            "msg": '',
            "data": result
        }
        return make_response(res)
    except Exception as e:
        res = {
            "success": False,
            "code": 500,
            "msg": f"服务器内部错误: {str(e)}",
            "data": []
        }
        return make_response(res)


# 平均节拍统计图
@line_list_blueprint.route('/camera_api/iot/camera/line/get-average-beat', methods=['GET'])
def line_average_beat():
    try:
        start = str(request.args.get('startDate'))
        end = str(request.args.get('endDate'))
        timeslog = request.args.get('timeslog')
        workstation = request.args.get('workstation')
        # 更新五个时间段定义
        shift_times = {
            'morningshift': [('06:30:00', '15:00:00')],
            'noonshift': [('15:00:00', '23:30:00')],
            'nightshift': [('23:30:00', '06:30:00')],  # 跨天到第二天
            'dayshift': [('08:15:00', '16:45:00')],
            'day': [('06:30:00', '06:30:00')]  # 从今天6:30到第二天6:30
        }
        
        # 先从数据库获取所有icam_line_data数据，并按照sort字段排序，用于工位排序
        line_data = "SELECT * FROM icam_line_data ORDER BY sort ASC"
        line_data_df = db.select_db(line_data)
        
        # 创建一个映射字典，用于存储工位名称和排序值的对应关系
        # 先从icam_line_data表中获取工位名称和sort值
        station_sort_map = {}
        for i in range(len(line_data_df)):
            title = line_data_df['title'].values[i]
            sort = line_data_df['sort'].values[i]
            station_sort_map[title] = sort
        
        # 获取相机列表，用于补充工位名称
        cam_list = camname(0)
        for i, cam in enumerate(cam_list):
            # 如果工位名称不在映射字典中，使用默认排序值（索引+1000，确保在已有工位之后）
            if cam not in station_sort_map:
                station_sort_map[cam] = i + 1000
        
        # 获取日期格式
        start_date = datetime.datetime.strptime(start, '%Y-%m-%d')
        end_date = datetime.datetime.strptime(end, '%Y-%m-%d')
        delta = datetime.timedelta(days=1)
        
        # 结果列表
        result = []
        
        # 按天遍历
        current_date = start_date
        while current_date <= end_date:
            date_str = current_date.strftime('%Y-%m-%d')
            daily_data = []
            
            # 根据班次筛选数据
            if timeslog and timeslog in shift_times:
                shift_time = shift_times[timeslog][0]
                shift_start, shift_end = shift_time
                
                if shift_start < shift_end:  # 当天班次
                    sql = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) BETWEEN %s AND %s"
                    params = (date_str, shift_start, shift_end)
                    df = db.select_db(sql, params)
                else:  # 跨天班次
                    # 当天：时间大于等于开始时间
                    sql1 = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) >= %s"
                    params1 = (date_str, shift_start)
                    df1 = db.select_db(sql1, params1)
                    
                    # 第二天：时间小于等于结束时间
                    next_date = (current_date + delta).strftime('%Y-%m-%d')
                    sql2 = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s AND TIME(daytime) <= %s"
                    params2 = (next_date, shift_end)
                    df2 = db.select_db(sql2, params2)
                    
                    # 合并两天的数据
                    if df1 is not None and not df1.empty:
                        df = df1 if df2 is None or df2.empty else pd.concat([df1, df2])
                    else:
                        df = df2
            else:
                # 没有指定班次或班次无效，查询全天数据
                sql = "SELECT * FROM icam_process_timing_siemens WHERE DATE(daytime) = %s"
                params = (date_str,)
                df = db.select_db(sql, params)
            
            # 按工位筛选数据
            workstations = []
            if workstation:
                workstations = workstation.split(',')
                if df is not None and not df.empty:
                    df = df[df['camname'].isin(workstations)]
            
            # 计算每个工位的平均节拍时间
            # 创建一个字典来存储每个工位的数据
            cam_data = {}
            
            if df is not None and not df.empty:
                cam_groups = df.groupby('camname')
                for cam, group in cam_groups:
                    calculate_process_numeric = pd.to_numeric(group['calculate_process'], errors='coerce')
                    calculate_process_valid = calculate_process_numeric.dropna()
                    
                    if not calculate_process_valid.empty:
                        mean_val = round(float(calculate_process_valid.mean()), 2)
                    else:
                        mean_val = 0.0
                    
                    # 存储到字典中
                    cam_data[cam] = {
                        "meanVal": mean_val
                    }
            
            # 如果有指定工位，确保所有指定的工位都出现在结果中
            if workstations:
                for ws in workstations:
                    if ws not in cam_data:
                        cam_data[ws] = {
                            "meanVal": 0.0
                        }
            # 如果没有指定工位，使用查询结果中的所有工位
            else:
                pass  # 已经处理过了
            
            # 将字典转换为列表
            daily_data = []
            for cam, data in cam_data.items():
                daily_data.append({
                    "cameraname": cam,
                    "meanVal": data["meanVal"],
                    "sort": station_sort_map.get(cam, 9999)  # 获取排序值，默认9999放在最后
                })
            
            # 按照sort字段排序
            daily_data.sort(key=lambda x: x["sort"])
            
            # 移除sort字段，不返回给前端
            for item in daily_data:
                del item["sort"]
            
            # 添加当天数据到结果列表
            result.append({
                "xlabel": date_str,
                "list": daily_data
            })
            
            current_date += delta
        
        res = {
            "success": True,
            "code": 200,
            "msg": '',
            "data": result
        }
        return make_response(res)
    except Exception as e:
        res = {
            "success": False,
            "code": 500,
            "msg": f"服务器内部错误: {str(e)}",
            "data": []
        }
        return make_response(res)