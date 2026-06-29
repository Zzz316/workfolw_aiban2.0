from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
from icamera.tool.alarmname import alarmname
from icamera.tool.regionname import regionname
import pandas as pd # 确保引入了 pandas 库处理空值

#blueprin
monitor_blueprint = Blueprint('monitor', __name__,template_folder='templates')

#route
@monitor_blueprint.route('/camera_api/iot/camera/camera_filtering', methods=['GET'])
def camera_filtering():
    list = []
    cam_list = []
    alarmid = request.args.get('alarmid').split(",")

    for i in range(len(alarmid)):
        sql = "SELECT * FROM icam_camera_data where areas='" + alarmid[i] + "'"
        df = db.select_db(sql)
        for a in range(len(df)):
            id = int(df['id'][a])
            name = df['name'][a]
            camlist = {"id": id,"name": name}
            cam_list.append(camlist)
        alarmlist = {"alarmid": id, "cam": cam_list}
        list.append(alarmlist)

    res = {
        'success': False,
        'code': 47,
        'data': list
    }
    return make_response(res)

@monitor_blueprint.route('/camera_api/iot/camera/get-real-imaging', methods=['GET'])
def real_live():
    url_list = []
    id = request.args.get('id').split(",")

    for i in range(len(id)):
        sql = "SELECT * FROM icam_camera_data where id='" + id[i] + "'"
        df = db.select_db(sql)
        streaming = df['streaming'].values[0]
        urllist = {"url": streaming}
        url_list.append(urllist)
        del df

    res = {
        'success': False,
        'code': 200,
        'data': url_list,
        'msg': '获取成功'
    }
    return make_response(res)

# ==========================================================
# ---------- 新版獲取實時畫面接口 (查詢新表 icam_camera_new_data) ----------
# ==========================================================

@monitor_blueprint.route('/camera_api/iot/camera/get-new-real-imaging', methods=['GET'])
def new_real_live():
    """
    新版接口：根據攝像頭 ID 獲取實時流地址
    支持批量查詢（ID 以逗號分隔）
    """
    url_list = []
    
    # 1. 獲取前端傳過來的 ID 參數
    id_param = request.args.get('id', '')
    
    if not id_param:
        return make_response({
            'success': False,
            'code': 400,
            'data': [],
            'msg': '缺少攝像頭 ID 參數'
        })

    # 2. 處理逗號分隔的 ID 列表
    ids = [i.strip() for i in id_param.split(",") if i.strip()]

    for cam_id in ids:
        # ✨ 關鍵：查詢新表 icam_camera_new_data，獲取 streaming 字段
        sql = f"SELECT streaming FROM icamera_data.icam_camera_new_data WHERE id = '{cam_id}'"
        df = db.select_db(sql)
        
        # 容錯判斷：確保查詢結果不為 None 且有數據
        if df is not None and not df.empty:
            # 獲取流地址並轉為字符串，處理可能的空值
            import pandas as pd
            raw_streaming = df['streaming'].values[0]
            streaming_url = str(raw_streaming) if pd.notna(raw_streaming) else ""
            url_list.append({"url": streaming_url})
        else:
            # 如果數據庫中找不到該 ID，返回空地址，保證順序對應
            url_list.append({"url": ""})
            
        # 釋放資源
        del df

    # 3. 組裝返回值（格式與老接口保持一致）
    res = {
        'success': True, # 修正老接口的 False 邏輯
        'code': 200,
        'data': url_list,
        'msg': '獲取成功'
    }
    return make_response(res)

@monitor_blueprint.route('/camera_api/iot/camera/getnewImg', methods=['GET'])
def alarmimgnew():
    sql = "SELECT * FROM icam_alarm_data ORDER BY timedate DESC LIMIT 1"
    df = db.select_db(sql)

    try:
        if df['alarm_content'].values[0]!= None or '':
            realregion = df['region'].values[0]
            realmatter = df['alarm_content'].values[0]
            imgpathlist = df['img_path'].values[0]
            id = df['camera_id'].values[0]
            sql1 = "SELECT * FROM icam_camera_data where id='" + str(id) + "'"
            df1 = db.select_db(sql1)
            streaming = df1['streaming'].values[0]

        res = {
            "success": True,
            "code": 0,
            "msg": realmatter,
            "area": realregion,
            "imgpath": imgpathlist,
            "streaming": streaming
        }
        return make_response(res)

    except Exception as ee:
        print('ee')

@monitor_blueprint.route('/camera_api/iot/camera/getvideo', methods=['GET'])
def getvideo():
    video_list = []
    id = request.args.get('id')

    sql = "SELECT * FROM icam_camera_data where id='" + id + "'"
    df = db.select_db(sql)
    streaming = df['streaming'].values[0]
    list = {"url": streaming}
    video_list.append(list)

    res = {
        'success': False,
        'code': 47,
        'data': video_list
    }
    return make_response(res)

@monitor_blueprint.route('/camera_api/iot/camera/filter_linkage', methods=['GET'])
def filter_linkage():
    alarm_list = []
    name = request.args.get('username')
    print(name)

    # 处理name为None的情况
    if not name:
        res = {
            "success": False,
            "code": 400,
            "msg": '用户名参数缺失',
            "data": []
        }
        return make_response(res)

    if name != 'admin' and name != 'minth_admin':
        sql = "SELECT * FROM icam_teams_data WHERE user LIKE '%" + name + "%'"
        df = db.select_db(sql)
        if df is not None and not df.empty:
            for i in range(len(df)):
                alarm_id = df['alarm'].values[i]
                alarm_list.append(alarm_id)

            alarmlist = sorted({int(num) for s in alarm_list for num in s.split(',')})
            numbers_str = "|".join(map(str, alarmlist))
            regex_pattern = f"(^|,)({numbers_str})(,|$)"

            cam_sql = f"""SELECT * FROM icam_camera_data WHERE alarmid REGEXP '{regex_pattern}';"""
            cam_df = db.select_db(cam_sql)
            if cam_df is not None and not cam_df.empty:
                table_data = cam_df.to_dict('records')

                grouped_data = {}
                for item in table_data:
                    area = item["areas"]
                    if area not in grouped_data:
                        grouped_data[area] = []

                    # 处理alarmid字段，转换为alarm列表
                    alarm_ids = []
                    if item["alarmid"]:
                        # 分割字符串并转换为整数列表
                        alarm_str_list = item["alarmid"].split(',')
                        for alarm_str in alarm_str_list:
                            if alarm_str.strip():  # 确保不是空字符串
                                alarm_ids.append({"id": int(alarm_str),"name":alarmname(0)[int(alarm_str)]})

                    # 构建cam对象
                    cam_obj = {
                        "id": item["id"],
                        "name": item["name"],
                        "alarm": alarm_ids
                    }
                    grouped_data[area].append(cam_obj)

                # 转换为目标格式
                result = []
                for area, cam_list in grouped_data.items():
                    result.append({
                        "id": area,
                        "name": regionname(0)[int(area)],
                        "cam": cam_list
                    })
            else:
                result = []
        else:
            result = []
    else:
        cam_sql = "SELECT * FROM icam_camera_data"
        cam_df = db.select_db(cam_sql)
        if cam_df is not None and not cam_df.empty:
            table_data = cam_df.to_dict('records')

            grouped_data = {}
            for item in table_data:
                area = item["areas"]
                if area not in grouped_data:
                    grouped_data[area] = []

                # 处理alarmid字段，转换为alarm列表
                alarm_ids = []
                if item["alarmid"]:
                    # 分割字符串并转换为整数列表
                    alarm_str_list = item["alarmid"].split(',')
                    for alarm_str in alarm_str_list:
                        if alarm_str.strip():  # 确保不是空字符串
                            alarm_ids.append({"id": int(alarm_str), "name": alarmname(0)[int(alarm_str)]})
                    print(alarm_ids)

                # 构建cam对象
                cam_obj = {
                    "id": item["id"],
                    "name": item["name"],
                    "alarm": alarm_ids
                }
                grouped_data[area].append(cam_obj)

            # 转换为目标格式
            result = []
            for area, cam_list in grouped_data.items():
                result.append({
                    "id": area,
                    "name": regionname(0)[int(area)],
                    "cam": cam_list
                })
        else:
            result = []

    print(result)
    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": result
    }
    return make_response(res)

@monitor_blueprint.route('/camera_api/iot/camera/gettree', methods=['GET'])
def get_camera_tree():
    # 1. 使用 LEFT JOIN 连表查询，一次性拿齐所需数据
    # c.areas 对应 P3 表的 id (返回 region 字段)
    # c.alarmid 对应 P4 表的 id (返回 alarmname 字段)
    sql = """
        SELECT 
            c.id AS cam_id, 
            c.name AS cam_name, 
            c.alarmid AS alarm_id, 
            a.alarmname AS alarm_name,
            c.areas AS region_id, 
            r.region AS region_name
        FROM icam_camera_data c
        LEFT JOIN icam_region_data r ON c.areas = r.id
        LEFT JOIN icam_alarmname_data a ON c.alarmid = a.id
        WHERE c.areas IS NOT NULL
    """
    
    df = db.select_db(sql)
    
    # 2. 组装树形结构
    regions_map = {}
    
    # 将 DataFrame 转换为字典列表以便遍历
    records = df.to_dict('records')
    
    for row in records:
        # 获取区域信息 (处理可能是 pandas 的 nan 或 None)
        region_id = str(row['region_id']) if pd.notna(row['region_id']) else "unknown"
        region_name = str(row['region_name']) if pd.notna(row['region_name']) else "未知区域"
        
        # 如果这个区域还没加到字典里，先初始化区域节点
        if region_id not in regions_map:
            regions_map[region_id] = {
                "id": region_id,      # P5中区域的id是字符串，例如 "1"
                "name": region_name,  # P5中区域的名称
                "cam": []
            }
            
        # 3. 处理告警数组 (alarm)
        alarm_list = []
        # 判断 alarmid 是否为空，不为空才往里面塞字典
        if pd.notna(row['alarm_id']) and str(row['alarm_id']).strip() != "":
            alarm_list.append({
                "id": int(row['alarm_id']),
                "name": str(row['alarm_name']) if pd.notna(row['alarm_name']) else ""
            })
            
        # 4. 组装摄像头节点 (cam)
        cam_node = {
            "id": int(row['cam_id']) if pd.notna(row['cam_id']) else 0, # P5中摄像头的id是数字
            "name": str(row['cam_name']) if pd.notna(row['cam_name']) else "",
            "alarm": alarm_list
        }
        
        # 5. 将该摄像头追加到对应的区域节点下
        regions_map[region_id]['cam'].append(cam_node)
        
    # 把字典的 values 取出来转换成 list，就是 P5 中 data 层需要的数组结构
    tree_data = list(regions_map.values())
    
    # 6. 返回结果
    res = {
        'success': True,
        'code': 200,
        'msg': '',
        'data': tree_data
    }
    
    return make_response(res)