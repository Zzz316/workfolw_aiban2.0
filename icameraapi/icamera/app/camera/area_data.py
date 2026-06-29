from flask import make_response, request, Blueprint
from icamera.tool.regionname import regionname
from icamera.common.mysql_operate import db
import pandas as pd

# blueprint
area_data_blueprint = Blueprint('area_data', __name__, template_folder='templates')

def init_area_table():
    """
    初始化创建新版树形区域表 icam_area_data
    如果表不存在则自动创建，如果已存在则跳过
    """
    create_table_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.icam_area_data (
        id INT NOT NULL COMMENT '主键ID',
        area_name VARCHAR(255) NOT NULL COMMENT '区域名称',
        parent_id INT DEFAULT 0 COMMENT '父节点ID，0代表最外层',
        level INT DEFAULT 1 COMMENT '层级，1代表最外层',
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='新版树形区域表';
    """
    try:
        db.execute_db(create_table_sql)
        print("====== 表 icam_area_data 初始化检查/创建成功 ======")
    except Exception as e:
        print(f"====== 初始化表 icam_area_data 失败: {e} ======")

def init_area_basic_info_table():
    """
    初始化创建：区域基础信息详情表 icam_area_basic_info
    用于记录原型图中的 基本信息 (负责人、部门、电话等) 以及绑定的设备ID
    """
    create_info_table_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.icam_area_basic_info (
        id INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
        area_id INT NOT NULL COMMENT '关联的区域树节点ID',
        department VARCHAR(100) DEFAULT NULL COMMENT '负责部门',
        manager_name VARCHAR(50) DEFAULT NULL COMMENT '负责人',
        phone_number VARCHAR(20) DEFAULT NULL COMMENT '手机号',
        email VARCHAR(100) DEFAULT NULL COMMENT '邮箱',
        description TEXT DEFAULT NULL COMMENT '区域描述',
        camera_ids TEXT DEFAULT NULL COMMENT '绑定的摄像头ID集合(逗号分隔或JSON)',
        alarm_ids TEXT DEFAULT NULL COMMENT '绑定的报警器ID集合(逗号分隔或JSON)',
        PRIMARY KEY (id),
        UNIQUE KEY uk_area_id (area_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='区域基础信息详情表';
    """
    # 如果你的表已经建好了，这段代码不会触发新增字段，你需要去数据库手动执行一下:
    # ALTER TABLE icamera_data.icam_area_basic_info ADD COLUMN camera_ids TEXT COMMENT '绑定的摄像头ID集合';
    # ALTER TABLE icamera_data.icam_area_basic_info ADD COLUMN alarm_ids TEXT COMMENT '绑定的报警器ID集合';
    try:
        db.execute_db(create_info_table_sql)
        print("====== 表 icam_area_basic_info 初始化检查/创建成功 ======")
    except Exception as e:
        print(f"====== 初始化表 icam_area_basic_info 失败: {e} ======")

# 在蓝图加载时立即执行一次初始化
init_area_table()
init_area_basic_info_table()

# route (保留原有老项目的接口)
@area_data_blueprint.route('/camera_api/iot/camera/get-areas', methods=['GET'])
def get_areas():
    real_regionname = regionname(1)
    res = {
        "success": True,
        "code": 47,
        "msg": "",
        "data": real_regionname
    }
    return make_response(res)

@area_data_blueprint.route('/camera_api/iot/camera/areas/add', methods=['POST'])
def areas_add():
    areasname = request.json.get('region')

    sql_areas = "SELECT * FROM icam_region_data"
    df_areas = db.select_db(sql_areas)
    if df_areas.empty:
        id = 1
        data = [id, areasname]
        SQL1 = f"Insert Into icamera_data.icam_region_data (id,region) Values ('{data[0]}','{data[1]}');"
        db.execute_db(SQL1)
    else:
        id = len(df_areas) + 1
        data = [id, areasname]
        SQL1 = f"Insert Into icamera_data.icam_region_data (id,region) Values ('{data[0]}','{data[1]}');"
        db.execute_db(SQL1)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

@area_data_blueprint.route('/camera_api/iot/camera/areas/edit', methods=['POST'])
def areas_edit():
    id = str(request.json.get('id'))
    region = request.json.get('region')

    sql = "update icam_region_data set region = '" + region + "' where id='" + id + "'"
    db.execute_db(sql)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

@area_data_blueprint.route('/camera_api/iot/camera/areas/del', methods=['POST'])
def areas_del():
    id = str(request.json.get('id'))

    sql = "DELETE FROM icam_region_data WHERE id='" + id + "'"
    db.execute_db(sql)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

# ==========================================
# 新项目接口 (icam_area_data 树形结构 & 详情)
# ==========================================

def build_tree(data_list, parent_id=0):
    """
    递归构建树形结构的方法
    :param data_list: 包含所有节点的列表 (List of Dicts)
    :param parent_id: 当前要寻找子节点的父节点ID
    :return: 树形结构列表
    """
    tree = []
    for item in data_list:
        # 匹配子节点
        if str(item.get('parent_id', '0')) == str(parent_id):
            # 递归寻找当前节点的子节点
            children = build_tree(data_list, item['id'])
            if children:
                item['children'] = children
            tree.append(item)
    return tree

@area_data_blueprint.route('/camera_api/iot/camera/new_areas/list', methods=['GET'])
def new_areas_list():
    """
    新接口：查询树形区域列表
    """
    sql = "SELECT id, area_name, parent_id, level FROM icamera_data.icam_area_data ORDER BY level ASC, id ASC;"
    df_areas = db.select_db(sql)
    
    if df_areas.empty:
        tree_data = []
    else:
        # 将 DataFrame 转换为 字典列表
        data_list = df_areas.to_dict('records')
        # 构建树形结构，默认根节点的 parent_id 为 0
        tree_data = build_tree(data_list, parent_id=0)

    res = {
        "success": True,
        "code": 200,
        "msg": "查询成功",
        "data": tree_data
    }
    return make_response(res)

@area_data_blueprint.route('/camera_api/iot/camera/new_areas/add', methods=['POST'])
def new_areas_add():
    """
    新接口：新增区域 (自动计算层级 0-4级，防主键冲突)
    """
    req_data = request.json
    area_name = req_data.get('area_name')
    # 默认 parent_id 为 0，代表最外层区域 (根节点)
    parent_id = req_data.get('parent_id', 0) 
    
    # ================= 1. 自动计算层级 (level) =================
    level = 0  # 默认最外层为 0 级
    if str(parent_id) != '0':
        # 如果不是根节点，查询父节点的 level
        sql_parent = f"SELECT level FROM icamera_data.icam_area_data WHERE id = '{parent_id}'"
        df_parent = db.select_db(sql_parent)
        
        if df_parent.empty:
            return make_response({"success": False, "code": 400, "msg": "父节点不存在", "data": None})
        
        # 子节点的层级 = 父节点层级 + 1
        parent_level = int(df_parent.iloc[0]['level'])
        level = parent_level + 1
        
        # 校验：限制最多只能到第4级（即0, 1, 2, 3, 4 共5级）
        if level > 4:
            return make_response({"success": False, "code": 400, "msg": "最多只支持5级区域配置", "data": None})

    # ================= 2. 生成新ID (防止删除导致的冲突) =================
    sql_max = "SELECT MAX(id) as max_id FROM icamera_data.icam_area_data"
    df_max = db.select_db(sql_max)
    
    # 处理 pandas 返回的空值情况 (表为空时 pd.isna 会捕捉到)
    if df_max.empty or pd.isna(df_max.iloc[0]['max_id']):
        new_id = 1
    else:
        new_id = int(df_max.iloc[0]['max_id']) + 1

    # ================= 3. 插入数据库 =================
    sql_insert = f"INSERT INTO icamera_data.icam_area_data (id, area_name, parent_id, level) VALUES ('{new_id}', '{area_name}', '{parent_id}', '{level}');"
    db.execute_db(sql_insert)

    res = {
        "success": True,
        "code": 200,
        "msg": '新增成功',
        "data": True
    }
    return make_response(res)

@area_data_blueprint.route('/camera_api/iot/camera/new_areas/edit', methods=['POST'])
def new_areas_edit():
    """
    新接口：编辑区域 (更新名称和层级)
    """
    req_data = request.json
    area_id = req_data.get('id')
    area_name = req_data.get('area_name')
    parent_id = req_data.get('parent_id', 0)

    if not area_id:
        return make_response({"success": False, "code": 400, "msg": "缺少区域ID", "data": None})

    # ================= 1. 防护逻辑 =================
    if str(area_id) == str(parent_id):
        return make_response({"success": False, "code": 400, "msg": "父节点不能是自己", "data": None})

    # ================= 2. 自动计算新层级 (level) =================
    level = 0  # 默认最外层为 0 级
    if str(parent_id) != '0':
        # 如果不是根节点，查询新父节点的 level
        sql_parent = f"SELECT level FROM icamera_data.icam_area_data WHERE id = '{parent_id}'"
        df_parent = db.select_db(sql_parent)
        
        if df_parent.empty:
            return make_response({"success": False, "code": 400, "msg": "父节点不存在", "data": None})
        
        parent_level = int(df_parent.iloc[0]['level'])
        level = parent_level + 1
        
        if level > 4:
            return make_response({"success": False, "code": 400, "msg": "最多只支持5级区域配置", "data": None})

    # ================= 3. 更新数据库 =================
    # 注意：这里仅更新当前节点。如果该节点有子节点，改变层级可能需要级联更新子节点的 level。
    sql_update = f"UPDATE icamera_data.icam_area_data SET area_name = '{area_name}', parent_id = '{parent_id}', level = '{level}' WHERE id = '{area_id}';"
    
    try:
        db.execute_db(sql_update)
        res = {
            "success": True,
            "code": 200,
            "msg": '编辑成功',
            "data": True
        }
    except Exception as e:
        res = {
            "success": False,
            "code": 500,
            "msg": f"数据库更新异常: {str(e)}",
            "data": False
        }
        
    return make_response(res)

@area_data_blueprint.route('/camera_api/iot/camera/new_areas/del', methods=['POST'])
def new_areas_del():
    """
    新接口：删除树形节点及其详情信息
    """
    area_id = str(request.json.get('id'))
    if not area_id:
        return make_response({"success": False, "code": 400, "msg": "缺少参数id", "data": False})

    # 1. 检查是否存在子节点，如果有则不允许直接删除
    sql_check_child = f"SELECT id FROM icamera_data.icam_area_data WHERE parent_id = '{area_id}'"
    df_child = db.select_db(sql_check_child)
    if not df_child.empty:
        return make_response({"success": False, "code": 400, "msg": "该区域下存在子区域，请先删除子区域", "data": False})

    # 2. 删除对应的基本信息详情
    sql_del_info = f"DELETE FROM icamera_data.icam_area_basic_info WHERE area_id = '{area_id}'"
    db.execute_db(sql_del_info)

    # 3. 删除树节点
    sql_del_node = f"DELETE FROM icamera_data.icam_area_data WHERE id = '{area_id}'"
    db.execute_db(sql_del_node)

    res = {
        "success": True,
        "code": 200,
        "msg": '删除成功',
        "data": True
    }
    return make_response(res)

@area_data_blueprint.route('/camera_api/iot/camera/new_areas/detail', methods=['GET'])
def new_areas_detail():
    """
    新接口：查询节点基础信息详情
    """
    area_id = request.args.get('area_id')
    if not area_id:
        return make_response({"success": False, "code": 400, "msg": "缺少参数area_id", "data": None})

    # SQL 加上了 camera_ids 和 alarm_ids
    sql = f"SELECT area_id, department, manager_name, phone_number, email, description, camera_ids, alarm_ids FROM icamera_data.icam_area_basic_info WHERE area_id = '{area_id}'"
    df_info = db.select_db(sql)

    if df_info.empty:
        # 如果还没填过详情，返回一个空结构，方便前端双向绑定
        data = {
            "area_id": int(area_id),
            "department": "",
            "manager_name": "",
            "phone_number": "",
            "email": "",
            "description": "",
            "camera_ids": "",
            "alarm_ids": ""
        }
    else:
        # 将 DataFrame 转换为字典，如果有空值(None/NaN)处理一下防止前端报错
        data = df_info.fillna("").to_dict('records')[0]

    res = {
        "success": True,
        "code": 200,
        "msg": "查询成功",
        "data": data
    }
    return make_response(res)

@area_data_blueprint.route('/camera_api/iot/camera/new_areas/detail/save', methods=['POST'])
def new_areas_detail_save():
    """
    新接口：保存/更新节点基础信息详情
    """
    req_data = request.json
    area_id = str(req_data.get('area_id'))
    
    if not area_id:
        return make_response({"success": False, "code": 400, "msg": "缺少关联的节点ID(area_id)", "data": False})

    # 获取前端传来的字段
    department = req_data.get('department', '')
    manager_name = req_data.get('manager_name', '')
    phone_number = req_data.get('phone_number', '')
    email = req_data.get('email', '')
    description = req_data.get('description', '')
    camera_ids = req_data.get('camera_ids', '')
    alarm_ids = req_data.get('alarm_ids', '')

    # 查询数据库是否已存在该区域的详情记录
    sql_check = f"SELECT id FROM icamera_data.icam_area_basic_info WHERE area_id = '{area_id}'"
    df_check = db.select_db(sql_check)

    if df_check.empty:
        # 不存在则插入
        sql_save = f"""
        INSERT INTO icamera_data.icam_area_basic_info 
        (area_id, department, manager_name, phone_number, email, description, camera_ids, alarm_ids) 
        VALUES ('{area_id}', '{department}', '{manager_name}', '{phone_number}', '{email}', '{description}', '{camera_ids}', '{alarm_ids}')
        """
        db.execute_db(sql_save)
    else:
        # 存在则更新
        sql_save = f"""
        UPDATE icamera_data.icam_area_basic_info 
        SET department='{department}', 
            manager_name='{manager_name}', 
            phone_number='{phone_number}', 
            email='{email}', 
            description='{description}',
            camera_ids='{camera_ids}',
            alarm_ids='{alarm_ids}'
        WHERE area_id='{area_id}'
        """
        db.execute_db(sql_save)

    res = {
        "success": True,
        "code": 200,
        "msg": "保存成功",
        "data": True
    }
    return make_response(res)

@area_data_blueprint.route('/camera_api/iot/camera/area_camera_alarm_tree', methods=['GET'])
def get_area_camera_alarm_tree():
    try:
        # 1. 获取所有区域
        sql_areas = "SELECT id, area_name, parent_id FROM icam_area_data"
        df_areas = db.select_db(sql_areas)

        # 2. 获取区域关联的摄像头ID映射
        sql_mapping = "SELECT area_id, camera_ids FROM icam_area_basic_info WHERE camera_ids IS NOT NULL AND camera_ids != ''"
        df_mapping = db.select_db(sql_mapping)

        # 3. 获取所有摄像头详情 (✨ 核心：这次把 alarm_type 一并查出来)
        sql_cameras = "SELECT id, camera_name, alarm_type FROM icamera_data.icam_camera_new_data" 
        df_cameras = db.select_db(sql_cameras)

        # --- 构建摄像头字典 (包含报警类型) ---
        camera_dict = {}
        if df_cameras is not None and not df_cameras.empty:
            for i in range(len(df_cameras)):
                cam_id = int(df_cameras['id'].values[i])
                cam_name = str(df_cameras['camera_name'].values[i])
                alarm_type_str = str(df_cameras['alarm_type'].values[i])

                # ✨ 解析逗号分隔的报警类型字符串，转成标准字典数组格式
                alarms = []
                if alarm_type_str and alarm_type_str != 'nan' and alarm_type_str.strip():
                    alarm_list = alarm_type_str.split(',')
                    for al in alarm_list:
                        al_name = al.strip()
                        if al_name:
                            alarms.append({
                                "id": al_name,
                                "name": al_name
                            })

                camera_dict[str(cam_id)] = {
                    "id": cam_id,            
                    "name": cam_name,
                    "alarms": alarms  # ✨ 挂载报警类型叶子节点
                }

        # --- 解析挂载摄像头到区域字典 ---
        area_cam_map = {}
        if df_mapping is not None and not df_mapping.empty:
            for i in range(len(df_mapping)):
                area_id = int(df_mapping['area_id'].values[i])
                c_ids_str = str(df_mapping['camera_ids'].values[i])
                
                if c_ids_str and c_ids_str.strip() and c_ids_str != 'nan':
                    c_id_list = c_ids_str.split(',')
                    c_nodes = []
                    for c_id in c_id_list:
                        c_id = c_id.strip()
                        if c_id in camera_dict:
                            c_nodes.append(camera_dict[c_id].copy())
                    area_cam_map[area_id] = c_nodes

        # --- 构建区域节点列表 ---
        area_nodes = {}
        if df_areas is not None and not df_areas.empty:
            for i in range(len(df_areas)):
                a_id = int(df_areas['id'].values[i])
                p_id = int(df_areas['parent_id'].values[i])
                a_name = str(df_areas['area_name'].values[i])
                
                area_nodes[a_id] = {
                    "id": f"area_{a_id}",        
                    "real_id": a_id,              
                    "name": a_name,
                    "parent_id": p_id,
                    "children": [],               
                    "cameras": area_cam_map.get(a_id, []) # ✨ 区域 -> 摄像头 -> 报警类型
                }

        # --- 组装最终的树结构 ---
        tree = []
        for a_id, node in area_nodes.items():
            p_id = node['parent_id']
            if p_id == 0 or p_id not in area_nodes:
                tree.append(node)
            else:
                area_nodes[p_id]['children'].append(node)
                
        # ✨ 清理空的 children 数组，避免前端树组件展示无用的展开箭头
        def clean_empty_children(nodes):
            for n in nodes:
                if not n['children']:
                    del n['children']
                else:
                    clean_empty_children(n['children'])
                    
        clean_empty_children(tree)

        res = {
            "success": True,
            "code": 200,
            "msg": "获取成功",
            "data": tree
        }
        return make_response(res)

    except Exception as e:
        print(f"Error building tree: {e}")
        return make_response({"success": False, "code": 500, "msg": str(e)})