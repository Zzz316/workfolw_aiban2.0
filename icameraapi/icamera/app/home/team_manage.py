from flask import request, make_response, Blueprint
from icamera.common.mysql_operate import db
import pandas as pd

team_manage_blueprint = Blueprint('team_manage', __name__)

# ==========================================================
# ---------- 自动初始化：团队管理相关的数据库表 ----------
# ==========================================================

def init_team_manage_tables():
    """自动初始化创建团队管理需要的3张核心数据表"""
    
    # 1. 团队主表
    create_team_table_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.icam_team (
        id INT AUTO_INCREMENT PRIMARY KEY COMMENT '团队ID',
        team_name VARCHAR(100) NOT NULL COMMENT '团队名称',
        remark VARCHAR(255) DEFAULT NULL COMMENT '团队描述备注',
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团队管理主表';
    """

    # 2. 团队-用户 关联表 (多对多)
    create_team_user_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.icam_team_user (
        id INT AUTO_INCREMENT PRIMARY KEY,
        team_id INT NOT NULL COMMENT '团队ID',
        user_id VARCHAR(100) NOT NULL COMMENT '中台用户ID',
        user_name VARCHAR(100) DEFAULT NULL COMMENT '用户冗余名称',
        UNIQUE KEY uk_team_user (team_id, user_id) COMMENT '防止重复绑定'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团队与用户关联表';
    """

    # 3. 团队-摄像头 关联表 (多对多)
    create_team_camera_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.icam_team_camera (
        id INT AUTO_INCREMENT PRIMARY KEY,
        team_id INT NOT NULL COMMENT '团队ID',
        camera_id INT NOT NULL COMMENT '摄像头ID',
        UNIQUE KEY uk_team_camera (team_id, camera_id) COMMENT '防止重复绑定'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团队与摄像头关联表';
    """
    
    try:
        db.execute_db(create_team_table_sql)
        db.execute_db(create_team_user_sql)
        db.execute_db(create_team_camera_sql)
        print("====== 团队管理核心数据表 (icam_team 系列) 初始化成功 ======")
    except Exception as e:
        print(f"====== 初始化团队管理表失败: {e} ======")

# 每次启动应用加载该蓝图时，自动执行建表校验
init_team_manage_tables()


# ==========================================================
# ---------- 1. 团队的 CRUD 接口 ----------
# ==========================================================

@team_manage_blueprint.route('/camera_api/iot/team/list', methods=['POST'])
def get_team_list():
    """获取团队列表 (支持按名称搜索)"""
    req = request.json
    keyword = req.get('keyword', '')
    
    base_sql = "FROM icamera_data.icam_team WHERE 1=1"
    if keyword:
        base_sql += f" AND team_name LIKE '%{keyword}%'"
        
    df_data = db.select_db(f"SELECT * {base_sql} ORDER BY create_time DESC")
    data_list = df_data.fillna('').to_dict('records') if (df_data is not None and not df_data.empty) else []
    
    # 统计每个团队下绑定的用户数和摄像头数，方便前端展示
    for item in data_list:
        team_id = item['id']
        u_df = db.select_db(f"SELECT COUNT(1) as cnt FROM icamera_data.icam_team_user WHERE team_id={team_id}")
        c_df = db.select_db(f"SELECT COUNT(1) as cnt FROM icamera_data.icam_team_camera WHERE team_id={team_id}")
        item['user_count'] = int(u_df.iloc[0]['cnt']) if (u_df is not None and not u_df.empty) else 0
        item['camera_count'] = int(c_df.iloc[0]['cnt']) if (c_df is not None and not c_df.empty) else 0

    return make_response({"success": True, "code": 200, "data": data_list})

@team_manage_blueprint.route('/camera_api/iot/team/save', methods=['POST'])
def save_team():
    """新增或修改团队"""
    req = request.json
    team_id = req.get('id')
    team_name = req.get('team_name')
    remark = req.get('remark', '')
    
    if not team_name:
        return make_response({"success": False, "code": 400, "msg": "团队名称不能为空"})
        
    try:
        if team_id:
            sql = f"UPDATE icamera_data.icam_team SET team_name='{team_name}', remark='{remark}' WHERE id={team_id}"
        else:
            sql = f"INSERT INTO icamera_data.icam_team (team_name, remark) VALUES ('{team_name}', '{remark}')"
            
        db.execute_db(sql)
        return make_response({"success": True, "code": 200, "msg": "保存成功"})
    except Exception as e:
        return make_response({"success": False, "code": 500, "msg": f"保存失败: {str(e)}"})

@team_manage_blueprint.route('/camera_api/iot/team/delete', methods=['POST'])
def delete_team():
    """删除团队 (连带删除关联关系)"""
    team_id = request.json.get('id')
    if team_id:
        try:
            # 开启级联删除：删除团队的同时，清空其下的分配关系
            db.execute_db(f"DELETE FROM icamera_data.icam_team WHERE id={team_id}")
            db.execute_db(f"DELETE FROM icamera_data.icam_team_user WHERE team_id={team_id}")
            db.execute_db(f"DELETE FROM icamera_data.icam_team_camera WHERE team_id={team_id}")
            return make_response({"success": True, "code": 200, "msg": "删除成功"})
        except Exception as e:
            return make_response({"success": False, "code": 500, "msg": f"删除失败: {str(e)}"})
    return make_response({"success": False, "code": 400, "msg": "缺少团队ID"})


# ==========================================================
# ---------- 2. 团队绑定关系管理接口 ----------
# ==========================================================

@team_manage_blueprint.route('/camera_api/iot/team/relations', methods=['GET'])
def get_team_relations():
    """回显：获取某个团队已绑定的用户ID和摄像头ID"""
    team_id = request.args.get('team_id')
    if not team_id:
        return make_response({"success": False, "code": 400, "msg": "缺少团队ID"})
    
    u_df = db.select_db(f"SELECT user_id FROM icamera_data.icam_team_user WHERE team_id={team_id}")
    c_df = db.select_db(f"SELECT camera_id FROM icamera_data.icam_team_camera WHERE team_id={team_id}")
    
    user_ids = u_df['user_id'].tolist() if (u_df is not None and not u_df.empty) else []
    camera_ids = c_df['camera_id'].tolist() if (c_df is not None and not c_df.empty) else []
    
    return make_response({"success": True, "code": 200, "data": {"user_ids": user_ids, "camera_ids": camera_ids}})

@team_manage_blueprint.route('/camera_api/iot/team/bind_users', methods=['POST'])
def bind_users():
    """分配用户到团队 (覆盖更新)"""
    req = request.json
    team_id = req.get('team_id')
    users = req.get('users', []) # 格式: [{'user_id': '101', 'user_name': '张三'}, ...]
    
    if not team_id:
        return make_response({"success": False, "code": 400, "msg": "缺少团队ID"})
        
    try:
        # 核心逻辑：先删后插，保证数据状态一致性
        db.execute_db(f"DELETE FROM icamera_data.icam_team_user WHERE team_id={team_id}")
        for u in users:
            uid = str(u.get('user_id', '')).replace("'", "''") # 简单防注入
            uname = str(u.get('user_name', '')).replace("'", "''")
            if uid:
                db.execute_db(f"INSERT INTO icamera_data.icam_team_user (team_id, user_id, user_name) VALUES ({team_id}, '{uid}', '{uname}')")
            
        return make_response({"success": True, "code": 200, "msg": "用户分配成功"})
    except Exception as e:
        return make_response({"success": False, "code": 500, "msg": f"用户分配失败: {str(e)}"})

@team_manage_blueprint.route('/camera_api/iot/team/bind_cameras', methods=['POST'])
def bind_cameras():
    """分配摄像头到团队 (覆盖更新)"""
    req = request.json
    team_id = req.get('team_id')
    camera_ids = req.get('camera_ids', []) # 格式: [1, 2, 3]
    
    if not team_id:
        return make_response({"success": False, "code": 400, "msg": "缺少团队ID"})
        
    try:
        # 核心逻辑：先删后插
        db.execute_db(f"DELETE FROM icamera_data.icam_team_camera WHERE team_id={team_id}")
        for cid in camera_ids:
            # 确保传入的是数字，防止 SQL 报错
            if str(cid).isdigit():
                db.execute_db(f"INSERT INTO icamera_data.icam_team_camera (team_id, camera_id) VALUES ({team_id}, {cid})")
            
        return make_response({"success": True, "code": 200, "msg": "摄像头分配成功"})
    except Exception as e:
        return make_response({"success": False, "code": 500, "msg": f"摄像头分配失败: {str(e)}"})

@team_manage_blueprint.route('/camera_api/iot/camera/auth_tree', methods=['GET'])
def get_auth_camera_tree():
    """业务大屏专用：获取区域摄像头树 (保留完整区域，仅剔除无权限的摄像头)"""
    try:
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
                auth_camera_ids = set([int(x) for x in df_auth['camera_id'].tolist()])
            # 注意：即使查不到权限，依然继续往下走，为了返回纯净的区域骨架树

        sql_areas = "SELECT id, area_name, parent_id FROM icam_area_data"
        df_areas = db.select_db(sql_areas)

        sql_mapping = "SELECT area_id, camera_ids FROM icam_area_basic_info WHERE camera_ids IS NOT NULL AND camera_ids != ''"
        df_mapping = db.select_db(sql_mapping)

        sql_cameras = "SELECT id, camera_name, alarm_type FROM icamera_data.icam_camera_new_data" 
        df_cameras = db.select_db(sql_cameras)

        # --- 构建摄像头字典 (仅存入有权限的摄像头) ---
        camera_dict = {}
        if df_cameras is not None and not df_cameras.empty:
            for i in range(len(df_cameras)):
                cam_id = int(df_cameras['id'].values[i])
                
                # 🛡️ 剔除没权限的摄像头
                if username and username != 'admin' and cam_id not in auth_camera_ids:
                    continue
                    
                cam_name = str(df_cameras['camera_name'].values[i])
                alarm_type_str = str(df_cameras['alarm_type'].values[i])

                alarms = []
                if alarm_type_str and alarm_type_str != 'nan' and alarm_type_str.strip():
                    alarm_list = alarm_type_str.split(',')
                    for al in alarm_list:
                        al_name = al.strip()
                        if al_name:
                            alarms.append({"id": al_name, "name": al_name})

                camera_dict[str(cam_id)] = {
                    "id": cam_id,            
                    "name": cam_name,
                    "alarms": alarms 
                }

        # --- 组装区域-摄像头映射 ---
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

        # --- 构建所有区域节点 (此时全部区域都会被构建) ---
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
                    "cameras": area_cam_map.get(a_id, []) 
                }

        # --- 组装完整的树 ---
        tree = []
        for a_id, node in area_nodes.items():
            p_id = node['parent_id']
            if p_id == 0 or p_id not in area_nodes:
                tree.append(node)
            else:
                area_nodes[p_id]['children'].append(node)
                
        # --- 仅仅清理空的 children 数组，绝对不删除区域节点 ---
        def clean_empty_children(nodes):
            for n in nodes:
                if not n.get('children'):
                    if 'children' in n:
                        del n['children']
                else:
                    clean_empty_children(n['children'])
                    
        clean_empty_children(tree)

        res = {
            "success": True,
            "code": 200,
            "msg": "获取权限树成功",
            "data": tree
        }
        return make_response(res)

    except Exception as e:
        print(f"Error building auth tree: {e}")
        return make_response({"success": False, "code": 500, "msg": str(e)})