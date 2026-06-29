# from icamera.common.mysql_operate import db
# from icamera.config.setting import yaml_path, video_path
# import yaml

# def rgb_data(rgba):
#     b = rgba[5:-1].split(",")
#     c = str(int(float(b[3]) * 255))
#     b[3] = c
#     d = ';'.join(b)
#     return d

# def camera_get():
#     filterarea_list = []
#     sql = "SELECT * FROM icam_camera_data"
#     df = db.select_db(sql)

#     for a in range(1,len(df)+1):
#         camera_sql = "SELECT * FROM icam_camera_data where id = " + str(a) + ""
#         camera_df = db.select_db(camera_sql)

#         # 检查camera_df是否为空或None
#         if camera_df is None or camera_df.empty:
#             continue  # 跳过不存在的ID

#         filterarea_sql = "SELECT * FROM icam_filterarea_data where id = " + str(a) + ""
#         filterarea_df = db.select_db(filterarea_sql)

#         id = camera_df['id'].values[0]
#         name = camera_df['name'].values[0]
#         url = camera_df['url'].values[0]
#         videopath = camera_df['videopath'].values[0]
#         fps = camera_df['fps'].values[0]
#         decodecache = camera_df['decodecache'].values[0]
#         enablefilter = camera_df['enablefilter'].values[0]

#         for i in range(len(filterarea_df)):
#             roiname = filterarea_df['name'].values[i]
#             filtertype = filterarea_df['filtertype'].values[i]
#             distance = filterarea_df['distance'].values[i]
#             bordersize = filterarea_df['bordersize'].values[i]
#             bordercolor = filterarea_df['bordercolor'].values[i]
#             bgcolor = filterarea_df['bgcolor'].values[i]
#             points = filterarea_df['points'].values[i]
#             pointradius = filterarea_df['pointradius'].values[i]
#             pointcolor = filterarea_df['pointcolor'].values[i]
#             showpoint = filterarea_df['showpoint'].values[i]
#             showroi = filterarea_df['showroi'].values[i]
#             filterarea = {'name': roiname,
#                           'filtertype': int(filtertype),
#                           'distance':int(distance),
#                           'bordersize':int(bordersize),
#                           'bordercolor':'255;0;0;255',
#                           'bgcolor':'255;0;0;255',
#                           'points': points,
#                           'pointradius': int(pointradius),
#                           'pointcolor': '255;0;0;255',
#                           'showpoint': bool(showpoint==1),
#                           'showroi': bool(showroi==1)
#                           }
#             filterarea_list.append(filterarea)
#         if filterarea_list == []:
#             filterarea_list = ''

#         if url != '':
#             data = {
#                 'id': int(id),
#                 'name': int(id),
#                 'url': url,
#                 'fps': int(fps) if fps is not None else 0,
#                 'decodecache':int(decodecache) if decodecache is not None else 0,
#                 'enablefilter': bool(enablefilter==1) if enablefilter is not None else False,
#                 'filterarea': ''
#             }
#         else:
#             data = {
#                 'id': int(id),
#                 'name': int(id),
#                 'url': videopath,
#                 'fps': int(fps) if fps is not None else 0,
#                 'decodecache': int(decodecache) if decodecache is not None else 0,
#                 'enablefilter': bool(enablefilter == 1) if enablefilter is not None else False,
#                 'filterarea': ''
#             }
#         yaml_datas = yaml.dump(data, indent=4, sort_keys=False, allow_unicode=True)
#         with open(yaml_path + str(a) +'.yaml', 'w+') as fb:
#             fb.write(yaml_datas)
#         filterarea_list = []

# if __name__ == "__main__":
#     camera_get()

# 新版
from icamera.common.mysql_operate import db
from icamera.config.setting import yaml_path, video_path
import yaml
import os
import pandas as pd

def rgb_data(rgba_str, default="255;0;0;255"):
    """
    颜色转换函数
    """
    if not rgba_str or not isinstance(rgba_str, str):
        return default
        
    rgba_str = rgba_str.strip()
    try:
        if rgba_str.startswith('rgba('):
            b = [x.strip() for x in rgba_str[5:-1].split(",")]
            c = str(int(float(b[3]) * 255))
            return f"{b[0]};{b[1]};{b[2]};{c}"
        elif rgba_str.startswith('rgb('):
            b = [x.strip() for x in rgba_str[4:-1].split(",")]
            return f"{b[0]};{b[1]};{b[2]};255"
        else:
            return default
    except Exception:
        return default

# ✨ 新增：终极布尔值安全转换函数
def safe_bool(val):
    """
    不管 val 是数字 1、字符串 '1'、字符串 'True' 还是真实的 True，统统识别为 True
    """
    if pd.isna(val) or val is None:
        return False
    # 转成字符串，去空格，转小写，然后比对
    return str(val).strip().lower() in ['1', 'true', 'yes', 'on']

def camera_get():
    # 1. 查新表 icam_camera_new_data
    sql = "SELECT * FROM icamera_data.icam_camera_new_data"
    camera_df = db.select_db(sql)

    if camera_df is None or camera_df.empty:
        return

    # 2. 动态遍历真实存在的数据
    for index, row in camera_df.iterrows():
        cam_data = row.to_dict()
        
        cam_id = cam_data.get('id')
        url = cam_data.get('url', '')
        videopath = cam_data.get('videopath', '')
        fps = cam_data.get('stream_fps', 0)
        decodecache = cam_data.get('stream_cache', 0)
        
        enablestream = cam_data.get('enablestream', 1)
        inferframesplit = cam_data.get('inferframesplit', 0)
        inferenable = cam_data.get('inferenable', 1)
        temprun = cam_data.get('temprun', 1)
        enableroi = cam_data.get('enableroi', 0)
        enablefilter = cam_data.get('enablefilter', 0)

        # =========================================================
        # 3. 查对应的 过滤区域 数据 (filterarea)
        # =========================================================
        filterarea_sql = f"SELECT * FROM icamera_data.icam_filterarea_data WHERE id = '{cam_id}'"
        filterarea_df = db.select_db(filterarea_sql)

        filterarea_list = []
        if filterarea_df is not None and not filterarea_df.empty:
            for i, fa_row in filterarea_df.iterrows():
                fa_data = fa_row.to_dict()
                
                try:
                    f_type = int(fa_data.get('filtertype') or 0)
                    dist = int(fa_data.get('distance') or 0)
                    b_size = int(fa_data.get('bordersize') or 3)
                    p_radius = int(fa_data.get('pointradius') or 3)
                except ValueError:
                    f_type, dist, b_size, p_radius = 0, 0, 3, 3

                bordercolor = rgb_data(str(fa_data.get('bordercolor', '')))
                bgcolor = rgb_data(str(fa_data.get('bgcolor', '')))
                pointcolor = rgb_data(str(fa_data.get('pointcolor', '')))

                filterarea = {
                    'name': str(fa_data.get('name', '')),
                    'filtertype': f_type,
                    'distance': dist,
                    'bordersize': b_size,
                    'bordercolor': bordercolor,
                    'bgcolor': bgcolor,
                    'points': str(fa_data.get('points', '')),
                    'pointradius': p_radius,
                    'pointcolor': pointcolor,
                    # ✨ 修复：使用 safe_bool，彻底解决 == 1 失败的问题
                    'showpoint': safe_bool(fa_data.get('showpoint')),
                    'showroi': safe_bool(fa_data.get('showroi'))
                }
                filterarea_list.append(filterarea)

        # =========================================================
        # 4. 查对应的 检测ROI 数据 (inferroi)
        # =========================================================
        inferroi_sql = f"SELECT * FROM icamera_data.icam_inferroi_data WHERE id = '{cam_id}'"
        inferroi_df = db.select_db(inferroi_sql)

        inferroi_list = []
        if inferroi_df is not None and not inferroi_df.empty:
            for j, ir_row in inferroi_df.iterrows():
                ir_data = ir_row.to_dict()
                
                try:
                    ir_b_size = int(ir_data.get('bordersize') or 3)
                    ir_p_radius = int(ir_data.get('pointradius') or 4)
                except ValueError:
                    ir_b_size, ir_p_radius = 3, 4

                ir_bordercolor = rgb_data(str(ir_data.get('bordercolor', '')))
                ir_bgcolor = rgb_data(str(ir_data.get('bgcolor', '')))
                ir_pointcolor = rgb_data(str(ir_data.get('pointcolor', '')))

                inferroi = {
                    'bordersize': ir_b_size,
                    'bordercolor': ir_bordercolor,
                    'bgcolor': ir_bgcolor,
                    'points': str(ir_data.get('points', '')),
                    'pointradius': ir_p_radius,
                    'pointcolor': ir_pointcolor,
                    # ✨ 修复：同样使用 safe_bool
                    'showpoint': safe_bool(ir_data.get('showpoint')),
                    'showroi': safe_bool(ir_data.get('showroi'))
                }
                inferroi_list.append(inferroi)

        final_filterarea = filterarea_list if len(filterarea_list) > 0 else ''
        final_inferroi = inferroi_list if len(inferroi_list) > 0 else ''
        final_url = url if url and str(url).strip() != '' else videopath

        # =========================================================
        # 5. 构建最终写入 YAML 的字典 
        # =========================================================
        data = {
            'id': int(cam_id),
            'name': int(cam_id),
            'url': str(final_url),
            'fps': int(fps) if fps else 0,
            'decodecache': int(decodecache) if decodecache else 0,
            
            # ✨ 修复：这里也全都换成 safe_bool 保护起来，避免大坑！
            'enablestream': safe_bool(enablestream),
            'inferframesplit': int(inferframesplit),
            'inferenable': safe_bool(inferenable),
            'temprun': safe_bool(temprun),
            'enableroi': safe_bool(enableroi),
            
            'inferroi': final_inferroi,
            
            'enablefilter': safe_bool(enablefilter),
            'filterarea': final_filterarea 
        }

        # 6. 生成 YAML 文件
        yaml_datas = yaml.dump(data, indent=4, sort_keys=False, allow_unicode=True)
        file_path = os.path.join(yaml_path, f"{cam_id}.yaml")
        
        with open(file_path, 'w+', encoding='utf-8') as fb:
            fb.write(yaml_datas)

if __name__ == "__main__":
    camera_get()