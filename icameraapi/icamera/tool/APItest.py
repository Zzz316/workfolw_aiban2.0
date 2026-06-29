import socket
import os
import requests
import datetime
import random
import hashlib

def aping(ngcode,ngarea):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        videohome = "C:\\Users\\xuweijun\\Desktop\\logs\\"
        lists = os.listdir( videohome )
        lists.sort(key=lambda x: os.path.getmtime( videohome + x))
        data_path = lists[-1]
        data_path = os.path.join(videohome , lists[-1])
        files = {'files': open(data_path, 'rb')}

        # url = 'https://iot-ati.mega-oasis.com/core/api/iot-camera-data/data-report'
        url = 'http://192.168.101.37:9099/core/api/iot/camera/data-report'
        trackid = str(datetime.datetime.now())
        deviceCode = 'TEST_01'
        params = {
            "deviceCode": deviceCode,
            "deviceIp": str(ip),
            "deviceSn": '21A506934',
            "trackId": trackid,
            "dataType": 'NG',
            "params": '{"defectType":"' + ngcode + '","defaultArea":"' + ngarea + '","trackId":"' + trackid + '"}'
        }
        nuvaTs = str(random.randint(10, 99))+str(int(datetime.datetime.now().timestamp())*1000)+str(random.randint(10, 99))
        sigSource = nuvaTs + trackid + deviceCode
        nuvaSig = hashlib.md5(sigSource.encode('UTF-8')).hexdigest() # md5加密
        headers = { "nuvaTs" : nuvaTs,"nuvaSig" : nuvaSig }
        print(headers)
        print(params)
        response = requests.post(url,headers=headers,data=params, files=files)
        print(response.text)
    except Exception as e:
        print("", str(e))
        pass

aping("人车安全距离","一号大厅")
