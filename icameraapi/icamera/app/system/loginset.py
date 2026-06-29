from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db

#blueprin
loginset_blueprint = Blueprint('loginset', __name__,template_folder='templates')

#route
# @loginset_blueprint.route('/camera_api/iot/camera/user/list', methods=['GET'])
# def user_list():
#     userlist = []
#
#     sql_user_list = "SELECT * FROM icam_user_data"
#     df_user_list = db.select_db(sql_user_list)
#     for i in range(len(df_user_list)):
#         userpathlist = df_user_list['user'].values[i]
#         user = {"username": userpathlist,"id":i}
#         userlist.append(user)
#
#     res = {
#         "success": True,
#         "code": 47,
#         "msg": "",
#         "data": userlist
#     }
#     return make_response(res)

# @loginset_blueprint.route('/camera_api/iot/camera/user/add', methods=['POST'])
# def user_add():
#     user = request.json.get('username')
#     password = request.json.get('password')
#
#     data = [user,password]
#     SQL1 = f"Insert Into icamera_data.icam_user_data (user, password) Values ('{data[0]}', '{data[1]}');"
#     db.execute_db(SQL1)
#
#     res = {
#         "success": True,
#         "code": 200,
#         "msg":'',
#         "data":True
#     }
#     return make_response(res)
#
# @loginset_blueprint.route('/camera_api/iot/camera/user/edit', methods=['POST'])
# def user_edit():
#     user = request.json.get('username')
#     password = request.json.get('password')
#
#     sql = "update user_data set password = '"+ password +"' where user='"+ user +"'"
#     db.execute_db(sql)
#
#     res = {
#         "success": True,
#         "code": 200,
#         "msg":'',
#         "data":True
#     }
#     return make_response(res)
#
# @loginset_blueprint.route('/camera_api/iot/camera/user/del', methods=['POST'])
# def user_del():
#     user = request.json.get('user')
#
#     sql = "DELETE FROM user_data WHERE user='"+ user +"'"
#     db.execute_db(sql)
#
#     res = {
#         "success": True,
#         "code": 200,
#         "msg":'',
#         "data":True
#     }
#     return make_response(res)