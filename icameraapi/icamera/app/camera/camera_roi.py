import os
from flask import make_response, request, Blueprint, send_from_directory
from icamera.common.mysql_operate import db
from werkzeug.utils import secure_filename
from icamera.tool.yaml_camget import camera_get
from icamera.config.setting import img_path

# blueprint
camera_roi_blueprint = Blueprint('camera_roi', __name__, template_folder='templates')

# ==========================================================
# ✨ 新增：启动时自动初始化 inferroi 表
# ==========================================================
def init_inferroi_table():
    create_table_sql = """
    CREATE TABLE IF NOT EXISTS icamera_data.icam_inferroi_data (
        id VARCHAR(50) NOT NULL COMMENT '关联的摄像头ID',
        bordersize INT DEFAULT 3 COMMENT '线大小',
        bordercolor VARCHAR(50) DEFAULT 'rgba(0, 0, 128, 1)' COMMENT '线颜色',
        bgcolor VARCHAR(50) DEFAULT 'rgba(0, 255, 0, 0.5)' COMMENT '填充区颜色',
        points TEXT COMMENT '点集合(x,y;x,y...)',
        pointradius INT DEFAULT 4 COMMENT '点大小',
        pointcolor VARCHAR(50) DEFAULT 'rgba(0, 255, 0, 1)' COMMENT '点颜色',
        showpoint INT DEFAULT 0 COMMENT '是否显示点 0关 1开',
        showroi INT DEFAULT 0 COMMENT '是否绘制ROI 0关 1开',
        INDEX idx_camera_id (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='检测ROI区域表';
    """
    try:
        db.execute_db(create_table_sql)
        print("====== 表 icam_inferroi_data 初始化检查/创建成功 ======")
    except Exception as e:
        print(f"====== 初始化表 icam_inferroi_data 失败: {e} ======")

# 注册蓝图时立即执行建表
init_inferroi_table()

# ==========================================================
# 1. 原本的区域绘制 (Filter Area) 接口
# ==========================================================
@camera_roi_blueprint.route('/camera_api/iot/camera/cameraroi/list', methods=['GET'])
def cameraroi_list():
    id = request.args.get('id')

    cameraroilist = []
    cameraroi_list = "SELECT * FROM icam_filterarea_data WHERE id='"+ str(id) +"'"
    cameraroi_list = db.select_db(cameraroi_list)
    
    if cameraroi_list is not None and not cameraroi_list.empty:
        for i in range(len(cameraroi_list)):
            name = cameraroi_list['name'].values[i]
            filtertype = int(cameraroi_list['filtertype'].values[i])
            distance = int(cameraroi_list['distance'].values[i])
            bordersize = int(cameraroi_list['bordersize'].values[i])
            bordercolor = cameraroi_list['bordercolor'].values[i]
            bgcolor = cameraroi_list['bgcolor'].values[i]
            pointcolor = cameraroi_list['pointcolor'].values[i]
            points = cameraroi_list['points'].values[i]
            pointradius = int(cameraroi_list['pointradius'].values[i])
            showpoint = int(cameraroi_list['showpoint'].values[i])
            showroi = int(cameraroi_list['showroi'].values[i])
            cameraroi = {
                "areaname": name,
                "filtertype": filtertype,
                "distance": distance,
                "bordersize": bordersize,
                "bordercolor": bordercolor,
                "bgcolor": bgcolor,
                "points": points,
                "pointradius": pointradius,
                "pointcolor": pointcolor,
                "showpoint": showpoint,
                "showroi": showroi
            }
            cameraroilist.append(cameraroi)

    camepath = "SELECT * FROM icam_fileimg_data WHERE id='" + str(id) + "'"
    camepath_data = db.select_db(camepath)
    if camepath_data is None or camepath_data.empty:
        imgpath = ''
    else:
        imgpath = camepath_data['fileimg_path'][0]

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "img": imgpath,
        "data": cameraroilist
    }
    return make_response(res)

@camera_roi_blueprint.route('/camera_api/iot/camera/cameraroi/edit', methods=['POST'])
def cameraroi():
    id = request.json.get('id')
    imgpath = request.json.get('img')

    imgpath_data = "SELECT * FROM icam_fileimg_data WHERE id='" + str(id) + "'"
    imgpath_sql = db.select_db(imgpath_data)
    if imgpath_sql.empty:
        data1 = [id, imgpath]
        SQL2 = f"Insert Into icamera_data.icam_fileimg_data (id, fileimg_path) Values ('{data1[0]}','{data1[1]}');"
        db.execute_db(SQL2)
    else:
        sql1 = "update icam_fileimg_data set fileimg_path = '" + imgpath + "' where id ='" + str(id) + "'"
        db.execute_db(sql1)

    data = request.json.get('list', [])
    delete_sql = f"DELETE FROM icam_filterarea_data WHERE id='{id}'"
    db.execute_db(delete_sql)

    if data and len(data) > 0:
        def safe_int_str(val, default=0):
            if val == '' or val is None or str(val).lower() == 'null':
                return str(default)
            try:
                return str(int(float(val))) 
            except ValueError:
                return str(default)

        for array in data:
            areaname = str(array.get('areaname', ''))
            filtertype = safe_int_str(array.get('filtertype'), 0)
            distance = safe_int_str(array.get('distance'), 0)
            bordersize = safe_int_str(array.get('bordersize'), 3)
            pointradius = safe_int_str(array.get('pointradius'), 3)
            showpoint = safe_int_str(array.get('showpoint'), 0)
            showroi = safe_int_str(array.get('showroi'), 0)
            bordercolor = str(array.get('bordercolor', ''))
            bgcolor = str(array.get('bgcolor', ''))
            points = str(array.get('points', ''))
            pointcolor = str(array.get('pointcolor', ''))

            SQL = f"Insert Into icamera_data.icam_filterarea_data (id, name, filtertype, distance, bordersize, bordercolor, bgcolor, points, pointradius, pointcolor, showpoint, showroi) Values ('{id}','{areaname}','{filtertype}','{distance}','{bordersize}','{bordercolor}','{bgcolor}','{points}','{pointradius}','{pointcolor}','{showpoint}','{showroi}');"
            db.execute_db(SQL)

    res = {
        "success": True,
        "code": 200,
        "msg": '保存成功',
        "data": True
    }

    # 触发底层 yaml 生成
    camera_get()
    return make_response(res)


# ==========================================================
# ✨ 2. 新增的检测 ROI (Infer ROI) 接口
# ==========================================================
@camera_roi_blueprint.route('/camera_api/iot/camera/inferroi/list', methods=['GET'])
def inferroi_list():
    id = request.args.get('id')
    roilist = []
    
    sql = f"SELECT * FROM icam_inferroi_data WHERE id='{id}'"
    df = db.select_db(sql)
    
    if df is not None and not df.empty:
        for i in range(len(df)):
            roilist.append({
                "bordersize": int(df['bordersize'].values[i]),
                "bordercolor": df['bordercolor'].values[i],
                "bgcolor": df['bgcolor'].values[i],
                "points": df['points'].values[i],
                "pointradius": int(df['pointradius'].values[i]),
                "pointcolor": df['pointcolor'].values[i],
                "showpoint": int(df['showpoint'].values[i]),
                "showroi": int(df['showroi'].values[i])
            })

    # 复用查图片的逻辑，保证两边前端都能拿到同一样的底图
    camepath = "SELECT * FROM icam_fileimg_data WHERE id='" + str(id) + "'"
    camepath_data = db.select_db(camepath)
    imgpath = '' if (camepath_data is None or camepath_data.empty) else camepath_data['fileimg_path'][0]

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "img": imgpath,
        "data": roilist
    }
    return make_response(res)

@camera_roi_blueprint.route('/camera_api/iot/camera/inferroi/edit', methods=['POST'])
def inferroi_edit():
    id = request.json.get('id')
    imgpath = request.json.get('img')

    # 更新底图路径
    imgpath_data = f"SELECT * FROM icam_fileimg_data WHERE id='{id}'"
    imgpath_sql = db.select_db(imgpath_data)
    if imgpath_sql.empty:
        db.execute_db(f"Insert Into icamera_data.icam_fileimg_data (id, fileimg_path) Values ('{id}','{imgpath}');")
    else:
        db.execute_db(f"update icam_fileimg_data set fileimg_path = '{imgpath}' where id ='{id}'")

    data = request.json.get('list', [])
    
    # 核心：先删后插，防止残影
    db.execute_db(f"DELETE FROM icam_inferroi_data WHERE id='{id}'")

    if data and len(data) > 0:
        def safe_int_str(val, default=0):
            if val == '' or val is None or str(val).lower() == 'null':
                return str(default)
            try:
                return str(int(float(val)))
            except ValueError:
                return str(default)

        for array in data:
            bordersize = safe_int_str(array.get('bordersize'), 3)
            pointradius = safe_int_str(array.get('pointradius'), 4)
            showpoint = safe_int_str(array.get('showpoint'), 0)
            showroi = safe_int_str(array.get('showroi'), 0)
            
            bordercolor = str(array.get('bordercolor', 'rgba(0, 0, 128, 1)'))
            bgcolor = str(array.get('bgcolor', 'rgba(0, 255, 0, 0.5)'))
            pointcolor = str(array.get('pointcolor', 'rgba(0, 255, 0, 1)'))
            points = str(array.get('points', ''))

            SQL = f"""Insert Into icamera_data.icam_inferroi_data 
                     (id, bordersize, bordercolor, bgcolor, points, pointradius, pointcolor, showpoint, showroi) 
                     Values 
                     ('{id}', '{bordersize}', '{bordercolor}', '{bgcolor}', '{points}', '{pointradius}', '{pointcolor}', '{showpoint}', '{showroi}');"""
            db.execute_db(SQL)

    res = {
        "success": True,
        "code": 200,
        "msg": '保存成功',
        "data": True
    }

    # 触发底层 yaml 生成
    camera_get()
    return make_response(res)

# ==========================================================
# 3. 通用的图片处理接口
# ==========================================================
@camera_roi_blueprint.route('/camera_api/iot/camera/scene/image', methods=['POST'])
def scene():
    file = request.files['file']
    save_path = img_path
    file_name = file.filename
    filename = secure_filename(file_name) 
    
    # 存入硬盘用 filename
    file.save(os.path.join(save_path, filename))
    
    # ✨ 修复：返回路径也必须用 filename
    savepath = (save_path + filename)[10:]

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data": savepath
    }
    return make_response(res)

@camera_roi_blueprint.route('/camera_api/iot/ngimages/<path:filename>', methods=['GET'])
def get_image(filename):
    print(f"==== 进来了！收到获取图片的请求: {filename} ====")
    try:
        return send_from_directory(img_path, filename)
    except FileNotFoundError:
        print(f"==== 报错：在 {img_path} 目录下找不到 {filename} ====")
        return "Image not found", 404