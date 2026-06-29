import datetime
from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
from icamera.tool.camname import camname
import pandas as pd

#blueprin
beat_data_blueprint = Blueprint('beat_data', __name__,template_folder='templates')

#route
@beat_data_blueprint.route('/camera_api/iot/camera/get-beat',  methods=['GET'])
def get_beat_data():
    # try:
    alarm_new = []
    starttime = request.args.get('start')
    endtime = request.args.get('end')
    camid = request.args.get('cam').split(",")
    camid_filtered = [num for num in camid if num and num.strip()]
    result_list = [str(int(num) - 1) for num in camid_filtered]
    cam_list = [camname(0)[int(x)] for x in result_list]
    date_start = datetime.datetime.strptime(starttime, '%Y-%m-%d %H:%M:%S')
    date_end = datetime.datetime.strptime(endtime, '%Y-%m-%d %H:%M:%S')
    if len(camid) > 1:
        sql = "SELECT * FROM icam_process_timing_siemens where camname in{}".format(tuple(cam_list)) + ""
        df = db.select_db(sql)
        df = df.sort_index(ascending=False)
        df = df[(df['daytime'] >= date_start) & (df['daytime'] <= date_end)]
        df = df.reset_index(drop=True)
        for i in range(len(df)):
            realtime = df['daytime'][i]
            realregion = df['region'][i]
            camename = df['camname'][i]
            starttime = df['starttime'][i]
            endtime = df['endtime'][i]
            # 为 process 添加空值检查
            process_val = df['calculate_process'][i]
            process = int(process_val) if process_val not in [None, '', 'null', 'NULL'] and pd.notna(process_val) else 0
            # 为 per_leaving 添加空值检查
            per_leaving_val = df['per_leaving'][i]
            per_leaving = int(per_leaving_val) if per_leaving_val not in [None, '', 'null', 'NULL'] and pd.notna(per_leaving_val) else 0
            date = {"time": str(realtime), "region": realregion, "camname": camename, "starttime": starttime,
                    "endtime": endtime,"process": process,"Person_leaving": per_leaving}
            alarm_new.append(date)

    if len(camid) == 1:
        sql = "SELECT * FROM icam_process_timing_siemens where camname ='" + cam_list[0] + "'"
        df = db.select_db(sql)
        df = df.sort_index(ascending=False)
        df = df[(df['daytime'] >= date_start) & (df['daytime'] <= date_end)]
        df = df.reset_index(drop=True)
        for i in range(len(df)):
            realtime = df['daytime'][i]
            realregion = df['region'][i]
            camename = df['camname'][i]
            starttime = df['starttime'][i]
            endtime = df['endtime'][i]
            # 为 process 添加空值检查
            process_val = df['calculate_process'][i]
            process = int(process_val) if process_val not in [None, '', 'null', 'NULL'] and pd.notna(process_val) else 0
            # 为 per_leaving 添加空值检查
            per_leaving_val = df['per_leaving'][i]
            per_leaving = int(per_leaving_val) if per_leaving_val not in [None, '', 'null', 'NULL'] and pd.notna(per_leaving_val) else 0
            date = {"time": str(realtime), "region": realregion, "camname": camename, "starttime": starttime,
                    "endtime": endtime, "process": process,"Person_leaving": per_leaving}
            alarm_new.append(date)

    res = {
        "success": False,
        "code": 47,
        "msg": "in",
        "data": alarm_new
    }
    return make_response(res)

    # except Exception as ee:
    #     print('ee')