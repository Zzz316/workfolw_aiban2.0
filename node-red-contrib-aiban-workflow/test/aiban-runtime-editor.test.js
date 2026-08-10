"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const editorPath = path.join(__dirname, "..", "aiban-runtime.html");
const editorHtml = fs.readFileSync(editorPath, "utf8");
const scriptMatch = editorHtml.match(
    /<script type="text\/javascript">([\s\S]*?)<\/script>/
);

test("aiban-runtime editor JavaScript has valid syntax", () => {
    assert.ok(scriptMatch, "Editor JavaScript block should exist");
    assert.doesNotThrow(() => new Function(scriptMatch[1]));
});

test("canvas button reads actual state and does not toggle autoStart", () => {
    assert.doesNotMatch(editorHtml, /toggle\s*:\s*["']autoStart["']/);
    assert.match(editorHtml, /aibanRuntimeStatusRequest\(node\.id\)/);
    assert.match(editorHtml, /actual_state/);
    assert.match(editorHtml, /aibanRuntimeControlRequest\(node\.id, action\)/);
});

test("edit dialog exposes real status plus start, stop and restart controls", () => {
    assert.match(editorHtml, /id="aiban-runtime-actual-state"/);
    assert.match(editorHtml, /id="aiban-runtime-start"/);
    assert.match(editorHtml, /id="aiban-runtime-stop"/);
    assert.match(editorHtml, /id="aiban-runtime-restart"/);
    assert.match(editorHtml, /ready_metadata_summary/);
    assert.match(editorHtml, /groups=/);
    assert.match(editorHtml, /metadata=未就绪/);
    for (const state of [
        "STOPPED",
        "STARTING",
        "READY",
        "STOPPING",
        "ERROR",
        "RECOVERING",
    ]) {
        assert.match(editorHtml, new RegExp(state));
    }
});
