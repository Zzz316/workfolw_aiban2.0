from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
from icamera.tool.yaml_groupget import main_get
import json
import pandas as pd

# blueprint
scene_list_blueprint = Blueprint('scene_list', __name__, template_folder='templates')

# ==========================================
# 原有老接口 (兼容保留)
# ==========================================
@scene_list_blueprint.route('/camera_api/iot/camera/scene/list', methods=['GET'])
def scene_list():
    group_list = []
    sources_list = []
    infers_list = []

    group_sql = "SELECT * FROM icam_group_data"
    group_sql_df = db.select_db(group_sql)

    for a in range(len(group_sql_df)):
        groupid = group_sql_df['groupid'].values[a]
        groupname = group_sql_df['groupname'].values[a]
        groupenable = group_sql_df['groupenable'].values[a]
        metadatacount = group_sql_df['metadatacount'].values[a]
        propertydatacount = group_sql_df['propertydatacount'].values[a]
        deviceid = group_sql_df['deviceid'].values[a]
        devicememorylimit = group_sql_df['devicememorylimit'].values[a]
        averagebitrate = group_sql_df['averagebitrate'].values[a]
        maxbitrate = group_sql_df['maxbitrate'].values[a]
        captionfontsize = group_sql_df['captionfontsize'].values[a]
        captioncolor = group_sql_df['captioncolor'].values[a]

        sources_sql = "SELECT * FROM icam_sources_data where groupid = " + str(groupid) + ""
        sources_sql_df = db.select_db(sources_sql)

        for i in range(len(sources_sql_df)):
            config = sources_sql_df['sourcesid'].values[i]
            config_data = int(config)
            sources_list.append(config_data)

        infers_sql = "SELECT * FROM icam_infers_data where groupid = " + str(groupid) + ""
        infers_sql_df = db.select_db(infers_sql)

        for b in range(len(infers_sql_df)):
            modelid = infers_sql_df['modelid'].values[b]
            useroiimage = infers_sql_df['useroiimage'].values[b]
            savepropertyimage = infers_sql_df['savepropertyimage'].values[b]
            enable_data = infers_sql_df['enable'].values[b]
            bgcolor = infers_sql_df['bgcolor'].values[b]
            labelid = infers_sql_df['labelid'].values[b]
            drawperscent = infers_sql_df['drawperscent'].values[b]

            property_sql = "SELECT * FROM icam_property_data where groupid = " + str(groupid) + "&& modelid ='" + str(modelid) + "'"
            property_sql_df = db.select_db(property_sql)
            property_list = []

            for d in range(len(property_sql_df)):
                labeldata = property_sql_df['labelid'].values[d]
                orderid = property_sql_df['orderid'].values[d]

                property_data = str(labeldata)+':'+str(orderid)
                property_list.append(property_data)

            shadowing_data = {
                'enable': bool(enable_data == 'True'),
                'bgcolor': bgcolor,
                'labelid': labelid,
            }

            infers_data = {
                'modeid': int(modelid),
                'useroiimage': bool(useroiimage == 'True'),
                'savepropertyimage': bool(savepropertyimage == 'True'),
                'property': property_list,
                'shadowing': shadowing_data
            }
            infers_list.append(infers_data)

        grouparrary = {
            'groupid': int(groupid),
            'groupname': groupname,
            'groupenable': bool(groupenable == 'True'),
            'metadatacount': int(metadatacount),
            'propertydatacount': int(propertydatacount),
            'deviceid': int(deviceid),
            'devicememorylimit': str(devicememorylimit),
            'averagebitrate': int(averagebitrate),
            'maxbitrate': int(maxbitrate),
            'captionfontsize': str(captionfontsize),
            'captioncolor': captioncolor,
            'Sources': sources_list,
            'Infers': infers_list,
        }

        group_list.append(grouparrary)
        property_list = []
        sources_list = []
        infers_list = []

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": group_list
    }
    return make_response(res)

@scene_list_blueprint.route('/camera_api/iot/camera/scene/add', methods=['POST'])
def scene_add():
    groupname = str(request.json.get('groupname'))
    groupenable = str(request.json.get('groupenable'))
    metadatacount = str(request.json.get('metadatacount'))
    propertydatacount = str(request.json.get('propertydatacount'))
    deviceid = str(request.json.get('deviceid'))
    devicememorylimit = str(request.json.get('devicememorylimit'))
    averagebitrate = str(request.json.get('averagebitrate'))
    maxbitrate = str(request.json.get('maxbitrate'))
    captionfontsize = str(request.json.get('captionfontsize'))
    captioncolor = str(request.json.get('captioncolor'))
    Infers = request.json.get('Infers')
    Sources = request.json.get('Sources')

    sql = "SELECT * FROM icam_group_data"
    df = db.select_db(sql)
    if df.empty:
        id = 1
        data = [id,groupname, groupenable, metadatacount, propertydatacount, deviceid,devicememorylimit,averagebitrate,maxbitrate,captionfontsize,captioncolor]
        SQL1 = f"Insert Into icamera_data.icam_group_data (groupid, groupname, groupenable,metadatacount, propertydatacount, deviceid,devicememorylimit,averagebitrate,maxbitrate,captionfontsize,captioncolor) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}','{data[4]}','{data[5]}','{data[6]}','{data[7]}','{data[8]}','{data[9]}','{data[10]}');"
        db.execute_db(SQL1)
        for i in range(len(Infers)):
            modelid = Infers[i]['modelid']
            useroiimage = Infers[i]['useroiimage']
            savepropertyimage = Infers[i]['savepropertyimage']
            enable = Infers[i]['enable']
            data = [id, modelid, useroiimage, savepropertyimage]
            SQL2 = f"Insert Into icamera_data.icam_infers_data (groupid, modelid, useroiimage,savepropertyimage) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}');"
            db.execute_db(SQL2)
            property = Infers[i]['property']
            for i in range(len(property)):
                labelid = property[i][0:1]
                orderid = property[i][2:]
                data = [id, modelid, labelid, orderid]
                SQL3= f"Insert Into icamera_data.icam_property_data (groupid, modelid, labelid, orderid) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}');"
                db.execute_db(SQL3)
        for i in range(len(Sources)):
            sourcesid = Sources[i]
            data = [id, sourcesid]
            SQL4 = f"Insert Into icamera_data.icam_sources_data (groupid, sourcesid) Values ('{data[0]}','{data[1]}');"
            db.execute_db(SQL4)
    else:
        id = len(df) + 1
        data = [id, groupname, groupenable, metadatacount, propertydatacount, deviceid, devicememorylimit,captionfontsize, captioncolor]
        SQL1 = f"Insert Into icamera_data.icam_group_data (groupid, groupname, groupenable, metadatacount, propertydatacount, deviceid, devicememorylimit, captionfontsize, captioncolor) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}','{data[4]}','{data[5]}','{data[6]}','{data[7]}','{data[8]}');"
        db.execute_db(SQL1)
        for i in range(len(Infers)):
            modelid = Infers[i]['modeid']
            useroiimage = Infers[i]['useroiimage']
            savepropertyimage = Infers[i]['savepropertyimage']
            data = [id, modelid, useroiimage, savepropertyimage]
            SQL2 = f"Insert Into icamera_data.icam_infers_data (groupid, modelid, useroiimage, savepropertyimage) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}');"
            db.execute_db(SQL2)
            property = Infers[i]['property']
            for i in range(len(property)):
                labelid = property[i][0:1]
                orderid = property[i][2:]
                data = [id, modelid, labelid, orderid]
                SQL3 = f"Insert Into icamera_data.icam_property_data (groupid, modelid, labelid, orderid) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}');"
                db.execute_db(SQL3)
        for i in range(len(Sources)):
            sourcesid = Sources[i]
            data = [id, sourcesid]
            SQL4 = f"Insert Into icamera_data.icam_sources_data (groupid, sourcesid) Values ('{data[0]}','{data[1]}');"
            db.execute_db(SQL4)

    main_get()

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":True
    }
    return make_response(res)

@scene_list_blueprint.route('/camera_api/iot/camera/scene/del', methods=['POST'])
def scene_del():
    id = request.json.get('groupid')

    group_del = "DELETE FROM icam_group_data WHERE groupid='" + str(id) + "'"
    db.execute_db(group_del)
    sources_del = "DELETE FROM icam_sources_data WHERE groupid='" + str(id) + "'"
    db.execute_db(sources_del)
    infers_del = "DELETE FROM icam_infers_data WHERE groupid='" + str(id) + "'"
    db.execute_db(infers_del)
    property_del = "DELETE FROM icam_property_data WHERE groupid='" + str(id) + "'"
    db.execute_db(property_del)

    main_get()

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

@scene_list_blueprint.route('/camera_api/iot/camera/scene/edit', methods=['POST'])
def cam_edit():
    id = str(request.json.get('groupid'))
    groupname = str(request.json.get('groupname'))
    groupenable = str(request.json.get('groupenable'))
    metadatacount = str(request.json.get('metadatacount'))
    propertydatacount = str(request.json.get('propertydatacount'))
    deviceid = str(request.json.get('deviceid'))
    devicememorylimit = str(request.json.get('devicememorylimit'))
    averagebitrate = str(request.json.get('averagebitrate'))
    maxbitrate = str(request.json.get('maxbitrate'))
    captionfontsize = str(request.json.get('captionfontsize'))
    captioncolor = str(request.json.get('captioncolor'))
    Infers = request.json.get('Infers')
    Sources = request.json.get('Sources')

    group_del = "DELETE FROM icam_group_data WHERE groupid='" + id + "'"
    db.execute_db(group_del)
    sources_del = "DELETE FROM icam_sources_data WHERE groupid='" + id + "'"
    db.execute_db(sources_del)
    infers_del = "DELETE FROM icam_infers_data WHERE groupid='" + id + "'"
    db.execute_db(infers_del)
    property_del = "DELETE FROM icam_property_data WHERE groupid='" + id + "'"
    db.execute_db(property_del)

    data = [id, groupname, groupenable, metadatacount, propertydatacount, deviceid, devicememorylimit, averagebitrate,maxbitrate, captionfontsize, captioncolor]
    SQL1 = f"Insert Into icamera_data.icam_group_data (groupid, groupname, groupenable,metadatacount, propertydatacount, deviceid,devicememorylimit,averagebitrate,maxbitrate,captionfontsize,captioncolor) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}','{data[4]}','{data[5]}','{data[6]}','{data[7]}','{data[8]}','{data[9]}','{data[10]}');"
    db.execute_db(SQL1)
    for i in range(len(Infers)):
        modelid = Infers[i]['modeid']
        useroiimage = Infers[i]['useroiimage']
        savepropertyimage = Infers[i]['savepropertyimage']
        data = [id, modelid, useroiimage, savepropertyimage]
        SQL2 = f"Insert Into icamera_data.icam_infers_data (groupid, modelid, useroiimage, savepropertyimage) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}');"
        db.execute_db(SQL2)
        property = Infers[i]['property']
        for i in range(len(property)):
            labelid = property[i][0:1]
            orderid = property[i][2:]
            data = [id, modelid, labelid, orderid]
            SQL3 = f"Insert Into icamera_data.icam_property_data (groupid, modelid, labelid, orderid) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}');"
            db.execute_db(SQL3)
    for i in range(len(Sources)):
        sourcesid = Sources[i]
        data = [id, sourcesid]
        SQL4 = f"Insert Into icamera_data.icam_sources_data (groupid, sourcesid) Values ('{data[0]}','{data[1]}');"
        db.execute_db(SQL4)

    main_get()

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":True
    }
    return make_response(res)


# ==========================================
# 1. 3.0新版场景表初始化脚本
# ==========================================
def init_scene_new_table():
    """
    初始化创建新版场景表 icam_scene_new_data
    包含：基础配置、关联设备JSON、推理定时、报警定时、备注等全量字段
    """
    create_table_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.icam_scene_new_data (
        id INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
        scene_name VARCHAR(255) NOT NULL COMMENT '场景名称',
        scene_category VARCHAR(100) DEFAULT NULL COMMENT '场景分类',
        group_enable VARCHAR(20) DEFAULT 'True' COMMENT '组别启用状态(推理开关)',
        metadatacount INT DEFAULT 0 COMMENT '二次属性资源池',
        propertydatacount INT DEFAULT 0 COMMENT '场景资源数',
        deviceid INT DEFAULT 0 COMMENT '使用GPU ID',
        devicememorylimit VARCHAR(50) DEFAULT '0.5' COMMENT '内存占用百分比',
        averagebitrate INT DEFAULT 2000 COMMENT '平均码率',
        maxbitrate INT DEFAULT 4000 COMMENT '最大码率',
        captionfontsize VARCHAR(20) DEFAULT '10' COMMENT '字体尺寸',
        captioncolor VARCHAR(50) DEFAULT 'rgba(255,0,0,1)' COMMENT '字体颜色',
        
        -- ✨ 推理开关专属字段
        infer_timer VARCHAR(255) DEFAULT '00:00-23:59' COMMENT '推理定时时间段',
        
        -- ✨ 报警开关专属字段
        alarm_timer VARCHAR(255) DEFAULT '00:00-23:59' COMMENT '报警定时时间段',
        alarm_enable VARCHAR(20) DEFAULT 'True' COMMENT '报警开启状态',
        
        -- ✨ 公共辅助字段
        remark VARCHAR(500) DEFAULT '' COMMENT '场景备注',
        
        -- 核心数据字段 (JSON存储列表)
        camera_ids TEXT DEFAULT NULL COMMENT '关联摄像头ID列表(JSON)',
        hardware_ids TEXT DEFAULT NULL COMMENT '关联硬件ID列表(JSON)',
        infers TEXT DEFAULT NULL COMMENT '关联模型配置(深层JSON)',
        
        -- 界面展示辅助字段
        camera_names VARCHAR(1000) DEFAULT '' COMMENT '关联摄像头名称展示',
        hardware_names VARCHAR(1000) DEFAULT '' COMMENT '关联硬件名称展示',
        
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='新版场景配置表';
    """
    try:
        db.execute_db(create_table_sql)
        print("====== 表 icam_scene_new_data 初始化检查/创建成功（已包含推理/报警双链路定时） ======")
    except Exception as e:
        print(f"====== 初始化表 icam_scene_new_data 失败: {e} ======")

# 蓝图加载时立即执行一次初始化
init_scene_new_table()

# ==========================================
# 2. 新版场景保存/编辑接口
# ==========================================
@scene_list_blueprint.route('/camera_api/iot/camera/scene/newSave', methods=['POST'])
def scene_new_save():
    try:
        req = request.json
        scene_id = req.get('id')  
        
        # 1. 提取基础参数
        scene_name = str(req.get('scene_name', ''))
        scene_category = str(req.get('scene_category', ''))
        group_enable = str(req.get('group_enable', 'True'))
        metadatacount = int(req.get('metadatacount', 200))
        propertydatacount = int(req.get('propertydatacount', 0))
        deviceid = int(req.get('deviceid', 0))
        devicememorylimit = str(req.get('devicememorylimit', '0.5'))
        averagebitrate = int(req.get('averagebitrate', 2000))
        maxbitrate = int(req.get('maxbitrate', 4000))
        captionfontsize = str(req.get('captionfontsize', '10'))
        captioncolor = str(req.get('captioncolor', 'rgba(255,0,0,1)'))
        
        # ✨ 新增：推理定时 & 备注
        infer_timer = str(req.get('infer_timer', '00:00-23:59'))
        remark = str(req.get('remark', ''))

        camera_names = str(req.get('camera_names', ''))
        hardware_names = str(req.get('hardware_names', ''))

        # 2. 序列化 JSON 关联数据
        camera_ids_json = json.dumps(req.get('camera_ids', []), ensure_ascii=False)
        hardware_ids_json = json.dumps(req.get('hardware_ids', []), ensure_ascii=False)
        infers_json = json.dumps(req.get('Infers', []), ensure_ascii=False)

        if not scene_name:
            return make_response({"success": False, "code": 400, "msg": "场景名称不能为空"})

        if scene_id:
            # ============ 编辑模式 ============
            sql = """
                UPDATE icamera_data.icam_scene_new_data 
                SET scene_name=%s, scene_category=%s, group_enable=%s, 
                    metadatacount=%s, propertydatacount=%s, deviceid=%s, 
                    devicememorylimit=%s, averagebitrate=%s, maxbitrate=%s, 
                    captionfontsize=%s, captioncolor=%s, 
                    infer_timer=%s, remark=%s,
                    camera_ids=%s, hardware_ids=%s, infers=%s,
                    camera_names=%s, hardware_names=%s
                WHERE id=%s
            """
            params = (scene_name, scene_category, group_enable, 
                      metadatacount, propertydatacount, deviceid, 
                      devicememorylimit, averagebitrate, maxbitrate, 
                      captionfontsize, captioncolor, 
                      infer_timer, remark,
                      camera_ids_json, hardware_ids_json, infers_json,
                      camera_names, hardware_names, scene_id)
        else:
            # ============ 新增模式 ============
            sql = """
                INSERT INTO icamera_data.icam_scene_new_data 
                (scene_name, scene_category, group_enable, metadatacount, 
                 propertydatacount, deviceid, devicememorylimit, averagebitrate, 
                 maxbitrate, captionfontsize, captioncolor, infer_timer, remark,
                 camera_ids, hardware_ids, infers, camera_names, hardware_names)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """
            params = (scene_name, scene_category, group_enable, metadatacount, 
                      propertydatacount, deviceid, devicememorylimit, averagebitrate, 
                      maxbitrate, captionfontsize, captioncolor, infer_timer, remark,
                      camera_ids_json, hardware_ids_json, infers_json,
                      camera_names, hardware_names)

        db.execute_db(sql, params)

        main_get()

        return make_response({"success": True, "code": 200, "msg": "场景保存成功", "data": True})

    except Exception as e:
        print(f"Error saving scene: {e}")
        return make_response({"success": False, "code": 500, "msg": str(e)})
        
# ==========================================
# 3. 新版场景分页列表接口
# ==========================================
@scene_list_blueprint.route('/camera_api/iot/camera/scene/newListPage', methods=['GET'])
def scene_new_list():
    try:
        page_num = int(request.args.get('pageNum', 1))
        page_size = int(request.args.get('pageSize', 15))
        scene_name = request.args.get('scene_name', '')
        category = request.args.get('scene_category', '')

        sql = "SELECT * FROM icamera_data.icam_scene_new_data WHERE 1=1"
        if scene_name:
            sql += f" AND scene_name LIKE '%%{scene_name}%%'"
        if category:
            sql += f" AND scene_category = '{category}'"
        
        sql += " ORDER BY id DESC"
        df = db.select_db(sql)

        if df is None or df.empty:
            return make_response({"success": True, "code": 200, "data": {"list": [], "total": 0}})

        all_scenes = df.to_dict('records')
        for scene in all_scenes:
            scene['camera_ids'] = json.loads(scene['camera_ids']) if scene['camera_ids'] else []
            scene['hardware_ids'] = json.loads(scene['hardware_ids']) if scene['hardware_ids'] else []
            scene['Infers'] = json.loads(scene['infers']) if scene['infers'] else []
            scene['group_enable'] = (scene['group_enable'] == 'True')

        total = len(all_scenes)
        start = (page_num - 1) * page_size
        paginated_data = all_scenes[start : start + page_size]

        return make_response({
            "success": True, 
            "code": 200, 
            "data": {
                "list": paginated_data, 
                "total": total
            }
        })
    except Exception as e:
        return make_response({"success": False, "code": 500, "msg": str(e)})

# ==========================================
# 4. 新版场景删除接口
# ==========================================
@scene_list_blueprint.route('/camera_api/iot/camera/scene/newDel', methods=['POST'])
def scene_new_del():
    scene_id = request.json.get('id')
    if not scene_id:
        return make_response({"success": False, "code": 400, "msg": "缺少场景ID"})

    sql = f"DELETE FROM icamera_data.icam_scene_new_data WHERE id='{scene_id}'"
    db.execute_db(sql)

    main_get()

    return make_response({"success": True, "code": 200, "msg": "场景删除成功", "data": True})

# ==========================================
# ✨ 5. 新增：推理开关独立业务接口
# ==========================================
@scene_list_blueprint.route('/camera_api/iot/camera/infer_switch/list', methods=['GET'])
def get_infer_switch_list():
    """获取推理开关精简列表"""
    # ✨ 核心：SQL 里把 scene_category 查出来
    sql = "SELECT id, scene_name, scene_category, infer_timer, remark, group_enable FROM icamera_data.icam_scene_new_data ORDER BY id DESC"
    df = db.select_db(sql)
    
    result_list = []
    if df is not None and not df.empty:
        for i in range(len(df)):
            result_list.append({
                "id": int(df['id'].values[i]),
                "scene_name": str(df['scene_name'].values[i] if pd.notna(df['scene_name'].values[i]) else ''),
                "scene_category": str(df['scene_category'].values[i] if pd.notna(df['scene_category'].values[i]) else ''), # ✨ 恢复分类字段
                "infer_timer": str(df['infer_timer'].values[i] if pd.notna(df['infer_timer'].values[i]) else '00:00-23:59'),
                "remark": str(df['remark'].values[i] if pd.notna(df['remark'].values[i]) else ''),
                "group_enable": bool(str(df['group_enable'].values[i]) == 'True' or df['group_enable'].values[i] == 1)
            })

    res = {
        "success": True,
        "code": 200,
        "msg": "获取成功",
        "data": result_list
    }
    return make_response(res)

@scene_list_blueprint.route('/camera_api/iot/camera/infer_switch/edit', methods=['POST'])
def edit_infer_switch():
    """
    修改定時配置或手動切換開關狀態，並保存備註
    """
    req = request.json
    scene_id = str(req.get('id', ''))
    infer_timer = req.get('infer_timer')
    group_enable = req.get('group_enable') # boolean
    remark = req.get('remark') # ✨ 新增：接住前端傳來的備註欄位
    
    if not scene_id:
        return make_response({"success": False, "code": 400, "msg": "缺少場景ID"})

    update_parts = []
    
    # 這裡改成 is not None 判斷，這樣就算傳入空字串（清空定時），也能正確更新
    if infer_timer is not None:
        update_parts.append(f"infer_timer = '{str(infer_timer)}'")
        
    # ✨ 新增：將備註拼接到 UPDATE 語句中
    if remark is not None:
        update_parts.append(f"remark = '{str(remark)}'")
    
    if group_enable is not None:
        enable_val = "True" if group_enable else "False"
        update_parts.append(f"group_enable = '{enable_val}'")
        
    if update_parts:
        update_sql = f"UPDATE icamera_data.icam_scene_new_data SET {', '.join(update_parts)} WHERE id = '{scene_id}'"
        db.execute_db(update_sql)
        
        main_get()

    return make_response({"success": True, "code": 200, "msg": "修改成功", "data": True})

# ==========================================
# ✨ 报警开关独立业务接口
# ==========================================
@scene_list_blueprint.route('/camera_api/iot/camera/alarm_switch/list', methods=['GET'])
def get_alarm_switch_list():
    """获取报警开关精简列表"""
    sql = "SELECT id, scene_name, scene_category, alarm_timer, remark, alarm_enable FROM icamera_data.icam_scene_new_data ORDER BY id DESC"
    df = db.select_db(sql)
    
    result_list = []
    if df is not None and not df.empty:
        for i in range(len(df)):
            result_list.append({
                "id": int(df['id'].values[i]),
                "scene_name": str(df['scene_name'].values[i] if pd.notna(df['scene_name'].values[i]) else ''),
                "scene_category": str(df['scene_category'].values[i] if pd.notna(df['scene_category'].values[i]) else ''),
                "alarm_timer": str(df['alarm_timer'].values[i] if pd.notna(df['alarm_timer'].values[i]) else '00:00-23:59'),
                "remark": str(df['remark'].values[i] if pd.notna(df['remark'].values[i]) else ''),
                "alarm_enable": bool(str(df['alarm_enable'].values[i]).strip().lower() == 'true' or df['alarm_enable'].values[i] == 1)
            })

    return make_response({"success": True, "code": 200, "msg": "获取成功", "data": result_list})

@scene_list_blueprint.route('/camera_api/iot/camera/alarm_switch/edit', methods=['POST'])
def edit_alarm_switch():
    """
    修改报警定时配置或手动切换报警开关状态
    """
    req = request.json
    scene_id = str(req.get('id', ''))
    alarm_timer = req.get('alarm_timer')
    alarm_enable = req.get('alarm_enable') # boolean
    remark = req.get('remark')
    
    if not scene_id:
        return make_response({"success": False, "code": 400, "msg": "缺少场景ID"})

    update_parts = []
    
    if alarm_timer is not None:
        update_parts.append(f"alarm_timer = '{str(alarm_timer)}'")
        
    if remark is not None:
        update_parts.append(f"remark = '{str(remark)}'")
    
    if alarm_enable is not None:
        enable_val = "True" if alarm_enable else "False"
        update_parts.append(f"alarm_enable = '{enable_val}'")
        
    if update_parts:
        update_sql = f"UPDATE icamera_data.icam_scene_new_data SET {', '.join(update_parts)} WHERE id = '{scene_id}'"
        db.execute_db(update_sql)
        # 注意：这里不需要调 main_get() 刷新 YAML！

    return make_response({"success": True, "code": 200, "msg": "修改成功", "data": True})

@scene_list_blueprint.route('/camera_api/iot/camera/scene/auth_list', methods=['GET'])
def auth_scene_list():
    """业务大屏专用：获取场景列表（保留所有场景，仅过滤场景内无权限的摄像头）"""
    try:
        # ================= 1. 获取当前用户权限 =================
        username = request.headers.get('Username')
        auth_camera_ids = set()

        if username and username != 'admin':
            sql_auth = f"""
                SELECT DISTINCT tc.camera_id 
                FROM icamera_data.icam_team_user tu
                JOIN icamera_data.icam_team_camera tc ON tu.team_id = tc.team_id
                WHERE tu.user_name = '{username}' OR tu.user_id = '{username}'
            """
            df_auth = db.select_db(sql_auth)
            if df_auth is not None and not df_auth.empty:
                # 统一转成字符串，方便后续比对
                auth_camera_ids = set([str(x) for x in df_auth['camera_id'].tolist()])
            # 注意：即使没有权限，也继续往下走，因为要返回空的场景骨架

        # ================= 2. 执行你原有的基础查询逻辑 =================
        page_num = int(request.args.get('pageNum', 1))
        page_size = int(request.args.get('pageSize', 100))
        scene_name = request.args.get('scene_name', '')
        category = request.args.get('scene_category', '')

        sql = "SELECT * FROM icamera_data.icam_scene_new_data WHERE 1=1"
        if scene_name:
            sql += f" AND scene_name LIKE '%%{scene_name}%%'"
        if category:
            sql += f" AND scene_category = '{category}'"
        
        sql += " ORDER BY id DESC"
        df = db.select_db(sql)

        if df is None or df.empty:
            return make_response({"success": True, "code": 200, "data": {"list": [], "total": 0}})

        all_scenes = df.to_dict('records')
        
        # ================= 3. 核心：在解析时注入权限过滤 =================
        for scene in all_scenes:
            # 解析你原本的字段
            raw_c_ids = json.loads(scene['camera_ids']) if scene['camera_ids'] else []
            scene['hardware_ids'] = json.loads(scene['hardware_ids']) if scene['hardware_ids'] else []
            scene['Infers'] = json.loads(scene['infers']) if scene['infers'] else []
            scene['group_enable'] = (str(scene['group_enable']) == 'True')

            # 解析 camera_names (假设数据库存的是逗号分隔的字符串)
            raw_c_names_str = str(scene.get('camera_names', ''))
            raw_c_names = [x.strip() for x in raw_c_names_str.split(',')] if raw_c_names_str and raw_c_names_str != 'nan' else []

            # 如果是超级管理员，直接赋予原解析数据，不做过滤
            if username == 'admin':
                scene['camera_ids'] = raw_c_ids
                # camera_names 保持原字符串即可，前端会处理
                continue

            # 开始权限过滤：只保留有权限的摄像头 ID 和对应的 Name
            valid_ids = []
            valid_names = []
            
            for idx, cid in enumerate(raw_c_ids):
                if str(cid) in auth_camera_ids:
                    valid_ids.append(cid)
                    # 避免名称数组长度不一致导致越界
                    if idx < len(raw_c_names):
                        valid_names.append(raw_c_names[idx])
            
            # 将过滤后的干净数据塞回 scene 字典
            scene['camera_ids'] = valid_ids
            scene['camera_names'] = ",".join(valid_names)

        # ================= 4. 分页并返回 (你原有的逻辑) =================
        total = len(all_scenes)
        start = (page_num - 1) * page_size
        paginated_data = all_scenes[start : start + page_size]

        return make_response({
            "success": True, 
            "code": 200, 
            "data": {
                "list": paginated_data, 
                "total": total
            }
        })
    except Exception as e:
        return make_response({"success": False, "code": 500, "msg": str(e)})