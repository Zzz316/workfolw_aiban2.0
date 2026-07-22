"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const {
    DesiredState,
    RuntimeController,
    RuntimeState,
    RuntimeTransitionError,
} = require("../lib/runtime-controller");

function createController(options = {}) {
    let tick = 0;
    return new RuntimeController({
        clock: () => new Date(Date.UTC(2026, 6, 22, 0, 0, tick++)),
        ...options,
    });
}

function startAndSpawn(controller, pid = 1234) {
    controller.requestStart({ source: "test" });
    controller.spawnRequested({ source: "test" });
    controller.processSpawned({ pid });
}

describe("RuntimeController", () => {
    test("starts with separate policy, desired and actual state", () => {
        const manual = createController({ autoStart: false });
        assert.equal(manual.autoStart, false);
        assert.equal(manual.desiredState, DesiredState.STOPPED);
        assert.equal(manual.actualState, RuntimeState.STOPPED);

        const automatic = createController({ autoStart: true });
        assert.equal(automatic.autoStart, true);
        assert.equal(automatic.desiredState, DesiredState.READY);
        assert.equal(automatic.actualState, RuntimeState.STOPPED);
    });

    test("spawn success remains STARTING until runtime_ready", () => {
        const controller = createController();
        startAndSpawn(controller, 4321);

        assert.equal(controller.actualState, RuntimeState.STARTING);
        assert.equal(controller.pid, 4321);
        assert.equal(controller.isReady, false);

        controller.runtimeReady({ sessionId: "session-1" });
        assert.equal(controller.actualState, RuntimeState.READY);
        assert.equal(controller.sessionId, "session-1");
        assert.equal(controller.isReady, true);
    });

    test("manual start works while autoStart remains false", () => {
        const controller = createController({ autoStart: false });
        controller.requestStart({ source: "manual" });

        assert.equal(controller.autoStart, false);
        assert.equal(controller.desiredState, DesiredState.READY);
        assert.equal(controller.actualState, RuntimeState.STARTING);
    });

    test("duplicate start and stop requests are idempotent", () => {
        const controller = createController();
        controller.requestStart();
        const startSeq = controller.getStatus().transitionSeq;
        const duplicateStart = controller.requestStart();
        assert.equal(duplicateStart.idempotent, true);
        assert.equal(controller.getStatus().transitionSeq, startSeq);

        controller.processSpawned({ pid: 55 });
        controller.runtimeReady({ sessionId: "s" });
        controller.requestStop();
        const stopSeq = controller.getStatus().transitionSeq;
        const duplicateStop = controller.requestStop();
        assert.equal(duplicateStop.idempotent, true);
        assert.equal(controller.getStatus().transitionSeq, stopSeq);
    });

    test("stop during STARTING enters STOPPING and completes cleanly", () => {
        const controller = createController();
        startAndSpawn(controller);
        controller.requestStop({ source: "manual" });

        assert.equal(controller.desiredState, DesiredState.STOPPED);
        assert.equal(controller.actualState, RuntimeState.STOPPING);

        controller.processExited({ code: 0, expected: true });
        assert.equal(controller.actualState, RuntimeState.STOPPED);
        assert.equal(controller.pid, null);
    });

    test("start during STOPPING is queued without faking READY", () => {
        const controller = createController();
        startAndSpawn(controller);
        controller.runtimeReady({ sessionId: "old-session" });
        controller.requestStop();

        const queued = controller.requestStart({ source: "manual" });
        assert.equal(queued.queued, true);
        assert.equal(controller.desiredState, DesiredState.READY);
        assert.equal(controller.actualState, RuntimeState.STOPPING);

        controller.processExited({ code: 0, expected: true });
        controller.requestStart({ source: "queued" });
        assert.equal(controller.actualState, RuntimeState.STARTING);
    });

    test("spawn failure enters ERROR and records the failure", () => {
        const controller = createController();
        controller.requestStart();
        controller.spawnFailed(Object.assign(new Error("python missing"), { code: "ENOENT" }));

        assert.equal(controller.actualState, RuntimeState.ERROR);
        assert.equal(controller.pid, null);
        assert.deepEqual(controller.lastError, {
            code: "ENOENT",
            message: "python missing",
        });
    });

    test("startup timeout enters ERROR and keeps PID for forced cleanup", () => {
        const controller = createController();
        startAndSpawn(controller, 9876);
        controller.startupTimeout();

        assert.equal(controller.actualState, RuntimeState.ERROR);
        assert.equal(controller.pid, 9876);
        assert.equal(controller.lastError.code, "STARTUP_TIMEOUT");
    });

    test("stop timeout enters ERROR with STOPPED as desired state", () => {
        const controller = createController();
        startAndSpawn(controller);
        controller.runtimeReady({ sessionId: "session" });
        controller.requestStop();
        controller.stopTimeout();

        assert.equal(controller.actualState, RuntimeState.ERROR);
        assert.equal(controller.desiredState, DesiredState.STOPPED);
        assert.equal(controller.lastError.code, "STOP_TIMEOUT");
    });

    test("runtime_stopped keeps PID until the child process actually exits", () => {
        const controller = createController();
        startAndSpawn(controller, 6789);
        controller.runtimeReady({ sessionId: "session" });
        controller.requestStop();
        controller.runtimeStopped();

        assert.equal(controller.actualState, RuntimeState.STOPPED);
        assert.equal(controller.pid, 6789);

        controller.processExited({ code: 0, expected: true });
        assert.equal(controller.pid, null);
    });

    test("unexpected process exit enters ERROR", () => {
        const controller = createController();
        startAndSpawn(controller);
        controller.runtimeReady({ sessionId: "session" });
        controller.processExited({ code: 7, signal: null });

        assert.equal(controller.actualState, RuntimeState.ERROR);
        assert.equal(controller.pid, null);
        assert.equal(controller.lastError.code, "PROCESS_EXITED");
        assert.match(controller.lastError.message, /code=7/);
    });

    test("recovery uses RECOVERING and increments restart count", () => {
        const controller = createController();
        startAndSpawn(controller);
        controller.processExited({ code: 1 });
        controller.recoveryScheduled();

        assert.equal(controller.actualState, RuntimeState.RECOVERING);
        assert.equal(controller.restartCount, 1);

        controller.spawnRequested();
        assert.equal(controller.actualState, RuntimeState.STARTING);
        controller.processSpawned({ pid: 2222 });
        controller.runtimeReady({ sessionId: "recovered" });
        assert.equal(controller.actualState, RuntimeState.READY);
        assert.equal(controller.restartCount, 0);
    });

    test("heartbeat loss is a named ERROR transition", () => {
        const controller = createController();
        startAndSpawn(controller);
        controller.runtimeReady({ sessionId: "session" });
        controller.heartbeatTimeout();

        assert.equal(controller.actualState, RuntimeState.ERROR);
        assert.equal(controller.lastError.code, "HEARTBEAT_TIMEOUT");
    });

    test("runtime_ready from STOPPED is rejected as an illegal transition", () => {
        const controller = createController();
        assert.throws(
            () => controller.runtimeReady({ sessionId: "invalid" }),
            (error) => error instanceof RuntimeTransitionError
                && error.code === "INVALID_RUNTIME_TRANSITION"
        );
    });

    test("every material change emits an explicit stateChanged event", () => {
        const controller = createController();
        const events = [];
        controller.on("stateChanged", (transition) => events.push(transition));

        controller.requestStart({ operationId: "op-1" });
        controller.processSpawned({ pid: 12 });
        controller.runtimeReady({ sessionId: "session" });

        assert.deepEqual(events.map((item) => item.event), [
            "start_requested",
            "process_spawned",
            "runtime_ready",
        ]);
        assert.equal(events[0].metadata.operationId, "op-1");
        assert.equal(events[2].current.actualState, RuntimeState.READY);
    });

    test("serialized status is read-only and protocol-friendly", () => {
        const controller = createController({ autoStart: false });
        startAndSpawn(controller, 1010);
        const status = controller.serialize();

        assert.equal(status.auto_start, false);
        assert.equal(status.desired_state, DesiredState.READY);
        assert.equal(status.actual_state, RuntimeState.STARTING);
        assert.equal(status.pid, 1010);
        assert.ok(status.last_state_at);
        assert.equal(Object.isFrozen(status), true);
    });
});
