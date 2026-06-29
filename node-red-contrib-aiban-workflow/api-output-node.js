const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

module.exports = function(RED) {
    function md5(value) {
        return crypto.createHash('md5').update(value || '', 'utf8').digest('hex');
    }

    // 按 api.py 的格式组装一次签名 POST，仅供编辑界面「发送测试」使用。
    // 运行时真正的推送在 Python 侧 core/alarm_db.py 完成。
    function sendApiOutput(options, ngcode, ngarea, done) {
        let target;
        try {
            target = new URL(options.url);
        } catch (e) {
            done(new Error('URL 非法: ' + e.message));
            return;
        }
        const client = target.protocol === 'https:' ? https : http;
        const timeoutMs = parseInt(options.timeoutMs) || 5000;

        const appid = String(options.appid || '');
        const appsecret = String(options.appsecret || '');
        const timestamp = new Date().toString();
        const appsign = md5(appid + timestamp + appsecret);

        const headers = {
            'version': '2',
            'appid': appid,
            'timestamp': timestamp,
            'appsign': appsign,
            'content-type': 'application/json; charset=UTF-8'
        };

        const body = JSON.stringify({
            channelCode: appid,
            args: { address: ngarea, code: ngcode }
        });
        headers['Content-Length'] = Buffer.byteLength(body);

        const req = client.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            method: 'POST',
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
                    body: text.length > 20000 ? text.slice(0, 20000) + '\n... response truncated ...' : text
                });
            });
        });
        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.on('error', err => done(err));
        req.write(body);
        req.end();
    }

    if (!RED._aibanApiOutputRoutes) {
        RED._aibanApiOutputRoutes = true;
        RED.httpAdmin.post('/aiban/test-api-output', RED.auth.needsPermission(''), function(req, res) {
            try {
                const body = req.body || {};
                sendApiOutput({
                    url: body.url,
                    appid: body.appid,
                    appsecret: body.appsecret,
                    timeoutMs: body.timeoutMs || 5000
                }, body.ngcode || '报警名称', body.ngarea || '报警区域', function(err, result) {
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

    function WorkflowApiOutputNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.on('input', function(msg) {
            const gid = parseInt(config.groupId);
            if (isNaN(gid)) {
                node.error('请配置有效的 群组(Group ID)');
                return;
            }
            if (!config.appid || !String(config.appid).trim()) {
                node.error('请填写 appid');
                return;
            }
            if (!config.url || !String(config.url).trim()) {
                node.error('请填写 url');
                return;
            }

            const payload = {
                _is_api_output: true,
                group_id: gid,
                appid: String(config.appid).trim(),
                appsecret: String(config.appsecret || '').trim(),
                url: String(config.url).trim()
            };

            const sourceid = parseInt(config.sourceId);
            if (!isNaN(sourceid)) payload.sourceid = sourceid;

            msg.payload = payload;
            node.send(msg);
        });
    }

    RED.nodes.registerType('workflow-api-output', WorkflowApiOutputNode);
};
