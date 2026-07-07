"use strict";

/**
 * aiban-label — Individual Label Component
 *
 * Each instance configures only its own (model_id + label + confidence)
 * condition. Multiple instances are wired in series on the canvas to
 * express the expected recognition order.
 *
 * This node is PASSTHROUGH: every frame passes through regardless of
 * match. Matched frames get an entry appended to msg.aiban.label_matches[].
 * The wire order between aiban-label nodes defines the sequence topology.
 *
 * Config:
 *   - label_id: user-defined step identifier (e.g. "A", "B", "C")
 *   - model_id: model ID to match (string, e.g. "1")
 *   - label: label string to match (e.g. "person", "A")
 *   - confidence: minimum confidence (0-1, default 0.5)
 */

module.exports = function registerLabelNode(RED) {
    function AibanLabelNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // === Configuration ===
        const labelId = config.label_id || config.name || "?";
        const modelId = String(config.model_id || "1");
        const label = String(config.label || "");
        const confidenceMin = Number(config.confidence) || 0.5;

        let matchCount = 0;
        let totalFrames = 0;

        node.on("input", function onInput(msg, send, done) {
            totalFrames++;
            const matchStart = process.hrtime.bigint();

            try {
                // Scan models[*].boxes[*] from aiban-runtime frame message.
                // The old flat labels[] array is deprecated and no longer
                // emitted by aiban-runtime (Phase 1+).
                const frame = msg.payload || {};
                const models = frame.models || {};

                // Ensure aiban block exists
                if (!msg.aiban) {
                    msg.aiban = {};
                }
                if (!Array.isArray(msg.aiban.label_matches)) {
                    msg.aiban.label_matches = [];
                }

                let matched = false;
                let matchedConfidence = null;
                let matchedBoxIndex = -1;
                let boxCount = 0;

                // Walk every model → boxes and check against our config
                for (const [mId, result] of Object.entries(models)) {
                    if (String(mId) !== modelId) continue;
                    if (!result || !result.ok || !Array.isArray(result.boxes)) continue;

                    for (let boxIdx = 0; boxIdx < result.boxes.length; boxIdx++) {
                        boxCount++;
                        const box = result.boxes[boxIdx];
                        if (
                            String(box.label) === label &&
                            Number(box.confidence) >= confidenceMin
                        ) {
                            matched = true;
                            matchedConfidence = Number(box.confidence);
                            matchedBoxIndex = boxIdx;
                            matchCount++;
                            break;
                        }
                    }
                    if (matched) break;
                }

                const matchDurationMs = Number(
                    process.hrtime.bigint() - matchStart
                ) / 1e6;

                // Append match result (preserves format for downstream nodes)
                msg.aiban.label_matches.push({
                    node_id: node.id,
                    label_id: labelId,
                    model_id: modelId,
                    label: label,
                    confidence_min: confidenceMin,
                    matched: matched,
                    confidence: matched ? matchedConfidence : null,
                    box_index: matched ? matchedBoxIndex : -1,
                    boxes_scanned: boxCount,
                    match_duration_ms: Number(matchDurationMs.toFixed(3)),
                });

                // Also populate workflow block per Phase 2 message contract
                if (matched) {
                    if (!msg.workflow) {
                        msg.workflow = {};
                    }
                    if (!Array.isArray(msg.workflow.matched_steps)) {
                        msg.workflow.matched_steps = [];
                    }
                    if (!Array.isArray(msg.workflow.matched_labels)) {
                        msg.workflow.matched_labels = [];
                    }
                    msg.workflow.matched_steps.push(labelId);
                    msg.workflow.matched_labels.push({
                        step_id: labelId,
                        model_id: modelId,
                        label: label,
                        confidence: matchedConfidence,
                        box_index: matchedBoxIndex,
                    });
                    msg.workflow.match_started_at_ms = Number(
                        process.hrtime.bigint()
                    ) / 1e6;
                    msg.workflow.match_finished_at_ms = Number(
                        process.hrtime.bigint()
                    ) / 1e6;
                    msg.workflow.match_duration_ms = Number(
                        matchDurationMs.toFixed(3)
                    );
                }

                // Update status
                if (matched) {
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: `${labelId}: ${label} ✅ ${matchedConfidence.toFixed(2)} (${matchDurationMs.toFixed(2)}ms)`,
                    });
                } else {
                    node.status({
                        fill: "grey",
                        shape: "ring",
                        text: `${labelId}: ${label} —`,
                    });
                }

                // ALWAYS pass through — downstream labels must also see this frame
                send(msg);
            } catch (error) {
                node.error(`aiban-label [${labelId}] error: ${error.message}`, msg);
            }

            if (done) done();
        });

        node.on("close", function onClose() {
            node.status({});
        });
    }

    RED.nodes.registerType("aiban-label", AibanLabelNode, {
        category: "艾班工作流",
        color: "#87CEEB",
        defaults: {
            name: { value: "" },
            label_id: { value: "" },
            model_id: { value: "1" },
            label: { value: "" },
            confidence: { value: 0.5 },
        },
        inputs: 1,
        outputs: 1,
        icon: "font-awesome/fa-tag",
        paletteLabel: "aiban label",
        label: function () {
            const lid = this.label_id || "";
            const lbl = this.label || "";
            if (lid && lbl) return `标签 ${lid}: ${lbl}`;
            if (lid) return `标签 ${lid}`;
            return this.name || "aiban label";
        },
    });
};
