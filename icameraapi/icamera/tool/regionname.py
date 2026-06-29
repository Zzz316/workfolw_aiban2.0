from icamera.common.mysql_operate import db

def regionname(select):
    region_list = []
    areaslist = []
    sql_region = "SELECT * FROM icam_region_data"
    df_region = db.select_db(sql_region)
    for i in range(len(df_region)):
        region = df_region['region'].values[i]
        region_list.append(region)
        id = int(df_region['id'].values[i])
        areaspathlist = df_region['region'].values[i]
        name = {"id": id, "name": areaspathlist}
        areaslist.append(name)
    del df_region
    if select == 0:
        return region_list
    if select == 1:
        return areaslist