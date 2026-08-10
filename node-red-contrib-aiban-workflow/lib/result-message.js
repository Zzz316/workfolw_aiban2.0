"use strict";

const {
    BUSINESS_STATUSES,
    assertValidOutcome,
    buildResultFromOutcome,
    makeResultEventId,
    toAuditAbcResult,
} = require("./workflow-contract");

function hasTerminalAbcResult(msg) {
    const abcResult = msg && msg.abc_result;
    return Boolean(abcResult && BUSINESS_STATUSES.includes(abcResult.result_status));
}

function providedResultEventId(msg, outcome) {
    return msg?.workflow?.result?.result_event_id
        || outcome?.compatibility?.abc_result_event_id
        || msg?.abc_result?.result_event_id
        || msg?.abc_result?.event_id
        || "";
}

function normalizeTerminalResultMessage(msg) {
    if (!msg || typeof msg !== "object") {
        return { terminal: false };
    }

    if (msg.workflow && msg.workflow.outcome) {
        const outcome = assertValidOutcome(msg.workflow.outcome);
        const expectedResultEventId = makeResultEventId(outcome);
        const suppliedResultEventId = providedResultEventId(msg, outcome);
        if (suppliedResultEventId && suppliedResultEventId !== expectedResultEventId) {
            throw new Error(`result_event_id mismatch: expected ${expectedResultEventId}, got ${suppliedResultEventId}`);
        }

        const workflowResult = buildResultFromOutcome(outcome, {
            resultEventId: expectedResultEventId,
        });
        const abcResult = hasTerminalAbcResult(msg)
            ? {
                ...msg.abc_result,
                result_event_id: msg.abc_result.result_event_id || expectedResultEventId,
                event_id: msg.abc_result.event_id || msg.abc_result.result_event_id || expectedResultEventId,
            }
            : toAuditAbcResult(outcome, {
                audit: msg.abc_result || {},
                resultEventId: workflowResult.result_event_id,
            });

        return {
            terminal: true,
            abcResult,
            workflowOutcome: outcome,
            workflowResult,
            resultEventId: workflowResult.result_event_id,
        };
    }

    if (hasTerminalAbcResult(msg)) {
        const abcResult = msg.abc_result;
        const resultEventId = abcResult.result_event_id || abcResult.event_id || "";
        return {
            terminal: true,
            abcResult,
            workflowOutcome: null,
            workflowResult: null,
            resultEventId,
        };
    }

    return { terminal: false };
}

function applyNormalizedTerminalResult(msg, normalized) {
    if (!normalized || !normalized.terminal) return msg;

    msg.abc_result = normalized.abcResult;
    if (normalized.workflowOutcome || normalized.workflowResult) {
        msg.workflow = {
            ...(msg.workflow || {}),
            workflow_id: normalized.workflowOutcome?.workflow_id || msg.workflow?.workflow_id,
            scene_id: normalized.workflowOutcome?.scene_id || msg.workflow?.scene_id,
            outcome: normalized.workflowOutcome || msg.workflow?.outcome,
            result: normalized.workflowResult || msg.workflow?.result,
        };
    }
    return msg;
}

module.exports = {
    normalizeTerminalResultMessage,
    applyNormalizedTerminalResult,
};

