"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateReleaseGate } = require("../../tools/release_gate");

test("T22 release gate reports current field blockers without hiding completed dev checks", () => {
    const result = evaluateReleaseGate(require("node:path").resolve(__dirname, "../.."), {});
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.checks.find(check => check.id === "node:aiban-custom-flow").ok, true);
    assert.equal(result.checks.find(check => check.id === "package:version-2.0").ok, true);
    assert.equal(result.checks.find(check => check.id === "legacy-path:icameraapi").ok, true);
    assert.equal(result.checks.find(check => check.id === "legacy-path:scenes").ok, true);
    assert.equal(result.checks.find(check => check.id === "legacy-path:core").ok, true);
    assert.equal(result.checks.find(check => check.id === "legacy-path:workflows").ok, true);
    assert.equal(result.checks.find(check => check.id === "legacy-python-dependency:pyzmq").ok, true);
    assert.equal(result.checks.find(check => check.id === "legacy-python-dependency:pymysql").ok, true);
    assert.equal(result.checks.find(check => check.id === "node-red-lock:no-zeromq").ok, true);
    assert.equal(result.checks.find(check => check.id === "node-red-cache:node-red/.config.nodes.json").ok, true);
    assert.equal(result.checks.find(check => check.id === "node-red-cache:node-red/.config.nodes.json.backup").ok, true);
    assert.equal(result.checks.find(check => check.id === "generated-npm-lock:node-red/node_modules/.package-lock.json").ok, true);
    assert.equal(result.checks.find(check => check.id === "generated-npm-lock:node-red-contrib-aiban-workflow/node_modules/.package-lock.json").ok, true);
    assert.ok(result.blockers.some(item => item.includes("T16 field acceptance")));
    assert.ok(result.blockers.some(item => item.includes("field acceptance sign-off")));
});
