from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db

#blueprin
camera_aiset_blueprint = Blueprint('camera_aiset', __name__,template_folder='templates')

#route
@camera_aiset_blueprint.route('/camera_api/iot/camera/getfunctionparameter', methods=['GET'])
def getfunctionparameter_get():
    swith_list = []

    sql = "SELECT * FROM icam_getparameter_data"
    df = db.select_db(sql)
    for i in range(len(df)):
        id = int(df['id'].values[i])
        alarmid = df['alarmid'].values[i]
        switch = df['data'].values[i]
        starttime = df['starttime'].values[i]
        endtime =  df['endtime'].values[i]

        swith_new = {"camid": id, "date": bool(switch == 'True'), "starttime": starttime,"endtime": endtime,"alarm": alarmid}
        swith_list.append(swith_new)

    res = {
        "success": True,
        "code": 0,
        "msg": "string",
        "data": swith_list
    }
    return make_response(res)

@camera_aiset_blueprint.route('/camera_api/iot/camera/getfunctionparameter/edit', methods=['POST'])
def getfunctionparameter_post():
    id = int(request.json.get('camid'))
    data = str(request.json.get('date'))
    starttime = str(request.json.get('starttime'))
    endtime = str(request.json.get('endtime'))
    alarmid = str(request.json.get('alarm'))

    set_up_data = "SELECT * FROM icam_getparameter_data WHERE id='" + str(id) + "'"
    set_up_sql = db.select_db(set_up_data)
    if set_up_sql.empty:
        data = [id, data,starttime,endtime,alarmid]
        SQL = f"Insert Into icamera_data.icam_getparameter_data (id, data,starttime,endtime,alarmid) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}','{data[4]}');"
        db.execute_db(SQL)
    else:
        sql1 = "update icam_getparameter_data set data = '" + data + "',starttime = '" + starttime + "',endtime = '" + endtime + "',alarmid = '" + alarmid + "'where id='" + str(id) + "'"
        db.execute_db(sql1)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": True
    }
    return make_response(res)

@camera_aiset_blueprint.route('/camera_api/iot/camera/getfunctionparameter/del', methods=['POST'])
def getfunctionparameter_del():
    id = str(request.json.get('camid'))

    sql = "DELETE FROM icam_getparameter_data WHERE id='"+ id +"'"
    db.execute_db(sql)

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":True
    }
    return make_response(res)

# @camera_aiset_blueprint.route('/camera_api/iot/camera/getfunctionparameter/add', methods=['POST'])
# def getfunctionparameter_add():
#     id = request.json.get('camid')
#     date = str(request.json.get('date'))
#     monitoringtime = str(request.json.get('Monitoringtime'))
#     recognitiontime = str(request.json.get('Recognitiontime'))
#
#     data = [id,date,monitoringtime,recognitiontime]
#     SQL1 = f"Insert Into icamera_data.icam_getparameter_data (id,data,starttime,endtime) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}');"
#     db.execute_db(SQL1)
#
#     res = {
#         "success": True,
#         "code": 200,
#         "msg":'',
#         "data":True
#     }
#     return make_response(res)