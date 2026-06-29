from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
from icamera.tool.yaml_groupget import main_get
from icamera.config.setting import DOCUMENT_PATH
import json

#blueprin
system_blueprint = Blueprint('system', __name__,template_folder='templates')

def read_document():
    """读取文档数据"""
    try:
        with open(DOCUMENT_PATH, 'r') as f:
            data = json.load(f)
            return data.get("status",1)
    except (FileNotFoundError, json.JSONDecodeError):
        return None

def write_document(status):
    """写入文档数据"""
    with open(DOCUMENT_PATH, 'w') as f:
        json.dump({"status": status}, f)

#route
@system_blueprint.route('/camera_api/iot/camera/state/return', methods=['POST'])
def button_return():
    data = request.json.get('data')
    data1 = read_document()
    
    # 1. 容错处理：如果前端传过来的是字典 {'data': 0}，提取真正的值
    if isinstance(data, dict) and 'data' in data:
        data = data.get('data')
        
    # 2. 容错处理：如果值为 None 或空，给一个默认值（比如 0）防止 int() 报错
    if data is None or data == '':
        data = 0
    if data1 is None or data1 == '':
        data1 = 0

    print("解析后数据: ", data, data1)

    # 现在确保了 data 和 data1 都是可以转换成数字的类型
    if int(data1) > int(data):
        write_document(data)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "img": 0,
        "data": 0
    }
    return make_response(res)

@system_blueprint.route('/camera_api/iot/camera/state/button', methods=['GET'])
def button():
    data = read_document()
    
    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "img": '',
        "data": data
    }
    return make_response(res)

@system_blueprint.route('/camera_api/iot/camera/mainyaml/list', methods=['GET'])
def mainyaml_list():
    mainyaml_list = "SELECT * FROM icam_main_data"
    mainyaml_list = db.select_db(mainyaml_list)

    version = str(mainyaml_list['version'].values[0])
    windowname = str(mainyaml_list['windowname'].values[0])
    saveimagedir = str(mainyaml_list['saveimagedir'].values[0])
    streamurl = str(mainyaml_list['streamurl'].values[0])
    streamshow = str(mainyaml_list['streamshow'].values[0])
    saveimagequeuesize = str(mainyaml_list['saveimagequeuesize'].values[0])
    hostmemorylimit = str(mainyaml_list['hostmemorylimit'].values[0])
    loglevel = str(mainyaml_list['loglevel'].values[0])
    # datamonitorshow = str(mainyaml_list['datamonitorshow'].values[0])
    if 'datamonitorshow' in mainyaml_list.columns:
        datamonitorshow = str(mainyaml_list['datamonitorshow'].values[0])
    elif 'datastreamshow' in mainyaml_list.columns:
        datamonitorshow = str(mainyaml_list['datastreamshow'].values[0])
    else:
        datamonitorshow = True
    # campath = str(mainyaml_list['campath'].values[0])
    # modelpath = str(mainyaml_list['modelpath'].values[0])
    homepage = str(mainyaml_list['homepage'].values[0])

    mainyaml = {
        "version": version,
        "windowname": windowname,
        "saveimagedir": saveimagedir,
        "streamurl": streamurl,
        "streamshow": streamshow,
        "saveimagequeuesize": saveimagequeuesize,
        "hostmemorylimit": hostmemorylimit,
        "loglevel": loglevel,
        "datamonitorshow": datamonitorshow,
        "homepage": homepage
    }

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": [mainyaml]
    }
    return make_response(res)

@system_blueprint.route('/camera_api/iot/camera/mainyaml/modify', methods=['POST'])
def modify_edit():
    # 1. 兼容性解析前端传来的数据 (处理新版 {data: {...}} 的包裹)
    req_data = request.json.get('data')
    if not isinstance(req_data, dict):
        req_data = request.json  # 兼容老前端直接传平级参数的情况

    if not req_data:
        return make_response({"success": False, "code": 500, "msg": "未获取到参数"})

    # 2. 安全提取字段，并设置默认值，防止前端没传导致存入 "None"
    version = str(req_data.get('version', ''))
    windowname = str(req_data.get('windowname', ''))
    saveimagedir = str(req_data.get('saveimagedir', ''))
    streamurl = str(req_data.get('streamurl', ''))
    
    # 新增的 V3.0 字段
    saveimagequeuesize = str(req_data.get('saveimagequeuesize', '1000'))
    hostmemorylimit = str(req_data.get('hostmemorylimit', '0.8'))
    devicememorylimit = str(req_data.get('devicememorylimit', '0.98')) # ✨ 新增
    loglevel = str(req_data.get('loglevel', 'Info'))
    
    # 布尔值/数值兼容：前端现在传的是 true/false，数据库如果存的是 1/0 需要处理
    datamonitorshow_val = req_data.get('datamonitorshow', True)
    datamonitorshow = "1" if datamonitorshow_val in [True, "1", 1] else "0"
    
    # 前端已被注释的隐藏字段，给保底值
    streamshow = str(req_data.get('streamshow', '1'))
    homepage = str(req_data.get('homepage', '0'))

    # 3. 拼装执行 SQL
    # ⚠️ 强提醒：请确保你的 icam_main_data 数据库表里，已经有了 devicememorylimit 字段，
    # 并且老字段 datastreamshow 已经改名为了 datamonitorshow，否则这里 execute_db 会报 SQL 语法错误！
    sql = f"""
        UPDATE icam_main_data 
        SET windowname = '{windowname}',
            saveimagedir = '{saveimagedir}',
            streamurl = '{streamurl}',
            streamshow = '{streamshow}',
            saveimagequeuesize = '{saveimagequeuesize}',
            hostmemorylimit = '{hostmemorylimit}',
            devicememorylimit = '{devicememorylimit}', 
            loglevel = '{loglevel}',
            datamonitorshow = '{datamonitorshow}',
            homepage = '{homepage}' 
        WHERE version = '{version}'
    """
    db.execute_db(sql)

    main_get()

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)