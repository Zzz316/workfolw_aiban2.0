"use strict";

const { EventEmitter } = require("node:events");

const RuntimeState = Object.freeze({
    STOPPED: "STOPPED",
    STARTING: "STARTING",
    READY: "READY",
    STOPPING: "STOPPING",
    ERROR: "ERROR",
    RECOVERING: "RECOVERING",
});

const DesiredState = Object.freeze({
    STOPPED: "STOPPED",
    READY: "READY",
});

class RuntimeTransitionError extends Error {
    constructor(event, fromState, allowedStates) {
        super(
            `Invalid runtime transition: event=${event} from=${fromState}`
            + ` allowed=${allowedStates.join(",")}`
        );
        this.name = "RuntimeTransitionError";
        this.code = "INVALID_RUNTIME_TRANSITION";
        this.event = event;
        this.fromState = fromState;
        this.allowedStates = [...allowedStates];
    }
}

function normalizeError(error, defaultCode, defaultMessage) {
    if (!error) {
        return Object.freeze({
            code: defaultCode,
            message: defaultMessage,
        });
    }

    if (error instanceof Error) {
        return Object.freeze({
            code: error.code || defaultCode,
            message: error.message || defaultMessage,
        });
    }

    if (typeof error === "string") {
        return Object.freeze({
            code: defaultCode,
            message: error,
        });
    }

    const normalized = {
        code: error.code || error.error_code || defaultCode,
        message: error.message || error.error || defaultMessage,
    };
    if (error.details !== undefined) {
        normalized.details = error.details;
    }
    return Object.freeze(normalized);
}

function sameValue(left, right) {
    if (left === right) {
        return true;
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    return JSON.stringify(left) === JSON.stringify(right);
}

class RuntimeController extends EventEmitter {
    constructor(options = {}) {
        super();
        this._clock = typeof options.clock === "function" ? options.clock : () => new Date();
        this._autoStart = options.autoStart === true;
        this._desiredState = this._autoStart ? DesiredState.READY : DesiredState.STOPPED;
        this._actualState = RuntimeState.STOPPED;
        this._pid = null;
        this._sessionId = null;
        this._lastError = null;
        this._lastStateAt = this._nowIso();
        this._restartCount = 0;
        this._transitionSeq = 0;
        this._lastEvent = "initialized";
    }

    get autoStart() {
        return this._autoStart;
    }

    get desiredState() {
        return this._desiredState;
    }

    get actualState() {
        return this._actualState;
    }

    get pid() {
        return this._pid;
    }

    get sessionId() {
        return this._sessionId;
    }

    get lastError() {
        return this._lastError;
    }

    get restartCount() {
        return this._restartCount;
    }

    get isReady() {
        return this._actualState === RuntimeState.READY;
    }

    get isStopping() {
        return this._actualState === RuntimeState.STOPPING;
    }

    setAutoStart(value) {
        return this._commit("auto_start_changed", {
            autoStart: value === true,
        });
    }

    requestStart(metadata = {}) {
        if (this._actualState === RuntimeState.STOPPING) {
            const change = this._commit("start_queued", {
                desiredState: DesiredState.READY,
            }, [RuntimeState.STOPPING], metadata);
            return {
                ...change,
                accepted: true,
                queued: true,
            };
        }

        if ([
            RuntimeState.STARTING,
            RuntimeState.READY,
            RuntimeState.RECOVERING,
        ].includes(this._actualState)) {
            const change = this._commit("start_requested", {
                desiredState: DesiredState.READY,
            }, [this._actualState], metadata);
            return {
                ...change,
                accepted: true,
                queued: false,
            };
        }

        const change = this._commit("start_requested", {
            desiredState: DesiredState.READY,
            actualState: RuntimeState.STARTING,
            sessionId: null,
            lastError: null,
        }, [RuntimeState.STOPPED, RuntimeState.ERROR], metadata);
        return {
            ...change,
            accepted: true,
            queued: false,
        };
    }

    spawnRequested(metadata = {}) {
        return this._commit("spawn_requested", {
            actualState: RuntimeState.STARTING,
            sessionId: null,
        }, [RuntimeState.STARTING, RuntimeState.RECOVERING], metadata);
    }

    processSpawned({ pid = null } = {}) {
        return this._commit("process_spawned", {
            pid: pid === undefined ? null : pid,
        }, [RuntimeState.STARTING]);
    }

    runtimeStarting(metadata = {}) {
        if (this._actualState === RuntimeState.STOPPED
            && this._desiredState !== DesiredState.READY) {
            throw new RuntimeTransitionError(
                "runtime_starting",
                this._actualState,
                [RuntimeState.STARTING, RuntimeState.RECOVERING]
            );
        }
        return this._commit("runtime_starting", {
            desiredState: DesiredState.READY,
            actualState: RuntimeState.STARTING,
        }, [RuntimeState.STOPPED, RuntimeState.STARTING, RuntimeState.RECOVERING], metadata);
    }

    runtimeReady({ sessionId, pid } = {}) {
        const patch = {
            desiredState: DesiredState.READY,
            actualState: RuntimeState.READY,
            lastError: null,
            restartCount: 0,
        };
        if (sessionId !== undefined && sessionId !== null) {
            patch.sessionId = sessionId;
        }
        if (pid !== undefined && pid !== null) {
            patch.pid = pid;
        }
        return this._commit(
            "runtime_ready",
            patch,
            [RuntimeState.STARTING, RuntimeState.READY]
        );
    }

    requestStop(metadata = {}) {
        if (this._actualState === RuntimeState.STOPPED) {
            return {
                ...this._commit("stop_requested", {
                    desiredState: DesiredState.STOPPED,
                }, [RuntimeState.STOPPED], metadata),
                accepted: true,
            };
        }

        if (this._actualState === RuntimeState.STOPPING) {
            return {
                ...this._commit("stop_requested", {
                    desiredState: DesiredState.STOPPED,
                }, [RuntimeState.STOPPING], metadata),
                accepted: true,
            };
        }

        if (this._actualState === RuntimeState.ERROR && this._pid === null) {
            return {
                ...this._commit("stop_requested", {
                    desiredState: DesiredState.STOPPED,
                    actualState: RuntimeState.STOPPED,
                }, [RuntimeState.ERROR], metadata),
                accepted: true,
            };
        }

        return {
            ...this._commit("stop_requested", {
                desiredState: DesiredState.STOPPED,
                actualState: RuntimeState.STOPPING,
            }, [
                RuntimeState.STARTING,
                RuntimeState.READY,
                RuntimeState.ERROR,
                RuntimeState.RECOVERING,
            ], metadata),
            accepted: true,
        };
    }

    runtimeStopping(metadata = {}) {
        return this._commit("runtime_stopping", {
            actualState: RuntimeState.STOPPING,
        }, [
            RuntimeState.STARTING,
            RuntimeState.READY,
            RuntimeState.STOPPING,
            RuntimeState.ERROR,
            RuntimeState.RECOVERING,
        ], metadata);
    }

    runtimeStopped(metadata = {}) {
        return this._commit("runtime_stopped", {
            actualState: RuntimeState.STOPPED,
        }, [
            RuntimeState.STOPPED,
            RuntimeState.STARTING,
            RuntimeState.READY,
            RuntimeState.STOPPING,
            RuntimeState.ERROR,
            RuntimeState.RECOVERING,
        ], metadata);
    }

    spawnFailed(error) {
        return this._commit("spawn_failed", {
            actualState: RuntimeState.ERROR,
            pid: null,
            lastError: normalizeError(error, "SPAWN_FAILED", "Failed to spawn runtime process"),
        }, [RuntimeState.STARTING, RuntimeState.RECOVERING]);
    }

    startupTimeout(error) {
        return this._commit("startup_timeout", {
            actualState: RuntimeState.ERROR,
            lastError: normalizeError(error, "STARTUP_TIMEOUT", "Runtime startup timed out"),
        }, [RuntimeState.STARTING]);
    }

    stopTimeout(error) {
        return this._commit("stop_timeout", {
            desiredState: DesiredState.STOPPED,
            actualState: RuntimeState.ERROR,
            lastError: normalizeError(error, "STOP_TIMEOUT", "Runtime stop timed out"),
        }, [RuntimeState.STOPPING, RuntimeState.STOPPED]);
    }

    processError(error) {
        return this._commit("process_error", {
            actualState: RuntimeState.ERROR,
            lastError: normalizeError(error, "PROCESS_ERROR", "Runtime process error"),
        }, [
            RuntimeState.STARTING,
            RuntimeState.READY,
            RuntimeState.STOPPING,
            RuntimeState.ERROR,
            RuntimeState.RECOVERING,
        ]);
    }

    heartbeatTimeout(error) {
        return this._commit("heartbeat_timeout", {
            actualState: RuntimeState.ERROR,
            lastError: normalizeError(error, "HEARTBEAT_TIMEOUT", "Runtime heartbeat lost"),
        }, [RuntimeState.READY]);
    }

    processExited({ code = null, signal = null, expected = false } = {}) {
        if (this._actualState === RuntimeState.STOPPED && this._pid === null) {
            return this._commit("process_exited", {}, [RuntimeState.STOPPED], {
                code,
                signal,
                expected: true,
            });
        }

        const shouldStop = expected
            || this._desiredState === DesiredState.STOPPED
            || this._actualState === RuntimeState.STOPPING;

        if (shouldStop) {
            return this._commit("process_exited", {
                actualState: RuntimeState.STOPPED,
                pid: null,
            }, [
                RuntimeState.STOPPED,
                RuntimeState.STARTING,
                RuntimeState.READY,
                RuntimeState.STOPPING,
                RuntimeState.ERROR,
                RuntimeState.RECOVERING,
            ], { code, signal, expected: true });
        }

        const lastError = this._lastError || normalizeError({
            code: "PROCESS_EXITED",
            message: `Runtime process exited unexpectedly: code=${code} signal=${signal}`,
            details: { code, signal },
        }, "PROCESS_EXITED", "Runtime process exited unexpectedly");
        return this._commit("process_exited", {
            actualState: RuntimeState.ERROR,
            pid: null,
            lastError,
        }, [
            RuntimeState.STARTING,
            RuntimeState.READY,
            RuntimeState.ERROR,
            RuntimeState.RECOVERING,
        ], { code, signal, expected: false });
    }

    recoveryScheduled(error) {
        return this._commit("recovery_scheduled", {
            desiredState: DesiredState.READY,
            actualState: RuntimeState.RECOVERING,
            restartCount: this._restartCount + 1,
            lastError: error
                ? normalizeError(error, "RECOVERY_SCHEDULED", "Runtime recovery scheduled")
                : this._lastError,
        }, [RuntimeState.ERROR, RuntimeState.STOPPED]);
    }

    recoveryExhausted(error) {
        return this._commit("recovery_exhausted", {
            actualState: RuntimeState.ERROR,
            lastError: normalizeError(
                error,
                "MAX_RESTARTS_REACHED",
                "Maximum runtime restart count reached"
            ),
        }, [RuntimeState.ERROR, RuntimeState.RECOVERING]);
    }

    getStatus() {
        return Object.freeze({
            autoStart: this._autoStart,
            desiredState: this._desiredState,
            actualState: this._actualState,
            pid: this._pid,
            sessionId: this._sessionId,
            lastError: this._lastError,
            lastStateAt: this._lastStateAt,
            restartCount: this._restartCount,
            transitionSeq: this._transitionSeq,
            lastEvent: this._lastEvent,
        });
    }

    serialize() {
        const status = this.getStatus();
        return Object.freeze({
            auto_start: status.autoStart,
            desired_state: status.desiredState,
            actual_state: status.actualState,
            pid: status.pid,
            session_id: status.sessionId,
            last_error: status.lastError,
            last_state_at: status.lastStateAt,
            restart_count: status.restartCount,
            transition_seq: status.transitionSeq,
            last_event: status.lastEvent,
        });
    }

    _commit(event, patch, allowedStates, metadata = {}) {
        const permitted = allowedStates || Object.values(RuntimeState);
        if (!permitted.includes(this._actualState)) {
            throw new RuntimeTransitionError(event, this._actualState, permitted);
        }

        const previous = this.getStatus();
        const nextValues = {
            autoStart: patch.autoStart !== undefined ? patch.autoStart : this._autoStart,
            desiredState: patch.desiredState !== undefined
                ? patch.desiredState
                : this._desiredState,
            actualState: patch.actualState !== undefined ? patch.actualState : this._actualState,
            pid: patch.pid !== undefined ? patch.pid : this._pid,
            sessionId: patch.sessionId !== undefined ? patch.sessionId : this._sessionId,
            lastError: patch.lastError !== undefined ? patch.lastError : this._lastError,
            restartCount: patch.restartCount !== undefined
                ? patch.restartCount
                : this._restartCount,
        };
        const changed = nextValues.autoStart !== this._autoStart
            || nextValues.desiredState !== this._desiredState
            || nextValues.actualState !== this._actualState
            || nextValues.pid !== this._pid
            || nextValues.sessionId !== this._sessionId
            || !sameValue(nextValues.lastError, this._lastError)
            || nextValues.restartCount !== this._restartCount;

        if (!changed) {
            return {
                changed: false,
                idempotent: true,
                previous,
                current: previous,
                event,
            };
        }

        this._autoStart = nextValues.autoStart;
        this._desiredState = nextValues.desiredState;
        this._actualState = nextValues.actualState;
        this._pid = nextValues.pid;
        this._sessionId = nextValues.sessionId;
        this._lastError = nextValues.lastError;
        this._restartCount = nextValues.restartCount;
        this._lastStateAt = this._nowIso();
        this._transitionSeq += 1;
        this._lastEvent = event;

        const current = this.getStatus();
        const transition = Object.freeze({
            changed: true,
            idempotent: false,
            event,
            previous,
            current,
            metadata: Object.freeze({ ...metadata }),
        });
        this.emit("stateChanged", transition);
        return transition;
    }

    _nowIso() {
        const value = this._clock();
        if (value instanceof Date) {
            return value.toISOString();
        }
        if (typeof value === "number") {
            return new Date(value).toISOString();
        }
        return new Date(value).toISOString();
    }
}

module.exports = {
    DesiredState,
    RuntimeController,
    RuntimeState,
    RuntimeTransitionError,
};
