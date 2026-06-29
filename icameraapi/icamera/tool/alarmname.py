from icamera.common.mysql_operate import db

def alarmname(select):
    alarm_list = []
    alarmlist = []
    sql_alarm = "SELECT * FROM icam_alarmname_data"
    df_alarm = db.select_db(sql_alarm)
    for i in range(len(df_alarm)):
        alarm = df_alarm['alarmname'].values[i]
        alarm_list.append(alarm)
        id = int(df_alarm['id'].values[i])
        alarmpathlist = df_alarm['alarmname'].values[i]
        name = {"id": id, "name": alarmpathlist}
        alarmlist.append(name)
    if select == 0:
        return alarm_list
    if select == 1:
        return alarmlist