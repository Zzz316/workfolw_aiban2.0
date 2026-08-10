#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { StabilityMetrics } = require("../node-red-contrib-aiban-workflow/lib/stability-metrics");

function argsOf(argv) {
    const args = { durationSeconds: 24 * 3600, healthIntervalSeconds: 10, mock: false };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (key === "--mock") args.mock = true;
        else if (key === "--duration-seconds") args.durationSeconds = Number(argv[++i]);
        else if (key === "--duration-hours") args.durationSeconds = Number(argv[++i]) * 3600;
        else if (key === "--health-interval-seconds") args.healthIntervalSeconds = Number(argv[++i]);
        else if (key === "--python") args.python = argv[++i];
        else if (key === "--sdk-home") args.sdkHome = argv[++i];
        else if (key === "--pipeline-config") args.pipelineConfig = argv[++i];
        else if (key === "--working-directory") args.workingDirectory = argv[++i];
        else if (key === "--output") args.output = argv[++i];
    }
    if (!args.output) throw new Error("--output is required");
    if (!args.mock && (!args.sdkHome || !args.pipelineConfig)) {
        throw new Error("real mode requires --sdk-home and --pipeline-config (or pass --mock)");
    }
    return args;
}

function waitFor(predicate, state, timeoutMs) {
    if (predicate(state.events)) return Promise.resolve(predicate(state.events));
    return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject };
        state.waiters.add(waiter);
        waiter.timer = setTimeout(() => {
            state.waiters.delete(waiter);
            reject(new Error(`timeout after ${timeoutMs}ms`));
        }, timeoutMs);
    });
}

function notify(state) {
    for (const waiter of [...state.waiters]) {
        const result = waiter.predicate(state.events);
        if (!result) continue;
        clearTimeout(waiter.timer);
        state.waiters.delete(waiter);
        waiter.resolve(result);
    }
}

function send(child, command, params = {}) {
    const requestId = randomUUID();
    child.stdin.write(JSON.stringify({
        schema_version: 1, command, request_id: requestId, params,
    }) + "\n");
    return requestId;
}

async function main() {
    const options = argsOf(process.argv.slice(2));
    const root = path.resolve(__dirname, "..");
    const runner = path.join(root, "python_runtime", "aiban_runner.py");
    const python = options.python || (process.platform === "win32" && fs.existsSync("D:/my_env/python.exe")
        ? "D:/my_env/python.exe" : "python");
    const childArgs = ["-u", runner, "--heartbeat-interval", "3"];
    if (options.mock) childArgs.push("--mock", "--num-groups", "1", "--num-sources", "2", "--labels", "A,B,C");
    else childArgs.push("--sdk-home", options.sdkHome, "--pipeline-config", options.pipelineConfig,
        "--working-directory", options.workingDirectory || options.sdkHome);
    const cwd = options.workingDirectory || root;
    const child = spawn(python, childArgs, {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    });
    const metrics = new StabilityMetrics();
    const state = { events: [], waiters: new Set(), stderr: [] };
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
        try {
            const event = JSON.parse(line);
            state.events.push(event);
            if (state.events.length > 10000) state.events.splice(0, 5000);
            metrics.recordRuntimeEvent(event);
            notify(state);
        } catch (_) { /* protocol errors surface through missing health/ready */ }
    });
    child.stderr.on("data", chunk => {
        state.stderr.push(chunk.toString("utf8"));
        if (state.stderr.length > 200) state.stderr.shift();
    });

    let healthTimer;
    let failure = null;
    try {
        send(child, "start");
        await waitFor(events => events.find(event => event.type === "runtime_ready"), state, 60000);
        healthTimer = setInterval(() => send(child, "health"),
            Math.max(1, options.healthIntervalSeconds) * 1000);
        await new Promise(resolve => setTimeout(resolve, options.durationSeconds * 1000));
        send(child, "health");
        await new Promise(resolve => setTimeout(resolve, 250));
        send(child, "stop");
        await waitFor(events => events.find(event => event.type === "runtime_stopped"), state, 30000);
        await new Promise(resolve => child.exitCode !== null ? resolve()
            : child.once("exit", resolve));
    } catch (error) {
        failure = error;
        if (child.exitCode === null) child.kill();
    } finally {
        if (healthTimer) clearInterval(healthTimer);
    }

    const report = metrics.report({ expectedStops: failure ? 0 : 1 });
    report.environment = {
        mode: options.mock ? "mock" : "real",
        duration_seconds_requested: options.durationSeconds,
        python,
        sdk_home: options.mock ? null : options.sdkHome,
        pipeline_config: options.mock ? null : options.pipelineConfig,
    };
    report.failure = failure ? failure.message : null;
    report.stderr_tail = state.stderr.join("").split(/\r?\n/).filter(Boolean).slice(-100);
    report.external_scenarios = {
        node_red_deploy: "run现场步骤并附 Node-RED operation_id",
        mysql_disconnect_recovery: "run T17 real-MySQL fault injection",
        scene_fast_switch: "run Registry/Router现场切换",
        screenshot_timeout: "disconnect target source and request screenshot",
    };
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, JSON.stringify(report, null, 2), "utf8");
    process.exitCode = failure || !report.pass ? 1 : 0;
}

main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
