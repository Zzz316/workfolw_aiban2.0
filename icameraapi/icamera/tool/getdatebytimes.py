import datetime

def getDatesByTimes(start_day, end_day):
    result = []
    date_start = datetime.datetime.strptime(start_day, '%Y-%m-%d')
    date_end = datetime.datetime.strptime(end_day, '%Y-%m-%d')
    result.append(date_start.strftime('%Y-%m-%d'))
    while date_start < date_end:
        date_start += datetime.timedelta(days=1)
        result.append(date_start.strftime('%Y-%m-%d'))
    return result
