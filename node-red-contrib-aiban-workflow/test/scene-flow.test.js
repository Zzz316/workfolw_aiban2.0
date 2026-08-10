"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const registerEntryNode = require("../aiban-scene-entry");
const registerResultNode = require("../aiban-result");
const { TopologyCompiler } = require("../lib/topology-compiler");

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "aiban-scene-flow-"));
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
        // Best-effort test cleanup.
    }
}

function input(node, msg) {
    const sent = [];
    return new Promise((resolve) => {
        node.emit("input", msg, (out) => sent.push(out), () => resolve(sent));
    });
}

describe("aiban-scene-entry", () => {
    test("passes matching scene identity and rejects a mismatched workflow", async () => {
        let Constructor;
        const RED = {
            nodes: {
                createNode(node, config) {
                    const emitter = new EventEmitter();
                    node.id = config.id;
                    node.on = emitter.on.bind(emitter);
                    node.emit = emitter.emit.bind(emitter);
                    node.status = () => {};
                },
                registerType(name, ctor) {
                    if (name === "aiban-scene-entry") Constructor = ctor;
                },
            },
        };
        registerEntryNode(RED);
        const node = new Constructor({
            id: "entry",
            runtimeNodeId: "runtime",
            group_id: 1,
            scene_id: "plug-sequence",
            workflow_id: "group/1/scene/plug-sequence",
        });

        const accepted = await input(node, {
            aiban: {
                group_id: 1,
                scene_id: "plug-sequence",
                workflow_id: "group/1/scene/plug-sequence",
            },
            payload: {},
        });
        assert.equal(accepted[0][0].workflow.scene_id, "plug-sequence");
        assert.equal(accepted[0][1], null);

        const rejected = await input(node, {
            aiban: {
                group_id: 1,
                scene_id: "plug-sequence",
                workflow_id: "wrong",
            },
            payload: {},
        });
        assert.equal(rejected[0][0], null);
        assert.equal(
            rejected[0][1].payload.diagnostic_code,
            "SCENE_IDENTITY_MISMATCH"
        );
    });
});

describe("TopologyCompiler scene entry", () => {
    test("recognizes aiban-scene-entry as a valid topology boundary", () => {
        const nodes = [
            {
                id: "entry",
                type: "aiban-scene-entry",
                runtime_node_id: "runtime",
                wires: [["label-1"]],
            },
            {
                id: "label-1",
                type: "aiban-label",
                label_id: "1",
                model_id: "0",
                label: "plug-1",
                confidence: 0.8,
                frame_count: 1,
                is_end: false,
                wires: [["result"]],
            },
            { id: "result", type: "aiban-result", wires: [[]] },
        ];
        const compiler = new TopologyCompiler({
            nodes: {
                eachNode(callback) {
                    nodes.forEach(callback);
                },
            },
        });
        const result = compiler.compile("result");
        assert.equal(result.valid, true);
        assert.equal(result.entryNodeId, "entry");
        assert.deepEqual(result.labels.map((label) => label.labelId), ["1"]);
    });
});

describe("scene interruption and shipped flows", () => {
    test("aiban-interrupt closes only the matching unfinished workflow as INTERRUPTED", async () => {
        const dir = tempDir();
        let Constructor;
        const nodes = new Map();
        const runtime = {
            id: "runtime",
            type: "aiban-runtime",
            wires: [[]],
        };
        const entry = {
            id: "entry",
            type: "aiban-scene-entry",
            runtimeNodeId: "runtime",
            runtime_node_id: "runtime",
            wires: [["label-1"]],
        };
        const label1 = {
            id: "label-1",
            type: "aiban-label",
            label_id: "1",
            model_id: "0",
            label: "plug-1",
            confidence: 0.8,
            frame_count: 1,
            is_end: false,
            wires: [["label-2"]],
        };
        const label2 = {
            id: "label-2",
            type: "aiban-label",
            label_id: "2",
            model_id: "0",
            label: "plug-2",
            confidence: 0.8,
            frame_count: 1,
            is_end: false,
            wires: [["result"]],
        };
        [runtime, entry, label1, label2].forEach((node) => nodes.set(node.id, node));

        const RED = {
            settings: { userDir: dir },
            nodes: {
                createNode(node, config) {
                    const emitter = new EventEmitter();
                    node.id = config.id;
                    node.type = "aiban-result";
                    node.wires = [[]];
                    node.on = emitter.on.bind(emitter);
                    node.emit = emitter.emit.bind(emitter);
                    node.send = () => {};
                    node.error = () => {};
                    node.warn = () => {};
                    node.log = () => {};
                    node.status = () => {};
                    nodes.set(node.id, node);
                },
                registerType(name, ctor) {
                    if (name === "aiban-result") Constructor = ctor;
                },
                getNode(id) {
                    return nodes.get(id);
                },
                eachNode(callback) {
                    nodes.forEach(callback);
                },
            },
        };
        registerResultNode(RED);
        const node = new Constructor({
            id: "result",
            mode: "simple-sequence",
            workflow_id: "group/1/scene/plug-sequence",
            scene_id: "plug-sequence",
            cycle_timeout_ms: 30000,
            stateDbPath: path.join(dir, "state.db"),
            auditDir: path.join(dir, "audit"),
        });

        try {
            const first = await input(node, {
                payload: {
                    group_id: 1,
                    source_id: 1,
                    session_id: "session-1",
                    event_seq: 1,
                    event_id: "event-1",
                },
                aiban: {
                    group_id: 1,
                    source_id: 1,
                    session_id: "session-1",
                    event_seq: 1,
                    event_id: "event-1",
                    label_matches: [{
                        label_id: "1",
                        matched: true,
                    }],
                },
            });
            assert.equal(first.length, 0);

            const interrupted = await input(node, {
                topic: "aiban-interrupt",
                payload: {
                    group_id: 1,
                    source_id: 1,
                    session_id: "session-1",
                    scene_id: "plug-sequence",
                    workflow_id: "group/1/scene/plug-sequence",
                    reason: "exclusive-selection-changed",
                },
                aiban: {
                    group_id: 1,
                    source_id: 1,
                    session_id: "session-1",
                    scene_id: "plug-sequence",
                    workflow_id: "group/1/scene/plug-sequence",
                },
            });
            assert.equal(interrupted.length, 1);
            assert.equal(interrupted[0].abc_result.result_status, "INTERRUPTED");
            assert.equal(interrupted[0].workflow.scene_id, "plug-sequence");
            assert.match(
                interrupted[0].abc_result.result_event_id,
                /^group\/1\/scene\/plug-sequence:/
            );
        } finally {
            await new Promise((resolve, reject) => {
                node.emit("close", (error) => error ? reject(error) : resolve());
            });
            cleanup(dir);
        }
    });

    test("production flow has no business labels on the main tab and example is Mock-importable", () => {
        const productionPath = path.resolve(__dirname, "..", "..", "node-red", "flows.json");
        const examplePath = path.resolve(__dirname, "..", "examples", "group-scene-flow.json");
        const production = JSON.parse(fs.readFileSync(productionPath, "utf8"));
        const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));

        const mainTab = production.find((node) => (
            node.type === "tab" && node.label === "AiBan 主流程"
        ));
        const sceneTab = production.find((node) => (
            node.type === "tab" && node.label === "group/1/scene/plug-sequence"
        ));
        assert.ok(mainTab);
        assert.ok(sceneTab);
        assert.equal(
            production.some((node) => node.z === mainTab.id && node.type === "aiban-label"),
            false
        );
        assert.deepEqual(
            production.filter((node) => (
                node.z === sceneTab.id && node.type === "aiban-label"
            )).map((node) => node.label_id),
            ["1", "2", "3", "end"]
        );
        assert.ok(production.some((node) => (
            node.z === sceneTab.id && node.type === "aiban-scene-entry"
        )));
        assert.ok(example.some((node) => (
            node.type === "aiban-runtime" && node.useMock === true
        )));
        assert.ok(example.some((node) => node.type === "aiban-scene-router"));
        assert.ok(example.some((node) => node.type === "aiban-scene-entry"));
    });
});
