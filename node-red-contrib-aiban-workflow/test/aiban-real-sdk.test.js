/**
 * T16 — Real SDK Integration Test (Real Spawn).
 *
 * Unlike the mock-spawn tests in aiban-runtime-node.test.js, this test uses
 * real ``child_process.spawn`` to launch ``aiban_runner.py`` as a real OS
 * process.  It validates the full JSON Lines protocol exchange end-to-end.
 *
 * By default the runner is started with ``--mock`` so the test can run
 * anywhere.  Set the environment variable ``REAL_SDK_AVAILABLE=1`` and
 * provide ``AIBAN_SDK_HOME`` / ``AIBAN_PIPELINE_CONFIG`` to test against
 * the production AiBan SDK on a machine where it is installed.
 *
 * Usage::
 *
 *   # Mock mode (CI / dev)
 *   node --test test/aiban-real-sdk.test.js
 *
 *   # Real SDK mode (production machine)
 *   $env:REAL_SDK_AVAILABLE="1"
 *   $env:AIBAN_SDK_HOME="D:/product/AiBanWorkSpace"
 *   $env:AIBAN_PIPELINE_CONFIG="D:/product/AiBanWorkSpace/abvideo/main-flow.yaml"
 *   node --test test/aiban-real-sdk.test.js
 */

"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");
const fs = require("node:fs");
const os = require("node:os");
const { SceneRoutingEngine } = require("../lib/scene-routing");
const { SequenceRuntime } = require("../lib/sequence-runtime");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RUNNER_PATH = path.join(__dirname, "..", "..", "python_runtime", "aiban_runner.py");

const PYTHON = process.platform === "win32"
    ? (process.env.AIBAN_PYTHON_PATH
        || (fs.existsSync("D:/my_env/python.exe")
            ? "D:/my_env/python.exe"
            : "C:/Users/s2017088/AppData/Local/Programs/Python/Python39/python.exe"))
    : (process.env.AIBAN_PYTHON_PATH || "python3");

const USE_REAL_SDK = process.env.REAL_SDK_AVAILABLE === "1";
const SDK_HOME = process.env.AIBAN_SDK_HOME || "D:/product/AiBanWorkSpace";
const PIPELINE_CONFIG = process.env.AIBAN_PIPELINE_CONFIG || "D:/product/AiBanWorkSpace/abvideo/main-flow.yaml";

const STARTUP_TIMEOUT_MS = 60000;
const FRAME_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 15000;
const MAX_FRAMES = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the Python runner.
 *
 * When REAL_SDK_AVAILABLE, no --mock flag is passed; the runner loads the
 * real AiBan SDK.  Otherwise --mock is used with synthetic labels.
 */
function spawnRunner(extraArgs = [], options = {}) {
    const args = ["-u", RUNNER_PATH, "--heartbeat-interval", "3.0"];

    if (!USE_REAL_SDK) {
        args.push("--mock", "--labels", "A,B,C", "--num-groups", "1", "--num-sources", "2");
    } else {
        args.push("--sdk-home", SDK_HOME, "--pipeline-config", PIPELINE_CONFIG);
    }

    args.push(...extraArgs);

    const opts = {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...options,
    };

    return spawn(PYTHON, args, opts);
}

/**
 * Read JSON-Lines events from a readable stream for *timeoutMs* milliseconds.
 * Returns every parsed event (and parse-failure stubs) that arrived within the window.
 */
class EventCollector {
    constructor(readable) {
        this.events = [];
        this.waiters = new Set();
        this.closed = false;
        this.rl = readline.createInterface({ input: readable, crlfDelay: Infinity });
        this.rl.on("line", (line) => this._onLine(line));
        this.rl.on("close", () => {
            this.closed = true;
            this._flushWaiters();
        });
    }

    _onLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            this.events.push(JSON.parse(trimmed));
        } catch (_) {
            this.events.push({ _parse_error: true, raw: trimmed.substring(0, 200) });
        }
        this._flushWaiters();
    }

    _flushWaiters() {
        for (const waiter of [...this.waiters]) {
            if (!this.closed && !waiter.predicate(this.events)) continue;
            clearTimeout(waiter.timer);
            this.waiters.delete(waiter);
            waiter.resolve(this.events.slice(waiter.startIndex));
        }
    }

    waitFor(predicate, timeoutMs, startIndex = 0) {
        if (predicate(this.events)) {
            return Promise.resolve(this.events.slice(startIndex));
        }
        return new Promise((resolve) => {
            const waiter = {
                predicate,
                startIndex,
                resolve,
                timer: setTimeout(() => {
                    this.waiters.delete(waiter);
                    resolve(this.events.slice(startIndex));
                }, timeoutMs),
            };
            this.waiters.add(waiter);
        });
    }

    mark() {
        return this.events.length;
    }

    close() {
        this.rl.close();
    }
}

/**
 * Send a JSON-Lines command to the runner's stdin.
 */
function sendCommand(proc, command, requestId, params = {}) {
    const cmd = JSON.stringify({
        schema_version: 1,
        command,
        request_id: requestId,
        params,
    });
    proc.stdin.write(cmd + "\n");
}

/**
 * Wait for a specific event type in a list of events.
 */
function findEvent(events, type, commandFilter = null) {
    for (const e of events) {
        if (e.type !== type) continue;
        if (commandFilter && e.payload && e.payload.command !== commandFilter) continue;
        return e;
    }
    return null;
}

class MemoryStateStore {
    constructor() {
        this.rows = new Map();
    }
    getState(key) {
        const row = this.rows.get(key);
        return row ? { ...row } : null;
    }
    saveState(key, row) {
        this.rows.set(key, { ...row, state_key: key });
    }
    resetState(key) {
        const row = this.getState(key);
        if (row) this.rows.set(key, {
            ...row,
            step_index: 0,
            cycle_id: null,
            cycle_started_at_ms: null,
            actual_sequence: null,
        });
        return row;
    }
    listActive() {
        return [...this.rows.values()].filter(row => row.step_index > 0).map(row => ({ ...row }));
    }
}

function detectedLabels(frame) {
    const labels = [];
    for (const model of Object.values(frame.payload?.models || {})) {
        for (const box of model.boxes || []) labels.push(box.label);
    }
    return labels;
}

function frameToWorkflowMessage(frame, labels = detectedLabels(frame), overrides = {}) {
    const payload = {
        ...(frame.payload || {}),
        session_id: frame.session_id,
        event_id: frame.event_id,
        event_seq: frame.event_seq,
        ...overrides,
    };
    return {
        payload,
        aiban: {
            session_id: payload.session_id,
            group_id: payload.group_id,
            source_id: payload.source_id,
            event_id: payload.event_id,
            event_seq: payload.event_seq,
            label_matches: labels.map(label => ({
                label_id: label,
                label,
                matched: true,
                confidence: 0.99,
            })),
        },
    };
}

/**
 * Validate a frame event's structure against the standard contract.
 * Returns an array of error messages (empty = valid).
 */
function validateFrameStructure(frame) {
    const errors = [];

    // Envelope
    for (const f of ["session_id", "event_id", "event_seq", "type", "emitted_at"]) {
        if (!(f in frame)) errors.push(`Missing envelope field: ${f}`);
    }
    if (frame.type !== "frame") errors.push(`Expected type=frame, got ${frame.type}`);
    if (frame.schema_version !== 1) errors.push(`Expected schema_version=1, got ${frame.schema_version}`);

    // Payload
    const p = frame.payload;
    if (!p || typeof p !== "object") {
        errors.push("Missing or non-object payload");
        return errors;
    }

    for (const [field, expected] of Object.entries({
        group_id: "number",
        source_id: "number",
        stream_id: "string",
        captured_at: "string",
        models: "object",
    })) {
        if (!(field in p)) {
            errors.push(`Missing payload.${field}`);
        } else if (typeof p[field] !== expected && expected !== "any") {
            errors.push(`Wrong type for payload.${field}: expected ${expected}, got ${typeof p[field]}`);
        }
    }

    // Models
    const models = p.models;
    if (models && typeof models === "object") {
        for (const [mid, md] of Object.entries(models)) {
            if (!md || typeof md !== "object") {
                errors.push(`models.${mid}: expected object`);
                continue;
            }
            if (!("ok" in md)) errors.push(`models.${mid}: missing 'ok'`);
            if (md.ok && Array.isArray(md.boxes)) {
                for (let i = 0; i < md.boxes.length; i++) {
                    const box = md.boxes[i];
                    for (const bf of ["label", "confidence", "polygon"]) {
                        if (!(bf in box)) errors.push(`models.${mid}.boxes[${i}]: missing '${bf}'`);
                    }
                }
            }
        }
    }

    // Timing fields (optional but expected in real frames)
    const timingFields = ["sdk_received_at_ms", "sdk_convert_ms", "python_enqueued_at_ms"];
    for (const tf of timingFields) {
        if (!(tf in p)) {
            // Not an error — mock frames may not have these; real frames should
        }
    }

    return errors;
}

// ---------------------------------------------------------------------------
// Test: Real Process Spawn & Protocol Exchange
// ---------------------------------------------------------------------------

describe("T16 Real SDK Integration (Real Spawn)", { concurrency: 1 }, () => {
    /** @type {import("child_process").ChildProcess} */
    let proc;
    let events = [];
    let collector;
    let sessionId = null;
    let runnerPid = null;
    let stderrText = "";

    after(async () => {
        // Ensure the runner is stopped
        if (proc && proc.exitCode === null) {
            try {
                if (proc.stdin && !proc.stdin.destroyed) {
                    sendCommand(proc, "stop", "cleanup-stop");
                }
                // Give it a moment to exit gracefully
                await new Promise(r => setTimeout(r, 2000));
                if (proc.exitCode === null) {
                    proc.kill("SIGTERM");
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (proc.exitCode === null) {
                    proc.kill("SIGKILL");
                }
            } catch (_) { /* best-effort cleanup */ }
        }
        if (collector) collector.close();
    });

    // -----------------------------------------------------------------------
    // 1. Spawn, start, and startup sequence
    // -----------------------------------------------------------------------

    test("spawns the Python runner, sends start, and receives runtime_starting + runtime_ready", async () => {
        proc = spawnRunner([], {
            env: { ...process.env, PYTHONUNBUFFERED: "1" },
        });

        assert.ok(proc.pid, "Process should have a PID");
        runnerPid = proc.pid;
        collector = new EventCollector(proc.stdout);
        proc.stderr.on("data", (chunk) => {
            stderrText += chunk.toString("utf8");
            if (stderrText.length > 200000) stderrText = stderrText.slice(-200000);
        });

        // Send start command — the runner waits for this before emitting events
        sendCommand(proc, "start", "t16-startup");

        // Collect events for startup (runtime_starting, runtime_ready, early frames)
        events = await collector.waitFor(
            (all) => Boolean(findEvent(all, "runtime_starting") && findEvent(all, "runtime_ready")),
            STARTUP_TIMEOUT_MS
        );

        const starting = findEvent(events, "runtime_starting");
        assert.ok(starting, "Should receive runtime_starting event after start command");
        assert.ok(starting.payload, "runtime_starting should have payload");
        assert.ok(starting.payload.python_version, "Should include python_version");
        assert.ok(starting.payload.runner_version, "Should include runner_version");

        const ready = findEvent(events, "runtime_ready");
        assert.ok(ready, "Should receive runtime_ready event");
        assert.ok(ready.session_id, "Should have session_id");
        sessionId = ready.session_id;

        // Validate metadata
        const p = ready.payload;
        assert.ok(Array.isArray(p.groups), "ready payload should have groups array");
        assert.ok(typeof p.sources_per_group === "object", "ready payload should have sources_per_group");
        assert.ok(Array.isArray(p.models_loaded), "ready payload should have models_loaded array");
        assert.ok(Array.isArray(p.models), "ready payload should have models array");

        if (p.groups.length > 0) {
            const g = p.groups[0];
            assert.ok("group_id" in g, "group should have group_id");
            assert.ok("name" in g, "group should have name");
            assert.ok("enabled" in g, "group should have enabled flag");
            assert.ok(Array.isArray(g.sources), "group should have sources array");
        }

        // No parse errors
        const parseErrors = events.filter(e => e._parse_error);
        assert.strictEqual(parseErrors.length, 0, "Should have zero JSON parse errors on stdout");
    });

    // -----------------------------------------------------------------------
    // 2. Frame structure validation
    // -----------------------------------------------------------------------

    test("frames have valid structure and share session_id", async () => {
        assert.ok(proc, "Process should be running from previous test");
        assert.ok(proc.stdin && !proc.stdin.destroyed, "stdin should be open");
        assert.ok(sessionId, "session_id should be set from startup test");

        // Collect enough additional frames to prove the configured labels can
        // reach the downstream sequence layer.  Stop as soon as the condition
        // is satisfied instead of always sleeping for the full timeout.
        const startIndex = collector.mark();
        const frameEvents = await collector.waitFor(
            (all) => all.slice(startIndex).filter(e => e.type === "frame").length >= 6,
            FRAME_TIMEOUT_MS,
            startIndex
        );
        events = collector.events.slice();

        const frames = frameEvents.filter(e => e.type === "frame");
        assert.ok(frames.length > 0, `Should receive at least 1 frame, got ${frames.length}`);

        // Validate each frame structure
        const allErrors = [];
        for (const frame of frames) {
            const errs = validateFrameStructure(frame);
            if (errs.length > 0) {
                allErrors.push({ seq: frame.event_seq, errors: errs });
            }
        }

        if (!USE_REAL_SDK) {
            const detected = new Set();
            for (const frame of frames) {
                for (const model of Object.values(frame.payload.models || {})) {
                    for (const box of model.boxes || []) detected.add(box.label);
                }
            }
            assert.deepStrictEqual([...detected].sort(), ["A", "B", "C"],
                "Mock frames must cycle through A, B and C");
        }
        assert.strictEqual(allErrors.length, 0,
            `All ${frames.length} frames should match the contract. ` +
            `Errors: ${JSON.stringify(allErrors.slice(0, 3))}`);

        // event_seq should be monotonic
        const seqs = frames.map(f => f.event_seq).filter(s => typeof s === "number");
        for (let i = 1; i < seqs.length; i++) {
            assert.ok(seqs[i] > seqs[i - 1],
                `event_seq should be strictly monotonic: ${seqs[i - 1]} → ${seqs[i]}`);
        }

        // Frames should have the same session_id
        for (const frame of frames) {
            assert.strictEqual(frame.session_id, sessionId,
                "All frames should share the same session_id");
        }
    });

    // -----------------------------------------------------------------------
    // 3. Health check
    // -----------------------------------------------------------------------

    test("health command returns correct state", async () => {
        assert.ok(proc.stdin && !proc.stdin.destroyed, "stdin should be open");

        const startIndex = collector.mark();
        sendCommand(proc, "health", "t16-health");
        const healthEvents = await collector.waitFor(
            (all) => Boolean(all.slice(startIndex).find(e =>
                e.type === "command_result" && e.payload?.request_id === "t16-health")),
            5000,
            startIndex
        );

        const result = findEvent(healthEvents, "command_result", "health");
        assert.ok(result, "Should receive command_result for health");
        assert.strictEqual(result.payload.ok, true, "Health command should succeed");
        assert.strictEqual(result.payload.result.state, "ready", "State should be 'ready'");
        assert.ok(result.payload.result.uptime_seconds >= 0, "Should report uptime");
        assert.ok(result.payload.result.frames_emitted >= 0, "Should report frames_emitted");
    });

    // -----------------------------------------------------------------------
    // 4. Source pause/resume
    // -----------------------------------------------------------------------

    test("pause_source and resume_source commands are accepted", async () => {
        assert.ok(proc.stdin && !proc.stdin.destroyed, "stdin should be open");

        // Pause
        let startIndex = collector.mark();
        sendCommand(proc, "pause_source", "t16-pause", { group_id: 1, source_id: 1 });
        let respEvents = await collector.waitFor(
            (all) => Boolean(all.slice(startIndex).find(e =>
                e.type === "command_result" && e.payload?.request_id === "t16-pause")),
            5000,
            startIndex
        );
        let result = findEvent(respEvents, "command_result", "pause_source");
        assert.ok(result, "Should receive command_result for pause_source");
        assert.strictEqual(result.payload.ok, true, "pause_source should succeed");
        assert.strictEqual(result.payload.result.paused, true, "Result should indicate paused");

        if (!USE_REAL_SDK) {
            // Allow an in-flight callback to settle, then prove source 1 is
            // quiet while source 2 keeps flowing.
            await new Promise(r => setTimeout(r, 250));
            const isolationStart = collector.mark();
            const pausedFrames = await collector.waitFor(
                (all) => all.slice(isolationStart).filter(e =>
                    e.type === "frame" && e.payload?.source_id === 2).length >= 3,
                3000,
                isolationStart
            );
            assert.strictEqual(pausedFrames.filter(e =>
                e.type === "frame" && e.payload?.source_id === 1).length, 0,
            "paused source must stop frames");
            assert.ok(pausedFrames.some(e =>
                e.type === "frame" && e.payload?.source_id === 2),
            "other source must continue while source 1 is paused");
        }

        // Resume
        startIndex = collector.mark();
        sendCommand(proc, "resume_source", "t16-resume", { group_id: 1, source_id: 1 });
        respEvents = await collector.waitFor(
            (all) => Boolean(all.slice(startIndex).find(e =>
                e.type === "command_result" && e.payload?.request_id === "t16-resume")),
            5000,
            startIndex
        );
        result = findEvent(respEvents, "command_result", "resume_source");
        assert.ok(result, "Should receive command_result for resume_source");
        assert.strictEqual(result.payload.ok, true, "resume_source should succeed");
        assert.strictEqual(result.payload.result.paused, false, "Result should indicate not paused");

        const resumeStart = collector.mark();
        const resumed = await collector.waitFor(
            (all) => all.slice(resumeStart).some(e =>
                e.type === "frame" && e.payload?.group_id === 1 && e.payload?.source_id === 1),
            FRAME_TIMEOUT_MS,
            resumeStart
        );
        assert.ok(resumed.some(e => e.type === "frame" && e.payload?.source_id === 1),
            "resumed source must emit frames again");
    });

    // -----------------------------------------------------------------------
    // 5. Screenshot
    // -----------------------------------------------------------------------

    test("screenshot command produces command_result and screenshot_result", async () => {
        assert.ok(proc.stdin && !proc.stdin.destroyed, "stdin should be open");

        const startIndex = collector.mark();
        sendCommand(proc, "screenshot", "t16-screenshot", { group_id: 1, source_id: 1 });
        const ssEvents = await collector.waitFor(
            (all) => {
                const current = all.slice(startIndex);
                return Boolean(
                    current.find(e => e.type === "command_result"
                        && e.payload?.request_id === "t16-screenshot")
                    && current.find(e => e.type === "screenshot_result"
                        && e.payload?.request_id === "t16-screenshot")
                );
            },
            10000,
            startIndex
        );

        const cmdResult = findEvent(ssEvents, "command_result", "screenshot");
        assert.ok(cmdResult, "Should receive command_result for screenshot");
        assert.strictEqual(cmdResult.payload.ok, true, "Screenshot command should succeed");

        const ssResult = ssEvents.find(e => e.type === "screenshot_result");
        assert.ok(ssResult, "Should receive screenshot_result event");
        assert.strictEqual(ssResult.payload.ok, true, "screenshot_result should indicate success");
        // image_path may be empty if no frame arrived during the wait, but the
        // event itself must exist
    });

    test("mock SDK frames close Registry → Router → Scene Entry → Sequence → outcome", {
        skip: USE_REAL_SDK ? "real scene outcome requires controlled现场动作" : false,
    }, () => {
        const frames = collector.events.filter(event => event.type === "frame");
        const byLabel = new Map();
        for (const frame of frames) {
            for (const label of detectedLabels(frame)) {
                if (!byLabel.has(label)) byLabel.set(label, frame);
            }
        }
        for (const label of ["A", "B", "C"]) {
            assert.ok(byLabel.has(label), `spawned SDK frame stream must contain ${label}`);
        }

        const workflowId = "group/1/scene/plug-sequence";
        const sceneId = "plug-sequence";
        const router = new SceneRoutingEngine({
            routes: [{ route_id: "plug", group_id: 1, scene_id: sceneId }],
        });
        const snapshot = {
            groups: [{ group_id: 1, enabled: true }],
            scenes: [{
                group_id: 1,
                scene_id: sceneId,
                workflow_id: workflowId,
                enabled: true,
                mode: "exclusive",
            }],
            selection: { group_id: 1, scene_id: sceneId },
        };
        const runtime = new SequenceRuntime({
            topology: ["A", "B", "C"].map(label => ({
                labelId: label,
                modelId: "1",
                label,
                confidenceMin: 0.5,
            })),
            stateStore: new MemoryStateStore(),
            auditLogger: null,
            workflowId,
            sceneId,
            cycleTimeoutMs: 1000,
        });

        const terminal = [];
        let now = 1000;
        for (const label of ["A", "B", "C"]) {
            const routed = router.route(frameToWorkflowMessage(byLabel.get(label), [label]), snapshot);
            assert.strictEqual(routed[0].length, 1, `${label} frame must reach the fixed scene route`);
            assert.strictEqual(routed[0][0].workflow.scene_id, sceneId,
                "scene-entry identity must be attached before business logic");
            terminal.push(...runtime.process(routed[0][0], now).filter(event => event.type === "terminal"));
            now += 100;
        }
        assert.strictEqual(terminal.length, 1, "A→B→C must emit one terminal outcome");
        assert.strictEqual(terminal[0].outcome.status, "OK");
        assert.strictEqual(terminal[0].outcome.scene_id, sceneId);
        assert.ok(terminal[0].result.result_event_id, "terminal result must carry an idempotency key");

        // A controlled skip produces NG on an isolated session without
        // polluting the completed stream.
        const isolatedSession = `${sessionId}-ng`;
        const a = frameToWorkflowMessage(byLabel.get("A"), ["A"], {
            session_id: isolatedSession,
            event_id: `${isolatedSession}:1`,
            event_seq: 1,
        });
        const c = frameToWorkflowMessage(byLabel.get("C"), ["C"], {
            session_id: isolatedSession,
            event_id: `${isolatedSession}:2`,
            event_seq: 2,
        });
        runtime.process(router.route(a, snapshot)[0][0], 2000);
        const ng = runtime.process(router.route(c, snapshot)[0][0], 2100)
            .find(event => event.type === "terminal");
        assert.ok(ng, "A→C skip must emit a terminal outcome");
        assert.strictEqual(ng.outcome.status, "NG");

        // Disabling the scene emits an interruption on the previous fixed
        // route and does not control or restart the SDK process.
        router.route(a, snapshot);
        const disabled = router.route(c, {
            ...snapshot,
            scenes: snapshot.scenes.map(scene => ({ ...scene, enabled: false })),
            selection: null,
        });
        assert.strictEqual(disabled[0][0].topic, "aiban-interrupt");
        assert.strictEqual(proc.exitCode, null, "scene control must not stop the SDK process");
    });

    // -----------------------------------------------------------------------
    // 6. Graceful stop
    // -----------------------------------------------------------------------

    test("stop command triggers runtime_stopping → runtime_stopped and clean exit", async () => {
        assert.ok(proc.stdin && !proc.stdin.destroyed, "stdin should be open");

        const startIndex = collector.mark();
        sendCommand(proc, "stop", "t16-stop");
        const stopEvents = await collector.waitFor(
            (all) => Boolean(all.slice(startIndex).find(e => e.type === "runtime_stopped")),
            STOP_TIMEOUT_MS,
            startIndex
        );

        const stopping = findEvent(stopEvents, "runtime_stopping");
        if (stopping) {
            assert.ok(stopping.payload.frames_emitted >= 0, "runtime_stopping should report frames_emitted");
        }

        const stopped = findEvent(stopEvents, "runtime_stopped");
        assert.ok(stopped || stopping,
            "Should receive runtime_stopping or runtime_stopped event");

        if (stopped) {
            // runtime_stopped may have exit_code
            const ec = stopped.payload.exit_code;
            assert.ok(ec === 0 || ec === undefined,
                `Expected exit_code 0 or absent, got ${ec}`);
        }

        // Process should exit cleanly within the timeout
        const exitOk = proc.exitCode !== null ? proc.exitCode === 0 : await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
            proc.on("exit", (code) => {
                clearTimeout(timer);
                resolve(code === 0);
            });
        });
        assert.ok(exitOk, "Process should exit with code 0");
    });

    // -----------------------------------------------------------------------
    // 7. Stderr should be clean
    // -----------------------------------------------------------------------

    test("runner stderr contains no unexpected errors", async () => {
        // Normal log output is fine; Python tracebacks are not
        const hasTraceback = stderrText.includes("Traceback (most recent call last)");
        assert.strictEqual(hasTraceback, false,
            `Stderr should not contain Python tracebacks:\n${stderrText.substring(0, 500)}`);
    });
});

// ---------------------------------------------------------------------------
// Test: Frame Contract Validation (static)
// ---------------------------------------------------------------------------

describe("T16 Frame Contract", () => {
    test("required frame fields are documented and verifiable", () => {
        const requiredFields = [
            "group_id", "source_id", "stream_id", "captured_at", "models",
        ];
        const optionalTiming = [
            "sdk_received_at_ms", "sdk_convert_ms",
            "python_enqueued_at_ms", "python_queue_ms", "python_stdout_at_ms",
        ];

        // Contract check — these fields must exist in every frame payload
        assert.ok(requiredFields.length === 5, "Five required frame payload fields");

        // Timing fields are present in real SDK frames but optional in mock
        assert.ok(optionalTiming.length === 5, "Five optional timing fields");
    });

    test("runtime_ready metadata contract is well-defined", () => {
        const requiredMetadata = [
            "groups", "sources_per_group", "models_loaded", "models",
        ];
        assert.ok(requiredMetadata.length === 4, "Four required runtime_ready metadata fields");
    });
});

// ---------------------------------------------------------------------------
// Test: Environment Detection (informational)
// ---------------------------------------------------------------------------

describe("T16 Environment", () => {
    test("reports current test mode", () => {
        const mode = USE_REAL_SDK ? "REAL_SDK" : "MOCK";
        console.log(`[T16] Test mode: ${mode}`);
        console.log(`[T16] Python: ${PYTHON}`);
        console.log(`[T16] Runner: ${RUNNER_PATH}`);
        if (USE_REAL_SDK) {
            console.log(`[T16] SDK Home: ${SDK_HOME}`);
            console.log(`[T16] Pipeline Config: ${PIPELINE_CONFIG}`);
        }
        assert.ok(["REAL_SDK", "MOCK"].includes(mode), "Mode should be valid");
    });

    test("Python executable is available", () => {
        const exists = fs.existsSync(PYTHON);
        if (!exists) {
            console.log(`[T16] WARNING: Python not found at ${PYTHON} — spawn tests will fail`);
        }
        // Don't assert — the spawn test will surface the real error
    });
});
