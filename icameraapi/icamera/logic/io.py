import AiBanToolsPy3_9 as AiBanToolsPy
from icamera.common.mysql_operate import db

class IO():
    def __init__(self):
        self.toolsinstance = AiBanToolsPy.aibanToolsGetInstance()

    def select_db(self):
        try:
            dev_list = "SELECT * FROM icam_device_data"
            dev_list = db.select_db(dev_list)
        except Exception as ee:
            print(ee)

        if len(dev_list) > 0:
            for i in range(len(dev_list)):
                ip = dev_list['ip'].values[i]
                campos = dev_list['campos'].values[i]

