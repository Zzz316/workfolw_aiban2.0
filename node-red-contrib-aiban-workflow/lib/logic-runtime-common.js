"use strict";

const { buildResultFromOutcome, normalizeOutcome } = require("./workflow-contract");
const { beijingNowISO } = require("./workflow-audit");

function identityOf(msg, workflowId, sceneId) {
    const payload = msg?.payload || {};
    const aiban = msg?.aiban || {};
    const workflow = msg?.workflow || {};
    const sessionId = String(aiban.session_id || payload.session_id || "");
    const groupId = Number(payload.group_id ?? aiban.group_id ?? workflow.group_id ?? 0);
    const sourceId = Number(payload.source_id ?? aiban.source_id ?? 0);
    const resolvedWorkflow = String(workflow.workflow_id || aiban.workflow_id || workflowId || "");
    const resolvedScene = String(workflow.scene_id || aiban.scene_id || sceneId || "");
    const eventSeq = Number(aiban.event_seq ?? payload.event_seq ?? aiban.frame_seq ?? payload.frame_seq ?? 0);
    const eventId = String(aiban.event_id || payload.event_id || aiban.message_id || payload.message_id || "");
    return {
        workflowId: resolvedWorkflow,
        sceneId: resolvedScene,
        sessionId,
        groupId,
        sourceId,
        streamId: `group-${groupId}/source-${sourceId}`,
        eventSeq,
        eventId,
        stateKey: `${resolvedWorkflow}:${sessionId}:${groupId}:${sourceId}`,
    };
}

function matchedLabels(msg) {
    return new Set(Object.keys(factSnapshot(msg).labels));
}

function centerOf(box) {
    if (!box || typeof box !== "object") return null;
    if (Number.isFinite(Number(box.x)) && Number.isFinite(Number(box.y))) {
        return { x: Number(box.x), y: Number(box.y) };
    }
    if (Number.isFinite(Number(box.cx)) && Number.isFinite(Number(box.cy))) {
        return { x: Number(box.cx), y: Number(box.cy) };
    }
    const polygon = box.polygon || box.points;
    if (Array.isArray(polygon) && polygon.length > 0) {
        let sx = 0;
        let sy = 0;
        let count = 0;
        for (const point of polygon) {
            const x = Number(point?.x ?? point?.[0]);
            const y = Number(point?.y ?? point?.[1]);
            if (Number.isFinite(x) && Number.isFinite(y)) {
                sx += x;
                sy += y;
                count++;
            }
        }
        if (count > 0) return { x: sx / count, y: sy / count };
    }
    return null;
}

function addLabel(facts, label, source = {}) {
    const key = String(label || "").trim();
    if (!key) return;
    const current = facts.labels[key] || {
        count: 0,
        max_confidence: 0,
        boxes: [],
        sub_labels: {},
    };
    const count = Math.max(1, Number(source.count || 1));
    current.count += count;
    const confidence = Number(source.confidence ?? source.score ?? 0);
    if (Number.isFinite(confidence)) current.max_confidence = Math.max(current.max_confidence, confidence);
    if (source.box) current.boxes.push(source.box);
    for (const subLabel of source.subLabels || []) {
        current.sub_labels[subLabel] = (current.sub_labels[subLabel] || 0) + 1;
        facts.sub_labels[subLabel] = (facts.sub_labels[subLabel] || 0) + 1;
    }
    facts.labels[key] = current;
}

function subLabelsOf(box) {
    const labels = [];
    const candidates = [
        ...(Array.isArray(box?.sub_models) ? box.sub_models : []),
        ...(Array.isArray(box?.subModels) ? box.subModels : []),
        ...(Array.isArray(box?.sub_boxes) ? box.sub_boxes : []),
        ...(Array.isArray(box?.children) ? box.children : []),
    ];
    for (const item of candidates) {
        if (item?.label) labels.push(String(item.label));
        for (const subBox of item?.boxes || []) {
            if (subBox?.label) labels.push(String(subBox.label));
        }
        for (const subBox of item?.labels || []) {
            if (subBox?.name) labels.push(String(subBox.name));
            else if (typeof subBox === "string") labels.push(subBox);
        }
    }
    return labels;
}

function factSnapshot(msg) {
    const facts = { labels: {}, sub_labels: {} };
    const labels = new Set();
    for (const match of msg?.aiban?.label_matches || []) {
        if (match && match.matched === true) {
            const label = String(match.label_id || match.labelId || match.label || "");
            labels.add(label);
            addLabel(facts, label, {
                count: match.count,
                confidence: match.confidence,
                box: match.box || (match.x !== undefined && match.y !== undefined ? match : null),
                subLabels: match.sub_labels || match.subLabels || [],
            });
        }
    }
    for (const model of Object.values(msg?.payload?.models || {})) {
        for (const box of model?.boxes || []) {
            if (box && box.label) {
                const label = String(box.label);
                labels.add(label);
                addLabel(facts, label, {
                    confidence: box.confidence,
                    box: { ...box, center: centerOf(box) },
                    subLabels: subLabelsOf(box),
                });
            }
        }
    }
    return facts;
}

function terminalEvent({
    identity,
    state,
    status,
    code,
    reason,
    expectedStep = null,
    actualSteps = [],
    nowMs,
    details = {},
    effects = [],
    imagePath = "",
}) {
    const outcome = normalizeOutcome({
        workflow_id: identity.workflowId,
        scene_id: identity.sceneId,
        cycle_id: state.cycleId,
        status,
        started_at: state.startedAtMs ? beijingNowISO(state.startedAtMs) : null,
        finished_at: beijingNowISO(nowMs),
        duration_ms: state.startedAtMs ? Math.max(0, nowMs - state.startedAtMs) : 0,
        code,
        reason,
        expected_step: expectedStep,
        actual_steps: actualSteps,
        runtime: {
            session_id: identity.sessionId,
            stream_id: identity.streamId,
            group_id: identity.groupId,
            source_id: identity.sourceId,
            start_event_seq: state.startEventSeq ?? null,
            end_event_seq: identity.eventSeq ?? state.lastEventSeq ?? null,
        },
        evidence: { image_path: imagePath, screenshot_error: null },
        details,
        effects,
    });
    const result = buildResultFromOutcome(outcome);
    return { type: "terminal", outcome, result, effects };
}

function attachTerminal(msg, event) {
    const output = structuredClone(msg || {});
    output.workflow = {
        ...(output.workflow || {}),
        workflow_id: event.outcome.workflow_id,
        scene_id: event.outcome.scene_id,
        outcome: event.outcome,
        result: event.result,
    };
    output.topic = "aiban-outcome";
    return output;
}

module.exports = { identityOf, matchedLabels, factSnapshot, terminalEvent, attachTerminal };
