from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
import uuid
from icamera.tool.yaml_camget import camera_get
from werkzeug.utils import secure_filename
from icamera.config.setting import video_path
from io import BytesIO
import pandas as pd
import os
import logging
import binascii

logger = logging.getLogger(__name__)

camera_list_blueprint = Blueprint('camera_list', __name__, template_folder='templates')

# ==========================================================
# ---------- 以下原有接口完全不動 (老版本業務) ----------
# ==========================================================

def extract_domain(url):
    # 如果 url 为空或不是字符串类型（如 float NaN），返回空值
    if not url or not isinstance(url, str):
        return "", "", "", "", ""
    
    ip = url.split("@")[-1].split(":")[0]
    port = url.split(":")[-1].split("/")[0]
    route = url.split("4")[-1]
    user = url.split("//")[-1].split(":")[0]
    start = url.find("n") + 1
    end = url.find("@")
    password = url[start:end][1:] if start > 0 and end > start else ""
    return ip, port, route, user, password

@camera_list_blueprint.route('/camera_api/iot/camera/camera/list', methods=['GET'])
def cam_list():
    camlist = []
    camera_list = "SELECT * FROM icam_camera_data"
    camera_list = db.select_db(camera_list)
    for i in range(len(camera_list)):
        id = int(camera_list['id'].values[i])
        name = camera_list['name'].values[i]
        fps = int(camera_list['fps'].values[i]) if pd.notna(camera_list['fps'].values[i]) else 0
        url = camera_list['url'].values[i]
        enablefilter = camera_list['enablefilter'].values[i]
        decodecache = camera_list['decodecache'].values[i]
        notes = camera_list['notes'].values[i]
        streaming = camera_list['streaming'].values[i]
        areas = camera_list['areas'].values[i]
        videopath = camera_list['videopath'].values[i]
        domain = extract_domain(url)

        camera = {
            "camname": name,
            "id": id,
            "decodecache": decodecache,
            "notes": notes,
            "streaming": streaming,
            "ip": domain[0] if domain[0] else "",
            "port": domain[1] if domain[1] else "",
            "route": domain[2] if domain[2] else "",
            "user": domain[3] if domain[3] else "",
            "password": domain[4] if domain[4] else "",
            "fps": fps,
            "enablefilter": int(enablefilter) if pd.notna(enablefilter) else 0,
            "areas": areas,
            "videopath": videopath
        }
        camlist.append(camera)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": camlist
    }
    return make_response(res)

@camera_list_blueprint.route('/camera_api/iot/camera/camera/add', methods=['POST'])
def cam_add():
    camname = request.json.get('camname')
    fps = request.json.get('fps')
    enablefilter = request.json.get('enablefilter')
    decodecache = request.json.get('decodecache')
    notes = request.json.get('notes')
    streaming = request.json.get('streaming')
    areas = request.json.get('areas')
    videopath = request.json.get('videopath')

    ip = request.json.get('ip')
    port = request.json.get('port')
    route = request.json.get('route')
    user = request.json.get('user')
    password = request.json.get('password')

    if videopath == '':
        url = 'rtsp://' + user + ':' + password + '@' + ip + ':' + str(port) + route
    else:
        url = ''

    sql = "SELECT * FROM icam_camera_data"
    df = db.select_db(sql)
    if df.empty:
        id = 1
        data = [id, camname, url, str(fps), enablefilter, decodecache, notes, videopath, streaming, areas]
        sql = f"Insert Into icamera_data.icam_camera_data (id, name, url, fps, enablefilter, decodecache, notes, videopath, streaming, areas) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}','{data[4]}','{data[5]}','{data[6]}','{data[7]}','{data[8]}','{data[9]}');"
        db.execute_db(sql)
    else:
        id = len(df) + 1
        data = [id, camname, url, str(fps), enablefilter, decodecache, notes, videopath, streaming, areas]
        sql = f"Insert Into icamera_data.icam_camera_data (id, name, url, fps, enablefilter, decodecache, notes, videopath, streaming, areas) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}','{data[4]}','{data[5]}','{data[6]}','{data[7]}','{data[8]}','{data[9]}');"
        db.execute_db(sql)

    camera_get()

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

@camera_list_blueprint.route('/camera_api/iot/camera/camera/del', methods=['POST'])
def cam_del():
    id = request.json.get('id')

    sql = "DELETE FROM icam_camera_data WHERE id='" + str(id) + "'"
    db.execute_db(sql)

    camera_get()

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

@camera_list_blueprint.route('/camera_api/iot/camera/camera/edit', methods=['POST'])
def cam_edit():
    id = str(request.json.get('id'))
    camname = str(request.json.get('camname'))
    fps = str(request.json.get('fps'))
    enablefilter = str(request.json.get('enablefilter'))
    decodecache = str(request.json.get('decodecache'))
    notes = str(request.json.get('notes'))
    streaming = request.json.get('streaming')
    areas = str(request.json.get('areas'))
    videopath = request.json.get('videopath')

    ip = str(request.json.get('ip'))
    port = str(request.json.get('port'))
    route = str(request.json.get('route'))
    user = str(request.json.get('user'))
    password = str(request.json.get('password'))

    if videopath == '':
        url = 'rtsp://' + user + ':' + password + '@' + ip + ':' + str(port) + route
    else:
        url = ''

    sql = "update icam_camera_data set name = '" + camname + "',fps = '" + fps + "',enablefilter = '" + enablefilter + "',decodecache = '" + decodecache + "',notes = '" + notes + "',videopath = '" + videopath + "',streaming = '" + streaming + "',url = '" + url + "',areas = '" + areas + "'where id='" + id + "'"
    db.execute_db(sql)

    camera_get()

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

@camera_list_blueprint.route('/camera_api/iot/camera/video/upload', methods=['POST'])
def video_upload():
    file = request.files['file']
    file_name = file.filename
    filename = secure_filename(file_name)
    file.save(os.path.join(video_path, filename))
    savepath = video_path + file_name

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True,
        "videopath": savepath
    }
    return make_response(res)

@camera_list_blueprint.route('/camera_api/iot/camera/video/uploadUrl', methods=['POST'])
def get_upload_path():
    """
    通用文件上传并返回路径接口
    """
    try:
        # 1. 接收前端传来的文件
        file = request.files.get('file')
        if not file:
            return make_response({"success": False, "code": 400, "msg": "未接收到文件数据"})

        # 2. 定义你要存文件的硬盘目录 (请替换为你真实的目录变量，比如 video_path)
        save_dir = video_path 
        
        # 🛡️ 安全防御：如果该目录还不存在，自动创建它
        os.makedirs(save_dir, exist_ok=True)

        # 3. 获取原文件后缀，生成 UUID 新文件名 (彻底解决中文乱码和同名覆盖)
        original_filename = file.filename
        ext = os.path.splitext(original_filename)[1] # 拿到类似 .mp4, .png 的后缀
        new_filename = f"{uuid.uuid4().hex}{ext}"

        # 4. 存入硬盘
        file.save(os.path.join(save_dir, new_filename))

        # 5. 组装返回给前端的路径
        # ⚠️ 注意：如果你之前的图片接口用了 [10:] 来切除前缀以配合前端代理，
        # 请把下面这行改成： final_return_path = (save_dir + new_filename)[10:]
        final_return_path = save_dir + new_filename 

        # 6. 返回结果给前端
        res = {
            "success": True,
            "code": 200,
            "msg": "文件上传成功",
            "data": final_return_path,       # 适配新版前端拿 res.data
            "videopath": final_return_path   # 兼容老版前端拿 res.videopath
        }
        return make_response(res)

    except Exception as e:
        print(f"====== 获取路径接口异常: {e} ======")
        return make_response({"success": False, "code": 500, "msg": f"上传异常: {str(e)}"})

@camera_list_blueprint.route('/camera_api/iot/camera/template/upload', methods=['POST'])
def template_upload():
    try:
        # 检查 Content-Type
        if 'multipart/form-data' not in request.content_type:
            return make_response({"success": False, "code": 400, "msg": "Content-Type 必须是 multipart/form-data", "data": False})

        # 获取上传的文件
        file = request.files.get('file')
        if not file:
            return make_response({"success": False, "code": 400, "msg": "未获取到上传文件", "data": False})

        # 确保文件是Excel格式
        if not file.filename.endswith('.xlsx') and not file.filename.endswith('.xls'):
            return make_response({"success": False, "code": 400, "msg": "请上传Excel文件", "data": False})

        # 安全处理文件名
        filename = secure_filename(file.filename)

        # 读取文件内容
        file_bytes = file.read()
        if not file_bytes:
            return make_response({"success": False, "code": 400, "msg": "文件内容为空", "data": False})

        # 检查文件头是否是 ZIP 格式
        if file_bytes[:2] != b'PK':
            return make_response({"success": False, "code": 400, "msg": "文件不是合法 Excel 格式（缺失 ZIP 头）", "data": False})

        # 使用 pandas 读取 Excel 文件
        try:
            df = pd.read_excel(BytesIO(file_bytes), engine='openpyxl')
        except Exception as e:
            logger.exception("PD 解析失败")
            return make_response({"success": False, "code": 400, "msg": f"Excel 解析失败：{e}", "data": False})

        # 检查表头是否正确
        required = {'摄像头名称', '区域'}
        if not required.issubset(df.columns):
            return make_response({"success": False, "code": 400, "msg": f"缺少必要列：{required}", "data": False})

        # 遍历数据并插入数据库
        insert_sql = "INSERT INTO icam_camera_data (name, areas) VALUES (%s, %s)"
        values = []
        for _, row in df.iterrows():
            camera_name = str(row['摄像头名称']).strip() if pd.notna(row['摄像头名称']) else ''
            area = str(row['区域']).strip() if pd.notna(row['区域']) else ''
            if not camera_name and not area:
                continue
            values.append((camera_name, area))

        if values:
            ok = db.execute_many(insert_sql, values)
            if not ok:
                return make_response({"success": False, "code": 500, "msg": "数据库批量写入失败", "data": False})

        logger.info("模板导入完成，共 %s 条记录", len(values))
        return make_response({"success": True, "code": 200, "msg": "数据导入成功", "data": True})

    except Exception as e:
        logger.exception("模板导入异常")
        return make_response({"success": False, "code": 500, "msg": f"数据导入失败：{e}", "data": False})


# ==========================================================
# ---------- 以下為新版攝像頭接口 (關聯樹形區域) ----------
# ==========================================================

def init_new_camera_table():
    """
    初始化创建新版摄像头表 icam_camera_new_data
    ✨ 补齐了 YAML 文档中要求的所有底层 AI 控制字段
    """
    create_table_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.icam_camera_new_data (
        id INT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
        area_id INT NOT NULL COMMENT '关联的区域树节点ID',
        camera_name VARCHAR(255) NOT NULL COMMENT '摄像头名称',
        model_name VARCHAR(255) DEFAULT NULL COMMENT '模型',
        ip_address VARCHAR(100) DEFAULT NULL COMMENT 'IP地址',
        port VARCHAR(20) DEFAULT '554' COMMENT '端口号',
        connection_path VARCHAR(255) DEFAULT NULL COMMENT '连接路径',
        account_name VARCHAR(100) DEFAULT NULL COMMENT '账户名称',
        account_password VARCHAR(255) DEFAULT NULL COMMENT '账户密码',
        stream_fps VARCHAR(20) DEFAULT '20' COMMENT '拉流帧率',
        stream_cache VARCHAR(20) DEFAULT '20' COMMENT '拉流缓存',
        remark VARCHAR(500) DEFAULT NULL COMMENT '备注',
        
        videopath VARCHAR(255) DEFAULT '' COMMENT '本地视频文件路径',
        url VARCHAR(500) DEFAULT '' COMMENT '拼接生成的RTSP主路径',
        streaming VARCHAR(255) DEFAULT '' COMMENT '流转发/推流地址',
        alarm_type VARCHAR(255) DEFAULT NULL COMMENT '报警类型',
        
        -- ✨ 以下为对接 YAML 底层推理的 6 个新增核心参数
        enablefilter INT DEFAULT 0 COMMENT '是否启用过滤 (0关 1开)',
        enablestream INT DEFAULT 1 COMMENT '是否启动推流 (0关 1开)',
        inferframesplit INT DEFAULT 0 COMMENT '推理帧间隔 (0不跳帧)',
        inferenable INT DEFAULT 1 COMMENT '是否启用推理 (0关 1开)',
        temprun INT DEFAULT 1 COMMENT '是否运行 (0关 1开)',
        enableroi INT DEFAULT 0 COMMENT '是否运行检测ROI (0关 1开)',
        
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='新版摄像头信息表';
    """
    try:
        db.execute_db(create_table_sql)
        print("====== 表 icam_camera_new_data 初始化检查/创建成功 ======")
    except Exception as e:
        print(f"====== 初始化表 icam_camera_new_data 失败: {e} ======")

# 蓝图加载时立即执行一次初始化
init_new_camera_table()

# ================= 辅助函数：处理区域树与设备关联逻辑 =================
def get_all_areas_dict():
    """获取所有区域数据，方便快速构建层级路径"""
    sql = "SELECT id, area_name, parent_id, level FROM icamera_data.icam_area_data"
    df = db.select_db(sql)
    if df.empty:
        return {}
    
    # 转换为 id 为 key 的字典
    areas = df.to_dict('records')
    return {str(item['id']): item for item in areas}

def get_descendant_area_ids(target_id, all_areas_dict):
    """向下递归：获取某个节点及其所有子孙节点的 ID 列表"""
    descendants = [str(target_id)]
    for a_id, a_info in all_areas_dict.items():
        if str(a_info.get('parent_id')) == str(target_id):
            descendants.extend(get_descendant_area_ids(a_id, all_areas_dict))
    return list(set(descendants))

def get_ancestor_area_ids(target_id, all_areas_dict):
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

def build_area_path(area_id, all_areas_dict):
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

def update_area_camera_ids(area_id, cam_id, action="add"):
    """更新基础信息表里的 camera_ids 字段 (保存ID而非名称)"""
    sql = f"SELECT id, camera_ids FROM icamera_data.icam_area_basic_info WHERE area_id = '{area_id}'"
    df = db.select_db(sql)
    
    if df.empty:
        if action == "add":
            insert_sql = f"INSERT INTO icamera_data.icam_area_basic_info (area_id, camera_ids) VALUES ('{area_id}', '{cam_id}')"
            db.execute_db(insert_sql)
    else:
        existing = str(df.iloc[0]['camera_ids'])
        cam_list = []
        if existing and existing.strip() not in ['None', '', 'nan']:
            cam_list = existing.split(',')
        
        cam_id_str = str(cam_id)
        modified = False
        
        if action == "add":
            if cam_id_str not in cam_list:
                cam_list.append(cam_id_str)
                modified = True
        elif action == "remove":
            if cam_id_str in cam_list:
                cam_list.remove(cam_id_str)
                modified = True
        
        if modified:
            new_cams = ",".join(cam_list)
            update_sql = f"UPDATE icamera_data.icam_area_basic_info SET camera_ids='{new_cams}' WHERE area_id='{area_id}'"
            db.execute_db(update_sql)


# ================= 新接口：分页查询摄像头列表 =================
@camera_list_blueprint.route('/camera_api/iot/camera/camera/newPage', methods=['GET'])
def camera_page():
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

    sql = "SELECT * FROM icamera_data.icam_camera_new_data WHERE 1=1"
    all_areas = get_all_areas_dict()
    
    if target_area_id:
        descendant_ids = get_descendant_area_ids(target_area_id, all_areas)
        if descendant_ids:
            ids_str = ",".join([f"'{aid}'" for aid in descendant_ids])
            sql += f" AND area_id IN ({ids_str})"
        
    sql += " ORDER BY id DESC"
    df_cams = db.select_db(sql)
    
    # ✨ 核心修复点：增加 df_cams is None 的判断，防止表不存在时崩溃
    if df_cams is None or df_cams.empty:
        return make_response({"success": True, "code": 200, "msg": "", "data": {"list": [], "total": 0}})

    cam_list = df_cams.fillna('').to_dict('records')
    for cam in cam_list:
        area_id = cam.get('area_id')
        path_info = build_area_path(area_id, all_areas)
        cam.update(path_info)

    total = len(cam_list)
    start_idx = (page_num - 1) * page_size
    end_idx = start_idx + page_size
    paginated_list = cam_list[start_idx:end_idx]

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


# ================= 新接口：新增/编辑摄像头 =================
@camera_list_blueprint.route('/camera_api/iot/camera/camera/newSave', methods=['POST'])
def camera_save():
    req = request.json
    cam_id = req.get('id', '')
    area_id = str(req.get('area_id', ''))
    camera_name = str(req.get('camera_name', ''))
    model_name = str(req.get('model_name', ''))
    ip_address = str(req.get('ip_address', ''))
    port = str(req.get('port', '554'))
    connection_path = str(req.get('connection_path', ''))
    account_name = str(req.get('account_name', ''))
    account_password = str(req.get('account_password', ''))
    stream_fps = str(req.get('stream_fps', '20'))
    stream_cache = str(req.get('stream_cache', '20'))
    remark = str(req.get('remark', ''))
    
    videopath = str(req.get('videopath', ''))
    streaming = str(req.get('streaming', ''))
    alarm_type = str(req.get('alarmType', ''))

    # ✨ 提取 YAML 需要的新增字段 (前端传 boolean 或 int，后端统一转为 int 存入数据库)
    # 提供安全默认值，防止前端没传导致报错
    enablefilter = int(req.get('enablefilter', 0))
    enablestream = int(req.get('enablestream', 1))
    inferframesplit = int(req.get('inferframesplit', 0))
    inferenable = int(req.get('inferenable', 1))
    temprun = int(req.get('temprun', 1))
    enableroi = int(req.get('enableroi', 0))

    if not area_id or not camera_name:
        return make_response({"success": False, "code": 400, "msg": "区域和摄像头名称不能为空"})

    if videopath == '':
        url = f"rtsp://{account_name}:{account_password}@{ip_address}:{port}{connection_path}"
    else:
        url = ''

    all_areas = get_all_areas_dict()

    if cam_id:
        # ============ 编辑 ============
        old_sql = f"SELECT area_id FROM icamera_data.icam_camera_new_data WHERE id='{cam_id}'"
        df_old = db.select_db(old_sql)
        old_area_id = str(df_old.iloc[0]['area_id']) if not df_old.empty else None

        # ✨ UPDATE语句补齐所有新字段
        update_sql = f"""
            UPDATE icamera_data.icam_camera_new_data 
            SET area_id='{area_id}', camera_name='{camera_name}', model_name='{model_name}', 
                ip_address='{ip_address}', port='{port}', connection_path='{connection_path}', 
                account_name='{account_name}', account_password='{account_password}', 
                stream_fps='{stream_fps}', stream_cache='{stream_cache}', remark='{remark}',
                videopath='{videopath}', url='{url}', streaming='{streaming}', alarm_type='{alarm_type}',
                enablefilter='{enablefilter}', enablestream='{enablestream}', 
                inferframesplit='{inferframesplit}', inferenable='{inferenable}', 
                temprun='{temprun}', enableroi='{enableroi}'
            WHERE id='{cam_id}'
        """
        db.execute_db(update_sql)

        if old_area_id and old_area_id != area_id:
            old_ancestors = get_ancestor_area_ids(old_area_id, all_areas)
            for anc_id in old_ancestors:
                update_area_camera_ids(anc_id, cam_id, action="remove")
            
            new_ancestors = get_ancestor_area_ids(area_id, all_areas)
            for anc_id in new_ancestors:
                update_area_camera_ids(anc_id, cam_id, action="add")

    else:
        # ============ 新增 ============
        # ✨ INSERT语句补齐所有新字段
        insert_sql = f"""
            INSERT INTO icamera_data.icam_camera_new_data 
            (area_id, camera_name, model_name, ip_address, port, connection_path, 
             account_name, account_password, stream_fps, stream_cache, remark,
             videopath, url, streaming, alarm_type, 
             enablefilter, enablestream, inferframesplit, inferenable, temprun, enableroi) 
            VALUES 
            ('{area_id}', '{camera_name}', '{model_name}', '{ip_address}', '{port}', '{connection_path}', 
             '{account_name}', '{account_password}', '{stream_fps}', '{stream_cache}', '{remark}',
             '{videopath}', '{url}', '{streaming}', '{alarm_type}',
             '{enablefilter}', '{enablestream}', '{inferframesplit}', '{inferenable}', '{temprun}', '{enableroi}')
        """
        db.execute_db(insert_sql)
        
        fetch_id_sql = f"SELECT id FROM icamera_data.icam_camera_new_data WHERE area_id='{area_id}' AND camera_name='{camera_name}' ORDER BY id DESC LIMIT 1"
        df_new_id = db.select_db(fetch_id_sql)
        
        if not df_new_id.empty:
            new_cam_id = str(df_new_id.iloc[0]['id'])
            new_ancestors = get_ancestor_area_ids(area_id, all_areas)
            for anc_id in new_ancestors:
                update_area_camera_ids(anc_id, new_cam_id, action="add")

    # 触发底层 yaml 生成
    camera_get()

    return make_response({"success": True, "code": 200, "msg": "保存成功", "data": True})

# ================= 新接口：删除摄像头 =================
@camera_list_blueprint.route('/camera_api/iot/camera/camera/newDel', methods=['POST'])
def camera_delete():
    cam_id = str(request.json.get('id', ''))
    if not cam_id:
        return make_response({"success": False, "code": 400, "msg": "缺少ID"})

    check_sql = f"SELECT area_id FROM icamera_data.icam_camera_new_data WHERE id='{cam_id}'"
    df_cam = db.select_db(check_sql)
    
    if not df_cam.empty:
        area_id = str(df_cam.iloc[0]['area_id'])
        
        # 1. 主表删除
        del_sql = f"DELETE FROM icamera_data.icam_camera_new_data WHERE id='{cam_id}'"
        db.execute_db(del_sql)
        
        # 2. 向上溯源，从基础信息表中移除ID
        all_areas = get_all_areas_dict()
        ancestors = get_ancestor_area_ids(area_id, all_areas)
        
        for anc_id in ancestors:
            update_area_camera_ids(anc_id, cam_id, action="remove")

    # ✨ 补全老接口的底层配置刷新操作
    camera_get()

    return make_response({"success": True, "code": 200, "msg": "删除成功", "data": True})

# ==========================================================
# ---------- 以下為新增的：摄像头工序模板配置 接口 ----------
# ==========================================================

def init_camera_step_config_table():
    """初始化创建摄像头工序配置表"""
    create_table_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.icam_camera_step_config (
        id INT NOT NULL AUTO_INCREMENT COMMENT '步骤配置ID',
        camera_id INT NOT NULL COMMENT '关联的摄像头ID',
        step_code VARCHAR(50) NOT NULL COMMENT '步骤代号(如D1, D2)',
        step_name VARCHAR(255) NOT NULL COMMENT '步骤名称',
        sort_order INT DEFAULT 0 COMMENT '排序权重',
        is_active INT DEFAULT 1 COMMENT '是否启用 (0停用 1启用)',
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_camera_id (camera_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='摄像头工序模板配置表';
    """
    try:
        db.execute_db(create_table_sql)
        print("====== 表 icam_camera_step_config 初始化检查/创建成功 ======")
    except Exception as e:
        print(f"====== 初始化表 icam_camera_step_config 失败: {e} ======")

# 加载时立即执行一次初始化
init_camera_step_config_table()


@camera_list_blueprint.route('/camera_api/iot/camera/step/list', methods=['GET'])
def camera_step_list():
    """获取指定摄像头的工序列表"""
    camera_id = request.args.get('camera_id')
    if not camera_id:
        return make_response({"success": False, "code": 400, "msg": "缺少摄像头ID"})
    
    sql = f"SELECT * FROM icamera_data.icam_camera_step_config WHERE camera_id='{camera_id}' ORDER BY sort_order ASC, id ASC"
    df = db.select_db(sql)
    
    if df is None or df.empty:
        step_list = []
    else:
        step_list = df.fillna('').to_dict('records')
        
    return make_response({"success": True, "code": 200, "msg": "查询成功", "data": step_list})


@camera_list_blueprint.route('/camera_api/iot/camera/step/batchSave', methods=['POST'])
def camera_step_batch_save():
    """批量保存摄像头的工序配置 (全删全插逻辑)"""
    req = request.json
    camera_id = req.get('camera_id')
    steps = req.get('steps', [])
    
    if not camera_id:
        return make_response({"success": False, "code": 400, "msg": "缺少摄像头ID"})
        
    try:
        # 简单粗暴且安全的做法：全删全插 (因为是配置表，数据量极小，直接覆盖最稳妥)
        delete_sql = f"DELETE FROM icamera_data.icam_camera_step_config WHERE camera_id='{camera_id}'"
        db.execute_db(delete_sql)
        
        for index, step in enumerate(steps):
            step_code = str(step.get('step_code', '')).strip()
            step_name = str(step.get('step_name', '')).strip()
            # 如果前端没传排序，默认用数组索引作为排序
            sort_order = int(step.get('sort_order', index + 1)) 
            is_active = int(step.get('is_active', 1))
            
            if not step_code or not step_name:
                continue # 跳过空数据
                
            insert_sql = f"""
                INSERT INTO icamera_data.icam_camera_step_config 
                (camera_id, step_code, step_name, sort_order, is_active)
                VALUES 
                ('{camera_id}', '{step_code}', '{step_name}', {sort_order}, {is_active})
            """
            db.execute_db(insert_sql)
            
        return make_response({"success": True, "code": 200, "msg": "工序配置保存成功", "data": True})
    except Exception as e:
        return make_response({"success": False, "code": 500, "msg": f"保存失败: {str(e)}"})