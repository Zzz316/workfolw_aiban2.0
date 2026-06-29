from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db

#blueprin
device_list_blueprint = Blueprint('device_list', __name__,template_folder='templates')

@device_list_blueprint.route('/camera_api/iot/camera/equipment/list', methods=['GET'])
def device_list():
    devicelist = []
    dev_list = "SELECT * FROM icam_device_data"
    dev_list = db.select_db(dev_list,0)
    for i in range(len(dev_list)):
        id = dev_list['id'].values[i]
        name = dev_list['name'].values[i]
        ip = dev_list['ip'].values[i]
        campos = dev_list['campos'].values[i]
        notes = dev_list['notes'].values[i]
        DI0 = dev_list['DI0'].values[i]
        DI1 = dev_list['DI1'].values[i]
        DI2 = dev_list['DI2'].values[i]
        DI3 = dev_list['DI3'].values[i]
        DO0 = dev_list['DO0'].values[i]
        DO1 = dev_list['DO0'].values[i]
        DO2 = dev_list['DO0'].values[i]
        DO3 = dev_list['DO0'].values[i]

        device = {
            "name": name,
            "id": int(id),
            "ip": ip,
            "campos": campos,
            "notes": notes,
            "DI0": int(DI0),
            "DI1": int(DI1),
            "DI2": int(DI2),
            "DI3": int(DI3),
            "DO0": int(DO0),
            "DO1": int(DO1),
            "DO2": int(DO2),
            "DO3": int(DO3)
        }
        devicelist.append(device)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": devicelist
    }
    return make_response(res)

@device_list_blueprint.route('/camera_api/iot/camera/equipment/del', methods=['POST'])
def device_del():
    deviceid = request.json.get('id')

    sql = "DELETE FROM icam_device_data WHERE id='"+ str(deviceid) +"'"
    db.execute_db(sql)

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":True
    }
    return make_response(res)

@device_list_blueprint.route('/camera_api/iot/camera/equipment/add', methods=['POST'])
def device_add():
    name = request.json.get('name')
    ip = request.json.get('ip')
    campos = request.json.get('campos')
    notes = request.json.get('notes')
    DI0 = request.json.get('DI0')
    DI1 = request.json.get('DI1')
    DI2 = request.json.get('DI2')
    DI3 = request.json.get('DI3')
    DO0 = request.json.get('DO0')
    DO1 = request.json.get('DO1')
    DO2 = request.json.get('DO2')
    DO3 = request.json.get('DO3')

    data = [name,campos,notes,DI0,DI1,DI2,DI3,DO0,DO1,DO2,DO3]
    SQL1 = f"Insert Into icamera_data.icam_device_data (name, ip, campos, notes, DI0, DI1, DI2, DI3, DO0, DO1, DO2, DO3) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}','{data[4]}','{data[5]},'{data[6]}','{data[7]}','{data[8]}','{data[9]}','{data[10]}','{data[11]}');"
    db.execute_db(SQL1)

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":True
    }
    return make_response(res)