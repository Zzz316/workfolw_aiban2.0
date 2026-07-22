"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { createMockRED } = require("./test-helpers");
const { RuntimeState } = require("../lib/runtime-controller");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const RUNNER_PATH = path.join(PROJECT_ROOT, "python_runtime", "aiban_runner.py");
const KNOWN_WINDOWS_PYTHON = "C:/Users/s2017088/AppData/Local/Programs/Python/Python39/python.exe";
const PYTHON = process.env.AIBAN_TEST_PYTHON
    || (fs.existsSync(KNOWN_WINDOWS_PYTHON) ? KNOWN_WINDOWS_PYTHON : "python");

function waitUntil(predicate, timeoutMs, description) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (predicate()) {
                resolve();
                return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error(`Timed out waiting for ${description}`));
                return;
            }
            setTimeout(poll, 50);
        };
        poll();
    });
}

function closeNode(node, removed, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Node close timed out")), timeoutMs);
        node._onClose(removed, () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

test("Windows real child process restart replaces one PID and delete reaps it", {
    skip: process.platform !== "win32",
    timeout: 30000,
}, async () => {
    const trackedProcesses = [];
    const trackingSpawn = (command, args, options) => {
        const child = spawn(command, args, options);
        trackedProcesses.push(child);
        return child;
    };
    const { RED, nodeRegistry } = createMockRED({
        userDir: path.join(PROJECT_ROOT, "node-red"),
    });
    require("../aiban-runtime.js")(RED);
    const NodeCtor = nodeRegistry.get("aiban-runtime").constructor;
    const node = new NodeCtor({
        name: "windows-process-acceptance",
        pythonPath: PYTHON,
        runnerPath: RUNNER_PATH,
        sdkHome: "D:/product/AiBanWorkSpace",
        pipelineConfig: "D:/product/AiBanWorkSpace/abvideo/main-flow.yaml",
        workingDirectory: PROJECT_ROOT,
        useMock: true,
        startupTimeoutMs: 10000,
        shutdownTimeoutMs: 3000,
        heartbeatIntervalMs: 1000,
        heartbeatTimeoutMs: 5000,
        restartPolicy: "never",
        maxRestartCount: 3,
        restartBackoffMs: 100,
        autoStart: false,
        strictStdout: true,
        _spawn: trackingSpawn,
    });

    let closed = false;
    try {
        node.controlRuntime("start", {
            operationId: "windows-start",
            source: "windows_acceptance",
        });
        await waitUntil(
            () => node.getRuntimeStatus().actual_state === RuntimeState.READY,
            10000,
            "first runtime_ready"
        );
        const firstPid = node.getRuntimeStatus().pid;
        const firstSession = node.getRuntimeStatus().session_id;
        assert.ok(firstPid);
        assert.ok(firstSession);

        node.controlRuntime("restart", {
            operationId: "windows-restart",
            source: "windows_acceptance",
        });
        await waitUntil(
            () => node.getRuntimeStatus().actual_state === RuntimeState.READY
                && node.getRuntimeStatus().pid !== firstPid,
            15000,
            "replacement runtime_ready"
        );

        const secondPid = node.getRuntimeStatus().pid;
        const secondSession = node.getRuntimeStatus().session_id;
        assert.notEqual(secondPid, firstPid);
        assert.notEqual(secondSession, firstSession);
        assert.equal(trackedProcesses.length, 2, "Restart should spawn exactly one replacement");
        assert.notEqual(trackedProcesses[0].exitCode, null, "Old process must have exited");
        assert.deepEqual(
            trackedProcesses.filter(child => child.exitCode === null).map(child => child.pid),
            [secondPid],
            "Only the replacement PID may remain active"
        );

        await closeNode(node, true);
        closed = true;
        await waitUntil(
            () => trackedProcesses.every(child => child.exitCode !== null),
            5000,
            "all Python children to exit"
        );
        assert.equal(node.getRuntimeStatus().pid, null);
        assert.equal(node.getRuntimeStatus().actual_state, RuntimeState.STOPPED);
    } finally {
        if (!closed) {
            for (const child of trackedProcesses) {
                if (child.exitCode === null) {
                    child.kill("SIGKILL");
                }
            }
        }
    }
});
