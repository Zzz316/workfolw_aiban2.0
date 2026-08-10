"use strict";

const runtime = require("./flow-runtime");

/**
 * Public boundary for the simple linear sequence engine.
 *
 * `FlowRuntime` remains exported from `flow-runtime.js` for older callers.
 * New code should import `SequenceRuntime` from this module to make the
 * T06 ownership boundary explicit: the engine consumes normalized recognition
 * facts plus a state-store interface, and it returns transitions/outcomes.
 */
class SequenceRuntime extends runtime.FlowRuntime {}

module.exports = {
    ...runtime,
    SequenceRuntime,
    FlowRuntime: SequenceRuntime,
};
