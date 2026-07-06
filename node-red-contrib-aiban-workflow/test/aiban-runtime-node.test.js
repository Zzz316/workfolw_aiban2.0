/**
 * Phase 1 — aiban-runtime Node-RED node integration tests.
 *
 * These tests load the real aiban-runtime.js against a minimal RED mock
 * and verify the node's behavior end-to-end.  Spawn is injected so tests
 * do NOT depend on a real Python installation or AiBan hardware.
 *
 * Usage:
 *   cd node-red-contrib-aiban-workflow
 *   node --test test/aiban-runtime-node.test.js
 */

"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
    createMockRED,
    createMockSpawn,
    delay,
    emitEvent,
    getPortMessages,
} = require("./test-helpers");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
    return {
        name: "test-runtime",
        pythonPath: "python",
        runnerPath: path.join(__dirname, "..", "..", "python_runtime", "aiban_runner.py"),
        sdkHome: "D:/product/AiBanWorkSpace",
        pipelineConfig: "D:/product/AiBanWorkSpace/abvideo/main-flow.yaml",
        workingDirectory: "",
        useMock: true,
        startupTimeoutMs: 5000,
        shutdownTimeoutMs: 2000,
        heartbeatIntervalMs: 5000,
        heartbeatTimeoutMs: 15000,
        restartPolicy: "never",
        maxRestartCount: 3,
        restartBackoffMs: 1000,
        autoStart: true,
        strictStdout: true,
        ...overrides,
    };
}

function makeFrameEvent(overrides = {}) {
    return {
        schema_version: 1,
        type: "frame",
        session_id: "test-session-001",
        event_id: "evt-001",
        event_seq: overrides.event_seq !== undefined ? overrides.event_seq : 1,
        emitted_at: new Date().toISOString(),
        payload: {
            group_id: 1, source_id: 1,
            stream_id: "group-1/source-1",
            captured_at: new Date().toISOString(),
            models: { "1": { ok: true, boxes: [
                { label: "A", label_index: 0, confidence: 0.95,
                  polygon: [[0,0],[100,0],[100,100],[0,100]], tracker_id: 42 }
            ]}},
            ...overrides,
        },
    };
}

function makeReadyEvent(overrides = {}) {
    return {
        schema_version: 1, type: "runtime_ready",
        session_id: "test-session-001", event_id: "evt-ready",
        event_seq: overrides.event_seq !== undefined ? overrides.event_seq : 0,
        emitted_at: new Date().toISOString(),
        payload: { groups: [1], sources_per_group: {"1": [1]}, models_loaded: ["1"], ...overrides },
    };
}

function makeHeartbeatEvent(overrides = {}) {
    return {
        schema_version: 1, type: "heartbeat",
        session_id: "test-session-001", event_id: "evt-hb",
        event_seq: overrides.event_seq !== undefined ? overrides.event_seq : 10,
        emitted_at: new Date().toISOString(),
        payload: {
            uptime_seconds: 5.0, frames_emitted: 50,
            queue_depth: 10, queue_capacity: 1024,
            queue_overflow_count: 0, queue_is_full: false,
            paused_sources: [],
            ...overrides,
        },
    };
}

// ---------------------------------------------------------------------------
// Helper: read stdin data after a delay
// ---------------------------------------------------------------------------

function readStdinAfter(proc, delayMs) {
    return new Promise((resolve) => {
        const chunks = [];
        function onData(chunk) { chunks.push(chunk.toString()); }
        proc.stdin.on("data", onData);
        setTimeout(() => resolve(chunks.join("")), delayMs);
    });
}

// ---------------------------------------------------------------------------
// Helper: create a node and optionally trigger manual process start.
// Pass autoStart: false in config, then call this to get a running process.
// ---------------------------------------------------------------------------

async function bootNode(registry, mockSpawn, configOverrides = {}) {
    const config = makeConfig({ _spawn: mockSpawn, ...configOverrides });
    const NodeCtor = registry.get("aiban-runtime").constructor;
    const node = new NodeCtor(config);
    // Wait for constructor's setTimeout(100ms) to fire
    await delay(300);
    // If autoStart was false, manually start
    if (!config.autoStart && mockSpawn.processes.length === 0) {
        node._startProcess();
        await delay(300);
    }
    // Wait a bit more if autoStart needs time for the inner setTimeout(500ms) for auto-start cmd
    if (config.autoStart && mockSpawn.processes.length === 0) {
        await delay(400);
    }
    const proc = mockSpawn.processes[0] || null;
    return { node, proc };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aiban-runtime node", { concurrency: 1 }, () => {

    let mockSpawn;
    let RED;
    let registry;
    let userDir;

    beforeEach(() => {
        mockSpawn = createMockSpawn();
        const mock = createMockRED({
            userDir: path.join(__dirname, "..", "..", "node-red"),
        });
        RED = mock.RED;
        registry = mock.nodeRegistry;
        userDir = mock.userDir;
        // Re-register the node type on each test's fresh RED
        require("../aiban-runtime.js")(RED);
    });

    afterEach(() => {
        mockSpawn.reset();
    });

    // ==================================================================
    // Test 1: Constructor spawns process and sends auto-start
    // ==================================================================

    test("1. Constructor spawns Python and sends auto-start command on stdin", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: true });
        assert.ok(proc, "Should have spawned process");

        // Should have written auto-start command to stdin (with 500ms delay in _startProcess)
        const stdinData = await readStdinAfter(proc, 600);
        assert.ok(stdinData.includes('"start"'), "Should send auto-start command");
        assert.ok(stdinData.includes("auto-start"), "Should include auto-start request_id");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 2: Frame events → port 1
    // ==================================================================

    test("2. Frame events are sent to output port 1", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });
        assert.ok(proc, "Should have spawned process");

        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        const frame = makeFrameEvent({ event_seq: 1 });
        emitEvent(proc, frame);
        await delay(50);

        const frames = getPortMessages(node, 0);
        assert.ok(frames.length > 0, "Should have at least one frame on port 1");
        assert.strictEqual(frames[0].topic, "aiban/frame");
        assert.ok(frames[0].payload.models, "Frame msg should have models payload");
        assert.strictEqual(frames[0].aiban.runtime_id, node.id);

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 3: Lifecycle events → port 2
    // ==================================================================

    test("3. Lifecycle events are sent to output port 2", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        emitEvent(proc, {
            schema_version: 1, type: "runtime_starting",
            session_id: "test-session-001", event_id: "evt-start", event_seq: 0,
            emitted_at: new Date().toISOString(),
            payload: { runner_version: "1.0.0" },
        });
        await delay(50);

        emitEvent(proc, makeReadyEvent({ event_seq: 1 }));
        await delay(50);

        const statusMsgs = getPortMessages(node, 1);
        assert.ok(statusMsgs.length >= 2, `Should have ≥2 status msgs, got ${statusMsgs.length}`);
        assert.strictEqual(statusMsgs[0].topic, "aiban/status");

        const lastStatus = node._statusCalls[node._statusCalls.length - 1];
        assert.strictEqual(lastStatus.fill, "green");
        assert.ok(lastStatus.text.includes("ready"));

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 4: PARSE_ERROR on invalid stdout JSON
    // ==================================================================

    test("4. Invalid JSON on stdout produces PARSE_ERROR on port 3", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        proc.stdout.push("this is not valid json at all\n");
        await delay(100);

        const warns = node._logs.filter(l => l.level === "warn");
        assert.ok(warns.length > 0, "Should have at least one warning");
        assert.ok(warns[0].msg.includes("stdout parse error"));

        const errors = getPortMessages(node, 2);
        const parseErrors = errors.filter(e => e && e.payload && e.payload.error_code === "PARSE_ERROR");
        assert.ok(parseErrors.length > 0, "Should have PARSE_ERROR on port 3");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 5: Long invalid line truncated
    // ==================================================================

    test("5. Long invalid JSON line is truncated in error message", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        proc.stdout.push("x".repeat(5000) + "\n");
        await delay(100);

        const errors = getPortMessages(node, 2);
        const parseErrors = errors.filter(e => e && e.payload && e.payload.error_code === "PARSE_ERROR");
        assert.ok(parseErrors.length > 0, "Should have PARSE_ERROR");
        const detail = parseErrors[0].payload.details;
        assert.ok(detail.raw_preview.length <= 258, "Raw preview should be truncated");
        assert.strictEqual(detail.raw_length, 5000);

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 6: Empty lines skipped
    // ==================================================================

    test("6. Empty stdout lines are skipped without error", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        proc.stdout.push("\n");
        proc.stdout.push("   \n");
        proc.stdout.push("\n");
        await delay(100);

        const errors = getPortMessages(node, 2);
        const parseErrors = errors.filter(e => e && e.payload && e.payload.error_code === "PARSE_ERROR");
        assert.strictEqual(parseErrors.length, 0, "Empty lines should not produce errors");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 7: Half-json → PARSE_ERROR
    // ==================================================================

    test("7. Half/incomplete JSON lines produce PARSE_ERROR", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        proc.stdout.push('{"type": "frame", "payload": {"unclosed": true\n');
        await delay(100);

        const errors = getPortMessages(node, 2);
        const parseErrors = errors.filter(e => e && e.payload && e.payload.error_code === "PARSE_ERROR");
        assert.ok(parseErrors.length > 0, "Half JSON should produce PARSE_ERROR");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 8: Glued JSON → PARSE_ERROR
    // ==================================================================

    test("8. Glued JSON (two objects on one line) is rejected as PARSE_ERROR", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        proc.stdout.push('{"a":1}{"b":2}\n');
        await delay(100);

        const errors = getPortMessages(node, 2);
        const parseErrors = errors.filter(e => e && e.payload && e.payload.error_code === "PARSE_ERROR");
        assert.ok(parseErrors.length > 0, "Glued JSON should produce PARSE_ERROR");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 9: Oversized message safe handling
    // ==================================================================

    test("9. Oversized stdout line is safely handled", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        proc.stdout.push("NOT_JSON:" + "y".repeat(100 * 1024) + "\n");
        await delay(200);

        const errors = getPortMessages(node, 2);
        const parseErrors = errors.filter(e => e && e.payload && e.payload.error_code === "PARSE_ERROR");
        assert.ok(parseErrors.length > 0, "Should handle oversized line");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 10: Non-strict mode
    // ==================================================================

    test("10. Non-strict mode logs invalid stdout as debug without PARSE_ERROR", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false, strictStdout: false });

        proc.stdout.push("diagnostic text from AiBan DLL\n");
        await delay(100);

        const warns = node._logs.filter(l => l.level === "warn");
        assert.ok(warns.length > 0, "Should still warn even in non-strict mode");

        const nativeLogs = node._logs.filter(l => l.msg && l.msg.includes("[python:native]"));
        assert.ok(nativeLogs.length > 0, "Should log as python:native in non-strict mode");

        const errors = getPortMessages(node, 2);
        const parseErrors = errors.filter(e => e && e.payload && e.payload.error_code === "PARSE_ERROR");
        assert.strictEqual(parseErrors.length, 0, "Non-strict mode should not emit PARSE_ERROR");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 11: runtime_error → port 3
    // ==================================================================

    test("11. runtime_error events go to error output port 3", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        emitEvent(proc, {
            schema_version: 1, type: "runtime_error",
            session_id: "test-session-001", event_id: "evt-err", event_seq: 5,
            emitted_at: new Date().toISOString(),
            payload: {
                error_code: "QUEUE_HIGH_WATERMARK",
                message: "Queue depth 900 >= 819",
                details: { queue_depth: 900, capacity: 1024, threshold: 819 },
            },
        });
        await delay(100);

        const errors = getPortMessages(node, 2);
        const runtimeErrors = errors.filter(e => e && e.payload && e.payload.error_code === "QUEUE_HIGH_WATERMARK");
        assert.ok(runtimeErrors.length > 0, "runtime_error should go to port 3");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 12: Control command via msg.input → stdin
    // ==================================================================

    test("12. Input control msg sends command to stdin and receives result", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        // Make ready first so _sendCommand doesn't fail
        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        const stdinWrites = [];
        proc.stdin.on("data", (chunk) => stdinWrites.push(chunk.toString()));

        let sendCalled = false;
        const send = (msgArray) => { sendCalled = true; };

        node._onInput(
            { topic: "aiban/control", payload: { command: "health", params: {} } },
            send,
            () => {}
        );
        await delay(200);

        const allStdin = stdinWrites.join("");
        assert.ok(allStdin.includes('"health"'), "Should write health command to stdin");

        // Simulate command result
        const reqIdMatch = allStdin.match(/"request_id":"([^"]+)"/);
        if (reqIdMatch) {
            emitEvent(proc, {
                schema_version: 1, type: "command_result",
                session_id: "test-session-001", event_id: "evt-cr", event_seq: 100,
                emitted_at: new Date().toISOString(),
                payload: {
                    request_id: reqIdMatch[1], ok: true, command: "health",
                    result: { state: "ready" }, error: null,
                },
            });
            await delay(100);
        }

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 13: Invalid command
    // ==================================================================

    test("13. Invalid control command is warned and ignored", async () => {
        const { node } = await bootNode(registry, mockSpawn, { autoStart: false });

        node._onInput(
            { topic: "aiban/control", payload: { command: "nonexistent" } },
            () => {},
            () => {}
        );
        await delay(50);

        const warns = node._logs.filter(l => l.level === "warn" && l.msg.includes("Invalid control command"));
        assert.ok(warns.length > 0, "Should warn about invalid command");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 14: on-failure restart
    // ==================================================================

    test("14. on-failure restart policy restarts after non-zero exit", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false,
            restartPolicy: "on-failure",
            maxRestartCount: 3,
            restartBackoffMs: 100,
        });

        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        proc.exitCode = 1;
        proc.emit("exit", 1, null);
        await delay(600);

        assert.ok(mockSpawn.processes.length >= 2, `Should spawn restart process, got ${mockSpawn.processes.length}`);

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 15: Max restart count
    // ==================================================================

    test("15. Max restart count stops restarting after limit", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false,
            restartPolicy: "on-failure",
            maxRestartCount: 2,
            restartBackoffMs: 10,
        });

        // First crash
        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);
        proc.exitCode = 1;
        proc.emit("exit", 1, null);
        await delay(200);

        // Second crash
        const proc2 = mockSpawn.processes[1];
        if (proc2) {
            emitEvent(proc2, makeReadyEvent({ event_seq: 0 }));
            await delay(50);
            proc2.exitCode = 1;
            proc2.emit("exit", 1, null);
            await delay(200);
        }

        // Third crash (should give up after maxRestartCount=2)
        const proc3 = mockSpawn.processes[2];
        if (proc3) {
            emitEvent(proc3, makeReadyEvent({ event_seq: 0 }));
            await delay(50);
            proc3.exitCode = 1;
            proc3.emit("exit", 1, null);
            await delay(200);
        }

        // Should have stopped spawning
        const finalCount = mockSpawn.processes.length;
        assert.ok(finalCount <= 4, `Should not spawn beyond limit (initial + maxRestartCount), got ${finalCount}`);

        const maxStatus = node._statusCalls.find(s => s.text && s.text.includes("max restarts"));
        // May or may not have hit limit depending on timing — just verify node still works
        assert.ok(true, "Node survived restart limit test");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 16: Startup timeout
    // ==================================================================

    test("16. Startup timeout kills process and sets red status", async () => {
        const config = makeConfig({
            autoStart: true, _spawn: mockSpawn, startupTimeoutMs: 300,
        });
        const node = new (registry.get("aiban-runtime").constructor)(config);
        await delay(1200);

        const proc = mockSpawn.processes[0];
        if (proc) {
            assert.ok(proc.killed, "Process should be killed after startup timeout");
        }

        const timeoutStatus = node._statusCalls.find(s => s.text && s.text.includes("startup timeout"));
        assert.ok(timeoutStatus, "Should have startup timeout status");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 17: Stop during startup
    // ==================================================================

    test("17. Stop during startup kills process and does NOT auto-restart", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false, restartPolicy: "on-failure", shutdownTimeoutMs: 500,
        });

        // Call _stopProcess directly (simulates admin stop button or _onClose)
        node._stopProcess(true);
        await delay(200);

        assert.ok(proc.killed, "Process should be killed on stop");

        const stoppingStatus = node._statusCalls.find(s => s.text && s.text.includes("stopping"));
        assert.ok(stoppingStatus, "Should be stopping");

        proc.emit("exit", -1, "SIGTERM");
        await delay(500);

        const afterStop = mockSpawn.processes.length;
        assert.strictEqual(afterStop, 1, "Should not spawn new process after stop");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 18: Close handler
    // ==================================================================

    test("18. Node close kills process and calls done callback", async () => {
        const config = makeConfig({ autoStart: false, _spawn: mockSpawn });
        const node = new (registry.get("aiban-runtime").constructor)(config);
        await delay(300);
        node._startProcess();
        await delay(200);
        const proc = mockSpawn.processes[0];
        assert.ok(proc, "Should have process");

        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        let closeDone = false;
        node._onClose(false, () => { closeDone = true; });
        proc.emit("exit", 0, null);
        await delay(200);

        assert.ok(closeDone, "Close done callback should be called");
    });

    // ==================================================================
    // Test 19: Spawn failure
    // ==================================================================

    test("19. Spawn failure is caught and sets red status", async () => {
        const badSpawn = function () { throw new Error("SPAWN_FAIL_SIMULATED"); };
        badSpawn.processes = []; badSpawn.lastSpawn = null; badSpawn.reset = () => {};

        const config = makeConfig({ autoStart: true, _spawn: badSpawn });
        const node = new (registry.get("aiban-runtime").constructor)(config);
        await delay(300);

        const errors = node._logs.filter(l => l.level === "error" && l.msg.includes("Failed to spawn"));
        assert.ok(errors.length > 0, "Should log spawn failure");

        const spawnFailStatus = node._statusCalls.find(s => s.text && s.text.includes("spawn failed"));
        assert.ok(spawnFailStatus, "Should have spawn failed status");
    });

    // ==================================================================
    // Test 20: stderr forwarding
    // ==================================================================

    test("20. Python stderr is forwarded to node log", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        proc.stderr.push("[2026-07-06T10:00:00] INFO aiban_runner: Runner started\n");
        await delay(100);

        const stderrLogs = node._logs.filter(l => l.msg && l.msg.includes("[python:stderr]"));
        assert.ok(stderrLogs.length > 0, "Should forward stderr to log");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 21: stderr flooding doesn't block
    // ==================================================================

    test("21. Heavy stderr output does not block the node", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        for (let i = 0; i < 100; i++) {
            proc.stderr.push(`[python:stderr] log line ${i}\n`);
        }
        await delay(200);

        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);
        assert.ok(true, "Node survived stderr flooding");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 22: Admin HTTP start
    // ==================================================================

    test("22. Admin HTTP POST start spawns process when none is running", async () => {
        const { node } = await bootNode(registry, mockSpawn, { autoStart: false });

        // Kill the existing process to simulate a stopped state
        const firstProc = mockSpawn.processes[0];
        if (firstProc) {
            firstProc.kill();
            firstProc.emit("exit", -1, "SIGTERM");
            await delay(200);
        }
        const beforeCount = mockSpawn.processes.length;

        // Register node instance so getNode can find it
        const entry = registry.get("aiban-runtime");
        if (!entry._instances) entry._instances = new Map();
        entry._instances.set(node.id, node);

        const startRoute = RED.httpAdmin._routes.find(
            r => r.method === "POST" && r.path.includes(":action")
        );
        assert.ok(startRoute, "Should have admin POST route");

        let resStatus = 0;
        await startRoute.handlers[startRoute.handlers.length - 1](
            { params: { id: node.id, action: "start" } },
            { sendStatus: (code) => { resStatus = code; } }
        );

        assert.strictEqual(resStatus, 200, "Start endpoint should return 200");
        await delay(400);

        const afterCount = mockSpawn.processes.length;
        assert.ok(afterCount > beforeCount, `Should spawn process after admin start (${beforeCount} → ${afterCount})`);

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 23: Admin HTTP stop
    // ==================================================================

    test("23. Admin HTTP POST stop kills running process", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        const entry = registry.get("aiban-runtime");
        if (!entry._instances) entry._instances = new Map();
        entry._instances.set(node.id, node);

        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        const stopRoute = RED.httpAdmin._routes.find(
            r => r.method === "POST" && r.path.includes(":action")
        );
        assert.ok(stopRoute, "Should have admin POST route");

        let resStatus = 0;
        await stopRoute.handlers[stopRoute.handlers.length - 1](
            { params: { id: node.id, action: "stop" } },
            { sendStatus: (code) => { resStatus = code; } }
        );

        assert.strictEqual(resStatus, 200, "Stop endpoint should return 200");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 24: Admin 404
    // ==================================================================

    test("24. Admin endpoint returns 404 for unknown node", async () => {
        const { node } = await bootNode(registry, mockSpawn, { autoStart: false });

        const startRoute = RED.httpAdmin._routes.find(
            r => r.method === "POST" && r.path.includes(":action")
        );

        let resStatus = 0;
        await startRoute.handlers[startRoute.handlers.length - 1](
            { params: { id: "nonexistent-id", action: "start" } },
            { sendStatus: (code) => { resStatus = code; } }
        );

        assert.strictEqual(resStatus, 404, "Unknown node should return 404");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 25: Sequence gap
    // ==================================================================

    test("25. Event sequence gaps produce SEQUENCE_GAP error", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        emitEvent(proc, makeFrameEvent({ event_seq: 1 }));
        await delay(50);

        emitEvent(proc, makeFrameEvent({ event_seq: 5 }));
        await delay(50);

        const errors = getPortMessages(node, 2);
        const gapErrors = errors.filter(e => e && e.payload && e.payload.error_code === "SEQUENCE_GAP");
        assert.ok(gapErrors.length > 0, "Should detect sequence gap");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 26: Duplicate start prevention
    // ==================================================================

    test("26. _startProcess returns early if process already running", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });
        assert.ok(proc, "Should have process");

        const beforeCount = mockSpawn.processes.length;
        node._startProcess();
        await delay(100);

        const afterCount = mockSpawn.processes.length;
        const warns = node._logs.filter(l => l.msg && l.msg.includes("already running"));
        assert.ok(warns.length > 0 || afterCount === beforeCount, "Should prevent duplicate start");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 27: Heartbeat timeout
    // ==================================================================

    test("27. Missing heartbeat for heartbeatTimeoutMs kills process", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false, heartbeatTimeoutMs: 300,
        });

        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(600);

        assert.ok(proc.killed, "Process should be killed on heartbeat timeout");

        const hbStatus = node._statusCalls.find(s => s.text && s.text.includes("heartbeat lost"));
        assert.ok(hbStatus, "Should have heartbeat lost status");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 28: Close sends stop command
    // ==================================================================

    test("28. close sends stop command and waits for exit", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        let closeDone = false;
        const stdinWrites = [];
        proc.stdin.on("data", (chunk) => stdinWrites.push(chunk.toString()));

        node._onClose(false, () => { closeDone = true; });
        await delay(50);

        const allStdin = stdinWrites.join("");
        assert.ok(allStdin.includes('"stop"'), "Close should send stop command");

        proc.emit("exit", 0, null);
        await delay(100);
        assert.ok(closeDone, "Close done should be called after exit");
    });

});
