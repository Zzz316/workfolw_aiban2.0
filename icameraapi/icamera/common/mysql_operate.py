import pymysql
from dbutils.pooled_db import PooledDB
from contextlib import contextmanager
from icamera.config.setting import MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWD, MYSQL_DB

class MysqlDb:
    def __init__(self, host, port, user, passwd, db, pool_size):
        """
        初始化MySQL数据库连接池

        参数:
            host: 数据库主机地址
            port: 数据库端口
            user: 数据库用户名
            passwd: 数据库密码
            db: 数据库名称
            pool_size: 连接池大小(默认5)
        """
        self.host = host
        self.port = port
        self.user = user
        self.passwd = passwd
        self.db = db

        # 创建连接池
        self.pool = PooledDB(
            creator=pymysql,
            maxconnections=pool_size,
            mincached=2,
            host=host,
            port=port,
            user=user,
            password=passwd,
            database=db,
            charset='utf8mb4',
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=False
        )

    @contextmanager
    def _get_connection(self):
        """
        获取数据库连接(使用上下文管理器确保连接正确释放)

        用法:
        with self._get_connection() as conn:
            with conn.cursor() as cursor:
                cursor.execute(...)
        """
        conn = None
        try:
            conn = self.pool.connection()
            yield conn
        except Exception as e:
            print("获取数据库连接出错: %s" % str(e))
            if conn:
                conn.rollback()
            raise
        finally:
            if conn:
                conn.close()  # 实际上是归还给连接池

    def select_db(self, sql, params=None):
        """
        查询数据并返回DataFrame

        参数:
            sql: SQL查询语句
            params: 查询参数(可选)

        返回:
            pandas.DataFrame 或 None(出错时)
        """
        try:
            # 动态导入pandas，只有在需要时才导入
            import pandas as pd
            
            with self._get_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    data = cur.fetchall()
                    cols = [col[0] for col in cur.description]  # 获取列名
                    return pd.DataFrame(data, columns=cols)
        except Exception as e:
            print("查询出错: %s" % str(e))
            return None

    def execute_db(self, sql, params=None):
        """
        执行 INSERT/UPDATE/DELETE 操作

        参数:
            sql: SQL执行语句
            params: 执行参数(可选)

        返回:
            bool: 执行是否成功
        """
        try:
            with self._get_connection() as conn:
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    conn.commit()
                    return True
        except Exception as e:
            print("执行SQL出错: %s" % str(e))
            return False

    def execute_many(self, sql, params_list):
        """
        批量执行SQL语句

        参数:
            sql: SQL执行语句
            params_list: 参数列表

        返回:
            bool: 执行是否成功
        """
        try:
            with self._get_connection() as conn:
                with conn.cursor() as cur:
                    cur.executemany(sql, params_list)
                    conn.commit()
                    return True
        except Exception as e:
            print("批量执行SQL出错: %s" % str(e))
            return False

    def call_proc(self, proc_name, args=()):
        """
        调用存储过程

        参数:
            proc_name: 存储过程名称
            args: 参数元组

        返回:
            存储过程结果集
        """
        try:
            with self._get_connection() as conn:
                with conn.cursor() as cur:
                    cur.callproc(proc_name, args)
                    results = cur.fetchall()
                    conn.commit()
                    return results
        except Exception as e:
            print("调用存储过程出错: %s" % str(e))
            return None

db = MysqlDb(MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWD, MYSQL_DB,10)