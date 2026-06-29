import datetime
import time
import pandas as pd
from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
from icamera.tool.alarmname import alarmname
# from icamera.tool.regionname import regionname
from icamera.tool.getdatebytimes import getDatesByTimes
from icamera.tool.times import getTimes

#blueprin
historical_charts_blueprint = Blueprint('historical_charts', __name__,template_folder='templates')
real_alarmname = alarmname(0)
# real_regionname = regionname(0)

#route
@historical_charts_blueprint.route('/camera_api/iot/camera/get-real-stat-info-day', methods=['GET'])
def real_time():
    day = request.args.get('day')
    alarm = [0,1,2,3]
    data = []
    alarmcontent_list = [real_alarmname[int(x)] for x in alarm]
    for ls in alarmcontent_list:
        sql = "SELECT * FROM icam_alarm_data where day='"+ day +"'&& alarm_content='"+ ls +"'"
        df = db.select_db(sql)
        data_list = {"err": ls,"count": len(df),"num": 0,"id": 0}
        data.append(data_list)

    res = {
        'success': True,
        'code': 200,
        'data': {
            'errStats':data
        }
    }
    return make_response(res)


@historical_charts_blueprint.route('/camera_api/iot/camera/get-real-stat-info-qunchuang', methods=['GET'])
def real_time_qunchuang():
    alarm = request.args.get('alarm').split(",")
    area = request.args.get('area').split(",")
    alarm_new = []

    area_list = [real_regionname[int(x)] for x in area]
    alarmcontent_list = [real_alarmname[int(x)] for x in alarm]

    start = request.args.get('start')
    end = request.args.get('end')
    for ls in alarmcontent_list:
            if len(area_list) > 1:
                sql = "SELECT * FROM icam_alarm_data WHERE day BETWEEN '" + start + "' AND '" + end + "'&&region in{}".format(tuple(area_list)) + "&&alarm_content ='" + ls + "'"
                df = db.select_db(sql)
                alarm_path = {"err": ls, "count": len(df),"num": 0,"id": 0}
                alarm_new.append(alarm_path)

            if len(area_list) == 1:
                sql = "SELECT * FROM icam_alarm_data WHERE day BETWEEN '" + start + "' AND '" + end + "'&& region='" + area_list[0] + "'&& alarm_content ='" + ls + "'"
                df = db.select_db(sql)
                alarm_path = {"err": ls, "count": 0,"num": len(df),"id": 0}
                alarm_new.append(alarm_path)

    res = {
        'success': True,
        'code': 200,
        'data': {
            'errStats':alarm_new
        }
    }
    return make_response(res)

@historical_charts_blueprint.route('/camera_api/iot/camera/get-history-stat-info-lenovo',  methods=['GET'])
def getUrlInfo():
    alarm = request.args.get('alarm').split(",")
    data_list = []
    alarm_new = []

    alarmcontent_list = [real_alarmname[int(x)] for x in alarm]

    start = request.args.get('start')
    end = request.args.get('end')
    for i in range(len(getDatesByTimes(start, end))):
        # try:
        alarm_new.append([])
        if len(alarmcontent_list) > 1:
            for ls in alarmcontent_list:
                sql = "SELECT * FROM icam_alarm_data where day='" + getDatesByTimes(start, end)[i] + "'&&alarm_content='" + ls + "'"
                df = db.select_db(sql)
                alarm_path = {"err": ls, "num": len(df)}
                alarm_new[i].append(alarm_path)

        if len(alarmcontent_list) == 1:
            sql = "SELECT * FROM icam_alarm_data where day='" + getDatesByTimes(start, end)[i] + "'&&alarm_content ='" + alarmcontent_list[0] + "'"
            df = db.select_db(sql)
            alarm_path = {"err": alarmcontent_list[0], "num": len(df)}
            alarm_new[i].append(alarm_path)

        # except Exception as ee:
        #     print('ee')

        data_new = {"xLabel": getDatesByTimes(start, end)[i], "errStats": alarm_new[i]}
        data_list.append(data_new)

    res = {
        "success": True,
        "code": 200,
        "msg": "",
        "data": {
            "errStats": data_list
        }
    }
    return make_response(res)