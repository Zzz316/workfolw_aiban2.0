"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateReleaseGate } = require("../../tools/release_gate");

test("T22 release gate reports current field blockers without hiding completed dev checks", () => {
    const result = evaluateReleaseGate(require("node:path").resolve(__dirname, "../.."), {});
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.checks.find(check => check.id === "node:aiban-custom-flow").ok, true);
    assert.ok(result.blockers.some(item => item.includes("T16 field acceptance")));
    assert.ok(result.blockers.some(item => item.includes("field acceptance sign-off")));
});
