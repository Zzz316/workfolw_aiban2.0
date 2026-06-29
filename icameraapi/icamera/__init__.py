from flask import Flask
from icamera.app.login.user_login import users_login_blueprint
from icamera.app.home.monitor import monitor_blueprint
from icamera.app.home.server_path import server_path_blueprint
from icamera.app.home.history_data import history_data_blueprint
from icamera.app.home.beat_data import beat_data_blueprint
from icamera.app.home.historical_charts import historical_charts_blueprint
from icamera.app.home.visual_dashboard import visual_dashboard_blueprint
from icamera.app.home.station_monitor import station_monitor_blueprint
from icamera.app.home.team_manage import team_manage_blueprint
from icamera.app.camera.area_data import area_data_blueprint
from icamera.app.camera.alarm_data import alarm_data_blueprint
from icamera.app.camera.camera_list import camera_list_blueprint
from icamera.app.camera.camera_roi import camera_roi_blueprint
from icamera.app.camera.camera_aiset import camera_aiset_blueprint
from icamera.app.model.model_list import model_list_blueprint
from icamera.app.scene.scene_list import scene_list_blueprint
from icamera.app.device.device_list import device_list_blueprint
from icamera.app.system.system import system_blueprint
from icamera.app.system.loginset import loginset_blueprint
from icamera.app.system.teamset import team_blueprint
from icamera.app.system.line_list import line_list_blueprint
from icamera.app.system.logicalOrch import logicalOrch_blueprint


app = Flask(__name__)

# register our blueprints
app.register_blueprint(users_login_blueprint)
app.register_blueprint(station_monitor_blueprint)
app.register_blueprint(team_manage_blueprint)
app.register_blueprint(monitor_blueprint)
app.register_blueprint(server_path_blueprint)
app.register_blueprint(history_data_blueprint)
app.register_blueprint(beat_data_blueprint)
app.register_blueprint(historical_charts_blueprint)
app.register_blueprint(visual_dashboard_blueprint)
app.register_blueprint(area_data_blueprint)
app.register_blueprint(alarm_data_blueprint)
app.register_blueprint(camera_list_blueprint)
app.register_blueprint(camera_roi_blueprint)
app.register_blueprint(camera_aiset_blueprint)
app.register_blueprint(model_list_blueprint)
app.register_blueprint(scene_list_blueprint)
app.register_blueprint(device_list_blueprint)
app.register_blueprint(system_blueprint)
app.register_blueprint(loginset_blueprint)
app.register_blueprint(team_blueprint)
app.register_blueprint(line_list_blueprint)
app.register_blueprint(logicalOrch_blueprint)