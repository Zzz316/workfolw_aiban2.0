const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

module.exports = function(RED) {
    // 自动解析接口保持不变
    RED.httpAdmin.post("/aiban/auto-parse", RED.auth.needsPermission(''), function(req, res) {
        try {
            const doc = yaml.load(req.body.content);
            let groupCameraMap = {}; 
            let groupInferMap = {}; 

            if (doc.GroupArrary) {
                doc.GroupArrary.forEach(group => {
                    let cIds = [];
                    let props = {}; 
                    
                    if (group.Sources) group.Sources.forEach(s => {
                        if (fs.existsSync(s.config)) {
                            try {
                                const sDoc = yaml.load(fs.readFileSync(s.config, 'utf8'));
                                if (sDoc && sDoc.id !== undefined) cIds.push(sDoc.id);
                            } catch(e){}
                        }
                    });
                    
                    if (group.Infers) {
                        group.Infers.forEach(inf => {
                            if (inf.property) Object.assign(props, inf.property);
                        });
                    }
                    
                    groupCameraMap[group.groupid] = cIds;
                    groupInferMap[group.groupid] = props;
                });
            }
            
            let modelMap = {}; 
            if (doc.ModelArrary && doc.ModelArrary.Models) {
                doc.ModelArrary.Models.forEach(m => {
                    const jsonPath = m.modelpath.replace(/\.[^/.]+$/, "") + ".json";
                    let labels = [];
                    if (fs.existsSync(jsonPath)) {
                        try {
                            const labelData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                            labels = labelData.map(item => ({
                                name: item.labelName,
                                sign: item.sign !== undefined ? item.sign : parseInt(item.labelCode)
                            }));
                        } catch(e) {}
                    }
                    modelMap[m.modelid] = { 
                        modelName: path.basename(m.modelpath, path.extname(m.modelpath)), 
                        labels: labels 
                    };
                });
            }
            res.json({ groupCameraMap, modelMap, groupInferMap });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    function WorkflowSequenceNode(config) {
        RED.nodes.createNode(this, config);
        this.on('input', function(msg) {
            const alarmCooldown = parseInt(config.cooldown) || 10;

            let completeLogSteps = [];
            let formattedSteps = [];

            if (config.steps) {
                config.steps.forEach(s => {
                    if (s.count && s.count > 0) completeLogSteps.push(`${s.label || s.id}${s.count}颗`);
                    else completeLogSteps.push(s.label || s.id);

                    // 【核心修改】：组装带有 step 级 model_id 覆盖的步骤对象
                    let stepObj = {
                        id: s.id,
                        label: s.label,
                        confidence: s.confidence
                    };
                    
                    // 如果前端该步骤指定了局部模型，则写入覆盖属性
                    if (s.model_id !== undefined && s.model_id !== "") {
                        stepObj.model_id = parseInt(s.model_id);
                    }

                    if (s.count) stepObj.count = s.count;
                    if (s.duration) stepObj.duration = s.duration;
                    if (s.external === true || s.external === "true") stepObj.external = true;
                    if (s.alarm_name) stepObj.alarm_name = s.alarm_name;
                    if (s.step_code) stepObj.step_code = s.step_code;
                    if (s.trigger !== undefined) stepObj.trigger = s.trigger;
                    if (s.end) stepObj.end = s.end;

                    // 新格式：sub_models 数组（同 model_id OR，多 model_id AND）
                    if (Array.isArray(s.sub_models) && s.sub_models.length > 0) {
                        stepObj.sub_models = s.sub_models.map(sm => ({
                            model_id: parseInt(sm.model_id),
                            labels: (sm.labels || []).map(l => ({
                                name: l.name,
                                confidence: parseFloat(l.confidence) || 0.5
                            }))
                        })).filter(sm => !isNaN(sm.model_id) && sm.labels.length > 0);
                    } else if (s.sub_model_id && s.sub_label) {
                        // 旧格式保留兼容
                        stepObj.sub_model_id = s.sub_model_id;
                        stepObj.sub_label = s.sub_label;
                    }
                    formattedSteps.push(stepObj);
                });
            }
            const completeLogText = "流程完成：" + completeLogSteps.join(" → ") + "，OK";
            const saveResult = config.saveResult === true || config.saveResult === "true";
            const resultTable = config.resultTable || "icamera_data.icam_alarm_data";
            const okAlarmName = config.okAlarmName || "流程OK";

            const makeResultSaveAction = (alarmContent, status, imgPath) => ({ save_db: { table: resultTable, fields: {
                day: "$date", time: "$time", time_division: "$time_division", time_month: "$time_month",
                week: "$week", region: "$region", group_id: parseInt(config.groupId),
                camera_id: "$sourceid", alarm_content: alarmContent, img_path: imgPath,
                timedate: "$datetime", alarm_status: status
            } } });

            const speakEnabled = config.speak === true || config.speak === "true";
            // 构造 alarm 配置的辅助函数：自动附加 speak 字段
            const makeAlarmCfg = (msg, extra) => {
                const cfg = Object.assign({ msg: msg, type: "ng", save_image: true, cooldown: alarmCooldown }, extra || {});
                if (speakEnabled) cfg.speak = 1;
                return cfg;
            };

            const okActions = [ { log: completeLogText } ];
            const incompleteAlarmCfg = { type: "ng", save_image: true, cooldown: alarmCooldown };
            if (speakEnabled) incompleteAlarmCfg.speak = 1;
            const incompleteActions = [ { alarm_each_missing: incompleteAlarmCfg } ];
            const wrongCountActions = [ { alarm: makeAlarmCfg("{step_alarm_name} (数量错误，期望:{expected_count} 实际:{actual_count})") } ];
            const timeoutActions = [ { alarm: makeAlarmCfg("步骤超时") } ];

            if (saveResult) okActions.push(makeResultSaveAction(okAlarmName, "OK", "$image_path"));

            // 【核心还原】：回归只导出一个单独的 workflow 对象的逻辑
            msg.payload = {
                name: config.name || "步骤顺序检测",
                mode: "sequence",
                group_id: parseInt(config.groupId),
                model_id: parseInt(config.modelId), // 这是 workflow 级默认模型
                timers: {
                    step_timeout: { timeout: parseFloat(config.timeout) || 999999.0 }
                },
                sequence: {
                    ordered: config.ordered,
                    timeout_timer: "step_timeout",
                    steps: formattedSteps, // 这里面包含了可能带有 model_id 的子步骤
                    on_complete: okActions,
                    on_incomplete: incompleteActions,
                    on_skip: [ { alarm: makeAlarmCfg("漏步骤:{skipped_step}") } ],
                    on_wrong_count: wrongCountActions,
                    on_timeout: timeoutActions
                }
            };

            // 生产周期入库（主子表）：勾选后注入 cycle_record 块
            if (config.enableCycle === true || config.enableCycle === "true") {
                msg.payload.cycle_record = {
                    enabled: true,
                    master_table: config.cycleMasterTable || "icamera_data.production_cycle_record",
                    detail_table: config.cycleDetailTable || "icamera_data.step_execution_log"
                };
            }

            // 人员在场检测：勾选后注入 presence_tracking 块
            if (config.enablePresence === true || config.enablePresence === "true") {
                msg.payload.presence_tracking = {
                    enabled: true,
                    person_label: config.personLabel || "person",
                    confidence: parseFloat(config.personConf) || 0.5,
                    alarm_name: config.presenceAlarmName || "人员离岗",
                    absence_duration: parseFloat(config.presenceDuration) || 30
                };
            }

            // 循环模式：勾选后注入 loop_mode 块（多段序列 + 边沿触发）
            if (config.enableLoopMode === true || config.enableLoopMode === "true") {
                var segments = [];
                if (Array.isArray(config.loopSegments)) {
                    config.loopSegments.forEach(function(seg) {
                        if (seg.step_id) {
                            var s = {
                                step_id: seg.step_id,
                                loop_count: parseInt(seg.loop_count) || 1
                            };
                            // 备选步骤（逗号分隔）→ alt_step_ids 数组
                            if (seg.alt_step_ids_raw) {
                                var alts = seg.alt_step_ids_raw.split(',').map(function(x) { return x.trim(); }).filter(Boolean);
                                if (alts.length > 0) s.alt_step_ids = alts;
                            }
                            // guard 验证步骤（逗号分隔）→ guard_step_ids 数组
                            if (seg.guard_step_ids_raw) {
                                var guards = seg.guard_step_ids_raw.split(',').map(function(x) { return x.trim(); }).filter(Boolean);
                                if (guards.length > 0) s.guard_step_ids = guards;
                            }
                            // 过渡步骤（逗号分隔）→ transition_step_ids 数组
                            // B步骤：transition_alarm_name 有值→报警；无值→不报警静默过渡
                            // C步骤(guard)出现→清空计数
                            if (seg.transition_step_ids_raw) {
                                var trans = seg.transition_step_ids_raw.split(',').map(function(x) { return x.trim(); }).filter(Boolean);
                                if (trans.length > 0) s.transition_step_ids = trans;
                            }
                            if (seg.transition_alarm_name) s.transition_alarm_name = seg.transition_alarm_name;
                            if (seg.repeat_alarm_name) s.repeat_alarm_name = seg.repeat_alarm_name;
                            s.repeat_alarm_cooldown = parseInt(seg.repeat_alarm_cooldown) || parseInt(config.loopOutOfOrderCooldown) || 10;
                            segments.push(s);
                        }
                    });
                }
                if (segments.length > 0) {
                    msg.payload.loop_mode = {
                        enabled: true,
                        segments: segments,
                        out_of_order_alarm_name: config.loopOutOfOrderAlarm || "动作顺序错误",
                        out_of_order_cooldown: parseInt(config.loopOutOfOrderCooldown) || 10
                    };
                }
            }

            this.send(msg);
        });
    }
    RED.nodes.registerType("workflow-sequence", WorkflowSequenceNode);
}