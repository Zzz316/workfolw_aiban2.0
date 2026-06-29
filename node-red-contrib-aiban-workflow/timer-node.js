module.exports = function(RED) {
    function WorkflowTimerNode(config) {
        RED.nodes.createNode(this, config);
        this.on('input', function(msg) {

            // ── 归一化 sub_models 数组（同 model_id OR，多 model_id AND） ──
            function buildSubModels(raw) {
                if (!Array.isArray(raw)) return null;
                var grouped = {};
                raw.forEach(function(sm) {
                    var mid = parseInt(sm.model_id);
                    if (isNaN(mid)) return;
                    (sm.labels || []).forEach(function(lbl) {
                        if (!lbl || !lbl.name) return;
                        if (!grouped[mid]) grouped[mid] = { model_id: mid, labels: [] };
                        grouped[mid].labels.push({
                            name: lbl.name,
                            confidence: parseFloat(lbl.confidence) || 0.5
                        });
                    });
                });
                var arr = Object.values(grouped).filter(sm => sm.labels.length > 0);
                return arr.length > 0 ? arr : null;
            }

            // ── 构造单个 on_label 对象 ──
            function buildOnLabel(labelName, conf, useSub, subModels) {
                var obj = { name: labelName, confidence: parseFloat(conf) || 0.8 };
                if (useSub) {
                    var sm = buildSubModels(subModels);
                    if (sm) obj.sub_models = sm;
                }
                return obj;
            }

            var startLabelObj = buildOnLabel(config.startLabel, config.startConf, config.useSubStart, config.startSubModels);
            var endLabelObj = buildOnLabel(config.endLabel, config.endConf, config.useSubEnd, config.endSubModels);

            let dbFields = {
                camera_id: "$camera_id",
                duration: "$work_timer.elapsed",
                start_time: "$work_timer.start_time",
                end_time: "$now"
            };

            let timerEndActions = [
                { stop_timer: "work_timer" },
                { log: "工时统计：检测到结束动作，结束计时并存库" },
                { save_db: { table: config.dbTable || "work_hours", fields: dbFields } }
            ];

            if (config.saveAlarmResult) {
                timerEndActions.push({ save_db: { table: config.alarmResultTable || "icamera_data.icam_alarm_data", fields: {
                    day: "$date",
                    time: "$time",
                    time_division: "$time_division",
                    time_month: "$time_month",
                    week: "$week",
                    region: "",
                    group_id: parseInt(config.groupId),
                    camera_id: "$sourceid",
                    alarm_content: config.alarmResultName || "流程OK",
                    img_path: "",
                    timedate: "$datetime",
                    alarm_status: "OK"
                } } });
            }

            timerEndActions.push({ reset: "work_timer" });

            var startRule = {
                id: "detect_start",
                on_label: startLabelObj,
                actions: [ { start_timer: "work_timer" }, { log: "工时统计：检测到开始动作，开始计时" } ]
            };
            if (config.startModelId !== undefined && config.startModelId !== "") {
                startRule.model_id = parseInt(config.startModelId);
            }

            var endRule = {
                id: "detect_end",
                on_label: endLabelObj,
                require_timer_running: "work_timer",
                actions: timerEndActions
            };
            if (config.endModelId !== undefined && config.endModelId !== "") {
                endRule.model_id = parseInt(config.endModelId);
            }

            let payload = {
                name: config.name || "工时统计",
                mode: "timer_record",
                group_id: parseInt(config.groupId),
                model_id: parseInt(config.modelId),
                timers: { "work_timer": {} },
                rules: [startRule, endRule]
            };

            if (config.enableAbsence) {
                payload.absence_tracking = {
                    enabled: true,
                    person_label: config.absencePersonLabel || "person",
                    confidence: parseFloat(config.absenceConf) || 0.5,
                    require_timer_running: "work_timer",
                    accum_var: "absence_timer"
                };
                dbFields.absence_time = "$absence_timer.elapsed";
            }

            msg.payload = payload;
            this.send(msg);
        });
    }
    RED.nodes.registerType("workflow-timer", WorkflowTimerNode);
}
