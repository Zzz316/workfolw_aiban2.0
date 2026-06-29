import datetime
import pandas as pd
import json
import os
from flask import make_response, request, Blueprint, jsonify
from icamera.common.mysql_operate import db
from icamera.tool.yaml_camget import camera_get
from icamera.tool.camname import camname

# blueprint
logicalOrch_blueprint = Blueprint('logicalOrch', __name__, template_folder='templates')

# 初始化数据库表（如果不存在）
def init_tables():
    # 存储完整流程图的表
    create_flowchart_table = """
    CREATE TABLE IF NOT EXISTS icam_flowchart (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) DEFAULT NULL,
        flowchart_data JSON NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
    """
    db.execute_db(create_flowchart_table)
    
    # 存储路径信息的表
    create_path_table = """
    CREATE TABLE IF NOT EXISTS icam_flowchart_path (
        id INT AUTO_INCREMENT PRIMARY KEY,
        flowchart_id INT NOT NULL,
        path_index INT NOT NULL,
        path_data JSON NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (flowchart_id) REFERENCES icam_flowchart(id) ON DELETE CASCADE
    )
    """
    db.execute_db(create_path_table)
    
    # 存储 YAML 树的表
    create_yaml_tree_table = """
    CREATE TABLE IF NOT EXISTS icam_yaml_tree (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tree_data JSON NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
    """
    db.execute_db(create_yaml_tree_table)

# 初始化表结构
init_tables()

def find_paths(nodes, edges):
    """
    查找从开始节点到结束节点的所有路径
    """
    # 找到开始节点和结束节点
    start_node = None
    end_node = None
    for node in nodes:
        node_name = node.get('properties', {}).get('base', {}).get('nodeName')
        if node_name == '开始':
            start_node = node
        elif node_name == '结束':
            end_node = node
    
    if not start_node or not end_node:
        return []
    
    # 构建邻接表
    adjacency_list = {}
    for edge in edges:
        source_id = edge['sourceID']
        target_id = edge['targetID']
        if source_id not in adjacency_list:
            adjacency_list[source_id] = []
        adjacency_list[source_id].append(target_id)
    
    # 深度优先搜索查找所有路径
    paths = []
    
    def dfs(current_id, path):
        if current_id == end_node['id']:
            paths.append(path.copy())
            return
        
        if current_id not in adjacency_list:
            return
        
        for next_id in adjacency_list[current_id]:
            if next_id not in path:  # 避免循环
                path.append(next_id)
                dfs(next_id, path)
                path.pop()
    
    dfs(start_node['id'], [start_node['id']])
    
    return paths

def extract_node_content(nodes, node_id):
    """
    提取节点的 properties.outputs[0].value.content 内容
    """
    for node in nodes:
        if node['id'] == node_id:
            try:
                return node['properties']['outputs'][0]['value']['content']
            except (KeyError, IndexError, TypeError):
                return None
    return None

@logicalOrch_blueprint.route('/camera_api/iot/camera/save_flowchart', methods=['POST'])
def save_flowchart():
    try:
        # 接收请求数据
        flowchart_data = request.json
        flowchart_id = flowchart_data.get('id')
        name = flowchart_data.get('name', '')
        nodes = flowchart_data.get('nodes', [])
        edges = flowchart_data.get('edges', [])
        
        # 验证数据
        if not nodes or not edges:
            return jsonify({
                "success": False,
                "code": 400,
                "msg": "缺少节点或连线数据"
            })
        
        # 检查是否为编辑模式
        if flowchart_id:
            # 编辑模式：更新现有数据
            # 1. 更新流程图数据
            update_flowchart_sql = """
            UPDATE icam_flowchart SET name = %s, flowchart_data = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s
            """
            db.execute_db(update_flowchart_sql, (name, json.dumps(flowchart_data), flowchart_id))
            
            # 2. 删除原有路径数据
            delete_paths_sql = "DELETE FROM icam_flowchart_path WHERE flowchart_id = %s"
            db.execute_db(delete_paths_sql, (flowchart_id,))
            
            print(f"编辑流程图，ID: {flowchart_id}")
        else:
            # 创建模式：插入新数据
            # 1. 存储完整的流程图数据
            insert_flowchart_sql = """
            INSERT INTO icam_flowchart (name, flowchart_data) VALUES (%s, %s)
            """
            db.execute_db(insert_flowchart_sql, (name, json.dumps(flowchart_data),))
            
            # 2. 获取刚插入的流程图ID
            get_id_sql = "SELECT MAX(id) as max_id FROM icam_flowchart"
            result_df = db.select_db(get_id_sql)
            
            flowchart_id = 0
            if not result_df.empty and result_df['max_id'].values[0]:
                flowchart_id = int(result_df['max_id'].values[0])
                
            print(f"当前获取到的 flowchart_id: {flowchart_id}")
            
            if flowchart_id == 0:
                raise Exception("获取插入的主键ID失败")
        
        # 3. 查找所有路径
        paths = find_paths(nodes, edges)
        
        # 4. 处理每条路径，提取节点内容并存储
        path_data_list = []
        for i, path in enumerate(paths):
            # 提取路径上的节点内容（跳过开始和结束节点）
            node_contents = []
            for node_id in path:
                # 查找节点对象
                node = next((n for n in nodes if n['id'] == node_id), None)
                if node:
                    # 获取节点名称，增加容错处理
                    node_name = node.get('properties', {}).get('base', {}).get('nodeName')
                    # 跳过开始和结束节点
                    if node_name not in ['开始', '结束']:
                        content = extract_node_content(nodes, node_id)
                        if content:
                            node_contents.append(content)
            
            # 存储路径数据
            if node_contents:
                path_data_list.append(node_contents)
                
                insert_path_sql = """
                INSERT INTO icam_flowchart_path (flowchart_id, path_index, path_data) VALUES (%s, %s, %s)
                """
                try:
                    db.execute_db(insert_path_sql, (flowchart_id, i, json.dumps(node_contents)))
                    print(f"成功插入路径数据，flowchart_id: {flowchart_id}, path_index: {i}")
                except Exception as e:
                    print(f"插入路径数据失败: {str(e)}")
        
        # 构建响应
        res = {
            "success": True,
            "code": 200,
            "msg": "流程图数据保存成功",
            "data": {
                "flowchart_id": flowchart_id,
                "paths": path_data_list
            }
        }
        return jsonify(res)
    
    except Exception as e:
        print(f"保存流程图数据失败: {str(e)}")
        # 打印详细错误堆栈，方便调试
        import traceback
        traceback.print_exc()
        return jsonify({
            "success": False,
            "code": 500,
            "msg": f"保存流程图数据失败: {str(e)}"
        })

@logicalOrch_blueprint.route('/camera_api/iot/camera/get_flowchart', methods=['GET'])
def get_flowchart():
    try:
        flowchart_id = request.args.get('id')
        if not flowchart_id:
            return jsonify({
                "success": False,
                "code": 400,
                "msg": "缺少流程图ID"
            })
        
        # 获取流程图数据
        get_flowchart_sql = """
        SELECT * FROM icam_flowchart WHERE id = %s
        """
        flowchart_result = db.select_db(get_flowchart_sql, (flowchart_id,))
        
        if flowchart_result is None or flowchart_result.empty:
            return jsonify({
                "success": False,
                "code": 404,
                "msg": "流程图不存在"
            })
        
        # 获取路径数据
        get_paths_sql = """
        SELECT * FROM icam_flowchart_path WHERE flowchart_id = %s ORDER BY path_index
        """
        paths_result = db.select_db(get_paths_sql, (flowchart_id,))
        
        # 构建路径数据列表
        paths = []
        if not paths_result.empty:
            for i in range(len(paths_result)):
                paths.append(json.loads(paths_result['path_data'].values[i]))
        
        # 构建响应
        res = {
            "success": True,
            "code": 200,
            "msg": "获取流程图数据成功",
            "data": {
                "flowchart": json.loads(str(flowchart_result['flowchart_data'].values[0])),
                "paths": paths
            }
        }
        return jsonify(res)
    
    except Exception as e:
        print(f"获取流程图数据失败: {str(e)}")
        return jsonify({
            "success": False,
            "code": 500,
            "msg": f"获取流程图数据失败: {str(e)}"
        })


@logicalOrch_blueprint.route('/camera_api/iot/camera/flowchart_list', methods=['GET'])
def flowchart_list():
    """
    获取流程图列表（支持分页和过滤）
    """
    try:
        # 获取分页参数
        page = request.args.get('page', 1, type=int)
        size = request.args.get('size', 10, type=int)
        name = request.args.get('name', '')
        flowchart_id = request.args.get('id', '')
        
        # 计算偏移量
        offset = (page - 1) * size
        
        # 构建查询条件
        conditions = []
        params_list = []
        
        if flowchart_id:
            conditions.append("id = %s")
            params_list.append(flowchart_id)
        
        if name:
            conditions.append("name LIKE %s")
            params_list.append(f"%{name}%")
        
        where_clause = "WHERE " + " AND ".join(conditions) if conditions else ""
        params = tuple(params_list) + (size, offset)
        
        # 查询总数
        count_sql = f"SELECT COUNT(*) as total FROM icam_flowchart {where_clause}"
        # 只传递查询条件部分的参数，不包括分页参数 size 和 offset
        count_params = params[:-2] if len(params) >= 2 else ()
        count_result = db.select_db(count_sql, count_params)
        total = int(count_result['total'].values[0]) if count_result is not None and not count_result.empty else 0
        
        # 查询数据
        data_sql = f"SELECT id, name, created_at, updated_at FROM icam_flowchart {where_clause} ORDER BY created_at DESC LIMIT %s OFFSET %s"
        data_result = db.select_db(data_sql, params)
        
        # 构建响应数据
        items = []
        if data_result is not None and not data_result.empty:
            for i in range(len(data_result)):
                items.append({
                    "id": int(data_result['id'].values[i]),
                    "name": str(data_result['name'].values[i]) if data_result['name'].values[i] is not None else "",
                    "created_at": str(data_result['created_at'].values[i]) if data_result['created_at'].values[i] is not None else "",
                    "updated_at": str(data_result['updated_at'].values[i]) if data_result['updated_at'].values[i] is not None else ""
                })
        
        # 确保所有值都是 JSON 可序列化的
        total = int(total)
        page = int(page)
        size = int(size)
        pages = int((total + size - 1) // size)
        
        # 构建响应数据
        response_data = {
            "success": True,
            "code": 200,
            "msg": "获取流程图列表成功",
            "data": {
                "items": items,
                "total": total,
                "page": page,
                "size": size,
                "pages": pages
            }
        }
        return jsonify(response_data)
    
    except Exception as e:
        print(f"获取流程图列表失败: {str(e)}")
        return jsonify({
            "success": False,
            "code": 500,
            "msg": f"获取流程图列表失败: {str(e)}"
        })


@logicalOrch_blueprint.route('/camera_api/iot/camera/get_model_json', methods=['GET'])
def get_model_json():
    """
    根据 .aiban 路径读取对应的 .json 文件内容
    """
    try:
        # 获取路径参数
        paths_param = request.args.get('paths', '')
        if not paths_param:
            return jsonify({
                "success": False,
                "code": 400,
                "msg": "缺少路径参数"
            })
        
        # 分割路径
        aiban_paths = paths_param.split(',')
        result = []
        
        # 处理每个路径
        for aiban_path in aiban_paths:
            aiban_path = aiban_path.strip()
            if not aiban_path:
                continue
            
            # 替换为 .json 路径
            json_path = aiban_path.replace('.aiban', '.json')
            
            # 读取 JSON 文件
            try:
                if os.path.exists(json_path):
                    with open(json_path, 'r', encoding='utf-8') as f:
                        json_content = json.load(f)
                    result.append({
                        "aiban_path": aiban_path,
                        "json_path": json_path,
                        "content": json_content
                    })
                else:
                    result.append({
                        "aiban_path": aiban_path,
                        "json_path": json_path,
                        "error": "文件不存在"
                    })
            except json.JSONDecodeError as e:
                result.append({
                    "aiban_path": aiban_path,
                    "json_path": json_path,
                    "error": f"JSON 解析错误: {str(e)}"
                })
            except Exception as e:
                result.append({
                    "aiban_path": aiban_path,
                    "json_path": json_path,
                    "error": f"读取文件失败: {str(e)}"
                })
        
        # 构建响应
        return jsonify({
            "success": True,
            "code": 200,
            "msg": "获取模型 JSON 成功",
            "data": result
        })
    except Exception as e:
        print(f"获取模型 JSON 失败: {str(e)}")
        return jsonify({
            "success": False,
            "code": 500,
            "msg": f"获取模型 JSON 失败: {str(e)}"
        })


@logicalOrch_blueprint.route('/camera_api/iot/camera/delete_flowchart', methods=['POST'])
def delete_flowchart():
    """
    根据 ID 删除流程图
    """
    try:
        # 获取请求数据
        data = request.json
        flowchart_id = data.get('id')
        
        if not flowchart_id:
            return jsonify({
                "success": False,
                "code": 400,
                "msg": "缺少流程图 ID"
            })
        
        # 验证流程图是否存在
        check_sql = "SELECT id FROM icam_flowchart WHERE id = %s"
        check_result = db.select_db(check_sql, (flowchart_id,))
        
        if check_result is None or check_result.empty:
            return jsonify({
                "success": False,
                "code": 404,
                "msg": "流程图不存在"
            })
        
        # 删除流程图（由于外键约束，关联的路径数据会自动删除）
        delete_sql = "DELETE FROM icam_flowchart WHERE id = %s"
        db.execute_db(delete_sql, (flowchart_id,))
        
        # 构建响应
        return jsonify({
            "success": True,
            "code": 200,
            "msg": "删除流程图成功"
        })
    except Exception as e:
        print(f"删除流程图失败: {str(e)}")
        return jsonify({
            "success": False,
            "code": 500,
            "msg": f"删除流程图失败: {str(e)}"
        })


@logicalOrch_blueprint.route('/camera_api/iot/camera/save_yaml_tree', methods=['POST'])
def save_yaml_tree():
    """
    保存 YAML 树到数据库，如果已存在则替换
    """
    try:
        # 获取请求数据
        yaml_tree_data = request.json
        if not yaml_tree_data:
            return jsonify({
                "success": False,
                "code": 400,
                "msg": "缺少 YAML 树数据"
            })
        
        # 检查是否已存在记录
        check_sql = "SELECT id FROM icam_yaml_tree LIMIT 1"
        check_result = db.select_db(check_sql)
        
        if check_result is not None and not check_result.empty:
            # 已存在记录，更新
            update_sql = "UPDATE icam_yaml_tree SET tree_data = %s WHERE id = %s"
            db.execute_db(update_sql, (json.dumps(yaml_tree_data), check_result['id'].values[0]))
            print("更新 YAML 树数据成功")
        else:
            # 不存在记录，插入
            insert_sql = "INSERT INTO icam_yaml_tree (tree_data) VALUES (%s)"
            db.execute_db(insert_sql, (json.dumps(yaml_tree_data),))
            print("插入 YAML 树数据成功")
        
        # 构建响应
        return jsonify({
            "success": True,
            "code": 200,
            "msg": "保存 YAML 树成功"
        })
    except Exception as e:
        print(f"保存 YAML 树失败: {str(e)}")
        return jsonify({
            "success": False,
            "code": 500,
            "msg": f"保存 YAML 树失败: {str(e)}"
        })


@logicalOrch_blueprint.route('/camera_api/iot/camera/query_yaml_tree', methods=['GET'])
def query_yaml_tree():
    """
    查询 YAML 树，如果存在则返回完整的树，否则返回不存在的信息
    """
    try:
        # 查询最新的 YAML 树记录
        query_sql = "SELECT tree_data, created_at, updated_at FROM icam_yaml_tree ORDER BY updated_at DESC LIMIT 1"
        query_result = db.select_db(query_sql)
        
        if query_result is None or query_result.empty:
            return jsonify({
                "success": False,
                "code": 404,
                "msg": "YAML 树不存在"
            })
        
        # 解析结果
        tree_data = json.loads(str(query_result['tree_data'].values[0]))
        created_at = str(query_result['created_at'].values[0])
        updated_at = str(query_result['updated_at'].values[0])
        
        # 构建响应
        return jsonify({
            "success": True,
            "code": 200,
            "msg": "查询 YAML 树成功",
            "data": {
                "tree": tree_data,
                "created_at": created_at,
                "updated_at": updated_at
            }
        })
    except Exception as e:
        print(f"查询 YAML 树失败: {str(e)}")
        return jsonify({
            "success": False,
            "code": 500,
            "msg": f"查询 YAML 树失败: {str(e)}"
        })
