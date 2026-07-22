/**
 * aiban-runtime — Node-RED node that manages a Python/AiBan child process.
 *
 * Architecture:
 *   Node-RED deploy → spawn Python runner → stdin/stdout JSON Lines
 *   stdout = structured events (frame, lifecycle, heartbeat, error)
 *   stderr = diagnostic logs
 *
 * Outputs:
 *   port 1: inference frames (topic: aiban/frame)
 *   port 2: status/lifecycle events (topic: aiban/status)
 *   port 3: errors & diagnostics (topic: aiban/error)
 *
 * Input (control):
 *   msg.topic = "aiban/control"
 *   msg.payload = { command: "start"|"stop"|... }
 */

"use strict";

const { spawn: systemSpawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");
const {
    DesiredState,
    RuntimeController,
    RuntimeState,
    RuntimeTransitionError,
} = require("./lib/runtime-controller");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESTART_COUNT = 3;
const DEFAULT_RESTART_BACKOFF_MS = 5000;
const MAX_RESTART_BACKOFF_MS = 60000;
const DEFAULT_SDK_HOME = "D:/product/AiBanWorkSpace";
const DEFAULT_PIPELINE_CONFIG = "D:/product/AiBanWorkSpace/abvideo/main-flow.yaml";

const VALID_COMMANDS = new Set([
    "start", "stop", "restart", "status", "health",
    "pause_source", "resume_source", "screenshot",
]);
const RUNTIME_CONTROL_COMMANDS = new Set(["start", "stop", "restart", "status"]);

function resolvePythonPath(configuredPath) {
    if (configuredPath && configuredPath.toLowerCase() !== "python") {
        return configuredPath;
    }

    const localAppData = process.env.LOCALAPPDATA || "";
    const candidates = [
        process.env.AIBAN_PYTHON_PATH,
        "D:/my_env/python.exe",
        localAppData && path.join(localAppData, "Programs", "Python", "Python39", "python.exe"),
        localAppData && path.join(localAppData, "Programs", "Python", "Python310", "python.exe"),
        localAppData && path.join(localAppData, "Programs", "Python", "Python38", "python.exe"),
        localAppData && path.join(localAppData, "Programs", "Python", "Python37", "python.exe"),
    ].filter(Boolean);

    return candidates.find((candidate) => fs.existsSync(candidate))
        || configuredPath
        || "python";
}

function sendAdminJson(res, statusCode, payload) {
    if (typeof res.status === "function") {
        const response = res.status(statusCode);
        if (response && typeof response.json === "function") {
            response.json(payload);
            return;
        }
    }
    if (typeof res.json === "function") {
        res.json(payload);
        return;
    }
    if (typeof res.send === "function") {
        res.send(payload);
        return;
    }
    res.sendStatus(statusCode);
}

// ---------------------------------------------------------------------------
// Node registration
// ---------------------------------------------------------------------------

module.exports = function registerAibanRuntimeNode(RED) {

    function AibanRuntimeNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;

        // --- Configuration ---
        this.name = config.name || "aiban-runtime";
        this.pythonPath = resolvePythonPath(config.pythonPath || "python");
        this.runnerPath = config.runnerPath || "";
        this.sdkHome = config.sdkHome || DEFAULT_SDK_HOME;
        this.pipelineConfig = config.pipelineConfig || DEFAULT_PIPELINE_CONFIG;
        this.workingDirectory = config.workingDirectory || "";
        this.useMock = config.useMock === true;
        this.startupTimeoutMs = parseInt(config.startupTimeoutMs) || DEFAULT_STARTUP_TIMEOUT_MS;
        this.shutdownTimeoutMs = parseInt(config.shutdownTimeoutMs) || DEFAULT_SHUTDOWN_TIMEOUT_MS;
        this.heartbeatIntervalMs = parseInt(config.heartbeatIntervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.heartbeatTimeoutMs = parseInt(config.heartbeatTimeoutMs) || DEFAULT_HEARTBEAT_TIMEOUT_MS;
        this.restartPolicy = config.restartPolicy || "never";  // never | on-failure | always
        this.maxRestartCount = parseInt(config.maxRestartCount) || DEFAULT_MAX_RESTART_COUNT;
        this.restartBackoffMs = parseInt(config.restartBackoffMs) || DEFAULT_RESTART_BACKOFF_MS;
        this.autoStart = config.autoStart !== undefined ? config.autoStart : true;
        this.strictStdout = config.strictStdout !== undefined ? config.strictStdout : true;

        // --- Spawn injection (for testing) ---
        this._spawnFn = config._spawn || systemSpawn;

        // --- Runtime state ---
        this._process = null;
        this._sessionId = null;
        this._lastEventSeq = -1;
        this._currentBackoff = 0;
        this._heartbeatTimer = null;
        this._startupTimer = null;
        this._pendingCommands = new Map();  // request_id → { resolve, reject, timer }
        this._shutdownInitiated = false;
        this._auditText = null;
        this._legacyVideoLog = null;
        this._runtimeController = new RuntimeController({ autoStart: this.autoStart });
        this._runtimeController.on("stateChanged", (transition) => {
            this._applyRuntimeStatus(transition.current, transition.event);
        });

        // --- Resolve runner path ---
        if (!this.runnerPath) {
            // Prefer the project layout beside Node-RED's userDir. This remains
            // correct when this package is loaded through node_modules junctions.
            const candidates = [
                path.resolve(RED.settings.userDir, "..", "python_runtime", "aiban_runner.py"),
                path.resolve(__dirname, "..", "python_runtime", "aiban_runner.py"),
            ];
            this.runnerPath = candidates.find((candidate) => fs.existsSync(candidate))
                || candidates[0];
        }

        this._openAuditLogs();
        this._openLegacyVideoLog();

        // --- Set initial status ---
        this._applyRuntimeStatus(this._runtimeController.getStatus(), "initialized");

        // --- Event handlers ---
        this.on("input", this._onInput.bind(this));
        this.on("close", this._onClose.bind(this));

        // Defer process creation until Node-RED has finished constructing this
        // specific node instance.  This must live inside the constructor so
        // `node` refers to the deployed node rather than the module scope.
        setTimeout(() => {
            if (!node._shutdownInitiated && node.autoStart) {
                node._startProcess();
            }
        }, 100);
    }

    // ==================================================================
    // Status display
    // ==================================================================

    AibanRuntimeNode.prototype._setStatus = function (color, text) {
        const shapeMap = {
            red: "ring",
            green: "dot",
            yellow: "ring",
            grey: "ring",
        };
        this.status({
            fill: color,
            shape: shapeMap[color] || "ring",
            text: `${this.name}: ${text}`,
        });
    };

    AibanRuntimeNode.prototype._applyRuntimeStatus = function (snapshot, event) {
        const state = snapshot.actualState;
        if (state === RuntimeState.READY) {
            this._setStatus("green", "ready");
            return;
        }
        if (state === RuntimeState.STARTING) {
            this._setStatus("yellow", "starting");
            return;
        }
        if (state === RuntimeState.STOPPING) {
            this._setStatus("yellow", "stopping");
            return;
        }
        if (state === RuntimeState.RECOVERING) {
            this._setStatus("yellow", `restart #${snapshot.restartCount}`);
            return;
        }
        if (state === RuntimeState.ERROR) {
            const eventText = {
                spawn_failed: "spawn failed",
                startup_timeout: "startup timeout",
                stop_timeout: "stop timeout",
                heartbeat_timeout: "heartbeat lost",
                process_error: "process error",
                recovery_exhausted: "max restarts",
            };
            const errorText = eventText[event]
                || (snapshot.lastError && snapshot.lastError.code)
                || "error";
            this._setStatus("red", String(errorText).toLowerCase());
            return;
        }
        this._setStatus("grey", "stopped");
    };

    AibanRuntimeNode.prototype._transitionRuntime = function (method, ...args) {
        try {
            return this._runtimeController[method](...args);
        } catch (err) {
            if (err instanceof RuntimeTransitionError) {
                this.warn(err.message);
                return null;
            }
            throw err;
        }
    };

    AibanRuntimeNode.prototype.getRuntimeStatus = function () {
        return this._runtimeController.serialize();
    };

    AibanRuntimeNode.prototype._buildOperationResult = function (
        action,
        operationId,
        decision,
        options = {}
    ) {
        const status = this.getRuntimeStatus();
        const failed = options.failed === true;
        const idempotent = Boolean(decision && decision.idempotent);
        const queued = Boolean(decision && decision.queued);
        let acceptedStatus = "accepted";
        if (failed) {
            acceptedStatus = "failed";
        } else if (idempotent) {
            acceptedStatus = "idempotent";
        } else if (queued) {
            acceptedStatus = "queued";
        }
        return Object.freeze({
            operation_id: operationId,
            action,
            accepted: !failed,
            accepted_status: acceptedStatus,
            idempotent,
            queued,
            auto_start: status.auto_start,
            desired_state: status.desired_state,
            actual_state: status.actual_state,
            pid: status.pid,
            session_id: status.session_id,
            restart_count: status.restart_count,
            last_error: status.last_error,
            state_changed_at: status.last_state_at,
            message: options.message || null,
        });
    };

    AibanRuntimeNode.prototype.controlRuntime = function (action, options = {}) {
        if (!RUNTIME_CONTROL_COMMANDS.has(action)) {
            const err = new Error(`Invalid runtime action: ${action}`);
            err.code = "INVALID_RUNTIME_ACTION";
            throw err;
        }

        const operationId = options.operationId || randomUUID();
        const metadata = {
            operationId,
            source: options.source || "unknown",
            action,
        };

        if (action === "status") {
            return this._buildOperationResult(action, operationId, null, {
                message: "Current runtime state",
            });
        }

        if (this._shutdownInitiated) {
            return this._buildOperationResult(action, operationId, null, {
                failed: true,
                message: "Runtime node is shutting down",
            });
        }

        let decision;
        if (action === "start") {
            if (this._process && !this._process.killed
                && this._runtimeController.actualState === RuntimeState.ERROR) {
                this._stopProcess(false, metadata);
                decision = this._startProcess(true, metadata);
            } else {
                decision = this._startProcess(true, metadata);
            }
        } else if (action === "stop") {
            decision = this._stopProcess(false, metadata);
        } else if (action === "restart") {
            if (!this._process || this._process.killed) {
                decision = this._startProcess(true, metadata);
            } else if (this._runtimeController.actualState === RuntimeState.STOPPING) {
                decision = this._startProcess(true, metadata);
            } else {
                this._stopProcess(false, metadata);
                decision = this._startProcess(true, metadata);
            }
        }

        const status = this.getRuntimeStatus();
        const failed = status.actual_state === RuntimeState.ERROR
            && ["spawn_failed", "process_error"].includes(status.last_event);
        const messages = {
            start: "Start request accepted; wait for runtime_ready before treating it as READY",
            stop: "Stop request accepted; wait for process exit before treating it as fully stopped",
            restart: "Restart request accepted; the old process must exit before a new process starts",
        };
        return this._buildOperationResult(action, operationId, decision, {
            failed,
            message: failed && status.last_error
                ? status.last_error.message
                : messages[action],
        });
    };

    AibanRuntimeNode.prototype._openAuditLogs = function () {
        try {
            const directory = path.resolve(
                RED.settings.userDir, "..", "logs", "frame_bridge"
            );
            fs.mkdirSync(directory, { recursive: true });
            const now = new Date();
            const stamp = `${now.getFullYear()}`
                + `${String(now.getMonth() + 1).padStart(2, "0")}`
                + `${String(now.getDate()).padStart(2, "0")}-`
                + `${String(now.getHours()).padStart(2, "0")}`
                + `${String(now.getMinutes()).padStart(2, "0")}`
                + `${String(now.getSeconds()).padStart(2, "0")}`;
            const safeId = String(this.id || "runtime")
                .replace(/[^a-zA-Z0-9_-]/g, "_");
            const base = `runtime-${stamp}-${safeId}`;
            const textPath = path.join(directory, `${base}.log`);
            this._auditText = fs.createWriteStream(
                textPath, { flags: "a", encoding: "utf8" }
            );
            this._auditText.write(
                "┌──────────┬────────────────────────────────────────────────────────────┬────────────┬──────────────────┐\n"
                + "│ 帧号     │ SDK转换 → Python排队 → 进程管道 → Node输出                │ 累计耗时    │ 标签 / 时间       │\n"
                + "├──────────┼────────────────────────────────────────────────────────────┼────────────┼──────────────────┤\n"
            );
            this.log(`Frame timing log: ${textPath}`);
        } catch (err) {
            this.warn(`Cannot open frame timing log: ${err.message}`);
        }
    };

    AibanRuntimeNode.prototype._openLegacyVideoLog = function () {
        try {
            const directory = path.resolve(
                RED.settings.userDir, "..", "log", "abvideologs"
            );
            fs.mkdirSync(directory, { recursive: true });
            const textPath = path.join(directory, "vido_main.log");
            this._legacyVideoLog = fs.createWriteStream(
                textPath, { flags: "a", encoding: "utf8" }
            );
            this._writeLegacyVideoLog(
                "runtime",
                `==== aiban-runtime node started id=${this.id || ""} name=${this.name} ====`
            );
            this.log(`Legacy video log: ${textPath}`);
        } catch (err) {
            this.warn(`Cannot open legacy video log: ${err.message}`);
        }
    };

    AibanRuntimeNode.prototype._legacyTimestamp = function () {
        const now = new Date();
        const pad = (value, width = 2) => String(value).padStart(width, "0");
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
            + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.`
            + `${pad(now.getMilliseconds(), 3)}`;
    };

    AibanRuntimeNode.prototype._writeLegacyVideoLog = function (scope, message) {
        if (!this._legacyVideoLog) return;
        try {
            const text = typeof message === "string" ? message : JSON.stringify(message);
            this._legacyVideoLog.write(
                `[${this._legacyTimestamp()}][${scope}] ${text}\n`
            );
        } catch (_) {
            // Logging must never interrupt inference.
        }
    };

    AibanRuntimeNode.prototype._writeFrameAudit = function (payload, eventSeq) {
        if (!this._auditText) return;
        const nodeReceivedAtMs = performance.timeOrigin + performance.now();
        const sdkReceivedAtMs = Number(payload.sdk_received_at_ms || 0);
        const pythonStdoutAtMs = Number(payload.python_stdout_at_ms || 0);
        const sdkConvertMs = Number(payload.sdk_convert_ms || 0);
        const pythonQueueMs = Number(payload.python_queue_ms || 0);
        const pipeMs = pythonStdoutAtMs
            ? Math.max(0, nodeReceivedAtMs - pythonStdoutAtMs)
            : 0;
        const totalMs = sdkReceivedAtMs
            ? Math.max(0, nodeReceivedAtMs - sdkReceivedAtMs)
            : sdkConvertMs + pythonQueueMs + pipeMs;
        const streamId = payload.stream_id
            || `group-${payload.group_id}/source-${payload.source_id}`;
        const shortStream = String(streamId)
            .replace("group-", "g").replace("source-", "s");
        const labels = [];
        for (const [modelId, result] of Object.entries(payload.models || {})) {
            for (const box of (result && result.boxes) || []) {
                labels.push(
                    `m${modelId}:${box.label || ""}`
                    + `(${Number(box.confidence || 0).toFixed(3)})`
                );
            }
        }
        const labelText = labels.length ? labels.join("; ") : "-";
        const timeText = new Date(nodeReceivedAtMs).toLocaleTimeString(
            "zh-CN", { hour12: false }
        );
        this._writeLegacyVideoLog(
            "frame",
            `#${eventSeq} ${streamId || shortStream} labels=${labelText} `
            + `sdk_convert_ms=${sdkConvertMs.toFixed(2)} `
            + `python_queue_ms=${pythonQueueMs.toFixed(2)} `
            + `pipe_ms=${pipeMs.toFixed(2)} total_ms=${totalMs.toFixed(2)}`
        );
        this._auditText.write(
            `[PIPE] #${String(eventSeq).padEnd(5)} ${shortStream} │ `
            + `SDK转换 ${sdkConvertMs.toFixed(2).padStart(7)}ms → `
            + `Python排队 ${pythonQueueMs.toFixed(2).padStart(7)}ms → `
            + `管道 ${pipeMs.toFixed(2).padStart(7)}ms │ `
            + `∑ ${totalMs.toFixed(2).padStart(7)}ms │ `
            + `${labelText} │ ${timeText}\n`
        );
    };

    // ==================================================================
    // Input handler — control commands from upstream nodes
    // ==================================================================

    AibanRuntimeNode.prototype._onInput = function (msg, send, done) {
        if (!msg || msg.topic !== "aiban/control") {
            done();
            return;
        }

        const payload = msg.payload || {};
        const command = payload.command;

        if (!command || !VALID_COMMANDS.has(command)) {
            this.warn(`Invalid control command: ${command}`);
            done();
            return;
        }

        const requestId = `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const cmdObj = {
            schema_version: SCHEMA_VERSION,
            command: command,
            request_id: requestId,
            params: payload.params || {},
        };

        if (RUNTIME_CONTROL_COMMANDS.has(command)) {
            try {
                const result = this.controlRuntime(command, {
                    operationId: requestId,
                    source: "node_input",
                });
                send([
                    null,
                    {
                        topic: "aiban/status",
                        payload: result,
                        aiban: { runtime_id: this.id },
                    },
                    null,
                ]);
            } catch (err) {
                this.warn(`Runtime control ${command} (${requestId}) failed: ${err.message}`);
                send([
                    null,
                    null,
                    {
                        topic: "aiban/error",
                        payload: {
                            command,
                            operation_id: requestId,
                            ok: false,
                            error_code: err.code || "RUNTIME_CONTROL_FAILED",
                            error: err.message,
                        },
                    },
                ]);
            }
            done();
            return;
        }

        this._sendCommand(cmdObj)
            .then((result) => {
                this.log(`Command ${command} (${requestId}) succeeded: ${JSON.stringify(result)}`);
                // Also send result to output port 2 (status)
                send([
                    null,  // port 1
                    { topic: "aiban/status", payload: { command, requestId, ok: true, result } },
                    null,  // port 3
                ]);
            })
            .catch((err) => {
                this.warn(`Command ${command} (${requestId}) failed: ${err.message}`);
                send([
                    null,  // port 1
                    null,  // port 2
                    { topic: "aiban/error", payload: { command, requestId, ok: false, error: err.message } },
                ]);
            });

        done();
    };

    // ==================================================================
    // Send command via stdin
    // ==================================================================

    AibanRuntimeNode.prototype._sendCommand = function (cmdObj) {
        return new Promise((resolve, reject) => {
            if (!this._process || this._process.killed) {
                return reject(new Error("Python process not running"));
            }

            const requestId = cmdObj.request_id;
            const timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;

            const timer = setTimeout(() => {
                this._pendingCommands.delete(requestId);
                reject(new Error(`Command timeout: ${cmdObj.command} (${requestId})`));
            }, timeoutMs);

            this._pendingCommands.set(requestId, { resolve, reject, timer });

            try {
                const line = JSON.stringify(cmdObj) + "\n";
                this._process.stdin.write(line);
            } catch (err) {
                clearTimeout(timer);
                this._pendingCommands.delete(requestId);
                reject(err);
            }
        });
    };

    /**
     * Public API: request an on-demand screenshot from the Python backend.
     *
     * Used by aiban-result to save an image only when a terminal judgment
     * (OK/NG) is produced — matching V1 behaviour where metadata.saveImage()
     * is called at alarm time in workflow_engine.py.
     *
     * @param {number} groupId
     * @param {number} sourceId
     * @param {boolean} [saveRoi=false]
     * @returns {Promise<string>} resolves with the saved image_path
     */
    AibanRuntimeNode.prototype.requestScreenshot = function (groupId, sourceId, saveRoi) {
        const requestId = `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return this._sendCommand({
            schema_version: SCHEMA_VERSION,
            command: "screenshot",
            request_id: requestId,
            params: {
                group_id: Number(groupId),
                source_id: Number(sourceId),
                save_roi: Boolean(saveRoi),
            },
        }).then((result) => {
            return (result && result.image_path) || "";
        });
    };

    // ==================================================================
    // Process management
    // ==================================================================

    AibanRuntimeNode.prototype._startProcess = function (forceAutoStart, metadata = {}) {
        const transitionMetadata = {
            ...metadata,
            source: metadata.source
                || (forceAutoStart === true ? "manual" : "runtime"),
        };
        const startDecision = this._transitionRuntime("requestStart", transitionMetadata);
        if (this._process && !this._process.killed) {
            if (startDecision && startDecision.queued) {
                this.warn("Process is stopping; start request queued");
            } else {
                this.warn("Process already running, not starting");
            }
            return startDecision;
        }
        if (startDecision && startDecision.queued) {
            return startDecision;
        }

        this._sessionId = null;
        this._lastEventSeq = -1;
        this._transitionRuntime("spawnRequested", transitionMetadata);

        const args = [
            "-u",  // unbuffered stdout/stderr
            this.runnerPath,
            "--heartbeat-interval", String(this.heartbeatIntervalMs / 1000),
        ];

        if (this.useMock) {
            args.push("--mock");
        }
        if (this.sdkHome) {
            args.push("--sdk-home", this.sdkHome);
        }
        if (this.pipelineConfig) {
            args.push("--pipeline-config", this.pipelineConfig);
        }

        const options = {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        };
        if (this.workingDirectory) {
            options.cwd = this.workingDirectory;
        }

        this.log(`Spawning: ${this.pythonPath} ${args.join(" ")}`);

        try {
            this._process = this._spawnFn(this.pythonPath, args, options);
        } catch (err) {
            this.error(`Failed to spawn process: ${err.message}`);
            return this._transitionRuntime("spawnFailed", err);
        }
        const child = this._process;
        this._transitionRuntime("processSpawned", { pid: child.pid });

        // --- Setup stdout reader (JSON Lines events) ---
        const stdoutRl = readline.createInterface({
            input: child.stdout,
            crlfDelay: Infinity,
        });

        stdoutRl.on("line", (line) => {
            this._handleStdoutLine(line);
        });

        stdoutRl.on("close", () => {
            this.log("stdout closed");
        });

        // --- Setup stderr reader (diagnostic logs) ---
        const stderrRl = readline.createInterface({
            input: child.stderr,
            crlfDelay: Infinity,
        });

        stderrRl.on("line", (line) => {
            this.log(`[python:stderr] ${line}`);
            this._writeLegacyVideoLog("python:stderr", line);
        });

        // --- Process exit handler ---
        let exitHandled = false;
        child.on("exit", (code, signal) => {
            if (exitHandled) {
                return;
            }
            exitHandled = true;
            this.log(`Python process exited: code=${code} signal=${signal}`);
            this._writeLegacyVideoLog(
                "runtime",
                `Python process exited: code=${code} signal=${signal}`
            );
            const stateBeforeExit = this._runtimeController.getStatus();
            const restartAfterStop = stateBeforeExit.actualState === RuntimeState.STOPPING
                && stateBeforeExit.desiredState === DesiredState.READY
                && !this._shutdownInitiated;
            const expectedStop = this._shutdownInitiated
                || stateBeforeExit.desiredState === DesiredState.STOPPED
                || (stateBeforeExit.actualState === RuntimeState.STOPPING && !restartAfterStop);
            if (this._process === child) {
                this._process = null;
            }
            this._clearTimers();

            // Resolve all pending commands as failed
            for (const [reqId, entry] of this._pendingCommands) {
                clearTimeout(entry.timer);
                entry.reject(new Error(`Process exited before command completed`));
            }
            this._pendingCommands.clear();
            this._transitionRuntime("processExited", {
                code,
                signal,
                expected: expectedStop,
            });

            if (restartAfterStop) {
                setTimeout(() => {
                    if (!this._shutdownInitiated) {
                        this._startProcess(true);
                    }
                }, 200);
            } else if (!expectedStop && !this._shutdownInitiated) {
                this._maybeRestart(code, signal);
            }
        });

        // --- Process error handler ---
        child.on("error", (err) => {
            this.error(`Process error: ${err.message}`);
            this._writeLegacyVideoLog("runtime:error", err.message);
            this._transitionRuntime("processError", err);
            this.send([
                null,
                null,
                {
                    topic: "aiban/error",
                    payload: {
                        error_code: "PROCESS_ERROR",
                        message: err.message,
                        python_path: this.pythonPath,
                        runner_path: this.runnerPath,
                    },
                },
            ]);
        });

        // --- Auto-start ---
        if (forceAutoStart === true || this.autoStart) {
            // Give the runner a moment to initialize, then send start
            setTimeout(() => {
                this._sendCommand({
                    schema_version: SCHEMA_VERSION,
                    command: "start",
                    request_id: metadata.operationId || `auto-start-${Date.now()}`,
                    params: {},
                }).catch((err) => {
                    this.warn(`Auto-start failed: ${err.message}`);
                    if (this._startupTimer) {
                        clearTimeout(this._startupTimer);
                        this._startupTimer = null;
                    }
                    if (this._runtimeController.actualState === RuntimeState.STARTING) {
                        this._transitionRuntime("processError", {
                            code: "SDK_START_FAILED",
                            message: err.message,
                        });
                    }
                    this.send([
                        null,
                        null,
                        {
                            topic: "aiban/error",
                            payload: {
                                error_code: "SDK_START_FAILED",
                                message: err.message,
                            },
                            aiban: { runtime_id: this.id },
                        },
                    ]);
                });
            }, 500);

            // Set startup timeout
            this._startupTimer = setTimeout(() => {
                if (this._runtimeController.actualState === RuntimeState.STARTING) {
                    this.warn("Startup timeout — runtime_ready not received");
                    this._writeLegacyVideoLog(
                        "runtime:error",
                        `Startup timeout: runtime_ready not received within ${this.startupTimeoutMs}ms`
                    );
                    this._transitionRuntime("startupTimeout", {
                        code: "STARTUP_TIMEOUT",
                        message: `runtime_ready not received within ${this.startupTimeoutMs}ms`,
                    });
                    if (this._process === child && !child.killed) {
                        child.kill("SIGKILL");
                    }
                }
            }, this.startupTimeoutMs);
        }
        return startDecision;
    };

    AibanRuntimeNode.prototype._stopProcess = function (force, metadata = {}) {
        const stopDecision = this._transitionRuntime("requestStop", {
            ...metadata,
            source: metadata.source || (force ? "forced" : "runtime"),
        });
        if (!this._process || this._process.killed) {
            return stopDecision;
        }

        const child = this._process;

        if (force) {
            this.log("Force killing Python process");
            child.kill("SIGKILL");
            return stopDecision;
        }

        // Send stop command for graceful shutdown
        this._sendCommand({
            schema_version: SCHEMA_VERSION,
            command: "stop",
            request_id: metadata.operationId || `stop-${Date.now()}`,
            params: { force: false },
        }).catch(() => {
            // If command fails, force kill
            this.warn("Stop command failed, force killing");
            if (this._process === child && !child.killed) {
                child.kill("SIGKILL");
            }
        });

        // Set a hard timeout for graceful shutdown
        setTimeout(() => {
            if (this._process === child && !child.killed) {
                this.warn("Shutdown timeout, force killing");
                this._transitionRuntime("stopTimeout", {
                    code: "STOP_TIMEOUT",
                    message: `process did not exit within ${this.shutdownTimeoutMs}ms`,
                });
                child.kill("SIGKILL");
            }
        }, this.shutdownTimeoutMs);
        return stopDecision;
    };

    // ==================================================================
    // Restart policy
    // ==================================================================

    AibanRuntimeNode.prototype._maybeRestart = function (code, signal) {
        if (this._shutdownInitiated) {
            return;
        }

        if (this.restartPolicy === "never") {
            return;
        }

        if (this.restartPolicy === "on-failure" && code === 0 && !signal) {
            return;  // Clean exit — don't restart
        }

        if (this._runtimeController.restartCount >= this.maxRestartCount) {
            this.error(`Max restart count (${this.maxRestartCount}) reached, giving up`);
            this._transitionRuntime("recoveryExhausted", {
                code: "MAX_RESTARTS_REACHED",
                message: `Maximum restart count (${this.maxRestartCount}) reached`,
            });
            return;
        }

        const previousRestartCount = this._runtimeController.restartCount;
        this._currentBackoff = Math.min(
            this.restartBackoffMs * Math.pow(2, previousRestartCount),
            MAX_RESTART_BACKOFF_MS
        );
        this._transitionRuntime("recoveryScheduled", {
            code: "PROCESS_EXITED",
            message: `Runtime exited: code=${code} signal=${signal}`,
            details: { code, signal },
        });
        const restartCount = this._runtimeController.restartCount;

        this.log(
            `Restarting in ${this._currentBackoff}ms (attempt ${restartCount}/${this.maxRestartCount})`
        );

        setTimeout(() => {
            if (!this._shutdownInitiated
                && this._runtimeController.desiredState === DesiredState.READY) {
                this._startProcess(true);
            }
        }, this._currentBackoff);
    };

    // ==================================================================
    // Timer management
    // ==================================================================

    AibanRuntimeNode.prototype._clearTimers = function () {
        if (this._heartbeatTimer) {
            clearTimeout(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
        if (this._startupTimer) {
            clearTimeout(this._startupTimer);
            this._startupTimer = null;
        }
    };

    // ==================================================================
    // stdout line handler
    // ==================================================================

    AibanRuntimeNode.prototype._handleStdoutLine = function (line) {
        const trimmed = line.trim();
        if (!trimmed) {
            return;
        }

        // Runner protocol messages are always JSON objects. The native AiBan
        // DLL writes several unrelated diagnostic formats to inherited stdout
        // (timestamped lines, "MCMOT ...", "Total ...", and others). Treat
        // every non-object line as native output. Object-shaped lines still go
        // through strict parsing, so broken/half/glued protocol messages remain
        // observable as PARSE_ERROR.
        if (!trimmed.startsWith("{")) {
            this.log(`[python:native] ${trimmed.substring(0, 500)}`);
            this._writeLegacyVideoLog("python:native", trimmed);
            return;
        }

        let event;
        try {
            event = JSON.parse(trimmed);
        } catch (err) {
            // Non-JSON content on stdout is a protocol violation under strict
            // mode.  In non-strict mode (real AiBan DLL may write diagnostics
            // to stdout), log at debug level and skip silently.
            const truncated = trimmed.length > 255
                ? trimmed.substring(0, 255) + "..."
                : trimmed;
            this.warn(`stdout parse error: ${err.message} | raw: ${truncated}`);
            this._writeLegacyVideoLog(
                "stdout:parse_error",
                `${err.message} | raw: ${truncated}`
            );
            if (this.strictStdout) {
                this.send([
                    null,  // port 1
                    null,  // port 2
                    {
                        topic: "aiban/error",
                        payload: {
                            error_code: "PARSE_ERROR",
                            message: `Invalid JSON on stdout: ${err.message}`,
                            details: {
                                raw_preview: truncated,
                                raw_length: trimmed.length,
                                parse_error: err.message,
                            },
                        },
                        aiban: { runtime_id: this.id },
                    },
                ]);
            } else {
                this.log(`[python:native] ${truncated}`);
            }
            return;
        }

        const eventType = event.type || "unknown";
        const payload = event.payload || {};
        const sessionId = event.session_id || "";
        const eventSeq = event.event_seq;

        // Track session
        if (sessionId && !this._sessionId) {
            this._sessionId = sessionId;
        }

        // Check for sequence gaps
        if (eventSeq !== undefined && this._lastEventSeq >= 0) {
            const expected = this._lastEventSeq + 1;
            if (eventSeq > expected) {
                this.warn(`Sequence gap: expected ${expected}, got ${eventSeq}`);
                this.send([
                    null,
                    null,
                    {
                        topic: "aiban/error",
                        payload: {
                            error_code: "SEQUENCE_GAP",
                            message: `Event sequence gap: expected ${expected}, got ${eventSeq}`,
                            expected,
                            actual: eventSeq,
                        },
                        aiban: { runtime_id: this.id, session_id: sessionId },
                    },
                ]);
            }
        }
        if (eventSeq !== undefined && eventSeq > this._lastEventSeq) {
            this._lastEventSeq = eventSeq;
        }

        // Dispatch by event type
        switch (eventType) {
            case "frame":
                this._handleFrameEvent(event, sessionId, eventSeq);
                break;

            case "runtime_starting":
                this._transitionRuntime("runtimeStarting", {
                    sessionId,
                    eventSeq,
                });
                this.log(`Runner starting: ${JSON.stringify(payload)}`);
                this._writeLegacyVideoLog("runtime_starting", payload);
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "runtime_ready":
                this._sessionId = sessionId || this._sessionId;
                this._currentBackoff = 0;
                if (this._startupTimer) {
                    clearTimeout(this._startupTimer);
                    this._startupTimer = null;
                }
                this._transitionRuntime("runtimeReady", {
                    sessionId: sessionId || undefined,
                    pid: this._process ? this._process.pid : undefined,
                });
                this.log(`Runner ready: ${JSON.stringify(payload)}`);
                this._writeLegacyVideoLog("runtime_ready", payload);
                this._emitStatus(event, sessionId, eventSeq);
                this._resetHeartbeat();
                break;

            case "runtime_stopping":
                this._transitionRuntime("runtimeStopping", {
                    sessionId,
                    eventSeq,
                });
                this._writeLegacyVideoLog("runtime_stopping", payload);
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "runtime_stopped":
                this._clearTimers();
                this._transitionRuntime("runtimeStopped", {
                    sessionId,
                    eventSeq,
                });
                this._writeLegacyVideoLog("runtime_stopped", payload);
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "runtime_error":
                this.warn(`Runtime error: ${payload.error_code} — ${payload.message}`);
                this._writeLegacyVideoLog("runtime:error", payload);
                this._emitError(event, sessionId, eventSeq, payload.error_code);
                break;

            case "heartbeat":
                if (this._runtimeController.actualState === RuntimeState.READY) {
                    this._resetHeartbeat();
                }
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "sdk_event":
                this.log(`[SDK:${payload.level}] ${payload.message}`);
                this._writeLegacyVideoLog("sdk_event", payload);
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "screenshot_result":
                this.log(`Screenshot result: ${JSON.stringify(payload)}`);
                this._writeLegacyVideoLog("screenshot_result", payload);
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "command_result":
                this._writeLegacyVideoLog("command_result", payload);
                this._handleCommandResult(payload);
                break;

            default:
                this.log(`Unknown event type: ${eventType}`);
                this._writeLegacyVideoLog(eventType, payload);
                this._emitStatus(event, sessionId, eventSeq);
                break;
        }
    };

    AibanRuntimeNode.prototype._handleFrameEvent = function (event, sessionId, eventSeq) {
        const payload = event.payload || {};
        const streamId = payload.stream_id || "";
        this._writeFrameAudit(payload, eventSeq);

        // Output port 1: inference frame
        this.send([
            {
                topic: "aiban/frame",
                payload: payload,
                aiban: {
                    runtime_id: this.id,
                    session_id: sessionId,
                    event_id: event.event_id,
                    event_seq: eventSeq,
                    stream_id: streamId,
                    group_id: payload.group_id,
                    source_id: payload.source_id,
                    captured_at: payload.captured_at,
                },
            },
            null,  // port 2
            null,  // port 3
        ]);
    };

    AibanRuntimeNode.prototype._emitStatus = function (event, sessionId, eventSeq) {
        this.send([
            null,  // port 1
            {
                topic: "aiban/status",
                payload: event.payload,
                aiban: {
                    runtime_id: this.id,
                    session_id: sessionId,
                    event_id: event.event_id,
                    event_seq: eventSeq,
                    status_type: event.type,
                },
            },
            null,  // port 3
        ]);
    };

    AibanRuntimeNode.prototype._emitError = function (event, sessionId, eventSeq, errorCode) {
        this.send([
            null,  // port 1
            null,  // port 2
            {
                topic: "aiban/error",
                payload: event.payload,
                aiban: {
                    runtime_id: this.id,
                    session_id: sessionId,
                    event_id: event.event_id,
                    event_seq: eventSeq,
                    error_code: errorCode || "UNKNOWN",
                },
            },
        ]);
    };

    // ==================================================================
    // Command result handler
    // ==================================================================

    AibanRuntimeNode.prototype._handleCommandResult = function (payload) {
        const requestId = payload.request_id;
        if (!requestId || !this._pendingCommands.has(requestId)) {
            // Late or unknown response — log only
            this.log(`Command result for unknown request: ${requestId}`);
            return;
        }

        const entry = this._pendingCommands.get(requestId);
        this._pendingCommands.delete(requestId);
        clearTimeout(entry.timer);

        if (payload.ok) {
            entry.resolve(payload.result || {});
        } else {
            entry.reject(new Error(payload.error || "Command failed"));
        }
    };

    // ==================================================================
    // Heartbeat monitoring
    // ==================================================================

    AibanRuntimeNode.prototype._resetHeartbeat = function () {
        if (this._heartbeatTimer) {
            clearTimeout(this._heartbeatTimer);
        }
        this._heartbeatTimer = setTimeout(() => {
            if (this._runtimeController.actualState === RuntimeState.READY) {
                this.warn("Heartbeat timeout — no heartbeat received");
                this._writeLegacyVideoLog(
                    "runtime:error",
                    `Heartbeat timeout: no heartbeat received within ${this.heartbeatTimeoutMs}ms`
                );
                this._transitionRuntime("heartbeatTimeout", {
                    code: "HEARTBEAT_TIMEOUT",
                    message: `no heartbeat received within ${this.heartbeatTimeoutMs}ms`,
                });
                if (this._process && !this._process.killed) {
                    this._process.kill("SIGKILL");
                }
                // Unexpected exit is handled by the restart policy.
            }
        }, this.heartbeatTimeoutMs);
    };

    // ==================================================================
    // Node lifecycle
    // ==================================================================

    AibanRuntimeNode.prototype._onClose = function (removed, done) {
        this._shutdownInitiated = true;
        this._transitionRuntime("requestStop", { source: "node_close" });
        this._clearTimers();
        const closeAuditLogs = () => {
            if (this._auditText) {
                this._auditText.end();
                this._auditText = null;
            }
            if (this._legacyVideoLog) {
                this._writeLegacyVideoLog(
                    "runtime",
                    `==== aiban-runtime node closed id=${this.id || ""} ====`
                );
                this._legacyVideoLog.end();
                this._legacyVideoLog = null;
            }
        };

        if (this._process && !this._process.killed) {
            // Send stop and wait briefly
            try {
                const line = JSON.stringify({
                    schema_version: SCHEMA_VERSION,
                    command: "stop",
                    request_id: `close-${Date.now()}`,
                    params: { force: true },
                }) + "\n";
                this._process.stdin.write(line);
            } catch (_) {
                // stdin may be closed
            }

            // Force kill after shutdown timeout
            const killTimer = setTimeout(() => {
                if (this._process && !this._process.killed) {
                    this._process.kill("SIGKILL");
                }
            }, this.shutdownTimeoutMs);

            this._process.on("exit", () => {
                clearTimeout(killTimer);
                closeAuditLogs();
                done();
            });
        } else {
            closeAuditLogs();
            done();
        }
    };

    // Pipeline labels endpoint: parse YAML pipeline config and extract
    // model/label information for the aiban-label editor dropdowns.
    //
    // Security:
    //   - Requires aiban-runtime.read permission.
    //   - Restricts path reading to files under the configured SDK home
    //     (or a default AiBan workspace) to prevent arbitrary file reads.
    RED.httpAdmin.get(
        "/aiban-runtime/pipeline-labels",
        RED.auth.needsPermission("aiban-runtime.read"),
        function getPipelineLabels(req, res) {
            const pipelinePath = (req.query.path || "").trim();
            if (!pipelinePath) {
                res.json({
                    pipeline_config: "",
                    models: [],
                    warning: "No pipeline config path provided",
                });
                return;
            }

            // Restrict to the SDK home directory (or its parents) to
            // prevent directory-traversal reads of arbitrary files.
            const sdkHome = path.resolve(
                process.env.AIBAN_SDK_HOME || "D:/product/AiBanWorkSpace"
            );
            const resolved = path.resolve(pipelinePath);
            if (!resolved.startsWith(sdkHome) && !resolved.startsWith(
                path.resolve(sdkHome, "..")
            )) {
                res.status(403).json({
                    pipeline_config: "",
                    models: [],
                    warning: "Access denied: path outside SDK home",
                });
                return;
            }

            try {
                const fs = require("node:fs");
                const yaml = require("js-yaml");

                if (!fs.existsSync(resolved)) {
                    res.json({
                        pipeline_config: resolved,
                        models: [],
                        warning: "Pipeline config file not found: " + resolved,
                    });
                    return;
                }

                const raw = fs.readFileSync(resolved, "utf8");
                const doc = yaml.load(raw);
                // Attach the YAML file's directory so _extractModelsFromYaml
                // can resolve relative model paths.
                if (doc && typeof doc === "object") {
                    doc._yamlDir = path.dirname(resolved);
                }
                const models = _extractModelsFromYaml(doc);
                res.json({
                    pipeline_config: resolved,
                    models: models,
                });
            } catch (err) {
                res.json({
                    pipeline_config: resolved,
                    models: [],
                    warning: "Failed to parse pipeline config: " + (err.message || "unknown error"),
                });
            }
        }
    );

    /**
     * Extract model/label info from parsed AiBan pipeline YAML.
     *
     * AiBen main-flow.yaml structure:
     *   ModelArrary.Models[] — { modelid, modelpath, ... }
     *   Each model has a companion .json file with labels:
     *     [{ sign: 0, labelCode: "...", labelName: "end" }, ...]
     *
     * Also handles sequence/monitor JSON configs as fallback.
     */
    function _extractModelsFromYaml(doc) {
        if (!doc || typeof doc !== "object") return [];

        const models = [];
        const yamlDir = doc._yamlDir || "";  // set by caller

        // ── AiBan main-flow.yaml format ──────────────────────────────
        // Keep AiBan YAML modelid unchanged. The SDK frame payload uses the
        // same key in payload.models, so label nodes must match it exactly.
        if (doc.ModelArrary && Array.isArray(doc.ModelArrary.Models)) {
            for (const mDef of doc.ModelArrary.Models) {
                const yamlId = mDef.modelid !== undefined ? Number(mDef.modelid) : 0;
                const mId = String(yamlId);
                const modelPath = mDef.modelpath || "";
                const labels = _loadLabelsFromModelJson(modelPath);

                // Try to find a model name from path
                const pathMatch = modelPath.match(/([^\\/]+)\.aiban$/i);
                const modelName = pathMatch ? pathMatch[1] : "";

                models.push({
                    model_id: mId,
                    model_name: modelName,
                    labels: labels,
                    warning: labels.length === 0 ? "No .json label file found for model" : null,
                });
            }
            return models;
        }

        // ── Fallback formats (JSON configs, etc.) ────────────────────

        // Format: { models: { "1": { name: "...", labels: [...] } } }
        if (doc.models && typeof doc.models === "object" && !Array.isArray(doc.models)) {
            for (const [mId, mDef] of Object.entries(doc.models)) {
                if (mDef && typeof mDef === "object") {
                    models.push({
                        model_id: String(mId),
                        model_name: mDef.name || mDef.model_name || "",
                        labels: _normalizeLabels(mDef.labels),
                        warning: null,
                    });
                }
            }
            return models;
        }

        // Format: { models: [{ model_id, name, labels }] }
        if (doc.models && Array.isArray(doc.models)) {
            for (const mDef of doc.models) {
                if (mDef && typeof mDef === "object") {
                    models.push({
                        model_id: String(mDef.model_id || mDef.id || ""),
                        model_name: mDef.name || mDef.model_name || "",
                        labels: _normalizeLabels(mDef.labels),
                        warning: null,
                    });
                }
            }
            return models;
        }

        // Format: { model_id, labels } (single model)
        if (doc.model_id || doc.labels) {
            models.push({
                model_id: String(doc.model_id || "1"),
                model_name: doc.name || doc.model_name || "",
                labels: _normalizeLabels(doc.labels),
                warning: null,
            });
            return models;
        }

        // Format: { sequence: { steps: [...] } }
        if (doc.sequence && Array.isArray(doc.sequence.steps)) {
            const labelsByModel = {};
            for (const step of doc.sequence.steps) {
                const mId = String(step.model_id || doc.model_id || "1");
                if (!labelsByModel[mId]) {
                    labelsByModel[mId] = { model_id: mId, model_name: "", labels: [] };
                }
                if (step.label && !labelsByModel[mId].labels.find(
                    (l) => l.name === step.label
                )) {
                    labelsByModel[mId].labels.push({
                        name: String(step.label),
                        sign: step.id || "",
                    });
                }
            }
            for (const m of Object.values(labelsByModel)) {
                models.push({ ...m, warning: null });
            }
            return models;
        }

        // Format: { rules: [...] } (monitor mode)
        if (doc.rules && Array.isArray(doc.rules)) {
            const labelsByModel = {};
            for (const rule of doc.rules) {
                const mId = String(rule.model_id || doc.model_id || "1");
                if (!labelsByModel[mId]) {
                    labelsByModel[mId] = { model_id: mId, model_name: "", labels: [] };
                }
                if (rule.label && !labelsByModel[mId].labels.find(
                    (l) => l.name === rule.label
                )) {
                    labelsByModel[mId].labels.push({
                        name: String(rule.label),
                        sign: rule.id || "",
                    });
                }
            }
            for (const m of Object.values(labelsByModel)) {
                models.push({ ...m, warning: null });
            }
            return models;
        }

        return models;
    }

    /**
     * Load labels from a model's companion .json file.
     * Model file:  D:/.../huayang-2.aiban
     * Labels file: D:/.../huayang-2.json
     *
     * JSON format: [{ sign: 0, labelCode: "...", labelName: "end" }, ...]
     */
    function _loadLabelsFromModelJson(modelPath) {
        if (!modelPath) return [];
        try {
            const fs = require("node:fs");
            const jsonPath = modelPath.replace(/\.aiban$/i, ".json");
            if (!fs.existsSync(jsonPath)) return [];
            const raw = fs.readFileSync(jsonPath, "utf8");
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr.map(function (item) {
                return {
                    name: String(item.labelName || item.label || ""),
                    sign: item.sign !== undefined ? String(item.sign) : "",
                };
            }).filter(function (l) { return l.name !== ""; });
        } catch (_) {
            return [];
        }
    }

    /**
     * Normalize labels into [{ name, sign }] format from various input shapes.
     * Handles: string[], {name, sign}[], {label, sign}[], etc.
     */
    function _normalizeLabels(labels) {
        if (!labels) return [];
        if (!Array.isArray(labels)) return [];
        return labels.map(function (l) {
            if (typeof l === "string") {
                return { name: l, sign: "" };
            }
            if (l && typeof l === "object") {
                return {
                    name: String(l.name || l.label || l.labelName || ""),
                    sign: l.sign !== undefined ? String(l.sign) : "",
                };
            }
            return { name: "", sign: "" };
        }).filter(function (l) { return l.name !== ""; });
    }

    // Shared endpoint: query icam_alarmname_data for alarm name dropdowns
    // used by aiban-label, aiban-result-db, and other nodes.
    //
    // Security:
    //   - Requires aiban-runtime.read permission.
    //   - DB credentials come from environment variables ONLY — passwords
    //     are NEVER accepted via URL query parameters.
    RED.httpAdmin.get(
        "/aiban-alarm-names",
        RED.auth.needsPermission("aiban-runtime.read"),
        function getAlarmNames(req, res) {
            (async () => {
                let connection = null;
                try {
                    const mysql = require("mysql2/promise");
                    const dbConfig = {
                        host: process.env.MYSQL_HOST || "127.0.0.1",
                        port: Number(process.env.MYSQL_PORT) || 3306,
                        user: process.env.MYSQL_USER || "root",
                        password: process.env.MYSQL_PASSWD || "",
                        database: process.env.MYSQL_DB || "icamera_data",
                        connectTimeout: 3000,
                    };
                    connection = await mysql.createConnection(dbConfig);
                    const [rows] = await connection.execute(
                        "SELECT id, alarmname FROM icam_alarmname_data ORDER BY id"
                    );
                    res.json({
                        success: true,
                        data: rows.map((r) => ({
                            id: r.id,
                            alarmname: r.alarmname,
                        })),
                    });
                } catch (err) {
                    res.json({
                        success: false,
                        error: err.message || "Unknown database error",
                        hint: "请检查 MySQL 连接配置或确认 icam_alarmname_data 表是否存在",
                        data: [],
                    });
                } finally {
                    if (connection) {
                        try { await connection.end(); } catch (_) { /* ignore */ }
                    }
                }
            })();
        }
    );

    RED.httpAdmin.get(
        "/aiban-runtime/:id/status",
        RED.auth.needsPermission("aiban-runtime.read"),
        function getRuntimeStatus(req, res) {
            const node = RED.nodes.getNode(req.params.id);
            if (!node) {
                sendAdminJson(res, 404, {
                    error_code: "RUNTIME_NOT_FOUND",
                    message: `Runtime node not found: ${req.params.id}`,
                });
                return;
            }
            sendAdminJson(res, 200, node.controlRuntime("status", {
                source: "http_status",
            }));
        }
    );

    RED.httpAdmin.post(
        "/aiban-runtime/:id/:action",
        RED.auth.needsPermission("aiban-runtime.write"),
        function controlRuntime(req, res) {
            const node = RED.nodes.getNode(req.params.id);
            const action = req.params.action;
            if (!node) {
                sendAdminJson(res, 404, {
                    error_code: "RUNTIME_NOT_FOUND",
                    message: `Runtime node not found: ${req.params.id}`,
                });
                return;
            }
            if (!["start", "stop", "restart"].includes(action)) {
                sendAdminJson(res, 400, {
                    error_code: "INVALID_RUNTIME_ACTION",
                    message: `Invalid runtime action: ${action}`,
                });
                return;
            }
            try {
                const result = node.controlRuntime(action, {
                    source: "http_admin",
                });
                let statusCode = 200;
                if (!result.accepted) {
                    statusCode = 500;
                } else if ([
                    RuntimeState.STARTING,
                    RuntimeState.STOPPING,
                    RuntimeState.RECOVERING,
                ].includes(result.actual_state)) {
                    statusCode = 202;
                }
                sendAdminJson(res, statusCode, result);
            } catch (err) {
                sendAdminJson(res, err.code === "INVALID_RUNTIME_ACTION" ? 400 : 500, {
                    error_code: err.code || "RUNTIME_CONTROL_FAILED",
                    message: err.message,
                });
            }
        }
    );

    // Register the node type
    RED.nodes.registerType("aiban-runtime", AibanRuntimeNode);
};
