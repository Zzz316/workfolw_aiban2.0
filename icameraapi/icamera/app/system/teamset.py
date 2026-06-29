import requests
from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db
from icamera.tool.alarmname import alarmname

#blueprin
team_blueprint = Blueprint('teamset', __name__,template_folder='templates')

#route
def find_user_by_name(users,name):
    if name is None or name.strip() == "":
        return users  # 返回所有用户（格式不变）
    else:
        # 查找匹配的用户名（不区分大小写）
        matched_users = [user for user in users if name.lower() in user['username'].lower()]
        return matched_users  # 返回匹配的用户列表（格式不变）

def team_aping(token,filter_username):
    try:
        url = 'http://127.0.0.1:6090/core/api/mdm/user/list'
        appsecret = token
        headers = {"Authorization": appsecret, "content-type": "application/json; charset=UTF-8"}
        response = requests.get(url, headers=headers)
        data = response.json()

        usernames_with_id = [
            {"id": idx, "username": user['userName']}
            for idx, user in enumerate(data['data'])
        ]

        filtered_users = find_user_by_name(usernames_with_id,filter_username)
        return filtered_users
    except Exception as e:
        print("", str(e))
        pass

@team_blueprint.route('/camera_api/iot/camera/user/list', methods=['GET'])
def user_list():
    token = request.args.get('token')
    query_user = request.args.get('userName')
    data_list = team_aping(token,query_user)

    res = {
            "success": True,
            "code": 47,
            "msg": "",
            "data": data_list
        }
    return make_response(res)

@team_blueprint.route('/camera_api/iot/camera/team/list', methods=['GET'])
def team_list():
    teamlist = []
    team_list = "SELECT * FROM icam_teams_data"
    team_list = db.select_db(team_list)
    for i in range(len(team_list)):
        id = int(team_list['id'].values[i])
        name = team_list['team'].values[i]
        userlist = team_list['user'].values[i].split(",")
        user_with_id = [{'id': idx + 1, 'name': name} for idx, name in enumerate(userlist)]
        alarm_id = team_list['alarm'].values[i].split(",")
        alarm_name = [alarmname(1)[int(x)] for x in alarm_id]
        # alarm_list = [{'id': int(id_str), 'name': name} for id_str, name in zip(alarm_id, alarm_name)]

        team = {
            "id": id,
            "team": name,
            "user": user_with_id,
            "alarm": alarm_name
        }
        teamlist.append(team)

    res = {
        "success": True,
        "code": 200,
        "msg": '',
        "data": teamlist
    }
    return make_response(res)

@team_blueprint.route('/camera_api/iot/camera/team/add', methods=['POST'])
def team_add():
    alarmid = request.json.get('alarmid')
    username = request.json.get('username')
    teamname = request.json.get('teamname')

    sql = "SELECT * FROM icam_teams_data"
    df = db.select_db(sql)
    if df.empty:
        id = 1
        data = [id,teamname,username,alarmid]
        sql = f"Insert Into icamera_data.icam_teams_data (id, team, user, alarm) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}');"
        db.execute_db(sql)
    else:
        id = len(df) + 1
        data = [id, teamname, username, alarmid]
        sql = f"Insert Into icamera_data.icam_teams_data (id, team, user, alarm) Values ('{data[0]}','{data[1]}','{data[2]}','{data[3]}');"
        db.execute_db(sql)

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":True
    }
    return make_response(res)

@team_blueprint.route('/camera_api/iot/camera/team/del', methods=['POST'])
def team_del():
    id = request.json.get('teamid')

    sql = "DELETE FROM icam_teams_data WHERE id='"+ str(id) +"'"
    db.execute_db(sql)

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":True
    }
    return make_response(res)

@team_blueprint.route('/camera_api/iot/camera/team/edit', methods=['POST'])
def team_edit():
    id = str(request.json.get('id'))
    alarmid = request.json.get('alarmid')
    username = request.json.get('username')
    teamname = request.json.get('teamname')

    sql = "update icam_teams_data set team = '"+ teamname +"',user = '"+ username +"',alarm = '"+ alarmid +"'where id='"+ id +"'"
    db.execute_db(sql)

    res = {
        "success": True,
        "code": 200,
        "msg":'',
        "data":True
    }
    return make_response(res)

