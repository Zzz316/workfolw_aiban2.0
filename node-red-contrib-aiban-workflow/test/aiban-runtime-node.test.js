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
const {
    DesiredState,
    RuntimeState,
} = require("../lib/runtime-controller");

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
    const {
        event_seq = 0,
        session_id = "test-session-001",
        ...payloadOverrides
    } = overrides;
    return {
        schema_version: 1, type: "runtime_ready",
        session_id, event_id: "evt-ready",
        event_seq,
        emitted_at: new Date().toISOString(),
        payload: {
            groups: [1],
            sources_per_group: {"1": [1]},
            models_loaded: ["1"],
            ...payloadOverrides,
        },
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

function makeAdminResponse() {
    return {
        statusCode: 0,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        send(payload) {
            this.body = payload;
            return this;
        },
        sendStatus(code) {
            this.statusCode = code;
            return this;
        },
    };
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
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.STARTING);
        assert.equal(node.getRuntimeStatus().pid, proc.pid);

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
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.READY);
        assert.equal(node.getRuntimeStatus().session_id, "test-session-001");

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 4: PARSE_ERROR on invalid stdout JSON
    // ==================================================================

    test("4. Invalid JSON on stdout produces PARSE_ERROR on port 3", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        proc.stdout.push("{this is not valid json at all\n");
        await delay(100);

        const warns = node._logs.filter(l => l.level === "warn");
        assert.ok(warns.length > 0, "Should have at least one warning");
        assert.ok(warns[0].msg.includes("stdout parse error"));

        const errors = getPortMessages(node, 2);
        const parseErrors = errors.filter(e => e && e.payload && e.payload.error_code === "PARSE_ERROR");
        assert.ok(parseErrors.length > 0, "Should have PARSE_ERROR on port 3");

        node._onClose(false, () => {});
    });

    test("4b. Known AiBan native DLL log does not produce PARSE_ERROR", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false,
            strictStdout: true,
        });

        proc.stdout.push(
            "[2026-07-06 11:04:33.714][warning][video] set default loglevel: info\n"
        );
        await delay(100);

        const parseErrors = getPortMessages(node, 2).filter(
            e => e && e.payload && e.payload.error_code === "PARSE_ERROR"
        );
        assert.strictEqual(parseErrors.length, 0);
        assert.ok(
            node._logs.some(l => l.msg && l.msg.includes("[python:native]")),
            "Native DLL line should remain visible in the node log"
        );

        node._onClose(false, () => {});
    });

    test("4c. Plain AiBan native diagnostics do not produce PARSE_ERROR", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false,
            strictStdout: true,
        });

        proc.stdout.push(
            "Total [2026-07-06 11:26:25] frames: 1\n"
            + "Max lost time: 0\n"
            + "MCMOT tracker inited done\n"
        );
        await delay(100);

        const parseErrors = getPortMessages(node, 2).filter(
            e => e && e.payload && e.payload.error_code === "PARSE_ERROR"
        );
        assert.strictEqual(parseErrors.length, 0);
        const nativeLogs = node._logs.filter(
            l => l.msg && l.msg.includes("[python:native]")
        );
        assert.strictEqual(nativeLogs.length, 3);

        node._onClose(false, () => {});
    });

    // ==================================================================
    // Test 5: Long invalid line truncated
    // ==================================================================

    test("5. Long invalid JSON line is truncated in error message", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });

        proc.stdout.push("{" + "x".repeat(4999) + "\n");
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

        proc.stdout.push("{" + "y".repeat(100 * 1024) + "\n");
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

        proc.stdout.push("{diagnostic text from AiBan DLL\n");
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

    test("14b. never restart policy leaves an unexpected exit in ERROR", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false,
            restartPolicy: "never",
            restartBackoffMs: 20,
        });
        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        proc.exitCode = 7;
        proc.emit("exit", 7, null);
        await delay(300);

        assert.equal(mockSpawn.processes.length, 1);
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.ERROR);
        assert.equal(node.getRuntimeStatus().last_error.code, "PROCESS_EXITED");
        node._onClose(false, () => {});
    });

    test("14c. on-failure policy does not restart a clean exit", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false,
            restartPolicy: "on-failure",
            restartBackoffMs: 20,
        });
        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        proc.exitCode = 0;
        proc.emit("exit", 0, null);
        await delay(300);

        assert.equal(mockSpawn.processes.length, 1);
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.ERROR);
        node._onClose(false, () => {});
    });

    test("14d. always restart policy restarts after a clean exit", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false,
            restartPolicy: "always",
            restartBackoffMs: 20,
        });
        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        proc.exitCode = 0;
        proc.emit("exit", 0, null);
        await delay(350);

        assert.equal(mockSpawn.processes.length, 2);
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.STARTING);
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

        // First crash after READY schedules recovery attempt #1.
        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);
        proc.exitCode = 1;
        proc.emit("exit", 1, null);
        await delay(100);

        // Recovery processes fail before READY, so the consecutive counter is
        // not reset.  The third crash must exhaust maxRestartCount=2.
        const proc2 = mockSpawn.processes[1];
        assert.ok(proc2, "First recovery process should spawn");
        proc2.exitCode = 1;
        proc2.emit("exit", 1, null);
        await delay(100);

        const proc3 = mockSpawn.processes[2];
        assert.ok(proc3, "Second recovery process should spawn");
        proc3.exitCode = 1;
        proc3.emit("exit", 1, null);
        await delay(150);

        assert.equal(mockSpawn.processes.length, 3, "No process may spawn beyond the limit");
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.ERROR);
        assert.equal(node.getRuntimeStatus().restart_count, 2);
        assert.equal(node.getRuntimeStatus().last_error.code, "MAX_RESTARTS_REACHED");
        assert.ok(
            node._statusCalls.some(status => status.text && status.text.includes("max restarts"))
        );

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
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.ERROR);
        assert.equal(node.getRuntimeStatus().last_error.code, "STARTUP_TIMEOUT");

        node._onClose(false, () => {});
    });

    test("16b. Runner start failure becomes SDK_START_FAILED", async () => {
        const config = makeConfig({ autoStart: true, _spawn: mockSpawn });
        const node = new (registry.get("aiban-runtime").constructor)(config);
        await delay(300);
        const proc = mockSpawn.processes[0];
        const stdinWrites = [];
        proc.stdin.on("data", chunk => stdinWrites.push(chunk.toString()));
        await delay(400);

        const requestMatch = stdinWrites.join("").match(/"request_id":"([^"]+)"/);
        assert.ok(requestMatch, "Auto-start command should be pending");
        emitEvent(proc, {
            schema_version: 1,
            type: "command_result",
            session_id: "test-session-001",
            event_id: "evt-start-failed",
            event_seq: 0,
            emitted_at: new Date().toISOString(),
            payload: {
                request_id: requestMatch[1],
                ok: false,
                command: "start",
                result: null,
                error: "SDK import or pipeline configuration failed",
            },
        });
        await delay(100);

        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.ERROR);
        assert.equal(node.getRuntimeStatus().last_error.code, "SDK_START_FAILED");
        node._stopProcess(true, { operationId: "cleanup-sdk-start-failure" });
        await delay(50);
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
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.ERROR);
        assert.equal(node.getRuntimeStatus().last_error.code, "SPAWN_FAILED");
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

        const response = makeAdminResponse();
        await startRoute.handlers[startRoute.handlers.length - 1](
            { params: { id: node.id, action: "start" } },
            response
        );

        assert.strictEqual(response.statusCode, 202, "Start endpoint should return 202 accepted");
        assert.ok(response.body.operation_id);
        assert.equal(response.body.accepted, true);
        assert.equal(response.body.actual_state, RuntimeState.STARTING);
        await delay(400);

        const afterCount = mockSpawn.processes.length;
        assert.ok(afterCount > beforeCount, `Should spawn process after admin start (${beforeCount} → ${afterCount})`);
        assert.equal(node.autoStart, false, "Manual start must not mutate autoStart policy");
        assert.equal(node.getRuntimeStatus().desired_state, DesiredState.READY);
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.STARTING);

        node._onClose(false, () => {});
    });

    test("22b. Repeated HTTP start is idempotent and does not double-spawn", async () => {
        const config = makeConfig({ autoStart: false, _spawn: mockSpawn });
        const node = new (registry.get("aiban-runtime").constructor)(config);
        await delay(200);
        assert.equal(mockSpawn.processes.length, 0);

        const entry = registry.get("aiban-runtime");
        if (!entry._instances) entry._instances = new Map();
        entry._instances.set(node.id, node);
        const startRoute = RED.httpAdmin._routes.find(
            r => r.method === "POST" && r.path.includes(":action")
        );

        const first = makeAdminResponse();
        await startRoute.handlers[startRoute.handlers.length - 1](
            { params: { id: node.id, action: "start" } },
            first
        );
        const second = makeAdminResponse();
        await startRoute.handlers[startRoute.handlers.length - 1](
            { params: { id: node.id, action: "start" } },
            second
        );

        assert.equal(first.statusCode, 202);
        assert.equal(first.body.idempotent, false);
        assert.equal(second.statusCode, 202);
        assert.equal(second.body.idempotent, true);
        assert.equal(mockSpawn.processes.length, 1, "Repeated start must not spawn twice");

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

        const response = makeAdminResponse();
        await stopRoute.handlers[stopRoute.handlers.length - 1](
            { params: { id: node.id, action: "stop" } },
            response
        );

        assert.strictEqual(response.statusCode, 202, "Stop endpoint should return 202 accepted");
        assert.ok(response.body.operation_id);
        assert.equal(response.body.actual_state, RuntimeState.STOPPING);
        assert.equal(node.getRuntimeStatus().desired_state, DesiredState.STOPPED);
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.STOPPING);

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

        const response = makeAdminResponse();
        await startRoute.handlers[startRoute.handlers.length - 1](
            { params: { id: "nonexistent-id", action: "start" } },
            response
        );

        assert.strictEqual(response.statusCode, 404, "Unknown node should return 404");
        assert.equal(response.body.error_code, "RUNTIME_NOT_FOUND");

        node._onClose(false, () => {});
    });

    test("24b. Admin GET status returns the confirmed runtime state", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });
        const entry = registry.get("aiban-runtime");
        if (!entry._instances) entry._instances = new Map();
        entry._instances.set(node.id, node);

        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        const statusRoute = RED.httpAdmin._routes.find(
            r => r.method === "GET" && r.path === "/aiban-runtime/:id/status"
        );
        assert.ok(statusRoute, "Should have admin GET status route");

        const response = makeAdminResponse();
        await statusRoute.handlers[statusRoute.handlers.length - 1](
            { params: { id: node.id } },
            response
        );

        assert.equal(response.statusCode, 200);
        assert.ok(response.body.operation_id);
        assert.equal(response.body.action, "status");
        assert.equal(response.body.actual_state, RuntimeState.READY);
        assert.equal(response.body.session_id, "test-session-001");

        node._onClose(false, () => {});
    });

    test("24c. Admin POST rejects an invalid runtime action", async () => {
        const { node } = await bootNode(registry, mockSpawn, { autoStart: false });
        const entry = registry.get("aiban-runtime");
        if (!entry._instances) entry._instances = new Map();
        entry._instances.set(node.id, node);

        const controlRoute = RED.httpAdmin._routes.find(
            r => r.method === "POST" && r.path.includes(":action")
        );
        const response = makeAdminResponse();
        await controlRoute.handlers[controlRoute.handlers.length - 1](
            { params: { id: node.id, action: "invalid" } },
            response
        );

        assert.equal(response.statusCode, 400);
        assert.equal(response.body.error_code, "INVALID_RUNTIME_ACTION");
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
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.ERROR);
        assert.equal(node.getRuntimeStatus().last_error.code, "HEARTBEAT_TIMEOUT");
        const forceKillLog = node._logs.find(entry =>
            entry.msg && entry.msg.includes("reason=heartbeat_timeout")
        );
        assert.ok(forceKillLog, "Forced timeout cleanup should be audited");
        assert.ok(forceKillLog.msg.includes(`pid=${proc.pid}`));
        assert.match(forceKillLog.msg, /operation_id=heartbeat-\d+/);

        node._onClose(false, () => {});
    });

    test("27b. Stop timeout records ERROR, audit data and final STOPPED", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false,
            shutdownTimeoutMs: 100,
        });
        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);
        proc.kill = function holdExit(signal) {
            this.killed = true;
            this.signalCode = signal || "SIGTERM";
            this.exitCode = -1;
            return true;
        };

        node.controlRuntime("stop", {
            operationId: "op-stop-timeout",
            source: "test",
        });
        await delay(175);

        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.ERROR);
        assert.equal(node.getRuntimeStatus().desired_state, DesiredState.STOPPED);
        assert.equal(node.getRuntimeStatus().last_error.code, "STOP_TIMEOUT");
        const forceKillLog = node._logs.find(entry =>
            entry.msg && entry.msg.includes("operation_id=op-stop-timeout")
        );
        assert.ok(forceKillLog);
        assert.ok(forceKillLog.msg.includes(`pid=${proc.pid}`));
        assert.ok(forceKillLog.msg.includes("reason=shutdown_timeout:stop"));

        proc.emit("exit", -1, "SIGKILL");
        await delay(50);
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.STOPPED);
        assert.equal(node.getRuntimeStatus().pid, null);
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

    test("28b. Node deletion timeout force-kills with an audited reason", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, {
            autoStart: false,
            shutdownTimeoutMs: 100,
        });
        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);
        proc.kill = function holdExit(signal) {
            this.killed = true;
            this.signalCode = signal || "SIGTERM";
            this.exitCode = -1;
            return true;
        };

        let closeDone = false;
        node._onClose(true, () => { closeDone = true; });
        await delay(175);

        assert.equal(proc.killed, true);
        assert.equal(closeDone, false, "Delete must wait for the real exit event");
        const forceKillLog = node._logs.find(entry =>
            entry.msg && entry.msg.includes("reason=node_deleted_timeout")
        );
        assert.ok(forceKillLog);
        assert.ok(forceKillLog.msg.includes(`pid=${proc.pid}`));

        proc.emit("exit", -1, "SIGKILL");
        await delay(50);
        assert.equal(closeDone, true);
    });

    test("29. Message start recreates the process after it was stopped", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });
        node._stopProcess(true);
        await delay(100);
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.STOPPED);

        let output = null;
        node._onInput(
            { topic: "aiban/control", payload: { command: "start" } },
            (messages) => { output = messages; },
            () => {}
        );
        await delay(100);

        assert.ok(mockSpawn.processes.length >= 2, "Message start should spawn a new process");
        assert.ok(output && output[1], "Message start should emit an operation result");
        assert.equal(output[1].payload.action, "start");
        assert.equal(output[1].payload.actual_state, RuntimeState.STARTING);
        assert.ok(output[1].payload.operation_id);

        node._onClose(false, () => {});
    });

    test("29b. Queued start never overlaps a force-killed process awaiting exit", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });
        proc.kill = function holdExit(signal) {
            this.killed = true;
            this.signalCode = signal || "SIGTERM";
            this.exitCode = -1;
            return true;
        };

        node._stopProcess(true, {
            operationId: "op-held-exit",
            reason: "test_force_stop",
        });
        const result = node.controlRuntime("start", {
            operationId: "op-queued-start",
            source: "test",
        });

        assert.equal(result.queued, true);
        assert.equal(node.getRuntimeStatus().desired_state, DesiredState.READY);
        assert.equal(mockSpawn.processes.length, 1, "No replacement may spawn before exit");

        proc.emit("exit", -1, "SIGKILL");
        await delay(350);
        assert.equal(mockSpawn.processes.length, 2, "Replacement should spawn after exit");
        const activeProcesses = mockSpawn.processes.filter(candidate =>
            candidate !== proc && candidate.exitCode === null && !candidate.killed
        );
        assert.equal(activeProcesses.length, 1);

        node._onClose(false, () => {});
    });

    test("30. Message restart uses process stop and queued respawn", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });
        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        const stdinWrites = [];
        proc.stdin.on("data", (chunk) => stdinWrites.push(chunk.toString()));
        let output = null;
        node._onInput(
            { topic: "aiban/control", payload: { command: "restart" } },
            (messages) => { output = messages; },
            () => {}
        );
        await delay(50);

        assert.ok(stdinWrites.join("").includes('"command":"stop"'));
        assert.ok(!stdinWrites.join("").includes('"command":"restart"'));
        assert.equal(output[1].payload.action, "restart");
        assert.equal(output[1].payload.actual_state, RuntimeState.STOPPING);
        assert.equal(output[1].payload.desired_state, DesiredState.READY);

        emitEvent(proc, {
            schema_version: 1,
            type: "runtime_stopped",
            session_id: "test-session-001",
            event_id: "evt-stopped",
            event_seq: 1,
            emitted_at: new Date().toISOString(),
            payload: { reason: "command", exit_code: 0, frames_emitted: 1 },
        });
        await delay(25);
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
        await delay(350);
        assert.ok(mockSpawn.processes.length >= 2, "Restart should spawn a replacement process");
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.STARTING);

        const replacement = mockSpawn.processes.at(-1);
        assert.notEqual(replacement.pid, proc.pid, "Replacement must use a new PID");
        const activeProcesses = mockSpawn.processes.filter(candidate =>
            candidate.exitCode === null && !candidate.killed
        );
        assert.deepEqual(activeProcesses, [replacement], "Only one replacement process may remain");

        emitEvent(replacement, makeReadyEvent({
            event_seq: 0,
            session_id: "test-session-002",
        }));
        await delay(50);
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.READY);
        assert.equal(node.getRuntimeStatus().pid, replacement.pid);
        assert.equal(node.getRuntimeStatus().session_id, "test-session-002");
        assert.equal(replacement.exitCode, null, "Replacement should remain alive");
        assert.equal(replacement.killed, false, "Replacement should not be killed");

        node._onClose(false, () => {});
    });

    test("31. Message stop uses the same graceful process control path", async () => {
        const { node, proc } = await bootNode(registry, mockSpawn, { autoStart: false });
        emitEvent(proc, makeReadyEvent({ event_seq: 0 }));
        await delay(50);

        const stdinWrites = [];
        proc.stdin.on("data", (chunk) => stdinWrites.push(chunk.toString()));
        let output = null;
        node._onInput(
            { topic: "aiban/control", payload: { command: "stop" } },
            (messages) => { output = messages; },
            () => {}
        );
        await delay(50);

        assert.ok(stdinWrites.join("").includes('"command":"stop"'));
        assert.equal(output[1].payload.action, "stop");
        assert.equal(output[1].payload.actual_state, RuntimeState.STOPPING);
        assert.equal(output[1].payload.desired_state, DesiredState.STOPPED);
        assert.ok(output[1].payload.operation_id);

        node._onClose(false, () => {});
    });

});
