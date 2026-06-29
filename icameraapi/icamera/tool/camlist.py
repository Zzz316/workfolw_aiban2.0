from icamera.common.mysql_operate import db

def camname(select):
    cam_list = []
    camlist = []
    sql_cam = "SELECT * FROM icam_camera_data"
    df_cam = db.select_db(sql_cam)
    for i in range(len(df_cam)):
        cam = df_cam['name'].values[i]
        cam_list.append(cam)
        id = int(df_cam['id'].values[i])
        campathlist = df_cam['mname'].values[i]
        name = {"id": id, "name": campathlist}
        camlist.append(name)
    if select == 0:
        return cam_list
    if select == 1:
        return camlist