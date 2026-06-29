# -*- coding: utf-8 -*-
import os, sys
import datetime
import logging
from logging.handlers import TimedRotatingFileHandler
from icamera.config.setting import SERVER_HOST, SERVER_PORT
from icamera import app
from icamera.tool.timer_task import init_scheduler

# 项目根路径
BASE_PATH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_PATH)  # 将项目根路径临时加入环境变量，程序退出后失效

def setup_logging():
    """
    配置日志记录器，实现每日日志轮转
    """
    # 修改为当前脚本所在目录
    current_dir = os.path.dirname(os.path.abspath(__file__))
    log_dir = os.path.join(current_dir, "logs")

    if not os.path.exists(log_dir):
        os.makedirs(log_dir)

    # 配置根日志记录器
    logger = logging.getLogger()
    logger.setLevel(logging.INFO)

    # 清除已有的处理器，避免重复日志
    logger.handlers.clear()

    # 创建 TimedRotatingFileHandler，每天轮转一次日志文件
    # 使用 utc=True 避免时区问题
    file_handler = TimedRotatingFileHandler(
        filename=os.path.join(log_dir, 'app.log'),
        when='midnight',  # 每天午夜轮转
        interval=1,  # 每天轮转一次
        backupCount=30,  # 保留最近30天的日志文件
        encoding='utf-8',
        utc=True
    )

    # 设置日志格式
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s'
    )
    file_handler.setFormatter(formatter)

    # 添加处理器到日志记录器
    logger.addHandler(file_handler)

    # 同时输出到控制台
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    return logger

if __name__ == '__main__':
    # 设置日志
    logger = setup_logging()

    # 记录应用启动日志
    logger.info("Application starting on %s:%s" % (SERVER_HOST, SERVER_PORT))

    try:
        # ✨ 新增：在启动 Web 服务前，执行定时任务初始化
        init_scheduler()
        logger.info("Timer scheduler initialized successfully (推理定时巡检已启动)")

        # host为HOST，port指定访问端口号，debug=False设置调试模式关闭
        app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False, threaded=True)
        logger.info("Application started successfully")
    except Exception as e:
        logger.error("Application failed to start: %s" % str(e))
        raise