module.exports = function(RED) {
    function WorkflowMonitorNode(config) {
        RED.nodes.createNode(this, config);
        this.on('input', function(msg) {
            const alarmCooldown = parseInt(config.cooldown) || 30;
            const saveResult = config.saveResult === true || config.saveResult === "true";
            const resultTable = config.resultTable || "icamera_data.icam_alarm_data";

            const makeResultSaveAction = (alarmContent) => ({
                save_db: {
                    table: resultTable,
                    fields: {
                        day: "$date",
                        time: "$time",
                        time_division: "$time_division",
                        time_month: "$time_month",
                        week: "$week",
                        region: "$region",
                        group_id: parseInt(config.groupId),
                        camera_id: "$sourceid",
                        alarm_content: alarmContent,
                        img_path: "$image_path",
                        timedate: "$datetime",
                        alarm_status: "NG"
                    }
                }
            });

            let rules = [];
            if (config.rules) {
                config.rules.forEach((r, idx) => {
                    if (!r.label) return;
                    const ruleId = r.id || ("rule" + (idx + 1));
                    const alarmName = r.alarm_name || r.label;

                    const rule = {
                        id: ruleId,
                        label: r.label,
                        confidence: parseFloat(r.confidence) || 0.5,
                        type: r.type === "on_absent" ? "on_absent" : "on_present",
                        frames: parseInt(r.frames) || 10
                    };

                    if (r.model_id !== undefined && r.model_id !== "") {
                        rule.model_id = parseInt(r.model_id);
                    }

                    // 新格式：sub_models 数组（同 model_id OR，多 model_id AND）
                    if (Array.isArray(r.sub_models) && r.sub_models.length > 0) {
                        rule.sub_models = r.sub_models.map(sm => ({
                            model_id: parseInt(sm.model_id),
                            labels: (sm.labels || []).map(l => ({
                                name: l.name,
                                confidence: parseFloat(l.confidence) || 0.5
                            }))
                        })).filter(sm => !isNaN(sm.model_id) && sm.labels.length > 0);
                    } else if (r.sub_model_id && r.sub_label) {
                        // 旧格式保留兼容
                        rule.sub_model_id = parseInt(r.sub_model_id);
                        rule.sub_label = {
                            name: r.sub_label.name,
                            confidence: parseFloat(r.sub_label.confidence) || 0.5
                        };
                    }

                    const alarmCfg = { msg: alarmName, type: "ng", save_image: true, cooldown: alarmCooldown };
                    if (r.speak === true) {
                        alarmCfg.speak = 1;  // 喇叭开启
                    }
                    const actions = [
                        { alarm: alarmCfg }
                    ];
                    if (saveResult) actions.push(makeResultSaveAction(alarmName));
                    rule.actions = actions;
                    rules.push(rule);
                });
            }

            msg.payload = {
                name: config.name || "安环监控",
                mode: "monitor",
                group_id: parseInt(config.groupId),
                model_id: parseInt(config.modelId),
                rules: rules
            };
            this.send(msg);
        });
    }
    RED.nodes.registerType("workflow-monitor", WorkflowMonitorNode);
}
