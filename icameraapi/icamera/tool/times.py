def getTimes(start, end):
    result = []
    date_start = start
    date_end = end
    result.append(start)
    while date_start < date_end:
        date_start += 1
        result.append(date_start)
    return result
