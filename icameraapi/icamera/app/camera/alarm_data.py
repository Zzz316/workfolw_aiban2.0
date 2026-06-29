from flask import make_response, request, Blueprint
from icamera.tool.alarmname import alarmname # 保留原有引用，不破坏老逻辑
from icamera.common.mysql_operate import db
import math

alarm_data_blueprint = Blueprint('alarm_data', __name__, template_folder='templates')

# ================= 原有接口保留 =================
@alarm_data_blueprint.route('/camera_api/iot/camera/get-alarm', methods=['GET'])
def get_alarm():
    real_alarmname = alarmname(1)
    res = {
        "success": True,
        "code": 47,  # 尊重老代码状态码
        "msg": "",
        "data": real_alarmname
    }
    return make_response(res)


# ================= 新增：分页+条件查询接口 =================
@alarm_data_blueprint.route('/camera_api/iot/camera/alarm/page', methods=['POST'])
def get_alarm_page():
    req_data = request.json or {}
    page_num = int(req_data.get('pageNum', 1))
    page_size = int(req_data.get('pageSize', 15))
    search_name = req_data.get('alarmname', '').strip()

    # 1. 构造条件
    where_clause = ""
    if search_name:
        where_clause = f" WHERE alarmname LIKE '%{search_name}%'"

    # 2. 查询总数
    count_sql = f"SELECT COUNT(1) as total FROM icam_alarmname_data{where_clause}"
    df_count = db.select_db(count_sql)
    total = int(df_count['total'].values[0]) if not df_count.empty else 0

    # 3. 分页查询数据
    offset = (page_num - 1) * page_size
    data_sql = f"SELECT id, alarmname FROM icam_alarmname_data{where_clause} ORDER BY id DESC LIMIT {page_size} OFFSET {offset}"
    df_data = db.select_db(data_sql)

    # 4. 组装返回列表
    data_list = []
    if not df_data.empty:
        for i in range(len(df_data)):
            data_list.append({
                "id": int(df_data['id'].values[i]),
                "alarmname": str(df_data['alarmname'].values[i])
            })

    res = {
        "success": True,
        "code": 200,
        "msg": "查询成功",
        "data": {
            "list": data_list,
            "total": total,
            "pageNum": page_num,
            "pageSize": page_size
        }
    }
    return make_response(res)


# ================= 优化：新增、编辑、删除 =================
@alarm_data_blueprint.route('/camera_api/iot/camera/alarm/add', methods=['POST'])
def alarm_add():
    alarm_name = request.json.get('alarmname', '')

    if not alarm_name:
        return make_response({"success": False, "code": 400, "msg": "报警器名称不能为空"})

    # 优化：不要用 len(df)+1，会引发主键冲突。改用 MAX(id) + 1，或直接依赖数据库自增(AUTO_INCREMENT)
    # 这里保守起见，兼容老表结构没有设置自增的情况，用 MAX(id) 计算
    max_id_sql = "SELECT MAX(id) as max_id FROM icam_alarmname_data"
    df_max = db.select_db(max_id_sql)
    
    new_id = 1
    if not df_max.empty and not math.isnan(df_max['max_id'].values[0]):
        new_id = int(df_max['max_id'].values[0]) + 1

    insert_sql = f"INSERT INTO icamera_data.icam_alarmname_data (id, alarmname) VALUES ('{new_id}', '{alarm_name}');"
    db.execute_db(insert_sql)

    res = {
        "success": True,
        "code": 200,
        "msg": "新增成功",
        "data": True
    }
    return make_response(res)


@alarm_data_blueprint.route('/camera_api/iot/camera/alarm/edit', methods=['POST'])
def alarm_edit():
    req_id = str(request.json.get('id', ''))
    alarm_name = request.json.get('alarmname', '')

    if not req_id or not alarm_name:
        return make_response({"success": False, "code": 400, "msg": "参数缺失"})

    update_sql = f"UPDATE icam_alarmname_data SET alarmname = '{alarm_name}' WHERE id = '{req_id}'"
    db.execute_db(update_sql)

    res = {
        "success": True,
        "code": 200,
        "msg": "更新成功",
        "data": True
    }
    return make_response(res)


@alarm_data_blueprint.route('/camera_api/iot/camera/alarm/del', methods=['POST'])
def alarm_del():
    req_id = str(request.json.get('id', ''))
    
    if not req_id:
        return make_response({"success": False, "code": 400, "msg": "缺失ID"})

    delete_sql = f"DELETE FROM icam_alarmname_data WHERE id = '{req_id}'"
    db.execute_db(delete_sql)

    res = {
        "success": True,
        "code": 200,
        "msg": "删除成功",
        "data": True
    }
    return make_response(res)

# ==========================================================
# ---------- 以下为新版报警器接口 (关联树形区域) ----------
# ==========================================================

def init_new_alarm_table():
    """
    初始化创建新版报警器表 icam_alarm_new_data
    (字段与摄像头表保持完全一致)
    """
    create_table_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.icam_alarm_new_data (
        id INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
        area_id INT NOT NULL COMMENT '关联的区域树节点ID',
        alarm_name VARCHAR(255) NOT NULL COMMENT '报警器名称',
        model_name VARCHAR(255) DEFAULT NULL COMMENT '模型',
        ip_address VARCHAR(100) DEFAULT NULL COMMENT 'IP地址',
        port VARCHAR(20) DEFAULT '554' COMMENT '端口号',
        connection_path VARCHAR(255) DEFAULT NULL COMMENT '连接路径',
        account_name VARCHAR(100) DEFAULT NULL COMMENT '账户名称',
        account_password VARCHAR(255) DEFAULT NULL COMMENT '账户密码',
        stream_fps VARCHAR(20) DEFAULT '20' COMMENT '拉流帧率',
        stream_cache VARCHAR(20) DEFAULT '20' COMMENT '拉流缓存',
        remark VARCHAR(500) DEFAULT NULL COMMENT '备注',
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='新版报警器信息表';
    """
    try:
        db.execute_db(create_table_sql)
        print("====== 表 icam_alarm_new_data 初始化检查/创建成功 ======")
    except Exception as e:
        print(f"====== 初始化表 icam_alarm_new_data 失败: {e} ======")

# 蓝图加载时立即执行一次初始化
init_new_alarm_table()

# ================= 辅助函数：处理区域树与设备关联逻辑 =================
# (注意：如果你的 alarm 文件和 camera 文件不在同一个蓝图里，这些辅助函数需要在这里再定义一遍以供调用)

def get_all_areas_dict_for_alarm():
    """获取所有区域数据，方便快速构建层级路径"""
    sql = "SELECT id, area_name, parent_id, level FROM icamera_data.icam_area_data"
    df = db.select_db(sql)
    if df.empty:
        return {}
    areas = df.to_dict('records')
    return {str(item['id']): item for item in areas}

def get_descendant_area_ids_for_alarm(target_id, all_areas_dict):
    """向下递归：获取某个节点及其所有子孙节点的 ID 列表"""
    descendants = [str(target_id)]
    for a_id, a_info in all_areas_dict.items():
        if str(a_info.get('parent_id')) == str(target_id):
            descendants.extend(get_descendant_area_ids_for_alarm(a_id, all_areas_dict))
    return list(set(descendants))

def get_ancestor_area_ids_for_alarm(target_id, all_areas_dict):
    """向上溯源：获取当前节点及其所有父级/祖父级节点的 ID 列表"""
    ancestors = []
    current_id = str(target_id)
    for _ in range(10): # 防止死循环
        if current_id not in all_areas_dict:
            break
        ancestors.append(current_id)
        parent_id = str(all_areas_dict[current_id].get('parent_id', '0'))
        if parent_id == '0' or parent_id == 'None':
            break
        current_id = parent_id
    return ancestors

def build_area_path_for_alarm(area_id, all_areas_dict):
    """根据节点ID，向上溯源构建出厂区、楼栋等名字"""
    path_info = {
        "level0_name": "", "level1_name": "", "level2_name": "", 
        "level3_name": "", "level4_name": ""
    }
    current_id = str(area_id)
    for _ in range(5):
        if current_id not in all_areas_dict:
            break
        node = all_areas_dict[current_id]
        level = int(node.get('level', 0))
        if 0 <= level <= 4:
            path_info[f"level{level}_name"] = node.get('area_name', '')
        
        parent_id = str(node.get('parent_id', '0'))
        if parent_id == '0' or parent_id == 'None':
            break
        current_id = parent_id
    return path_info

def update_area_alarm_ids(area_id, alarm_id, action="add"):
    """更新基础信息表里的 alarm_ids 字段 (保存真实ID)"""
    sql = f"SELECT id, alarm_ids FROM icamera_data.icam_area_basic_info WHERE area_id = '{area_id}'"
    df = db.select_db(sql)
    
    if df.empty:
        if action == "add":
            insert_sql = f"INSERT INTO icamera_data.icam_area_basic_info (area_id, alarm_ids) VALUES ('{area_id}', '{alarm_id}')"
            db.execute_db(insert_sql)
    else:
        existing = str(df.iloc[0]['alarm_ids'])
        alarm_list = []
        if existing and existing.strip() not in ['None', '', 'nan']:
            alarm_list = existing.split(',')
        
        alarm_id_str = str(alarm_id)
        modified = False
        
        if action == "add":
            if alarm_id_str not in alarm_list:
                alarm_list.append(alarm_id_str)
                modified = True
        elif action == "remove":
            if alarm_id_str in alarm_list:
                alarm_list.remove(alarm_id_str)
                modified = True
        
        if modified:
            new_alarms = ",".join(alarm_list)
            update_sql = f"UPDATE icamera_data.icam_area_basic_info SET alarm_ids='{new_alarms}' WHERE area_id='{area_id}'"
            db.execute_db(update_sql)


# ================= 新接口：分页查询报警器列表 =================
@alarm_data_blueprint.route('/camera_api/iot/camera/alarm/newPage', methods=['GET'])
def alarm_page():
    page_num = int(request.args.get('pageNum', 1))
    page_size = int(request.args.get('pageSize', 15))
    
    levels = [
        request.args.get('level0', ''),
        request.args.get('level1', ''),
        request.args.get('level2', ''),
        request.args.get('level3', ''),
        request.args.get('level4', '')
    ]
    
    target_area_id = None
    for i in range(4, -1, -1):
        if levels[i] and levels[i] != 'ALL':
            target_area_id = levels[i]
            break

    sql = "SELECT * FROM icamera_data.icam_alarm_new_data WHERE 1=1"
    all_areas = get_all_areas_dict_for_alarm()
    
    if target_area_id:
        descendant_ids = get_descendant_area_ids_for_alarm(target_area_id, all_areas)
        ids_str = ",".join([f"'{aid}'" for aid in descendant_ids])
        sql += f" AND area_id IN ({ids_str})"
        
    sql += " ORDER BY id DESC"
    df_alarms = db.select_db(sql)
    
    if df_alarms.empty:
        return make_response({"success": True, "code": 200, "msg": "", "data": {"list": [], "total": 0}})

    alarm_list = df_alarms.fillna('').to_dict('records')
    for alarm in alarm_list:
        area_id = alarm.get('area_id')
        path_info = build_area_path_for_alarm(area_id, all_areas)
        alarm.update(path_info)

    total = len(alarm_list)
    start_idx = (page_num - 1) * page_size
    end_idx = start_idx + page_size
    paginated_list = alarm_list[start_idx:end_idx]

    res = {
        "success": True,
        "code": 200,
        "msg": "查询成功",
        "data": {
            "list": paginated_list,
            "total": total
        }
    }
    return make_response(res)


# ================= 新接口：新增/编辑报警器 =================
@alarm_data_blueprint.route('/camera_api/iot/camera/alarm/newSave', methods=['POST'])
def alarm_save():
    req = request.json
    alarm_id = req.get('id', '')
    area_id = str(req.get('area_id', ''))
    alarm_name = str(req.get('alarm_name', ''))
    model_name = str(req.get('model_name', ''))
    ip_address = str(req.get('ip_address', ''))
    port = str(req.get('port', '554'))
    connection_path = str(req.get('connection_path', ''))
    account_name = str(req.get('account_name', ''))
    account_password = str(req.get('account_password', ''))
    stream_fps = str(req.get('stream_fps', '20'))
    stream_cache = str(req.get('stream_cache', '20'))
    remark = str(req.get('remark', ''))

    if not area_id or not alarm_name:
        return make_response({"success": False, "code": 400, "msg": "区域和报警器名称不能为空"})

    all_areas = get_all_areas_dict_for_alarm()

    if alarm_id:
        # ============ 编辑 ============
        old_sql = f"SELECT area_id FROM icamera_data.icam_alarm_new_data WHERE id='{alarm_id}'"
        df_old = db.select_db(old_sql)
        old_area_id = str(df_old.iloc[0]['area_id']) if not df_old.empty else None

        update_sql = f"""
            UPDATE icamera_data.icam_alarm_new_data 
            SET area_id='{area_id}', alarm_name='{alarm_name}', model_name='{model_name}', 
                ip_address='{ip_address}', port='{port}', connection_path='{connection_path}', 
                account_name='{account_name}', account_password='{account_password}', 
                stream_fps='{stream_fps}', stream_cache='{stream_cache}', remark='{remark}'
            WHERE id='{alarm_id}'
        """
        db.execute_db(update_sql)

        # 区域发生改变，联动修改所有长辈的 alarm_ids
        if old_area_id and old_area_id != area_id:
            old_ancestors = get_ancestor_area_ids_for_alarm(old_area_id, all_areas)
            for anc_id in old_ancestors:
                update_area_alarm_ids(anc_id, alarm_id, action="remove")
            
            new_ancestors = get_ancestor_area_ids_for_alarm(area_id, all_areas)
            for anc_id in new_ancestors:
                update_area_alarm_ids(anc_id, alarm_id, action="add")

    else:
        # ============ 新增 ============
        insert_sql = f"""
            INSERT INTO icamera_data.icam_alarm_new_data 
            (area_id, alarm_name, model_name, ip_address, port, connection_path, 
             account_name, account_password, stream_fps, stream_cache, remark) 
            VALUES 
            ('{area_id}', '{alarm_name}', '{model_name}', '{ip_address}', '{port}', '{connection_path}', 
             '{account_name}', '{account_password}', '{stream_fps}', '{stream_cache}', '{remark}')
        """
        db.execute_db(insert_sql)
        
        # 获取刚插入的ID
        fetch_id_sql = f"SELECT id FROM icamera_data.icam_alarm_new_data WHERE area_id='{area_id}' AND alarm_name='{alarm_name}' ORDER BY id DESC LIMIT 1"
        df_new_id = db.select_db(fetch_id_sql)
        
        if not df_new_id.empty:
            new_alarm_id = str(df_new_id.iloc[0]['id'])
            # 向上溯源，追加ID
            new_ancestors = get_ancestor_area_ids_for_alarm(area_id, all_areas)
            for anc_id in new_ancestors:
                update_area_alarm_ids(anc_id, new_alarm_id, action="add")

    return make_response({"success": True, "code": 200, "msg": "保存成功", "data": True})


# ================= 新接口：删除报警器 =================
@alarm_data_blueprint.route('/camera_api/iot/camera/alarm/newDel', methods=['POST'])
def alarm_delete():
    alarm_id = str(request.json.get('id', ''))
    if not alarm_id:
        return make_response({"success": False, "code": 400, "msg": "缺少ID"})

    check_sql = f"SELECT area_id FROM icamera_data.icam_alarm_new_data WHERE id='{alarm_id}'"
    df_alarm = db.select_db(check_sql)
    
    if not df_alarm.empty:
        area_id = str(df_alarm.iloc[0]['area_id'])
        
        # 1. 主表删除
        del_sql = f"DELETE FROM icamera_data.icam_alarm_new_data WHERE id='{alarm_id}'"
        db.execute_db(del_sql)
        
        # 2. 向上溯源，从基础信息表中移除ID
        all_areas = get_all_areas_dict_for_alarm()
        ancestors = get_ancestor_area_ids_for_alarm(area_id, all_areas)
        
        for anc_id in ancestors:
            update_area_alarm_ids(anc_id, alarm_id, action="remove")

    return make_response({"success": True, "code": 200, "msg": "删除成功", "data": True})