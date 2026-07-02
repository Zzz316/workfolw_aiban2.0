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

const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

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

const VALID_COMMANDS = new Set([
    "start", "stop", "restart", "health",
    "pause_source", "resume_source", "screenshot",
]);

// ---------------------------------------------------------------------------
// Node registration
// ---------------------------------------------------------------------------

module.exports = function registerAibanRuntimeNode(RED) {

    function AibanRuntimeNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;

        // --- Configuration ---
        this.name = config.name || "aiban-runtime";
        this.pythonPath = config.pythonPath || "python";
        this.runnerPath = config.runnerPath || "";
        this.sdkHome = config.sdkHome || "";
        this.pipelineConfig = config.pipelineConfig || "";
        this.workingDirectory = config.workingDirectory || "";
        this.startupTimeoutMs = parseInt(config.startupTimeoutMs) || DEFAULT_STARTUP_TIMEOUT_MS;
        this.shutdownTimeoutMs = parseInt(config.shutdownTimeoutMs) || DEFAULT_SHUTDOWN_TIMEOUT_MS;
        this.heartbeatIntervalMs = parseInt(config.heartbeatIntervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.heartbeatTimeoutMs = parseInt(config.heartbeatTimeoutMs) || DEFAULT_HEARTBEAT_TIMEOUT_MS;
        this.restartPolicy = config.restartPolicy || "never";  // never | on-failure | always
        this.maxRestartCount = parseInt(config.maxRestartCount) || DEFAULT_MAX_RESTART_COUNT;
        this.restartBackoffMs = parseInt(config.restartBackoffMs) || DEFAULT_RESTART_BACKOFF_MS;
        this.autoStart = config.autoStart !== undefined ? config.autoStart : true;

        // --- Runtime state ---
        this._process = null;
        this._sessionId = null;
        this._lastEventSeq = -1;
        this._ready = false;
        this._stopping = false;
        this._restartCount = 0;
        this._currentBackoff = 0;
        this._heartbeatTimer = null;
        this._startupTimer = null;
        this._pendingCommands = new Map();  // request_id → { resolve, reject, timer }
        this._shutdownInitiated = false;

        // --- Resolve runner path ---
        if (!this.runnerPath) {
            // Default: look for python_runtime/aiban_runner.py relative to this file
            this.runnerPath = path.join(__dirname, "..", "python_runtime", "aiban_runner.py");
        }

        // --- Set initial status ---
        this._setStatus("yellow", "configured");

        // --- Event handlers ---
        this.on("input", this._onInput.bind(this));
        this.on("close", this._onClose.bind(this));
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

    // ==================================================================
    // Process management
    // ==================================================================

    AibanRuntimeNode.prototype._startProcess = function () {
        if (this._process && !this._process.killed) {
            this.warn("Process already running, not starting");
            return;
        }

        this._stopping = false;
        this._setStatus("yellow", "starting");

        const args = [
            "-u",  // unbuffered stdout/stderr
            this.runnerPath,
            "--mock",
            "--heartbeat-interval", String(this.heartbeatIntervalMs / 1000),
        ];

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
            this._process = spawn(this.pythonPath, args, options);
        } catch (err) {
            this.error(`Failed to spawn process: ${err.message}`);
            this._setStatus("red", "spawn failed");
            return;
        }

        // --- Setup stdout reader (JSON Lines events) ---
        const stdoutRl = readline.createInterface({
            input: this._process.stdout,
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
            input: this._process.stderr,
            crlfDelay: Infinity,
        });

        stderrRl.on("line", (line) => {
            this.log(`[python:stderr] ${line}`);
        });

        // --- Process exit handler ---
        this._process.on("exit", (code, signal) => {
            this.log(`Python process exited: code=${code} signal=${signal}`);
            this._process = null;
            this._ready = false;
            this._clearTimers();

            // Resolve all pending commands as failed
            for (const [reqId, entry] of this._pendingCommands) {
                clearTimeout(entry.timer);
                entry.reject(new Error(`Process exited before command completed`));
            }
            this._pendingCommands.clear();

            if (!this._stopping && !this._shutdownInitiated) {
                this._setStatus("red", `exited code=${code}`);
                this._maybeRestart(code, signal);
            } else {
                this._setStatus("grey", "stopped");
            }
        });

        // --- Process error handler ---
        this._process.on("error", (err) => {
            this.error(`Process error: ${err.message}`);
            this._setStatus("red", "process error");
        });

        // --- Auto-start ---
        if (this.autoStart) {
            // Give the runner a moment to initialize, then send start
            setTimeout(() => {
                this._sendCommand({
                    schema_version: SCHEMA_VERSION,
                    command: "start",
                    request_id: `auto-start-${Date.now()}`,
                    params: {},
                }).catch((err) => {
                    this.warn(`Auto-start failed: ${err.message}`);
                });
            }, 500);

            // Set startup timeout
            this._startupTimer = setTimeout(() => {
                if (!this._ready) {
                    this.warn("Startup timeout — runtime_ready not received");
                    this._setStatus("red", "startup timeout");
                    this._stopProcess(true);
                }
            }, this.startupTimeoutMs);
        }
    };

    AibanRuntimeNode.prototype._stopProcess = function (force) {
        if (!this._process || this._process.killed) {
            return;
        }

        this._stopping = true;
        this._setStatus("yellow", "stopping");

        if (force) {
            this.log("Force killing Python process");
            this._process.kill("SIGKILL");
            return;
        }

        // Send stop command for graceful shutdown
        this._sendCommand({
            schema_version: SCHEMA_VERSION,
            command: "stop",
            request_id: `stop-${Date.now()}`,
            params: { force: false },
        }).catch(() => {
            // If command fails, force kill
            this.warn("Stop command failed, force killing");
            if (this._process && !this._process.killed) {
                this._process.kill("SIGKILL");
            }
        });

        // Set a hard timeout for graceful shutdown
        setTimeout(() => {
            if (this._process && !this._process.killed) {
                this.warn("Shutdown timeout, force killing");
                this._process.kill("SIGKILL");
            }
        }, this.shutdownTimeoutMs);
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

        if (this._restartCount >= this.maxRestartCount) {
            this.error(`Max restart count (${this.maxRestartCount}) reached, giving up`);
            this._setStatus("red", "max restarts");
            return;
        }

        this._currentBackoff = Math.min(
            this.restartBackoffMs * Math.pow(2, this._restartCount),
            MAX_RESTART_BACKOFF_MS
        );
        this._restartCount++;

        this.log(
            `Restarting in ${this._currentBackoff}ms (attempt ${this._restartCount}/${this.maxRestartCount})`
        );
        this._setStatus("yellow", `restart #${this._restartCount}`);

        setTimeout(() => {
            this._startProcess();
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

        let event;
        try {
            event = JSON.parse(trimmed);
        } catch (err) {
            this.warn(`Invalid JSON on stdout: ${trimmed.substring(0, 200)}`);
            // Emit parse error to port 3
            this.send([
                null,
                null,
                {
                    topic: "aiban/error",
                    payload: {
                        error_code: "PARSE_ERROR",
                        message: `Invalid JSON on stdout: ${err.message}`,
                        raw: trimmed.substring(0, 500),
                    },
                    aiban: { runtime_id: this.id },
                },
            ]);
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
                this._setStatus("yellow", "starting");
                this.log(`Runner starting: ${JSON.stringify(payload)}`);
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "runtime_ready":
                this._ready = true;
                this._restartCount = 0;
                this._currentBackoff = 0;
                if (this._startupTimer) {
                    clearTimeout(this._startupTimer);
                    this._startupTimer = null;
                }
                this._setStatus("green", "ready");
                this.log(`Runner ready: ${JSON.stringify(payload)}`);
                this._emitStatus(event, sessionId, eventSeq);
                this._resetHeartbeat();
                break;

            case "runtime_stopping":
                this._setStatus("yellow", "stopping");
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "runtime_stopped":
                this._ready = false;
                this._clearTimers();
                this._setStatus("grey", "stopped");
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "runtime_error":
                this.warn(`Runtime error: ${payload.error_code} — ${payload.message}`);
                this._emitError(event, sessionId, eventSeq, payload.error_code);
                break;

            case "heartbeat":
                if (this._ready) {
                    this._resetHeartbeat();
                }
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "sdk_event":
                this.log(`[SDK:${payload.level}] ${payload.message}`);
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "screenshot_result":
                this.log(`Screenshot result: ${JSON.stringify(payload)}`);
                this._emitStatus(event, sessionId, eventSeq);
                break;

            case "command_result":
                this._handleCommandResult(payload);
                break;

            default:
                this.log(`Unknown event type: ${eventType}`);
                this._emitStatus(event, sessionId, eventSeq);
                break;
        }
    };

    AibanRuntimeNode.prototype._handleFrameEvent = function (event, sessionId, eventSeq) {
        const payload = event.payload || {};
        const streamId = payload.stream_id || "";

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
            if (this._ready) {
                this.warn("Heartbeat timeout — no heartbeat received");
                this._setStatus("red", "heartbeat lost");
                this._stopProcess(true);
                // Restart will be triggered by exit handler
            }
        }, this.heartbeatTimeoutMs);
    };

    // ==================================================================
    // Node lifecycle
    // ==================================================================

    AibanRuntimeNode.prototype._onClose = function (removed, done) {
        this._shutdownInitiated = true;
        this._clearTimers();

        if (this._process && !this._process.killed) {
            // Send stop and wait briefly
            this._stopping = true;
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
                done();
            });
        } else {
            done();
        }
    };

    // ==================================================================
    // Deploy — kick off
    // ==================================================================

    // Start the process when the node is deployed
    // In Node-RED, the constructor is called during deploy, so we start here
    // but defer to allow the runtime to finish setting up
    setTimeout(() => {
        if (!AibanRuntimeNode.prototype._shutdownInitiated) {
            AibanRuntimeNode.prototype._boundStart =
                AibanRuntimeNode.prototype._boundStart ||
                function () {
                    this._startProcess();
                };
            this._startProcess();
        }
    }, 100);

    // Register the node type
    RED.nodes.registerType("aiban-runtime", AibanRuntimeNode);
};
