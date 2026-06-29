const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = function(RED) {
    function findProjectRoot(startDir) {
        let dir = path.resolve(startDir);
        for (let i = 0; i < 8; i++) {
            if (fs.existsSync(path.join(dir, 'main.py')) && fs.existsSync(path.join(dir, 'core'))) {
                return dir;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return null;
    }

    function getServerDefaultExportDir() {
        const projectRoot = findProjectRoot(__dirname);
        const base = projectRoot || ((RED.settings && RED.settings.userDir) ? RED.settings.userDir : process.cwd());
        return path.join(base, 'workflows').replace(/\\/g, '/');
    }

    RED.httpAdmin.get("/aiban/default-export-dir", RED.auth.needsPermission(''), function(req, res) {
        res.json({ path: getServerDefaultExportDir(), hostname: os.hostname() });
    });

    // --- 用于浏览文件夹的 API ---
    RED.httpAdmin.get("/aiban/list-dirs", RED.auth.needsPermission(''), function(req, res) {
        let queryPath = req.query.path;
        try {
            if (!queryPath) {
                queryPath = getServerDefaultExportDir();
                if (!fs.existsSync(queryPath)) {
                    queryPath = (RED.settings && RED.settings.userDir) ? RED.settings.userDir : process.cwd();
                }
            }
            const absolutePath = path.resolve(queryPath);
            const items = fs.readdirSync(absolutePath, { withFileTypes: true });
            const dirs = items.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);
            const parent = path.dirname(absolutePath);
            res.json({ current: absolutePath.replace(/\\/g, '/'), parent: parent.replace(/\\/g, '/'), dirs: dirs, hostname: os.hostname() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- 导出逻辑 ---
    function WorkflowExporterNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        const exportDir = config.exportPath || getServerDefaultExportDir();

        node.on('input', function(msg) {
            // 【核心优化】：使用 .flat(Infinity) 彻底拍平数组
            // 这样无论前面的节点传过来的是单对象 {}，还是数组 [{}]，甚至 join 造成的嵌套数组 [[{}], {}]
            // 全都会被统一拍平为一维对象数组，彻底杜绝丢数据的情况！
            let payloads = Array.isArray(msg.payload) ? msg.payload.flat(Infinity) : [msg.payload];
            if (payloads.length === 0) return;

            let groupMap = {};        // 用于存放 workflow
            let socketClientsMap = {}; // 用于存放 socket_client
            let apiTriggersMap = {};   // 用于存放 api_trigger
            let apiOutputsMap = {};    // 用于存放 api_output

            // --- 智能分拣传入的数据对象 ---
            payloads.forEach(item => {
                if (item && item.group_id !== undefined) {
                    const gid = item.group_id;

                    if (item._is_api_trigger) {
                        if (!apiTriggersMap[gid]) apiTriggersMap[gid] = [];
                        const { _is_api_trigger, group_id, ...triggerData } = item;
                        triggerData.group_id = parseInt(gid);
                        apiTriggersMap[gid].push(triggerData);
                    } else if (item._is_api_output) {
                        if (!apiOutputsMap[gid]) apiOutputsMap[gid] = [];
                        const { _is_api_output, group_id, ...outputData } = item;
                        outputData.group_id = parseInt(gid);
                        apiOutputsMap[gid].push(outputData);
                    } else if (item._is_socket_client || item.sourceid !== undefined && !item.mode) {
                        if (!socketClientsMap[gid]) socketClientsMap[gid] = [];
                        const { _is_socket_client, group_id, ...clientData } = item;
                        socketClientsMap[gid].push(clientData);
                    } else {
                        if (!groupMap[gid]) groupMap[gid] = [];
                        groupMap[gid].push(item);
                    }
                }
            });

            if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

            const apiServerEnabled = !!(config.apiServerHost && config.apiServerHost.trim() !== "");
            const apiServerCfg = apiServerEnabled ? {
                enabled: true,
                host: config.apiServerHost.trim(),
                port: parseInt(config.apiServerPort) || 18080,
                max_body_bytes: parseInt(config.apiServerMaxBody) || 1048576
            } : null;

            let generatedFiles = [];
            try {
                const allGids = new Set([
                    ...Object.keys(groupMap),
                    ...Object.keys(socketClientsMap),
                    ...Object.keys(apiTriggersMap),
                    ...Object.keys(apiOutputsMap)
                ]);

                for (const gid of allGids) {
                    const filePath = path.join(exportDir, `group_${gid}.json`);

                    const finalJson = {
                        db: {
                            host: config.dbHost || "127.0.0.1",
                            port: parseInt(config.dbPort) || 3306,
                            user: config.dbUser || "root",
                            password: config.dbPassword || "root",
                            charset: config.dbCharset || "GB2312",
                            alarm_table: config.dbTable || "icamera_data.icam_alarm_data"
                        }
                    };

                    if (config.socketHost && config.socketHost.trim() !== "") {
                        finalJson.socket_server = {
                            host: config.socketHost.trim(),
                            port: parseInt(config.socketPort) || 10000,
                            encoding: config.socketEncoding || "gbk"
                        };
                    }

                    if (socketClientsMap[gid] && socketClientsMap[gid].length > 0) {
                        finalJson.socket_clients = socketClientsMap[gid];
                    }

                    if (apiServerCfg && apiTriggersMap[gid] && apiTriggersMap[gid].length > 0) {
                        finalJson.api_server = apiServerCfg;
                    }
                    if (apiTriggersMap[gid] && apiTriggersMap[gid].length > 0) {
                        finalJson.api_triggers = apiTriggersMap[gid];
                    }

                    if (apiOutputsMap[gid] && apiOutputsMap[gid].length > 0) {
                        finalJson.api_outputs = apiOutputsMap[gid];
                    }

                    finalJson.workflows = groupMap[gid] || [];

                    fs.writeFileSync(filePath, JSON.stringify(finalJson, null, 2), 'utf8');
                    generatedFiles.push(`group_${gid}.json`);
                }
                node.status({fill:"green", shape:"dot", text:"成功导出"});
            } catch (error) {
                node.error("导出失败: " + error.message);
            }
        });
    }
    RED.nodes.registerType("workflow-exporter", WorkflowExporterNode);
}