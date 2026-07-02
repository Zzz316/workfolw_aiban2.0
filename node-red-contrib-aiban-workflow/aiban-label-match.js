"use strict";

/**
 * aiban-label-match — Label Filter/Matcher Node for A-B-C Recognition
 *
 * Checks each incoming frame's labels against configured steps
 * (model_id + label + confidence_min). If any steps match, the
 * message is augmented with a `workflow` block and sent onward.
 * Non-matching frames are discarded.
 */

module.exports = function registerLabelMatchNode(RED) {
    function AibanLabelMatchNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Parse configured steps
        const workflowId = config.workflow_id || "abc-sequence-demo";
        const steps = [];
        if (Array.isArray(config.steps)) {
            for (const s of config.steps) {
                if (s.id && s.label) {
                    steps.push({
                        id: String(s.id),
                        model_id: String(s.model_id || "1"),
                        label: String(s.label),
                        confidence_min: Number(s.confidence) || 0.5,
                    });
                }
            }
        }

        const unmatchedLogLevel = config.unmatchedLogLevel || "none";
        // "none" | "debug" | "info" | "warn"

        let matchCount = 0;
        let totalFrames = 0;

        node.on("input", function onInput(msg, send, done) {
            totalFrames++;
            const matchStart = process.hrtime.bigint();
            const matchStartedAtMs = Date.now();

            try {
                // Get labels from the frame (attached by frame-input-node)
                const frame = msg.payload;
                const labels = frame.labels || [];

                // No labels → no match
                if (!Array.isArray(labels) || labels.length === 0) {
                    if (unmatchedLogLevel === "debug") {
                        node.warn(`[label-match] #${frame.frame_seq} 无标签, 跳过`);
                    }
                    if (done) done();
                    return;
                }

                // Match each configured step against available labels
                const matchedSteps = [];
                for (const step of steps) {
                    for (const label of labels) {
                        if (
                            String(label.model_id) === step.model_id &&
                            String(label.label) === step.label &&
                            Number(label.confidence) >= step.confidence_min
                        ) {
                            matchedSteps.push(step.id);
                            break; // One match per step is sufficient
                        }
                    }
                }

                const matchFinishedAtMs = Date.now();
                const matchDurationMs = Number(
                    process.hrtime.bigint() - matchStart
                ) / 1e6;

                if (matchedSteps.length > 0) {
                    matchCount++;
                    // Attach workflow block
                    msg.workflow = {
                        workflow_id: workflowId,
                        matched_steps: matchedSteps,
                        match_started_at_ms: matchStartedAtMs,
                        match_finished_at_ms: matchFinishedAtMs,
                        match_duration_ms: Number(matchDurationMs.toFixed(3)),
                    };

                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: `匹配: [${matchedSteps.join(",")}] ${matchDurationMs.toFixed(2)}ms`,
                    });

                    send(msg);
                } else {
                    // Non-matching labels
                    if (unmatchedLogLevel === "warn") {
                        const labelStr = labels.map(
                            (l) => `m${l.model_id}:${l.label}(${l.confidence.toFixed(2)})`
                        ).join(", ");
                        node.status({
                            fill: "yellow",
                            shape: "ring",
                            text: `无匹配: ${labelStr}`,
                        });
                    }
                }
            } catch (error) {
                node.error(`label-match error: ${error.message}`, msg);
            }

            if (done) done();
        });

        node.on("close", function onClose() {
            node.status({});
        });
    }

    RED.nodes.registerType("aiban-label-match", {
        category: "艾班工作流",
        color: "#87CEEB",
        defaults: {
            name: { value: "标签匹配" },
            workflow_id: { value: "abc-sequence-demo" },
            steps: { value: [] },
            unmatchedLogLevel: { value: "none" },
        },
        inputs: 1,
        outputs: 1,
        icon: "font-awesome/fa-filter",
        paletteLabel: "aiban label match",
        label: function () {
            return this.name || "标签匹配";
        },
    });
};
