const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

module.exports = function(RED) {
    // 初始化日志目录和日志文件
    const logDir = path.join(__dirname, '..', 'log', 'apitriggerlogs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    // 获取当前日期格式化字符串
    function getDateString() {
        const now = new Date();
        return now.toISOString().split('T')[0];
    }

    // 获取当前日期时间格式化字符串
    function getTimestamp() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        return `${year}${month}${day} ${hour}:${minute}:${second}`;
    }

    // 写入日志
    function writeLog(message) {
        const logFile = path.join(logDir, `api_trigger_node.log`);
        const timestamp = getTimestamp();
        const logMessage = `${timestamp}-INFO: ${message}\n`;

        fs.appendFile(logFile, logMessage, (err) => {
            if (err) {
                console.error('写入日志失败:', err);
            }
        });
    }

    function sha256(value) {
        return crypto.createHash('sha256').update(value || '', 'utf8').digest('hex');
    }

    function normalizePath(pathValue, triggerId) {
        let value = (pathValue || '').trim();
        if (!value) value = `/aiban/api-trigger/${triggerId || 'api_trigger'}`;
        return value.startsWith('/') ? value : `/${value}`;
    }

    function parseJsonMaybe(value, fallback) {
        if (value === undefined || value === null || value === '') return fallback;
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch (e) {
            return fallback;
        }
    }

    function buildMappings(rawMappings) {
        if (!Array.isArray(rawMappings)) return {};
        const result = {};
        rawMappings.forEach(row => {
            if (!row || !row.name || !row.path) return;
            result[String(row.name).trim()] = String(row.path).trim();
        });
        return result;
    }

    function buildTriggerPayload(config, credentials) {
        const gid = parseInt(config.groupId);
        const sourceid = parseInt(config.sourceId);
        const triggerId = (config.triggerId || config.name || 'api_trigger').trim();
        const method = (config.method || 'POST').toUpperCase();
        const pathValue = normalizePath(config.path, triggerId);
        const responseStatus = parseInt(config.responseStatus) || 200;
        const responseBody = parseJsonMaybe(config.responseBody, { status: '200', errmsg: '' });
        const authType = config.authType || 'none';
        const token = credentials && credentials.authToken;
        const auth = authType === 'bearer' && token ? {
            type: 'bearer_sha256',
            header: config.authHeader || 'Authorization',
            prefix: config.authPrefix !== undefined ? config.authPrefix : 'Bearer ',
            token_sha256: sha256(token)
        } : { type: 'none' };

        const payload = {
            _is_api_trigger: true,
            id: triggerId,
            name: config.name || triggerId,
            enabled: config.enabled !== false && config.enabled !== 'false',
            group_id: gid,
            method: method,
            path: pathValue,
            auth: auth,
            request: {
                content_type: config.contentType || 'json',
                sourceid_path: (config.sourceIdPath || '').trim(),
                target_step_id_path: (config.targetStepIdPath || '').trim(),
                payload_mappings: buildMappings(config.mappings)
            },
            event: {
                type: 'step_hit',
                target_step_id: (config.targetStepId || triggerId).trim(),
                ttl_seconds: parseFloat(config.ttlSeconds) || 5,
                count: parseInt(config.count) || 1
            },
            response: {
                status: responseStatus,
                body: responseBody
            }
        };

        if (!isNaN(sourceid)) payload.sourceid = sourceid;
        return payload;
    }

    function requestOnce(options, body, done) {
        const target = new URL(options.url);
        const client = target.protocol === 'https:' ? https : http;
        const timeoutMs = parseInt(options.timeoutMs) || 5000;
        const headers = Object.assign({}, options.headers || {});
        let data = body;

        if (data !== undefined && data !== null && typeof data !== 'string' && !Buffer.isBuffer(data)) {
            data = JSON.stringify(data);
        }
        if (data !== undefined && data !== null && !headers['Content-Length']) {
            headers['Content-Length'] = Buffer.byteLength(data);
        }

        const req = client.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            method: options.method || 'POST',
            path: target.pathname + target.search,
            headers: headers,
            timeout: timeoutMs
        }, resp => {
            const chunks = [];
            resp.on('data', chunk => chunks.push(chunk));
            resp.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                done(null, {
                    statusCode: resp.statusCode,
                    headers: resp.headers,
                    body: text.length > 20000 ? text.slice(0, 20000) + '\n... response truncated ...' : text
                });
            });
        });

        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.on('error', err => done(err));
        if (data !== undefined && data !== null) req.write(data);
        req.end();
    }

    if (!RED._aibanApiTriggerRoutes) {
        RED._aibanApiTriggerRoutes = true;
        RED.httpAdmin.post('/aiban/test-api-trigger', RED.auth.needsPermission(''), function(req, res) {
            try {
                const body = req.body || {};
                const headers = Object.assign({}, body.headers || {});
                if (body.authToken) {
                    const prefix = body.authPrefix !== undefined ? body.authPrefix : 'Bearer ';
                    headers[body.authHeader || 'Authorization'] = `${prefix}${body.authToken}`;
                }
                if (body.contentType === 'json' && !headers['Content-Type']) {
                    headers['Content-Type'] = 'application/json';
                }

                requestOnce({
                    url: body.url,
                    method: (body.method || 'POST').toUpperCase(),
                    headers: headers,
                    timeoutMs: body.timeoutMs || 5000
                }, body.requestBody, function(err, result) {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }
                    res.json(result);
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });
    }

    function WorkflowApiTriggerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.on('input', function(msg) {
            const payload = buildTriggerPayload(config, node.credentials || {});

            // 记录接收到的 API 数据到日志文件
            writeLog('接收到 API 数据: ' + JSON.stringify(payload, null, 2));

            if (isNaN(payload.group_id)) {
                node.error('请配置有效的 Group ID');
                return;
            }
            const hasSourceId = payload.sourceid !== undefined && !isNaN(payload.sourceid);
            const hasSourceIdPath = payload.request && payload.request.sourceid_path;
            if (!hasSourceId && !hasSourceIdPath) {
                node.error('API 触发器必须按摄像头工作：请绑定摄像头或填写"动态 sourceid 路径"');
                return;
            }
            msg.payload = payload;
            node.send(msg);
        });
    }

    RED.nodes.registerType('workflow-api-trigger', WorkflowApiTriggerNode, {
        credentials: {
            authToken: { type: 'password' }
        }
    });
};
