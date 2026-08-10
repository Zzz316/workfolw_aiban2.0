/**
 * Test helpers for aiban-runtime node integration tests.
 *
 * Provides:
 *   - createMockRED()        — minimal Node-RED runtime mock
 *   - createMockSpawn()      — controllable fake child_process.spawn
 *   - createStreamPair()     — PassThrough pair for simulating pipe I/O
 *
 * Usage:
 *   const { createMockRED, createMockSpawn, delay } = require("./test-helpers");
 */

"use strict";

const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const fs = require("node:fs");

// ---------------------------------------------------------------------------
// Fake ChildProcess
// ---------------------------------------------------------------------------

class FakeChildProcess extends EventEmitter {
    constructor() {
        super();
        this.stdin = new PassThrough();
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.killed = false;
        this.exitCode = null;
        this.signalCode = null;
        this.pid = Math.floor(Math.random() * 60000) + 1000;

        // Allow writes to stdin
        this.stdin._isStdio = true;
    }

    kill(signal) {
        this.killed = true;
        this.signalCode = signal || "SIGTERM";
        this.exitCode = this.exitCode !== null ? this.exitCode : -1;
        // Emit exit asynchronously (mimics real process behavior)
        const exitCode = this.exitCode;
        const signalCode = this.signalCode;
        setImmediate(() => {
            this.emit("exit", exitCode, signalCode);
            this.emit("close", exitCode, signalCode);
        });
        return true;
    }
}

// ---------------------------------------------------------------------------
// Mock spawn factory
// ---------------------------------------------------------------------------

function createMockSpawn() {
    /**
     * Returns a factory that creates FakeChildProcess instances.
     * The factory has a `.processes` array tracking all created processes.
     *
     * Usage:
     *   const mockSpawn = createMockSpawn();
     *   const proc = mockSpawn("python", ["-u", "runner.py"], { stdio: [...] });
     *   // proc is a FakeChildProcess
     *   mockSpawn.processes  // => [proc]
     */
    const spawnFn = function mockSpawn(command, args, options) {
        const proc = new FakeChildProcess();
        proc._command = command;
        proc._args = args;
        proc._options = options;
        spawnFn.processes.push(proc);
        spawnFn.lastSpawn = { command, args, options, proc };
        return proc;
    };

    spawnFn.processes = [];
    spawnFn.lastSpawn = null;
    spawnFn.reset = function () {
        spawnFn.processes = [];
        spawnFn.lastSpawn = null;
    };

    return spawnFn;
}

// ---------------------------------------------------------------------------
// Mock RED runtime
// ---------------------------------------------------------------------------

function createMockRED(options = {}) {
    /**
     * Build a minimal RED object that aiban-runtime.js can be loaded against.
     *
     * Options:
     *   userDir    — RED.settings.userDir (default: temp directory)
     *   nodeLog    — capture node.log/warn/error calls (default: true)
     *
     * Returns:
     *   { RED, nodeRegistry } where RED is the mock and nodeRegistry is
     *   a Map of registered node types → constructors.
     */

    const userDir = options.userDir || fs.mkdtempSync(
        path.join(require("node:os").tmpdir(), "aiban-test-red-")
    );

    const nodeRegistry = new Map();

    // Ensure logs directory exists for audit log writes
    const logsDir = path.resolve(userDir, "..", "logs", "runtime");
    fs.mkdirSync(logsDir, { recursive: true });

    const RED = {
        nodes: {
            createNode(node, config) {
                // Give the node standard Node-RED methods
                node._config = config;
                node._sent = [];           // captured send() calls
                node._statusCalls = [];    // captured status() calls
                node._logs = [];           // captured log/warn/error calls
                node._closed = false;
                node._closeDone = null;

                node.send = function (msg) {
                    // Record the send call — handles array-form (multi-port)
                    node._sent.push(msg);
                };

                node.status = function (status) {
                    node._statusCalls.push({ ...status, _at: Date.now() });
                };

                node.log = function (msg) {
                    node._logs.push({ level: "log", msg, _at: Date.now() });
                };

                node.warn = function (msg) {
                    node._logs.push({ level: "warn", msg, _at: Date.now() });
                };

                node.error = function (msg) {
                    node._logs.push({ level: "error", msg, _at: Date.now() });
                };

                // Node-RED EventEmitter — aiban-runtime.js uses this.on()
                node._eventHandlers = {};

                node.on = function (event, handler) {
                    if (!node._eventHandlers[event]) {
                        node._eventHandlers[event] = [];
                    }
                    node._eventHandlers[event].push(handler);
                    return node;
                };

                node.emit = function (event, ...args) {
                    const handlers = node._eventHandlers[event] || [];
                    for (const handler of handlers) {
                        handler.apply(node, args);
                    }
                    return node;
                };

                return node;
            },

            registerType(typeName, constructor, opts) {
                nodeRegistry.set(typeName, { constructor, opts });
            },

            getNode(id) {
                // For admin endpoint tests: find a registered instance
                for (const [typeName, entry] of nodeRegistry) {
                    // Scan known instances — stored on the registry entry
                    if (entry._instances && entry._instances.has(id)) {
                        return entry._instances.get(id);
                    }
                }
                return null;
            },
        },

        settings: {
            userDir: userDir,
        },

        auth: {
            needsPermission(perm) {
                return function (req, res, next) {
                    next();
                };
            },
        },

        httpAdmin: {
            _routes: [],

            get(path, ...handlers) {
                RED.httpAdmin._routes.push({ method: "GET", path, handlers });
                return handlers[handlers.length - 1]; // return last handler
            },

            post(path, ...handlers) {
                RED.httpAdmin._routes.push({ method: "POST", path, handlers });
                return handlers[handlers.length - 1]; // return last handler
            },

            put(path, ...handlers) {
                RED.httpAdmin._routes.push({ method: "PUT", path, handlers });
                return handlers[handlers.length - 1]; // return last handler
            },

            delete(path, ...handlers) {
                RED.httpAdmin._routes.push({ method: "DELETE", path, handlers });
                return handlers[handlers.length - 1]; // return last handler
            },
        },
    };

    return { RED, nodeRegistry, userDir };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Write a JSON Lines event to a child process's stdout (simulating
 * what the Python runner would emit).
 */
function emitEvent(proc, event) {
    proc.stdout.push(JSON.stringify(event) + "\n");
}

/**
 * Read pending data from a child process's stdin (simulating what the
 * Python runner would receive as a command).
 */
function readStdin(proc) {
    return new Promise((resolve) => {
        const chunks = [];
        proc.stdin.on("data", (chunk) => {
            chunks.push(chunk);
        });
        // Wait a tick for data to arrive
        setTimeout(() => {
            resolve(Buffer.concat(chunks).toString("utf-8"));
        }, 50);
    });
}

/**
 * Get all messages sent to a specific output port (0, 1, or 2).
 * node.send() uses array form: [port0, port1, port2]
 */
function getPortMessages(node, portIndex) {
    return node._sent
        .filter(msg => Array.isArray(msg))
        .map(msg => msg[portIndex])
        .filter(msg => msg !== null && msg !== undefined);
}

module.exports = {
    FakeChildProcess,
    createMockSpawn,
    createMockRED,
    delay,
    emitEvent,
    readStdin,
    getPortMessages,
};
