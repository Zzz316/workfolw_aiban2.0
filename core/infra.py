import os
import sys
import queue
import logging
from logging.handlers import QueueHandler, QueueListener, TimedRotatingFileHandler


class MyLogger:
    def __init__(self, logdir, logname, isdebug=False, name=__name__):
        self.__name = name
        self.logger = logging.getLogger(self.__name)
        self.logger.setLevel(logging.DEBUG)
        self.logdir = logdir
        self.logname = logname
        self.debug = isdebug
        self.buff = ''

        if not os.path.exists(self.logdir):
            os.makedirs(self.logdir)

        log_file_path = os.path.join(self.logdir, self.logname)
        fh = TimedRotatingFileHandler(
            log_file_path,
            when='midnight',
            interval=1,
            backupCount=30,
            encoding='utf-8'
        )
        fh.suffix = '%Y-%m-%d'
        fh.setLevel(logging.DEBUG)

        if self.debug:
            formatter = logging.Formatter('%(asctime)s-%(name)s-%(filename)s-[line:%(lineno)d]'
                                          '-%(levelname)s-[logmessage]: %(message)s',
                                          datefmt='%a, %d %b %Y %H:%M:%S')
        else:
            formatter = logging.Formatter('%(asctime)s-%(levelname)s: %(message)s', datefmt='%Y%m%d %H:%M:%S')

        fh.setFormatter(formatter)

        que = queue.Queue(-1)
        queue_handler = QueueHandler(que)
        self.listener = QueueListener(que, fh)
        self.logger.addHandler(queue_handler)
        self.listener.start()

    def write(self, output_stream):
        self.buff += output_stream

    def flush(self):
        self.logger.info(self.buff)
        self.buff = ''

    def close_log(self):
        self.listener.stop()

    @property
    def get_log(self):
        return self.logger

    def get_logdir(self):
        return self.logdir

    def get_logname(self):
        return self.logname


class tool_in:
    def __init__(self, sid, tool_state):
        self.id = sid
        self.tool_state = tool_state

    def setio(self, setid, setio):
        self.id = setid
        self.tool_state = setio


class alam_msg:
    def __init__(self, gid, sid, who, led, speak, msg1, msg2, msg3, table=None):
        self.sourceid = sid
        self.groupid = gid
        self.who = who
        self.led = led
        self.speak = speak
        self.msg1 = msg1
        self.msg2 = msg2
        self.msg3 = msg3
        self.table = table

    def setmsg(self, ngid, nsid, nwho, nled, nspeak, nmsg1, nmsg2, nmsg3, ntable=None):
        self.sourceid = nsid
        self.groupid = ngid
        self.who = nwho
        self.led = nled
        self.speak = nspeak
        self.msg1 = nmsg1
        self.msg2 = nmsg2
        self.msg3 = nmsg3
        self.table = ntable


def get_runtime_base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# 全局多进程 log（日志写到运行目录下的 log/）
_LOG_DIR = os.path.join(get_runtime_base_dir(), 'log', 'abvideologs')
mylog_helper = MyLogger(_LOG_DIR + os.sep, 'vido_main.log', name=__name__)
global_sys_logger = mylog_helper.get_log

# API 触发器专用日志：只记录入站 HTTP 请求（method/path/headers/body）与匹配分发结果
_API_TRIGGER_LOG_DIR = os.path.join(get_runtime_base_dir(), 'log', 'apitriggerlogs')
api_trigger_log_helper = MyLogger(_API_TRIGGER_LOG_DIR + os.sep, 'api_trigger.log',
                                  name=__name__ + '.api_trigger')
api_trigger_logger = api_trigger_log_helper.get_log


def reconfigure_loggers_for_child_process(mp_log_queue):
    """子进程启动时调用：将所有模块级 logger 的 TimedRotatingFileHandler 替换为
    QueueHandler，日志通过 multiprocessing.Queue 转发到主进程统一写入。
    避免多进程同时写同一文件 + TimedRotatingFileHandler 跨天轮转时的冲突。
    """
    _helpers = [mylog_helper, api_trigger_log_helper]
    for helper in _helpers:
        # 停止本地文件写入监听线程
        if helper.listener:
            helper.listener.stop()
        # 清除旧的 QueueHandler（指向本地 threading.Queue）
        helper.logger.handlers.clear()
        # 装上指向 multiprocessing.Queue 的新 QueueHandler
        helper.logger.addHandler(QueueHandler(mp_log_queue))
