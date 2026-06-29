# 新版本内容
import json
import yaml
import pandas as pd
from icamera.common.mysql_operate import db
from icamera.config.setting import yaml_path
import os

def rgb_data(rgba):
    b = rgba[5:-1].split(",")
    c = str(int(float(b[3]) * 255))
    b[3] = c
    d = ';'.join(b)
    return d

# ✨ 新增：整型安全转换函数（防止 NULL 报错）
def safe_int(val, default=0):
    if pd.isna(val) or val is None or str(val).strip() in ['', 'None', 'null']:
        return default
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return default

# ✨ 新增：浮点型安全转换函数（防止 NULL 报错）
def safe_float(val, default=0.0):
    if pd.isna(val) or val is None or str(val).strip() in ['', 'None', 'null']:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default

def main_get():
    group_list = []
    model_list = []

    # ================= 1. 读取主配置 =================
    sql = "SELECT * FROM icam_main_data"
    df = db.select_db(sql)

    version = df['version'].values[0]
    windowname = df['windowname'].values[0]
    saveimagedir = df['saveimagedir'].values[0]
    streamurl = df['streamurl'].values[0]
    saveimagequeuesize = df['saveimagequeuesize'].values[0]
    hostmemorylimit = df['hostmemorylimit'].values[0]
    loglevel = df['loglevel'].values[0]
    # datamonitorshow = df['datamonitorshow'].values[0]
    if 'datamonitorshow' in df.columns:
        datamonitorshow = df['datamonitorshow'].values[0]
    elif 'datastreamshow' in df.columns:
        datamonitorshow = df['datastreamshow'].values[0]
    else:
        datamonitorshow = True
    platform = df['platform'].values[0]
    boxfontsize = df['boxfontsize'].values[0]
    boxbgalpha = df['boxbgalpha'].values[0]

    main = {
        'version': version,
        'windowname': windowname,
        'saveimagedir': saveimagedir,
        'streamurl': streamurl,
        'saveimagequeuesize': safe_int(saveimagequeuesize), # 使用安全转换
        'hostmemorylimit': safe_float(hostmemorylimit),     # 使用安全转换
        'loglevel': loglevel,
        'datamonitorshow': bool(str(datamonitorshow) == 'True')
    }

    # ================= 2. 读取新版场景表 =================
    new_group_sql = "SELECT * FROM icamera_data.icam_scene_new_data"
    new_group_df = db.select_db(new_group_sql)

    if new_group_df is not None and not new_group_df.empty:
        for a in range(len(new_group_df)):
            groupid = str(new_group_df['id'].values[a])
            groupname = 'group' + groupid  
            groupenable = new_group_df['group_enable'].values[a]
            metadatacount = new_group_df['metadatacount'].values[a]
            deviceid = new_group_df['deviceid'].values[a]
            averagebitrate = new_group_df['averagebitrate'].values[a]
            maxbitrate = new_group_df['maxbitrate'].values[a]
            captionfontsize = new_group_df['captionfontsize'].values[a]
            
            camera_ids_raw = new_group_df['camera_ids'].values[a]
            infers_raw = new_group_df['infers'].values[a]
            
            camera_ids = []
            if pd.notna(camera_ids_raw) and camera_ids_raw:
                try: camera_ids = json.loads(camera_ids_raw)
                except: pass
                
            infers_json = []
            if pd.notna(infers_raw) and infers_raw:
                try: infers_json = json.loads(infers_raw)
                except: pass

            sources_list = []
            for cam_id in camera_ids:
                config_data = {
                    'config': yaml_path + str(cam_id) + '.yaml'
                }
                sources_list.append(config_data)

            infers_list = []
            for infer in infers_json:
                # ✨✨✨ 改动在这里：使用一个大字典，而不是原来的 prop_list 列表！
                prop_dict = {}
                raw_props = infer.get('property', [])
                for p_str in raw_props:
                    try:
                        num, model = p_str.split(':')
                        # 直接把标签名作为 key，把后面的模型id组(如 "0;1")作为字符串存起来
                        # 因为有分号的存在，必须强转为字符串，不能用 int(model)
                        prop_dict[int(num)] = str(model)
                    except Exception:
                        pass
                
                # 只有用大字典，YAML生成的格式才会是:
                # property: 
                #   1: 0;1
                # 而不会带有横杠 -
                final_property = prop_dict if len(prop_dict) > 0 else ''

                shadow_conf = infer.get('shadowing', {})
                shadowing_data = {
                    'enable': bool(shadow_conf.get('enable', False)),
                    'bgcolor': shadow_conf.get('bgcolor') or '255;0;0;0',
                    'labelid': safe_int(shadow_conf.get('labelid'), 0),
                    'drawperscent': safe_float(shadow_conf.get('drawperscent'), 0.5)
                }

                infers_data = {
                    'modeid': safe_int(infer.get('modeid', 0)),
                    'useroiimage': bool(infer.get('useroiimage', False)),
                    'savepropertyimage': bool(infer.get('savepropertyimage', False)),
                    'property': final_property,
                    'shadowing': shadowing_data
                }
                infers_list.append(infers_data)

            grouparrary = {
                'groupid': safe_int(groupid),
                'groupname': groupname,
                'groupenable': bool(str(groupenable) == 'True' or groupenable is True),
                'metadatacount': safe_int(metadatacount),
                'deviceid': safe_int(deviceid),
                'averagebitrate': safe_int(averagebitrate),
                'maxbitrate': safe_int(maxbitrate),
                'Sources': sources_list,
                'Infers': infers_list,
                'OSD': {
                    'captionfontsize': safe_int(captionfontsize, 10),
                    'captioncolor': '255;0;0;0'
                }
            }
            group_list.append(grouparrary)

    # ================= 3. 获取模型列表 =================
    model_sql = "SELECT * FROM icam_model_data"
    model_sql_df = db.select_db(model_sql)

    if model_sql_df is not None and not model_sql_df.empty:
        for c in range(len(model_sql_df)):
            modelpath = model_sql_df['modelpath'].values[c]
            mode = model_sql_df['mode'].values[c]
            deviceid = model_sql_df['deviceid'].values[c]
            batchsize = model_sql_df['batchsize'].values[c]
            modelid = model_sql_df['modelid'].values[c]
            maxconfidencelabel = model_sql_df['maxconfidencelabel'].values[c]
            confidencethreshold = model_sql_df['confidencethreshold'].values[c]
            nmsthreshold = model_sql_df['nmsthreshold'].values[c]
            maximageboxes = model_sql_df['maximageboxes'].values[c]
            reserveboxes = model_sql_df['reserveboxes'].values[c]
            
            labelprintcolor_dict = {}
            if 'labelprintcolor' in model_sql_df.columns:
                raw_color = model_sql_df['labelprintcolor'].values[c]
                if pd.notna(raw_color) and str(raw_color).strip():
                    try:
                        parsed = json.loads(str(raw_color))
                        if isinstance(parsed, dict):
                            labelprintcolor_dict = {int(k): str(v) for k, v in parsed.items()}
                    except Exception:
                        pass 

            # ✨ 核心修复：这里所有的数字类型全部使用了安全转换！再也不会报 TypeError
            model_data = {
                'modelpath': str(modelpath) if pd.notna(modelpath) else "",
                'mode': safe_int(mode),
                'deviceid': safe_int(deviceid),
                'batchsize': safe_int(batchsize),
                'modelid': safe_int(modelid),
                'maxconfidencelabel': bool(str(maxconfidencelabel) == 'True'),
                'confidencethreshold': safe_float(confidencethreshold),
                'nmsthreshold': safe_float(nmsthreshold),
                'maximageboxes': safe_int(maximageboxes),
                'reserveboxes': str(reserveboxes) if pd.notna(reserveboxes) else "",
                'labelprintcolor': labelprintcolor_dict if labelprintcolor_dict else '' 
            }
            model_list.append(model_data)

    # ================= 4. 组装并写入 YAML =================
    data = {
        'AibanVideoMain': main,
        'GroupArrary': group_list,
        'ModelArrary': {
            'platform': platform,
            'boxfontsize': safe_int(boxfontsize, 2),
            'boxbgalpha': safe_int(boxbgalpha, 1),
            'Models': model_list
        }
    }
    
    yaml_datas = yaml.dump(data, indent=4, sort_keys=False, allow_unicode=True)

    # ✨ 新增这两行：如果目录不存在，则自动创建（exist_ok=True 保证目录已存在时不会报错）
    if not os.path.exists(yaml_path):
        os.makedirs(yaml_path, exist_ok=True)
    
    with open(yaml_path + 'main-flow.yaml', 'w+', encoding='utf-8') as fb:
        fb.write(yaml_datas)

if __name__ == "__main__":
    main_get()