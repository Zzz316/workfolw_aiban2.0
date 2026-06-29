import sys
import os
import time
import datetime
import pymysql
import subprocess
import logging
import queue
from multiprocessing import Process, Queue, Pipe
from logging.handlers import QueueHandler, QueueListener
from threading import Timer

import iCamera.logic.ai
import iCamera.logic.luoji
import AiBanVideoPy3_9 as AiBanVideoPy

class MyLogger:
    def __init__(self, logdir, logname, isdebug=False, name=__name__):
        # 创建一个loggger
        self.__name = name
        self.logger = logging.getLogger(self.__name)
        self.logger.setLevel(logging.DEBUG)
        self.logdir = logdir
        self.logname = logname
        self.debug = isdebug
        self.buff = ''

        # 创建一个handler，用于写入日志文件 log_path = os.path.dirname(os.path.abspath(__file__)) logname = log_path + '/' +
        # 'out.log'  # 指定输出的日志文件名 fh = logging.handlers.TimedRotatingFileHandler(logname, when='M', interval=1,
        # backupCount=5,encoding='utf-8')  # 指定utf-8格式编码，避免输出的日志文本乱码
        fh = logging.FileHandler(self.logdir + self.logname, mode='a', encoding='utf-8')  # 不拆分日志文件，a指追加模式,w为覆盖模式
        fh.setLevel(logging.DEBUG)

        # 创建一个handler，用于将日志输出到控制台
        # ch = logging.StreamHandler()
        # ch.setLevel(logging.DEBUG)

        # 定义handler的输出格式
        if self.debug:
            formatter = logging.Formatter('%(asctime)s-%(name)s-%(filename)s-[line:%(lineno)d]'
                                          '-%(levelname)s-[logmessage]: %(message)s',
                                          datefmt='%a, %d %b %Y %H:%M:%S')
        else:
            formatter = logging.Formatter('%(asctime)s-%(levelname)s: %(message)s', datefmt='%Y%m%d %H:%M:%S')

        fh.setFormatter(formatter)
        # ch.setFormatter(formatter)

        # 给logger添加handler
        que = queue.Queue(-1)  # no limit on size
        queue_handler = QueueHandler(que)
        self.listener = QueueListener(que, fh)
        self.logger.addHandler(queue_handler)
        self.listener.start()

    def write(self, output_stream):
        # if output_stream != '\n':
        self.buff += output_stream

    def flush(self):
        self.logger.info(self.buff)
        self.buff = ''

    def close_log(self):
        self.listener.stop()

    @property
    def get_log(self):
        """定义一个函数，回调logger实例"""
        return self.logger

    def get_logdir(self):
        """返回log位置"""
        return self.logdir

    def get_logname(self):
        """返回log名称"""
        return self.logname

# 全局多进程 log
mylog_helper = MyLogger('', 'vido_main.log', name=__name__)
global_sys_logger = mylog_helper.get_log

class normal_counter:
    def __int__(self):
        self.status = False
        self.up = 0
        self.down = 0

    def setdefault(self):
        self.status = False
        self.up = 0
        self.down = 0

class AibanVideoAlarm:
    def __init__(self, msqu=None):
        # 线程控制型号
        self.alarm_queue = msqu
        global_sys_logger.info('alarm parameters is ok, pid=%d', os.getpid())

    def run(self):
        t = Timer(1, self.alam_process)
        t.start()

    def ConnectMySQL(self,HostName, UserName, PassWord):
        con = pymysql.connect(host=HostName, user=UserName, passwd=PassWord, charset='GB2312')
        cur = con.cursor()
        return con, cur

    def SaveDb(self,con, cur, data):
        SQL1 = f"Insert Into icamera_data.alarm_data (day,time, time_division, time_month, week, region, camera_id, alarm_content,img_path,timedate) Values ('{data[0]}', '{data[1]}', '{data[2]}','{data[3]}', '{data[4]}', '{data[5]}', '{data[6]}', '{data[7]}', '{data[8]}', '{data[9]}');"
        cur.execute(SQL1)
        con.commit()
        time.sleep(0.5)

    def Saveqiwei(self,con, cur, data):
        SQL1 = (f"Insert Into ami_mom_qa.epdca_event (ID, MAIN_TYPE, SUB_TYPE, EVENT_LEVEL, TITLE, CONTENT, START_TIME,SITE_CODE,FAB_CODE,AREA_CODE,SOURCE_USER,CREATE_BY,CREATE_TIME) Values "
                f"('{data[0]}','{data[1]}','{data[2]}', '{data[3]}', '{data[4]}', '{data[5]}', '{data[6]}', '{data[7]}', '{data[8]}', '{data[9]}', '{data[10]}', '{data[11]}', '{data[12]}');")
        cur.execute(SQL1)
        con.commit()
        time.sleep(0.5)

    def getDatesByTimes(self,start_day, end_day):
        result = []
        date_start = int(start_day[0:2])
        date_end = int(end_day[0:2])
        result.append(date_start)
        while date_start > date_end:
                date_start += 1
                if date_start == 23:
                    date_start = 0
                result.append(date_start)
        while date_start < date_end:
            date_start +=1
            result.append(date_start)
        return result

    # 来自子进程的报警信息
    def alam_process(self):
        try:
            while True:
                if not self.alarm_queue.empty():
                    alarm_info = self.alarm_queue.get()
                    sourceid, groupid, who, led, speak, msg1, msg2 ,msg3= alarm_info.sourceid, alarm_info.groupid, alarm_info.who, alarm_info.led, alarm_info.speak, alarm_info.msg1, alarm_info.msg2, alarm_info.msg3

                    if msg1 or msg2 is not None:
                        try:
                            con2, cur2 = self.ConnectMySQL("127.0.0.1", "root", "root")
                            data = [datetime.datetime.now().strftime('%Y-%m-%d'), datetime.datetime.now().strftime('%H:%M:%S'),
                                    datetime.datetime.now().strftime('%H:%M'), datetime.datetime.now().strftime('%m'),
                                    datetime.datetime.now().isocalendar()[1], msg1, sourceid, msg2, msg3,datetime.datetime.now()]
                            self.SaveDb(con2, cur2, data)
                        except Exception as e:
                            global_sys_logger.exception(e)

                    if sourceid in [1,2,3,4,5,6,8,10]:
                        if speak == 1 or 3:
                            self.wenxuanbaoanshi.modbusWriteCoil(0, True)
                        if speak == 0 or 2:
                            self.wenxuanbaoanshi.modbusWriteCoil(0, False)
                    if sourceid in [11,13,14,15]:
                        if speak == 1 or 3:
                            self.jiankangbaoanshi.modbusWriteCoil(0, True)
                        if speak == 0 or 2:
                            self.jiankangbaoanshi.modbusWriteCoil(0, False)

                    if groupid == 1:
                        if sourceid in [1,2] and int(datetime.datetime.now().strftime("%H")) in self.getDatesByTimes(self.timestart1,self.timeend1):
                            if speak == 1:
                                self.wenxuan5shitang.modbusWriteCoil(0, True)
                            if speak == 0:
                                self.wenxuan5shitang.modbusWriteCoil(0, False)
                            if speak == 3:
                                self.wenxuan5shitang.modbusWriteCoil(1, True)
                            if speak == 2:
                                self.wenxuan5shitang.modbusWriteCoil(1, False)
                        if sourceid in [8,10] and int(datetime.datetime.now().strftime("%H")) in self.getDatesByTimes(self.timestart2,self.timeend2):
                            if speak == 1:
                                self.wenxuan3louti.modbusWriteCoil(0, True)
                            if speak == 0:
                                self.wenxuan3louti.modbusWriteCoil(0, False)
                            if speak == 3:
                                self.wenxuan3louti.modbusWriteCoil(1, True)
                            if speak == 2:
                                self.wenxuan3louti.modbusWriteCoil(1, False)
                        if sourceid == 11 and int(datetime.datetime.now().strftime("%H")) in self.getDatesByTimes(self.timestart6, self.timeend6):
                            if speak == 1:
                                self.jiankangshitang.modbusWriteCoil(0, True)
                            if speak == 0:
                                self.jiankangshitang.modbusWriteCoil(0, False)
                            if speak == 3:
                                self.jiankangshitang.modbusWriteCoil(1, True)
                            if speak == 2:
                                self.jiankangshitang.modbusWriteCoil(1, False)
                    if groupid == 2:
                        if sourceid == 3 and int(datetime.datetime.now().strftime("%H")) in self.getDatesByTimes(self.timestart3, self.timeend3):
                            if speak == 1:
                                self.wenxuanchechurukou.modbusWriteCoil(0, True)
                            if speak == 0:
                                self.wenxuanchechurukou.modbusWriteCoil(0, False)
                        # if sourceid == 4 and int(datetime.datetime.now().strftime("%H")) in self.getDatesByTimes(self.timestart4, self.timeend4):
                        #     if speak == 1:
                        #         self.wenxuancherukou.modbusWriteCoil(0, True)
                        #     if speak == 0:
                        #         self.wenxuancherukou.modbusWriteCoil(0, False)
                        # if sourceid == 5 and int(datetime.datetime.now().strftime("%H")) in self.getDatesByTimes(self.timestart4, self.timeend4):
                        #     if speak == 1:
                        #         self.wenxuancherukou.modbusWriteCoil(1, True)
                        #     if speak == 0:
                        #         self.wenxuancherukou.modbusWriteCoil(1, False)
                        if sourceid == 6 and int(datetime.datetime.now().strftime("%H")) in self.getDatesByTimes(self.timestart5,self.timeend5):
                            if speak == 1:
                                self.wenxuanchechukou.modbusWriteCoil(0, True)
                            if speak == 0:
                                self.wenxuanchechukou.modbusWriteCoil(0, False)
                            if speak == 3:
                                self.wenxuanchechukou.modbusWriteCoil(1, True)
                            if speak == 2:
                                self.wenxuanchechukou.modbusWriteCoil(1, False)
                        if sourceid == 13 and int(datetime.datetime.now().strftime("%H")) in self.getDatesByTimes(self.timestart8,self.timeend8):
                            if speak == 1:
                                self.jiankangchechukou.modbusWriteCoil(0, True)
                            if speak == 0:
                                self.jiankangchechukou.modbusWriteCoil(0, False)
                            if speak == 3:
                                self.jiankangchechukou.modbusWriteCoil(1, True)
                            if speak == 2:
                                self.jiankangchechukou.modbusWriteCoil(1, False)
                        if sourceid == 14 and int(datetime.datetime.now().strftime("%H")) in self.getDatesByTimes(self.timestart7,self.timeend7):
                            if speak == 1:
                                self.jiankangcherukou.modbusWriteCoil(0, True)
                            if speak == 0:
                                self.jiankangcherukou.modbusWriteCoil(0, False)
                        if sourceid == 15 and int(datetime.datetime.now().strftime("%H")) in self.getDatesByTimes(self.timestart7,self.timeend7):
                            if speak == 1:
                                self.jiankangcherukou.modbusWriteCoil(1, True)
                            if speak == 0:
                                self.jiankangcherukou.modbusWriteCoil(1, False)

        except Exception as ee:
            global_sys_logger.exception(ee)
#############################################################################################################################################################################################
class alam_msg:
    def __init__(self, gid, sid, who, led, speak, msg1, msg2, msg3):
        self.sourceid = sid
        self.groupid = gid
        self.who = who
        self.led = led
        self.speak = speak
        self.msg1 = msg1
        self.msg2 = msg2
        self.msg3 = msg3

    def setmsg(self, ngid, nsid, nwho, nled, nspeak, nmsg1, nmsg2, nmsg3):
        self.sourceid = nsid
        self.groupid = ngid
        self.who = nwho
        self.led = nled
        self.speak = nspeak
        self.msg1 = nmsg1
        self.msg2 = nmsg2
        self.msg3 = nmsg3

class AibanVideoProcess:
    def __init__(self, msgqueue, userconfig, piplieconfig):
        try:
            # 1.0引擎初始化，只能初始化一次，建议程式全局保存接口
            subprocess.Popen(['python', './webRun_data.py'])
            self.videoinstance = AiBanVideoPy.aibanVideoGetInstance()

            self.userconfig = userconfig
            self.piplieconfig = piplieconfig

            # 用户类
            self.alarm_queue_msg = alam_msg(None, None, None, None, None, None,None,None)
            self.alarm_queue = msgqueue

            global_sys_logger.info('vidoe process init ok, pid=%d', os.getpid())
        except Exception as ee:
            global_sys_logger.exception(ee)

    def run(self):
        print("user video run")
        # 设置回调函数
        self.videoinstance.registerVideoResultFunc(self.aibanvideometadataresult_callback)

        # 检查配置文档
        checkconfig = self.videoinstance.checkAllConfig(self.piplieconfig)
        if checkconfig != AiBanVideoPy.abErrorCode.aSUCCESS:
            print("user video checkconfig err")
            return False
        # 运行pipline
        buildpiline = self.videoinstance.buildPipline()
        if buildpiline != AiBanVideoPy.abErrorCode.aSUCCESS:
            print("user video buildpiline err")
            return False

    def sendMainProcessAlarm(self, gid, sid, who, led, speak, msg1, msg2, msg3):
        try:
            self.alarm_queue_msg.setmsg(gid, sid, who, led, speak, msg1, msg2, msg3)
            self.alarm_queue.put(self.alarm_queue_msg)

        except Exception as ee:
            global_sys_logger.exception(ee)

    def aibanvideometadataresult_callback(self, err: bool, groupid: int, sourceid: int, metadata: AiBanVideoPy.IAibanVideoMetaData):
        try:
            if not err:
                self.chushihua = logic.luoji.luoji.cvDrawBoxes(self, self.chushihua, (groupid, sourceid, metadata),
                                                         self.alarm_queue)
                if not self.alarm_queue.empty():
                    alarm_info = self.alarm_queue.get()

        except Exception as ee:
            global_sys_logger.exception(ee)

def videowork(p, msgqueue,userconfig, piplieconfig):
    try:
        finished = False
        videointerface = AibanVideoProcess(msgqueue, userconfig, piplieconfig)
        videointerface.run()
        while not finished:
            # time.sleep(1)
            try:
                run = p.recv()
                global_sys_logger.info('videowork receive run single {}'.format(run))
                if run:
                    finished = True
            except EOFError:
                p.close()
                global_sys_logger.info('videowork aiban_vedio_run_p EOFError')
                break

        print("videowork video process exit")
        global_sys_logger.info('videowork video process exit')

    except Exception as ee:
        print(ee)
        global_sys_logger.exception(ee)

def videoalarm(p,msgqueue):
    try:
        finished = False
        videointerface_alarm = AibanVideoAlarm(msgqueue)
        videointerface_alarm.run()
        while not finished:
            # time.sleep(1)
            try:
                run = p.recv()
                global_sys_logger.info('videoalarm receive run single {}'.format(run))
                if run:
                    finished = True
            except EOFError:
                p.close()
                global_sys_logger.info('videoalarm qt_ui_p EOFError')
                break

        print("videoalarmo process exit")
        global_sys_logger.info('videoalarm video process exit')

    except Exception as ee:
        print(ee)
        global_sys_logger.exception(ee)

def except_hook(cls, exception, traceback):
    sys.__excepthook__(cls, exception, traceback)
    print(exception)
    print(traceback)

if __name__ == '__main__':
    # all err
    sys.excepthook = except_hook
    # try:
        # 进程同步信号
    aiban_vedio_run_p, qt_ui_p = Pipe()
    aiban_vedio_msq_queue = Queue()

    # 创建子进程
    global_sys_logger.info('start video process')
    aiban_video_ptr = Process(target=videowork,args=(aiban_vedio_run_p, aiban_vedio_msq_queue,'./config.ini', './AiBanVideoSpace/abvideo/main-flow.yaml'))
    aiban_video_ptr.start()

    try:
        aiban_video_alarm = Process(target=videoalarm, args=(qt_ui_p,aiban_vedio_msq_queue))
        aiban_video_alarm.start()
    except Exception as e:
        global_sys_logger.exception(e)
        global_sys_logger.info('qt ui Exception shutdown video process')
        qt_ui_p.send(True)

    except Exception as e:
        global_sys_logger.exception(e)

    except KeyboardInterrupt:
        global_sys_logger.info('KeyboardInterrupt')

    finally:
        global_sys_logger.info('finally exit')
        mylog_helper.close_log()
