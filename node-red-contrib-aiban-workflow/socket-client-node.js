const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const os = require('os');

module.exports = function(RED) {

    // 将 YAML 文本解析为前端下拉所需的 { groupCameraMap, modelMap } 结构
    function parseGlobalYamlContent(content) {
        const doc = yaml.load(content);
        let groupCameraMap = {};
        if (doc.GroupArrary) {
            doc.GroupArrary.forEach(group => {
                let cIds = [];
                if (group.Sources) group.Sources.forEach(s => {
                    if (fs.existsSync(s.config)) {
                        try {
                            const sDoc = yaml.load(fs.readFileSync(s.config, 'utf8'));
                            if (sDoc && sDoc.id !== undefined) cIds.push(sDoc.id);
                        } catch(e){}
                    }
                });
                groupCameraMap[group.groupid] = cIds;
            });
        }
        let modelMap = {};
        if (doc.ModelArrary && doc.ModelArrary.Models) {
            doc.ModelArrary.Models.forEach(m => {
                const jsonPath = m.modelpath.replace(/\.[^/.]+$/, "") + ".json";
                let labels = [];
                if (fs.existsSync(jsonPath)) {
                    labels = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).map(item => item.labelName);
                }
                modelMap[m.modelid] = { modelName: path.basename(m.modelpath, path.extname(m.modelpath)), labels: labels };
            });
        }
        return { groupCameraMap, modelMap };
    }

    // 浏览服务器 YAML 时的默认起始目录：优先项目根，其次 userDir / cwd
    function getYamlBrowseDefaultDir() {
        let dir = path.resolve(__dirname);
        for (let i = 0; i < 8; i++) {
            if (fs.existsSync(path.join(dir, 'main.py')) && fs.existsSync(path.join(dir, 'core'))) {
                return dir;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return (RED.settings && RED.settings.userDir) ? RED.settings.userDir : process.cwd();
    }

    if (!RED._aibanGlobalYaml) {
        RED._aibanGlobalYaml = { groupCameraMap: {}, modelMap: {} };

        RED.httpAdmin.post("/aiban/parse-global-yaml", RED.auth.needsPermission(''), function(req, res) {
            try {
                RED._aibanGlobalYaml = parseGlobalYamlContent(req.body.content);
                res.json(RED._aibanGlobalYaml);
            } catch (e) { res.status(500).json({ error: e.message }); }
        });

        RED.httpAdmin.get("/aiban/global-yaml", RED.auth.needsPermission(''), function(req, res) {
            res.json(RED._aibanGlobalYaml || {});
        });

        // ── 手动触发喇叭测试：转发到 Flask API ─────────────────
        RED.httpAdmin.post("/aiban/speaker/test", RED.auth.needsPermission(''), function(req, res) {
            try {
                var payload = {
                    sourceid: req.body.sourceid,
                    group_id: req.body.group_id || 1,
                    speak_type: req.body.speak_type || 'on'
                };
                // 转发到 AiBan Flask API (主进程 127.0.0.1:9090)
                var http = require('http');
                var postData = JSON.stringify(payload);
                var options = {
                    hostname: '127.0.0.1',
                    port: 9090,
                    path: '/aiban/speaker/test',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData)
                    },
                    timeout: 5000
                };
                var flaskReq = http.request(options, function(flaskRes) {
                    var body = '';
                    flaskRes.on('data', function(chunk) { body += chunk; });
                    flaskRes.on('end', function() {
                        try {
                            var result = JSON.parse(body);
                            res.json(result);
                        } catch(e) {
                            res.json({ status: '999', errmsg: 'Flask 响应解析失败: ' + body });
                        }
                    });
                });
                flaskReq.on('error', function(e) {
                    res.status(503).json({ status: '999', errmsg: '无法连接 AiBan Flask 服务: ' + e.message });
                });
                flaskReq.on('timeout', function() {
                    flaskReq.destroy();
                    res.status(504).json({ status: '999', errmsg: 'Flask 服务响应超时' });
                });
                flaskReq.write(postData);
                flaskReq.end();
            } catch (e) {
                res.status(500).json({ status: '999', errmsg: e.message });
            }
        });

        // --- 浏览 Node-RED 服务器主机上的目录与 YAML 文件 ---
        RED.httpAdmin.get("/aiban/browse-yaml", RED.auth.needsPermission(''), function(req, res) {
            let queryPath = req.query.path;
            try {
                if (!queryPath) queryPath = getYamlBrowseDefaultDir();
                const absolutePath = path.resolve(queryPath);
                const items = fs.readdirSync(absolutePath, { withFileTypes: true });
                const dirs = items.filter(d => d.isDirectory()).map(d => d.name);
                const files = items.filter(d => d.isFile() && /\.ya?ml$/i.test(d.name)).map(d => d.name);
                const parent = path.dirname(absolutePath);
                res.json({
                    current: absolutePath.replace(/\\/g, '/'),
                    parent: parent.replace(/\\/g, '/'),
                    dirs: dirs,
                    files: files,
                    hostname: os.hostname()
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // --- 读取服务器主机上指定路径的 YAML 并解析 ---
        RED.httpAdmin.post("/aiban/parse-server-yaml", RED.auth.needsPermission(''), function(req, res) {
            try {
                const filePath = req.body.path;
                if (!filePath || !fs.existsSync(filePath)) {
                    return res.status(404).json({ error: "文件不存在: " + filePath });
                }
                const content = fs.readFileSync(filePath, 'utf8');
                RED._aibanGlobalYaml = parseGlobalYamlContent(content);
                res.json(RED._aibanGlobalYaml);
            } catch (e) { res.status(500).json({ error: e.message }); }
        });
    }

    function WorkflowSocketClientNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        node.on('input', function(msg) {
            if (!config.groupId || !config.sourceId || !config.host || !config.port) {
                node.error("请完善 Group ID、Source ID、目标 IP 和 端口配置！");
                return;
            }

            let commands = {};

            // 智能组装 speak_on (二选一)
            if (config.speakOnPayload && config.speakOnPayload.trim() !== "") {
                let payload = config.speakOnPayload.trim();
                commands.speak_on = {};
                if (config.speakOnType === "tts") {
                    commands.speak_on.tts = payload.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
                } else {
                    commands.speak_on.hex = payload;
                }
            }

            // --- 修改点：只有在勾选了 enableSpeakOff 时，才组装 speak_off ---
            if (config.enableSpeakOff && config.speakOffPayload && config.speakOffPayload.trim() !== "") {
                let payload = config.speakOffPayload.trim();
                commands.speak_off = {};
                if (config.speakOffType === "tts") {
                    commands.speak_off.tts = payload.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
                } else {
                    commands.speak_off.hex = payload;
                }
            }

            let clientPayload = {
                _is_socket_client: true,
                group_id: parseInt(config.groupId),
                sourceid: parseInt(config.sourceId),
                host: config.host.trim(),
                port: parseInt(config.port),
                commands: commands
            };
            if (config.encoding && config.encoding !== "") {
                clientPayload.encoding = config.encoding;
            }

            msg.payload = clientPayload;
            node.send(msg);
        });
    }
    RED.nodes.registerType("workflow-socket-client", WorkflowSocketClientNode);
}