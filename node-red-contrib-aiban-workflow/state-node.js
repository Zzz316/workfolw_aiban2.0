module.exports = function(RED) {
    function WorkflowStateNode(config) {
        RED.nodes.createNode(this, config);
        this.on('input', function(msg) {
            
            let vars = {};
            if(config.vars) {
                config.vars.forEach(v => {
                    if(v.name) {
                        vars[v.name] = { type: v.vtype };
                        if(v.vtype === 'bool' && v.vdefault === 'true') vars[v.name].default = true;
                        if(v.vtype === 'bool' && v.vdefault === 'false') vars[v.name].default = false;
                    }
                });
            }

            let timers = {};
            if(config.timers) {
                config.timers.forEach(t => {
                    if(t.name) {
                        timers[t.name] = {};
                        if(t.timeout) timers[t.name].timeout = parseFloat(t.timeout);
                    }
                });
            }

            let states = [];
            try {
                states = JSON.parse(config.statesJson || "[]");
            } catch (e) {
                this.error("用户自定义流程 states 格式错误，请检查 JSON 语法！");
            }

            msg.payload = {
                name: config.name || "用户自定义流程",
                mode: "custom_flow",
                group_id: parseInt(config.groupId),
                model_id: parseInt(config.modelId),
                vars: vars,
                timers: timers,
                states: states
            };
            this.send(msg);
        });
    }
    RED.nodes.registerType("workflow-state", WorkflowStateNode);
}