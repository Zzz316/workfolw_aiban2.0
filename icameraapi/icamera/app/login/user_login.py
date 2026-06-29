# -*- coding: utf-8 -*-
import requests
from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db

#blueprin
users_login_blueprint = Blueprint('users_login', __name__,template_folder='templates')

def user_login_aping(token):
    try:
        url = 'http://127.0.0.1:6090/core/api/mdm/user/info'
        appsecret = token
        headers = { "Authorization": appsecret,"content-type": "application/json; charset=UTF-8"}
        response = requests.get(url, headers=headers)
        data = response.json()
        user = data['data']['user']['userName']
        return user
    except Exception as e:
        print("", str(e))
        pass

#route
@users_login_blueprint.route('/camera_api/iot/camera/login', methods=['POST'])
def user_login():
    user = request.json.get('username')
    real_password = request.json.get('password')

    sql_user = "SELECT * FROM icam_user_data where user='" + user + "'"
    df_user = db.select_db(sql_user)

    if len(df_user) > 0:
        if df_user['password'].values[0] == real_password:
            data = True
        else:
            data = False
    else:
        data = False

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":data,
        "bi": ''
    }
    return make_response(res)

@users_login_blueprint.route('/camera_api/iot/camera/login_nuva', methods=['POST'])
def user_login_nuva():
    token = request.json.get('token')
    user = user_login_aping(token)
    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":'',
        "userName": user
    }
    return make_response(res)

@users_login_blueprint.route('/camera_api/iot/camera/get-name', methods=['GET'])
def real_name():
    res = {
        'success': True,
        'code': 47,
        'data':{
            'home': 'VisionSense 智控平台',
            'camera':'VisionSense 智控平台',
            'system':'VisionSense 智控平台'
        }
    }
    return make_response(res)