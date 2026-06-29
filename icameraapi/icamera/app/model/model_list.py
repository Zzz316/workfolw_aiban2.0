import os
from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
from werkzeug.utils import secure_filename
from icamera.tool.yaml_groupget import main_get
from icamera.config.setting import model_path
import pandas as pd
import logging
from io import BytesIO

logger = logging.getLogger(__name__)

# blueprint
model_list_blueprint = Blueprint('model_list', __name__, template_folder='templates')

@model_list_blueprint.route('/camera_api/iot/camera/model/list', methods=['GET'])
def model_list():
    modellist = []
    mod_list_sql = "SELECT * FROM icam_model_data"
    mod_list = db.select_db(mod_list_sql)
    
    if mod_list is not None and not mod_list.empty:
        for i in range(len(mod_list)):
            modelid = mod_list['modelid'].values[i]
            modelname = mod_list['modelname'].values[i]
            modelpath = mod_list['modelpath'].values[i]
            
            # ✨ 核心修复：安全获取 mode 并转换，防止 NULL 导致崩溃
            raw_mode = mod_list['mode'].values[i]
            if pd.isna(raw_mode) or raw_mode is None or str(raw_mode).strip() == '':
                mode = 0
            else:
                try:
                    mode = int(raw_mode)
                except (ValueError, TypeError):
                    mode = 0

            deviceid = mod_list['deviceid'].values[i]
            batchsize = mod_list['batchsize'].values[i]
            maxconfidencelabel = mod_list['maxconfidencelabel'].values[i]
            confidencethreshold = mod_list['confidencethreshold'].values[i]
            nmsthreshold = mod_list['nmsthreshold'].values[i]
            maximageboxes = mod_list['maximageboxes'].values[i]
            reserveboxes = mod_list['reserveboxes'].values[i]
            
            # 字段读取 (做兼容处理，防止旧表报错)
            labelprintcolor = ""
            if 'labelprintcolor' in mod_list.columns:
                val = mod_list['labelprintcolor'].values[i]
                labelprintcolor = val if pd.notna(val) else ""

            if mode > 0:
                model = {
                    "modelid": int(modelid) if pd.notna(modelid) else 0,
                    "modelpath": str(modelpath) if pd.notna(modelpath) else "",
                    "modelname": str(modelname) if pd.notna(modelname) else "",
                    "mode": mode,
                    "deviceid": int(deviceid) if pd.notna(deviceid) else 0,
                    "batchsize": int(batchsize) if pd.notna(batchsize) else 8,
                    "maxconfidencelabel": str(maxconfidencelabel) if pd.notna(maxconfidencelabel) else "",
                    "confidencethreshold": str(confidencethreshold) if pd.notna(confidencethreshold) else "",
                    "nmsthreshold": str(nmsthreshold) if pd.notna(nmsthreshold) else "",
                    "maximageboxes": int(maximageboxes) if pd.notna(maximageboxes) else 0,
                    "reserveboxes": str(reserveboxes) if pd.notna(reserveboxes) else "",
                    "labelprintcolor": str(labelprintcolor) 
                }
            else:
                model = {
                    "modelid": int(modelid) if pd.notna(modelid) else 0,
                    "modelpath": str(modelpath) if pd.notna(modelpath) else "",
                }
            modellist.append(model)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": modellist
    }
    return make_response(res)

@model_list_blueprint.route('/camera_api/iot/camera/model/del', methods=['POST'])
def mod_del():
    modelid = request.json.get('modelid')

    sql = "DELETE FROM icam_model_data WHERE modelid='"+ str(modelid) +"'"
    db.execute_db(sql)

    main_get()

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":True
    }
    return make_response(res)

@model_list_blueprint.route('/camera_api/iot/camera/model/edit', methods=['POST'])
def model_edit():
    id = str(request.json.get('modelid', ''))
    modelname = str(request.json.get('modelname', ''))
    modelpath = str(request.json.get('modelpath', ''))
    mode = str(request.json.get('mode', ''))
    deviceid = str(request.json.get('deviceid', ''))
    batchsize = str(request.json.get('batchsize', ''))
    maxconfidencelabel = str(request.json.get('maxconfidencelabel', ''))
    confidencethreshold = str(request.json.get('confidencethreshold', ''))
    nmsthreshold = str(request.json.get('nmsthreshold', ''))
    maximageboxes = str(request.json.get('maximageboxes', ''))
    reserveboxes = str(request.json.get('reserveboxes', ''))
    
    # ✨ 接收新增字段
    labelprintcolor = str(request.json.get('labelprintcolor', ''))

    # ✨ SQL 语句中追加 labelprintcolor
    SQL1 = f"""UPDATE icam_model_data SET 
               modelname = '{modelname}', modelpath = '{modelpath}', mode = '{mode}', 
               deviceid = '{deviceid}', batchsize = '{batchsize}', maxconfidencelabel = '{maxconfidencelabel}', 
               confidencethreshold = '{confidencethreshold}', nmsthreshold = '{nmsthreshold}', 
               maximageboxes = '{maximageboxes}', reserveboxes = '{reserveboxes}',
               labelprintcolor = '{labelprintcolor}'
               WHERE modelid='{id}'"""
    db.execute_db(SQL1)

    main_get()

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

@model_list_blueprint.route('/camera_api/iot/camera/model/add', methods=['POST'])
def model_add():
    modelname = str(request.json.get('modelname', ''))
    modelpath = str(request.json.get('modelpath', ''))
    mode = str(request.json.get('mode', ''))
    deviceid = str(request.json.get('deviceid', ''))
    batchsize = str(request.json.get('batchsize', ''))
    maxconfidencelabel = str(request.json.get('maxconfidencelabel', ''))
    confidencethreshold = str(request.json.get('confidencethreshold', ''))
    nmsthreshold = str(request.json.get('nmsthreshold', ''))
    maximageboxes = str(request.json.get('maximageboxes', ''))
    reserveboxes = str(request.json.get('reserveboxes', ''))
    
    # ✨ 接收新增字段
    labelprintcolor = str(request.json.get('labelprintcolor', ''))

    # 🚨 致命 Bug 修复：这里原来写的是 filtertype, distance 等区域表的字段名，现已彻底修复为模型表正确的字段名！
    SQL1 = f"""INSERT INTO icamera_data.icam_model_data 
               (modelname, modelpath, mode, deviceid, batchsize, maxconfidencelabel, 
                confidencethreshold, nmsthreshold, maximageboxes, reserveboxes, labelprintcolor) 
               VALUES 
               ('{modelname}', '{modelpath}', '{mode}', '{deviceid}', '{batchsize}', '{maxconfidencelabel}', 
                '{confidencethreshold}', '{nmsthreshold}', '{maximageboxes}', '{reserveboxes}', '{labelprintcolor}');"""
    db.execute_db(SQL1)

    main_get()

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

@model_list_blueprint.route('/camera_api/iot/camera/model/upload', methods=['POST'])
def model_upload():
    file = request.files['file']
    save_path = model_path
    file_name = file.filename
    filename = secure_filename(file_name)
    file.save(os.path.join(save_path, filename))
    savepath = save_path + file_name

    sql = "SELECT * FROM icam_model_data"
    df = db.select_db(sql)
    if df.empty:
        id = 1
        data = [id, savepath]
        SQL1 = f"Insert Into icamera_data.icam_model_data (modelid,modelpath) Values ('{data[0]}','{data[1]}');"
        db.execute_db(SQL1)
    else:
        id = len(df) + 1
        data = [id, savepath]
        SQL1 = f"Insert Into icamera_data.icam_model_data (modelid,modelpath) Values ('{data[0]}','{data[1]}');"
        db.execute_db(SQL1)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

@model_list_blueprint.route('/camera_api/iot/camera/model/update', methods=['POST'])
def model_update():
    id = str(request.form.get('id'))
    file = request.files['file']
    save_path = model_path
    file_name = file.filename
    filename = secure_filename(file_name)
    file.save(os.path.join(save_path, filename))
    savepath = save_path + file_name

    SQL1 = "update icam_model_data set modelpath = '" + savepath + "'where modelid='" + id + "'"
    db.execute_db(SQL1)

    main_get()

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)