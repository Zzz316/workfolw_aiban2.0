"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
    OUTCOME_SCHEMA_VERSION,
    RESULT_SCHEMA_VERSION,
    DEFAULT_SCENE_ID,
    ContractValidationError,
    buildResultFromOutcome,
    makeResultEventId,
    normalizeOutcome,
    validateOutcome,
    assertValidOutcome,
    toAuditAbcResult,
} = require("../lib/workflow-contract");

function baseOutcome(overrides = {}) {
    return {
        schema_version: OUTCOME_SCHEMA_VERSION,
        workflow_id: "abc-demo",
        scene_id: "plug-sequence",
        cycle_id: "cycle-001",
        status: "OK",
        started_at: "2026-07-24T10:00:00.000+08:00",
        finished_at: "2026-07-24T10:00:05.000+08:00",
        duration_ms: 5000,
        code: null,
        reason: null,
        expected_step: null,
        actual_steps: ["A", "B", "C"],
        runtime: {
            session_id: "session-001",
            stream_id: "group-1/source-1",
            group_id: 1,
            source_id: 1,
            start_event_seq: 100,
            end_event_seq: 102,
        },
        evidence: {
            image_path: "captures/cycle-001.jpg",
            screenshot_error: null,
        },
        compatibility: {
            abc_result_event_id: null,
        },
        ...overrides,
    };
}

describe("workflow outcome/result contract", () => {
    test("accepts a complete OK outcome and builds a deterministic result", () => {
        const outcome = baseOutcome();
        const validation = validateOutcome(outcome);

        assert.equal(validation.valid, true);
        assert.deepEqual(validation.errors, []);
        assert.equal(
            makeResultEventId(outcome),
            "abc-demo:session-001:group-1/source-1:cycle-001:OK"
        );

        const result = buildResultFromOutcome(outcome);
        assert.equal(result.schema_version, RESULT_SCHEMA_VERSION);
        assert.equal(result.result_event_id, "abc-demo:session-001:group-1/source-1:cycle-001:OK");
        assert.equal(result.dedupe_key, result.result_event_id);
        assert.equal(result.outcome.status, "OK");
    });

    test("duplicate outcomes produce the same result_event_id", () => {
        const one = buildResultFromOutcome(baseOutcome());
        const two = buildResultFromOutcome(baseOutcome());

        assert.equal(one.result_event_id, two.result_event_id);
    });

    test("rejects illegal business statuses", () => {
        const validation = validateOutcome(baseOutcome({ status: "FAILED" }));

        assert.equal(validation.valid, false);
        assert.ok(validation.errors.some((e) => e.includes("status")));
        assert.throws(
            () => assertValidOutcome(baseOutcome({ status: "SYSTEM_ERROR" })),
            ContractValidationError
        );
    });

    test("rejects missing identity fields", () => {
        const validation = validateOutcome(baseOutcome({
            workflow_id: "",
            scene_id: "",
            cycle_id: "",
        }));

        assert.equal(validation.valid, false);
        assert.ok(validation.errors.includes("workflow_id is required"));
        assert.ok(validation.errors.includes("scene_id is required"));
        assert.ok(validation.errors.includes("cycle_id is required"));
    });

    test("rejects invalid finished_at values", () => {
        const validation = validateOutcome(baseOutcome({ finished_at: "2026-07-24" }));

        assert.equal(validation.valid, false);
        assert.ok(validation.errors.includes("finished_at must be a valid ISO date-time string"));
    });

    test("normalizes abc_result audit fields into a standard outcome", () => {
        const outcome = normalizeOutcome({
            workflow_id: "abc-demo",
            cycle_id: "cycle-ng",
            result_status: "NG",
            failure_reason: "期望步骤 B，但识别到 C",
            expected_step: "B",
            actual_sequence: "[\"A\"]",
            cycle_started_at: "2026-07-24T10:00:00.000+08:00",
            cycle_finished_at: "2026-07-24T10:00:02.000+08:00",
            cycle_duration_ms: 2000,
            session_id: "session-001",
            stream_id: "group-1/source-1",
            group_id: 1,
            source_id: 1,
        });

        assert.equal(outcome.scene_id, DEFAULT_SCENE_ID);
        assert.equal(outcome.status, "NG");
        assert.equal(outcome.reason, "期望步骤 B，但识别到 C");
        assert.deepEqual(outcome.actual_steps, ["A"]);
        assert.equal(validateOutcome(outcome).valid, true);

        const auditResult = toAuditAbcResult(outcome);
        assert.equal(auditResult.result_status, "NG");
        assert.equal(auditResult.failure_reason, "期望步骤 B，但识别到 C");
    });

    test("screenshot failures are recorded but do not invalidate the outcome", () => {
        const outcome = baseOutcome({
            status: "TIMEOUT",
            code: "TIMEOUT",
            reason: "周期超时",
            expected_step: "C",
            actual_steps: ["A", "B"],
            evidence: {
                image_path: "",
                screenshot_error: "screenshot timeout",
            },
        });
        const validation = validateOutcome(outcome);
        const result = buildResultFromOutcome(outcome);

        assert.equal(validation.valid, true);
        assert.equal(result.screenshot_required, false);
        assert.equal(result.screenshot_error, "screenshot timeout");
    });
});

