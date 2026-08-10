"use strict";

const OUTCOME_SCHEMA_VERSION = "workflow-outcome/v1";
const RESULT_SCHEMA_VERSION = "workflow-result/v1";
const DEFAULT_SCENE_ID = "default";
const BUSINESS_STATUSES = Object.freeze(["OK", "NG", "TIMEOUT", "INTERRUPTED"]);
const SYSTEM_ERROR_TOPIC = "aiban/error";

class ContractValidationError extends Error {
    constructor(message, errors) {
        super(message);
        this.name = "ContractValidationError";
        this.errors = errors;
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
    for (const value of values) {
        if (value === undefined || value === null) continue;
        const s = String(value).trim();
        if (s) return s;
    }
    return "";
}

function normalizeStatus(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim().toUpperCase();
}

function isValidIsoDate(value) {
    if (typeof value !== "string" || value.trim() === "") return false;
    if (!value.includes("T")) return false;
    return Number.isFinite(Date.parse(value));
}

function toArray(value) {
    if (Array.isArray(value)) return value.slice();
    if (typeof value === "string" && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

function normalizeRuntime(source, opts = {}) {
    const runtime = isPlainObject(source.runtime) ? source.runtime : {};
    const groupId = source.group_id ?? runtime.group_id ?? opts.groupId ?? opts.group_id ?? null;
    const sourceId = source.source_id ?? runtime.source_id ?? opts.sourceId ?? opts.source_id ?? null;
    const streamId = firstString(
        source.stream_id,
        runtime.stream_id,
        opts.streamId,
        opts.stream_id,
        groupId !== null && sourceId !== null ? `group-${groupId}/source-${sourceId}` : ""
    );

    return {
        session_id: firstString(source.session_id, runtime.session_id, opts.sessionId, opts.session_id),
        stream_id: streamId,
        group_id: groupId === null || groupId === undefined ? null : Number(groupId),
        source_id: sourceId === null || sourceId === undefined ? null : Number(sourceId),
        start_event_seq: source.start_event_seq ?? source.start_frame_seq ?? runtime.start_event_seq ?? null,
        end_event_seq: source.end_event_seq ?? source.end_frame_seq ?? runtime.end_event_seq ?? null,
    };
}

function normalizeOutcome(input, opts = {}) {
    const source = isPlainObject(input) ? input : {};
    const status = normalizeStatus(source.status || source.result_status);
    const runtime = normalizeRuntime(source, opts);
    const actualSteps = toArray(source.actual_steps ?? source.actual_sequence);
    const finishedAt = firstString(source.finished_at, source.cycle_finished_at, opts.finishedAt, opts.finished_at);
    const evidenceSource = isPlainObject(source.evidence) ? source.evidence : {};
    const hasStandardSchema = firstString(source.schema_version) === OUTCOME_SCHEMA_VERSION;
    const sceneDefault = hasStandardSchema ? "" : DEFAULT_SCENE_ID;

    return {
        schema_version: firstString(source.schema_version, OUTCOME_SCHEMA_VERSION),
        workflow_id: firstString(source.workflow_id, source.workflowId, opts.workflowId, opts.workflow_id),
        scene_id: firstString(source.scene_id, source.sceneId, opts.sceneId, opts.scene_id, sceneDefault),
        cycle_id: firstString(source.cycle_id, source.cycleId, opts.cycleId, opts.cycle_id),
        status,
        finished_at: finishedAt,
        started_at: firstString(source.started_at, source.cycle_started_at, opts.startedAt, opts.started_at) || null,
        duration_ms: source.duration_ms ?? source.cycle_duration_ms ?? null,
        code: source.code === undefined || source.code === null
            ? (status && status !== "OK" ? status : null)
            : String(source.code),
        reason: source.reason ?? source.failure_reason ?? null,
        expected_step: source.expected_step ?? null,
        actual_steps: actualSteps,
        runtime,
        evidence: {
            image_path: firstString(source.image_path, evidenceSource.image_path),
            screenshot_error: source.screenshot_error ?? evidenceSource.screenshot_error ?? null,
        },
        details: isPlainObject(source.details) ? { ...source.details } : {},
        effects: Array.isArray(source.effects) ? source.effects.slice() : [],
        compatibility: {
            abc_result_event_id: firstString(
                source.result_event_id,
                source.event_id,
                opts.resultEventId,
                opts.result_event_id
            ) || null,
        },
    };
}

function validateOutcome(input) {
    const outcome = normalizeOutcome(input);
    const errors = [];

    if (outcome.schema_version !== OUTCOME_SCHEMA_VERSION) {
        errors.push(`schema_version must be ${OUTCOME_SCHEMA_VERSION}`);
    }
    if (!outcome.workflow_id) errors.push("workflow_id is required");
    if (!outcome.scene_id) errors.push("scene_id is required");
    if (!outcome.cycle_id) errors.push("cycle_id is required");
    if (!BUSINESS_STATUSES.includes(outcome.status)) {
        errors.push(`status must be one of ${BUSINESS_STATUSES.join(", ")}`);
    }
    if (!isValidIsoDate(outcome.finished_at)) {
        errors.push("finished_at must be a valid ISO date-time string");
    }
    if (!Array.isArray(outcome.actual_steps)) {
        errors.push("actual_steps must be an array");
    }
    if (!isPlainObject(outcome.details)) errors.push("details must be an object");
    if (!Array.isArray(outcome.effects)) errors.push("effects must be an array");
    if (outcome.duration_ms !== null && (!Number.isFinite(Number(outcome.duration_ms)) || Number(outcome.duration_ms) < 0)) {
        errors.push("duration_ms must be a non-negative number when present");
    }
    if (["NG", "TIMEOUT"].includes(outcome.status)) {
        if (outcome.code !== null && typeof outcome.code !== "string") {
            errors.push("code must be a string or null");
        }
        if (outcome.reason !== null && typeof outcome.reason !== "string") {
            errors.push("reason must be a string or null");
        }
        if (outcome.expected_step !== null && typeof outcome.expected_step !== "string") {
            errors.push("expected_step must be a string or null");
        }
    }

    return { valid: errors.length === 0, errors, outcome };
}

function assertValidOutcome(input) {
    const result = validateOutcome(input);
    if (!result.valid) {
        throw new ContractValidationError("Invalid workflow outcome", result.errors);
    }
    return result.outcome;
}

function makeResultEventId(input) {
    const outcome = normalizeOutcome(input);
    const runtime = outcome.runtime || {};
    const sessionId = firstString(runtime.session_id, "unknown-session");
    const streamId = firstString(runtime.stream_id, outcome.scene_id);
    const status = normalizeStatus(outcome.status);
    return `${outcome.workflow_id}:${sessionId}:${streamId}:${outcome.cycle_id}:${status}`;
}

function buildResultFromOutcome(input, opts = {}) {
    const outcome = assertValidOutcome(input);
    const resultEventId = firstString(opts.resultEventId, opts.result_event_id, makeResultEventId(outcome));
    return {
        schema_version: RESULT_SCHEMA_VERSION,
        result_event_id: resultEventId,
        dedupe_key: resultEventId,
        workflow_id: outcome.workflow_id,
        scene_id: outcome.scene_id,
        cycle_id: outcome.cycle_id,
        status: outcome.status,
        finished_at: outcome.finished_at,
        screenshot_required: false,
        screenshot_error: outcome.evidence.screenshot_error,
        outcome,
        details: outcome.details,
        effects: outcome.effects,
    };
}

function toAuditAbcResult(input, opts = {}) {
    const outcome = normalizeOutcome(input);
    const resultEventId = firstString(
        opts.resultEventId,
        opts.result_event_id,
        outcome.compatibility.abc_result_event_id,
        makeResultEventId(outcome)
    );
    const audit = isPlainObject(opts.audit) ? opts.audit : {};

    return {
        ...audit,
        cycle_id: outcome.cycle_id || audit.cycle_id || null,
        expected_step: outcome.expected_step ?? audit.expected_step ?? null,
        result_status: outcome.status,
        failure_reason: outcome.reason ?? audit.failure_reason ?? null,
        cycle_started_at: outcome.started_at ?? audit.cycle_started_at ?? null,
        cycle_finished_at: outcome.finished_at,
        cycle_duration_ms: outcome.duration_ms ?? audit.cycle_duration_ms ?? null,
        result_event_id: resultEventId,
        event_id: resultEventId,
        actual_sequence: audit.actual_sequence || JSON.stringify(outcome.actual_steps),
        session_id: outcome.runtime.session_id || audit.session_id || "",
        group_id: outcome.runtime.group_id ?? audit.group_id ?? null,
        source_id: outcome.runtime.source_id ?? audit.source_id ?? null,
        stream_id: outcome.runtime.stream_id || audit.stream_id || "",
        image_path: outcome.evidence.image_path || audit.image_path || "",
        screenshot_error: outcome.evidence.screenshot_error || audit.screenshot_error || null,
    };
}

module.exports = {
    OUTCOME_SCHEMA_VERSION,
    RESULT_SCHEMA_VERSION,
    DEFAULT_SCENE_ID,
    BUSINESS_STATUSES,
    SYSTEM_ERROR_TOPIC,
    ContractValidationError,
    normalizeOutcome,
    validateOutcome,
    assertValidOutcome,
    buildResultFromOutcome,
    makeResultEventId,
    toAuditAbcResult,
};

