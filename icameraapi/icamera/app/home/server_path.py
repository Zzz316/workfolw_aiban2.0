from flask import make_response, Blueprint

#blueprin
server_path_blueprint = Blueprint('server_path', __name__,template_folder='templates')

#route
@server_path_blueprint.route('/server_path', methods=['GET'])
def server_path():
    res = {
        'success': False,
        'code': 47,
        'data': ''
    }
    return make_response(res)