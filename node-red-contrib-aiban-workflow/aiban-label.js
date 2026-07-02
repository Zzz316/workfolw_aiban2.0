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
                // Get labels from the frame (attached by frame-input-node)
                const frame = msg.payload || {};
                const labels = frame.labels || [];

                // Ensure aiban block exists
                if (!msg.aiban) {
                    msg.aiban = {};
                }
                if (!Array.isArray(msg.aiban.label_matches)) {
                    msg.aiban.label_matches = [];
                }

                let matched = false;
                let matchedConfidence = null;

                // Check if any label in this frame matches our config
                if (Array.isArray(labels) && labels.length > 0) {
                    for (const lbl of labels) {
                        if (
                            String(lbl.model_id) === modelId &&
                            String(lbl.label) === label &&
                            Number(lbl.confidence) >= confidenceMin
                        ) {
                            matched = true;
                            matchedConfidence = Number(lbl.confidence);
                            matchCount++;
                            break;
                        }
                    }
                }

                const matchDurationMs = Number(
                    process.hrtime.bigint() - matchStart
                ) / 1e6;

                // Append match result
                msg.aiban.label_matches.push({
                    node_id: node.id,
                    label_id: labelId,
                    model_id: modelId,
                    label: label,
                    confidence_min: confidenceMin,
                    matched: matched,
                    confidence: matched ? matchedConfidence : null,
                    match_duration_ms: Number(matchDurationMs.toFixed(3)),
                });

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
