"use strict";

/**
 * Phase 2 Closed-Loop Tests — Topology-Driven Architecture
 *
 * Tests the FlowRuntime engine, WorkflowStateStore, WorkflowAuditLogger,
 * TopologyCompiler validation, and MysqlWriteQueue with the new
 * topology-driven architecture.
 *
 * Run: node --test test/phase2-closed-loop.test.js
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { describe, test, before, after, beforeEach } = require("node:test");

const { FlowRuntime, TopologyCompiler, makeStateKey, makeEventId, makeStreamId } = require("../lib/flow-runtime");
const { WorkflowStateStore } = require("../lib/workflow-state-store");
const { WorkflowAuditLogger } = require("../lib/workflow-audit");
const { MysqlWriteQueue } = require("../lib/mysql-write-queue");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir() {
    const dir = path.join(os.tmpdir(), `aiban-phase2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function safeCleanup(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ok */ }
}

function makeFrame(overrides = {}) {
    const d = {
        session_id: "test-session",
        group_id: 1,
        source_id: 1,
        event_seq: 100,
        event_id: "evt-100",
        label_matches: [],
        ...overrides,
    };
    return {
        payload: {
            // New field names (primary)
            event_id: d.event_id,
            event_seq: d.event_seq,
            // Backward compat
            event_id: d.event_id,
            event_seq: d.event_seq,
            // Identity
            session_id: d.session_id,
            stream_id: `group-${d.group_id}/source-${d.source_id}`,
            group_id: d.group_id,
            source_id: d.source_id,
            // Models (new format from aiban-runtime)
            models: {},
            // Legacy (no longer populated by aiban-runtime, kept for compat)
            labels: [],
            label_summary: "",
        },
        aiban: {
            // New field names (primary)
            event_id: d.event_id,
            event_seq: d.event_seq,
            // Backward compat
            event_id: d.event_id,
            event_seq: d.event_seq,
            // Identity
            session_id: d.session_id,
            stream_id: `group-${d.group_id}/source-${d.source_id}`,
            group_id: d.group_id,
            source_id: d.source_id,
            // Label matches from aiban-label nodes
            label_matches: d.label_matches,
        },
        workflow: { workflow_id: "abc-demo" },
    };
}

function makeLabelMatches(matchedIds, topology) {
    return topology.map((lbl) => ({
        node_id: `node-${lbl.labelId}`,
        label_id: lbl.labelId,
        model_id: lbl.modelId,
        label: lbl.label,
        confidence_min: lbl.confidenceMin,
        matched: matchedIds.includes(lbl.labelId),
        confidence: matchedIds.includes(lbl.labelId) ? 0.9 : null,
        match_duration_ms: 0.03,
    }));
}

const ABC_TOPOLOGY = [
    { labelId: "A", modelId: "1", label: "A", confidenceMin: 0.5 },
    { labelId: "B", modelId: "1", label: "B", confidenceMin: 0.5 },
    { labelId: "C", modelId: "1", label: "C", confidenceMin: 0.5 },
];

const ACB_TOPOLOGY = [
    { labelId: "A", modelId: "1", label: "A", confidenceMin: 0.5 },
    { labelId: "C", modelId: "1", label: "C", confidenceMin: 0.5 },
    { labelId: "B", modelId: "1", label: "B", confidenceMin: 0.5 },
];

const ABDC_TOPOLOGY = [
    { labelId: "A", modelId: "1", label: "A", confidenceMin: 0.5 },
    { labelId: "B", modelId: "1", label: "B", confidenceMin: 0.5 },
    { labelId: "D", modelId: "1", label: "D", confidenceMin: 0.5 },
    { labelId: "C", modelId: "1", label: "C", confidenceMin: 0.5 },
];

function createRuntime(topology, opts = {}) {
    const dir = tempDir();
    const stateDb = path.join(dir, "state.db");
    const auditDir = path.join(dir, "logs", "workflow");
    const store = new WorkflowStateStore(stateDb);
    const audit = new WorkflowAuditLogger(auditDir, "test-run");
    const runtime = new FlowRuntime({
        topology,
        stateStore: store,
        auditLogger: audit,
        workflowId: opts.workflowId || "abc-demo",
        cycleTimeoutMs: opts.cycleTimeoutMs || 1000,
        allowSameFrameRestart: opts.allowSameFrameRestart || false,
    });
    return { runtime, store, audit, dir };
}

// ---------------------------------------------------------------------------
// TopologyCompiler Validation
// ---------------------------------------------------------------------------

describe("TopologyCompiler (static validation)", () => {
    test("valid topology passes", () => {
        const r = TopologyCompiler.validate(ABC_TOPOLOGY);
        assert.equal(r.valid, true);
        assert.equal(r.errors.length, 0);
    });

    test("empty topology fails", () => {
        const r = TopologyCompiler.validate([]);
        assert.equal(r.valid, false);
        assert.ok(r.errors[0].includes("至少需要一个"));
    });

    test("duplicate label_ids fail", () => {
        const r = TopologyCompiler.validate([
            { labelId: "A", modelId: "1", label: "A", confidenceMin: 0.5 },
            { labelId: "A", modelId: "1", label: "A", confidenceMin: 0.5 },
        ]);
        assert.equal(r.valid, false);
        assert.ok(r.errors.some((e) => e.includes("重复")));
    });

    test("4-label and 5-label topologies pass", () => {
        assert.equal(TopologyCompiler.validate(ABDC_TOPOLOGY).valid, true);
        assert.equal(TopologyCompiler.validate([
            { labelId: "A", modelId: "1", label: "A", confidenceMin: 0.5 },
            { labelId: "B", modelId: "1", label: "B", confidenceMin: 0.5 },
            { labelId: "C", modelId: "1", label: "C", confidenceMin: 0.5 },
            { labelId: "D", modelId: "1", label: "D", confidenceMin: 0.5 },
            { labelId: "E", modelId: "1", label: "E", confidenceMin: 0.5 },
        ]).valid, true);
    });
});

// ---------------------------------------------------------------------------
// Scenario 1: A→B→C → OK
// ---------------------------------------------------------------------------

describe("Scenario 1: A→B→C → OK", () => {
    let ctx;
    beforeEach(() => { ctx = createRuntime(ABC_TOPOLOGY, { cycleTimeoutMs: 5000 }); });

    test("complete sequence produces OK", () => {
        const { runtime, store } = ctx;
        const key = makeStateKey("abc-demo", "test-session", 1, 1);

        let events = runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1000);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "transition");
        assert.equal(events[0].labelId, "A");
        assert.equal(store.getState(key).step_index, 1);

        events = runtime.process(makeFrame({
            event_seq: 101, event_id: "msg-101",
            label_matches: makeLabelMatches(["B"], ABC_TOPOLOGY),
        }), 1100);
        assert.equal(events.length, 1);
        assert.equal(events[0].labelId, "B");
        assert.equal(store.getState(key).step_index, 2);

        events = runtime.process(makeFrame({
            event_seq: 102, event_id: "msg-102",
            label_matches: makeLabelMatches(["C"], ABC_TOPOLOGY),
        }), 1200);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "terminal");
        assert.equal(events[0].result.result_status, "OK");
        assert.equal(events[0].result.cycle_duration_ms, 200);
        assert.equal(store.getState(key).step_index, 0);
    });

    after(() => { if (ctx) { ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir); } });
});

// ---------------------------------------------------------------------------
// Scenario 2: B→A→C → NG (B first ignored, then A→C skip B)
// ---------------------------------------------------------------------------

describe("Scenario 2: B first → NG", () => {
    let ctx;
    beforeEach(() => { ctx = createRuntime(ABC_TOPOLOGY); });

    test("B ignored when IDLE, then A→C (skip B) → NG", () => {
        const { runtime } = ctx;

        // B first — ignored (IDLE expects A)
        let events = runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["B"], ABC_TOPOLOGY),
        }), 1000);
        assert.equal(events.length, 0, "B ignored at IDLE");

        // A starts cycle
        runtime.process(makeFrame({
            event_seq: 101, event_id: "msg-101",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 2000);

        // C before B → NG
        events = runtime.process(makeFrame({
            event_seq: 102, event_id: "msg-102",
            label_matches: makeLabelMatches(["C"], ABC_TOPOLOGY),
        }), 3000);
        assert.equal(events[0].type, "terminal");
        assert.equal(events[0].result.result_status, "NG");
        assert.ok(events[0].result.failure_reason.includes("跳步"));
    });

    after(() => { if (ctx) { ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir); } });
});

// ---------------------------------------------------------------------------
// Scenario 3: A→C (skip B) → NG
// ---------------------------------------------------------------------------

describe("Scenario 3: A→C skip B → NG", () => {
    let ctx;
    beforeEach(() => { ctx = createRuntime(ABC_TOPOLOGY); });

    test("skipping B produces NG with clear reason", () => {
        const { runtime } = ctx;
        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1000);

        const events = runtime.process(makeFrame({
            event_seq: 101, event_id: "msg-101",
            label_matches: makeLabelMatches(["C"], ABC_TOPOLOGY),
        }), 2000);
        assert.equal(events[0].type, "terminal");
        assert.equal(events[0].result.result_status, "NG");
        assert.ok(events[0].result.failure_reason.includes("跳步"));
        assert.ok(events[0].result.failure_reason.includes("C"));
    });

    after(() => { if (ctx) { ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir); } });
});

// ---------------------------------------------------------------------------
// Scenario 4: A→B then timeout → TIMEOUT
// ---------------------------------------------------------------------------

describe("Scenario 4: Timeout → TIMEOUT", () => {
    test("A→B then timeout produces TIMEOUT", () => {
        const ctx = createRuntime(ABC_TOPOLOGY, { cycleTimeoutMs: 300 });
        const { runtime } = ctx;

        // Start cycle
        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1000);

        // B arrives quickly (100ms later)
        runtime.process(makeFrame({
            event_seq: 101, event_id: "msg-101",
            label_matches: makeLabelMatches(["B"], ABC_TOPOLOGY),
        }), 1100);

        // Next frame arrives well after timeout (500ms later = 600ms elapsed > 300ms timeout)
        const events = runtime.process(makeFrame({
            event_seq: 102, event_id: "msg-102",
            label_matches: makeLabelMatches([], ABC_TOPOLOGY),
        }), 1700);
        assert.equal(events.length, 1, "Should get 1 TIMEOUT event");
        assert.equal(events[0].type, "terminal");
        assert.equal(events[0].result.result_status, "TIMEOUT");

        ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir);
    });
});

// ---------------------------------------------------------------------------
// Scenario 5: Same label repeat → NG (乱序)
// ---------------------------------------------------------------------------

describe("Scenario 5: Same label repeat → NG", () => {
    let ctx;
    beforeEach(() => { ctx = createRuntime(ABC_TOPOLOGY); });

    test("A again in WAIT_B produces NG", () => {
        const { runtime } = ctx;
        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1000);

        const events = runtime.process(makeFrame({
            event_seq: 101, event_id: "msg-101",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1100);
        assert.equal(events[0].type, "terminal");
        assert.equal(events[0].result.result_status, "NG");
        assert.ok(events[0].result.failure_reason.includes("乱序"));
    });

    after(() => { if (ctx) { ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir); } });
});

// ---------------------------------------------------------------------------
// Scenario 6: message_id replay dedup
// ---------------------------------------------------------------------------

describe("Scenario 6: message_id replay dedup", () => {
    let ctx;
    beforeEach(() => { ctx = createRuntime(ABC_TOPOLOGY); });

    test("replay does not duplicate", () => {
        const { runtime } = ctx;
        const frame = makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        });
        let events = runtime.process(frame, 1000);
        assert.equal(events.length, 1);
        events = runtime.process(frame, 1000);
        assert.equal(events.length, 0, "Replay dedup");
    });

    after(() => { if (ctx) { ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir); } });
});

// ---------------------------------------------------------------------------
// Scenario 7: Parallel source isolation
// ---------------------------------------------------------------------------

describe("Scenario 7: Source isolation", () => {
    let ctx;
    beforeEach(() => { ctx = createRuntime(ABC_TOPOLOGY); });

    test("two sources progress independently", () => {
        const { runtime, store } = ctx;
        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-s1-100", source_id: 1,
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1000);
        runtime.process(makeFrame({
            event_seq: 50, event_id: "msg-s2-50", source_id: 2,
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1000);

        const s1 = store.getState(makeStateKey("abc-demo", "test-session", 1, 1));
        const s2 = store.getState(makeStateKey("abc-demo", "test-session", 1, 2));
        assert.equal(s1.step_index, 1);
        assert.equal(s2.step_index, 1);
        assert.notEqual(s1.cycle_id, s2.cycle_id);
    });

    after(() => { if (ctx) { ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir); } });
});

// ---------------------------------------------------------------------------
// Scenario 8: Session isolation
// ---------------------------------------------------------------------------

describe("Scenario 8: Session isolation", () => {
    let ctx;
    beforeEach(() => { ctx = createRuntime(ABC_TOPOLOGY); });

    test("different sessions isolated", () => {
        const { runtime, store } = ctx;
        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-s1-100", session_id: "session-1",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1000);
        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-s2-100", session_id: "session-2",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1000);

        assert.equal(store.getState(makeStateKey("abc-demo", "session-1", 1, 1)).step_index, 1);
        assert.equal(store.getState(makeStateKey("abc-demo", "session-2", 1, 1)).step_index, 1);
    });

    after(() => { if (ctx) { ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir); } });
});

// ---------------------------------------------------------------------------
// Scenario 9: MysqlWriteQueue stats
// ---------------------------------------------------------------------------

describe("Scenario 9: MysqlWriteQueue stats", () => {
    test("queue initializes correctly", () => {
        const wq = new MysqlWriteQueue({
            host: "127.0.0.1", port: 3306, user: "root", password: "",
            database: "icamera_data", maxRetries: 3, retryDelayMs: 500, queueSize: 100,
        });
        const s = wq.stats();
        assert.equal(s.enqueued, 0);
        assert.equal(s.succeeded, 0);
        assert.equal(s.failed, 0);
        assert.equal(s.pending, 0);
        wq.close();
    });
});

// ---------------------------------------------------------------------------
// Scenario 10: Queue overflow
// ---------------------------------------------------------------------------

describe("Scenario 10: Queue overflow protection", () => {
    test("overflow writes to fallback", () => {
        const dir = tempDir();
        try {
            const wq = new MysqlWriteQueue({
                host: process.env.MYSQL_HOST || "127.0.0.1",
                port: Number(process.env.MYSQL_PORT) || 3306,
                user: process.env.MYSQL_USER || "root",
                password: process.env.MYSQL_PASSWD || "",
                database: process.env.MYSQL_DB || "icamera_data",
                maxRetries: 1, retryDelayMs: 100, queueSize: 3,
            });
            for (let i = 0; i < 8; i++) {
                wq.enqueue({
                    event_id: `test-event-${i}`, cycle_id: `cyc-${i}`,
                    workflow_id: "test", session_id: "s1", stream_id: "group-1/source-1",
                    group_id: 1, source_id: 1, result_status: "OK",
                    start_frame_seq: i * 10, end_frame_seq: i * 10 + 5,
                    actual_sequence: '["A","B","C"]', failure_reason: null,
                    started_at: "2026-07-02T08:00:00.000+08:00",
                    finished_at: "2026-07-02T08:00:05.000+08:00",
                    cycle_duration_ms: 5000, db_write_duration_ms: null,
                    created_at: "2026-07-02T08:00:05.000+08:00",
                });
            }
            const s = wq.stats();
            assert.ok(s.enqueued + s.failed >= 8,
                `enqueued=${s.enqueued} + failed=${s.failed} should be >= 8`);
            wq.close();
        } finally { safeCleanup(dir); }
    });
});

// ---------------------------------------------------------------------------
// Scenario 11: Recovery → INTERRUPTED
// ---------------------------------------------------------------------------

describe("Scenario 11: Recovery marks expired INTERRUPTED", () => {
    test("expired active → INTERRUPTED", () => {
        const ctx = createRuntime(ABC_TOPOLOGY, { cycleTimeoutMs: 500 });
        const { runtime, store } = ctx;
        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1000);
        assert.equal(store.listActive().length, 1);

        const results = runtime.recover(5000);
        assert.equal(results.length, 1);
        assert.equal(results[0].result.result_status, "INTERRUPTED");
        assert.equal(store.listActive().length, 0);

        ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir);
    });
});

// ---------------------------------------------------------------------------
// Scenario 12: Audit completeness
// ---------------------------------------------------------------------------

describe("Scenario 12: Audit log/JSONL/CSV completeness", () => {
    test("audit generates all three files with correct content", async () => {
        const dir = tempDir();
        try {
            const auditDir = path.join(dir, "logs", "workflow");
            const audit = new WorkflowAuditLogger(auditDir, "test-run-001");

            audit.record("frame_received", {
                event_id: "audit-msg-1", event_seq: 100,
                group_id: 1, source_id: 1, session_id: "s1", stream_id: "group-1/source-1",
                label_summary: "A(0.900)",
            });
            audit.record("sequence_transition", {
                cycle_id: "cyc-001", previous_state: "IDLE", current_state: "WAIT_B",
                recognized_step: "A", stage_duration_ms: 0.08, workflow_id: "abc-demo",
                event_id: "audit-msg-1", event_seq: 100,
                group_id: 1, source_id: 1, session_id: "s1", stream_id: "group-1/source-1",
            });
            audit.record("sequence_completed", {
                cycle_id: "cyc-001", result_status: "OK", cycle_duration_ms: 5000,
                actual_sequence: '["A","B","C"]', total_processing_ms: 4.25,
                workflow_id: "abc-demo", event_id: "audit-msg-3",
                event_id: "abc-demo:s1:group-1/source-1:cyc-001:OK",
                event_seq: 102, group_id: 1, source_id: 1, session_id: "s1", stream_id: "group-1/source-1",
            });
            audit.recordCycleSummary({
                cycle_id: "cyc-001", workflow_id: "abc-demo", stream_id: "group-1/source-1",
                start_frame_seq: 100, end_frame_seq: 102,
                step_A_frame: 100, step_A_at: "2026-07-02T08:00:00.000+08:00",
                step_B_frame: 101, step_B_at: "2026-07-02T08:00:02.000+08:00",
                step_C_frame: 102, step_C_at: "2026-07-02T08:00:05.000+08:00",
                sequence_duration_ms: 0.08, total_processing_ms: 4.25,
                cycle_duration_ms: 5000, result_status: "OK", failure_reason: "",
            });

            await audit.close();

            assert.ok(fs.existsSync(audit.filePaths.text));
            assert.ok(fs.existsSync(audit.filePaths.jsonl));
            assert.ok(fs.existsSync(audit.filePaths.csv));

            const textContent = fs.readFileSync(audit.filePaths.text, "utf8");
            assert.ok(textContent.includes("frame_received"));
            assert.ok(textContent.includes("WAIT_B"));
            assert.ok(textContent.includes("OK"));

            const jsonlLines = fs.readFileSync(audit.filePaths.jsonl, "utf8").trim().split("\n");
            assert.ok(jsonlLines.length >= 3);
            for (const line of jsonlLines) {
                const obj = JSON.parse(line);
                assert.ok(obj.event);
                assert.ok(obj.audit_at);
            }

            const csv = fs.readFileSync(audit.filePaths.csv, "utf8");
            assert.ok(csv.includes("cycle_id"));
            assert.ok(csv.includes("cyc-001"));
        } finally { safeCleanup(dir); }
    });
});

// ---------------------------------------------------------------------------
// Scenario 13: Rewire A→C→B
// ---------------------------------------------------------------------------

describe("Scenario 13: Topology change A→C→B", () => {
    test("A→C→B expects C before B", () => {
        const ctx = createRuntime(ACB_TOPOLOGY, { cycleTimeoutMs: 5000 });
        const { runtime } = ctx;

        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ACB_TOPOLOGY),
        }), 1000);

        // B before C → NG in ACB topology
        const events = runtime.process(makeFrame({
            event_seq: 101, event_id: "msg-101",
            label_matches: makeLabelMatches(["B"], ACB_TOPOLOGY),
        }), 1100);
        assert.equal(events[0].type, "terminal");
        assert.equal(events[0].result.result_status, "NG");
        assert.ok(events[0].result.failure_reason.includes("跳步"));

        ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir);
    });

    test("A→C→B correct order → OK", () => {
        const ctx = createRuntime(ACB_TOPOLOGY, { cycleTimeoutMs: 5000 });
        const { runtime } = ctx;

        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ACB_TOPOLOGY),
        }), 1000);
        runtime.process(makeFrame({
            event_seq: 101, event_id: "msg-101",
            label_matches: makeLabelMatches(["C"], ACB_TOPOLOGY),
        }), 1100);

        const events = runtime.process(makeFrame({
            event_seq: 102, event_id: "msg-102",
            label_matches: makeLabelMatches(["B"], ACB_TOPOLOGY),
        }), 1200);
        assert.equal(events[0].type, "terminal");
        assert.equal(events[0].result.result_status, "OK");

        ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir);
    });
});

// ---------------------------------------------------------------------------
// Scenario 14: Insert D → A→B→D→C
// ---------------------------------------------------------------------------

describe("Scenario 14: 4-label topology A→B→D→C", () => {
    test("A→B→D→C completes in order", () => {
        const ctx = createRuntime(ABDC_TOPOLOGY, { cycleTimeoutMs: 5000 });
        const { runtime, store } = ctx;
        const key = makeStateKey("abc-demo", "test-session", 1, 1);

        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ABDC_TOPOLOGY),
        }), 1000);
        assert.equal(store.getState(key).step_index, 1);

        runtime.process(makeFrame({
            event_seq: 101, event_id: "msg-101",
            label_matches: makeLabelMatches(["B"], ABDC_TOPOLOGY),
        }), 1100);
        assert.equal(store.getState(key).step_index, 2);

        runtime.process(makeFrame({
            event_seq: 102, event_id: "msg-102",
            label_matches: makeLabelMatches(["D"], ABDC_TOPOLOGY),
        }), 1200);
        assert.equal(store.getState(key).step_index, 3);

        const events = runtime.process(makeFrame({
            event_seq: 103, event_id: "msg-103",
            label_matches: makeLabelMatches(["C"], ABDC_TOPOLOGY),
        }), 1300);
        assert.equal(events[0].type, "terminal");
        assert.equal(events[0].result.result_status, "OK");

        ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir);
    });

    test("skip D → NG", () => {
        const ctx = createRuntime(ABDC_TOPOLOGY, { cycleTimeoutMs: 5000 });
        const { runtime } = ctx;

        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ABDC_TOPOLOGY),
        }), 1000);
        runtime.process(makeFrame({
            event_seq: 101, event_id: "msg-101",
            label_matches: makeLabelMatches(["B"], ABDC_TOPOLOGY),
        }), 1100);

        const events = runtime.process(makeFrame({
            event_seq: 102, event_id: "msg-102",
            label_matches: makeLabelMatches(["C"], ABDC_TOPOLOGY),
        }), 1200);
        assert.equal(events[0].result.result_status, "NG");
        assert.ok(events[0].result.failure_reason.includes("跳步"));

        ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir);
    });
});

// ---------------------------------------------------------------------------
// WorkflowStateStore V2 CRUD
// ---------------------------------------------------------------------------

describe("WorkflowStateStore V2 CRUD", () => {
    test("save, get, reset, list, counts", () => {
        const dir = tempDir();
        try {
            const store = new WorkflowStateStore(path.join(dir, "state.db"));
            const key = makeStateKey("wf1", "sess1", 1, 1);

            assert.equal(store.getState(key), null);

            store.saveState(key, {
                workflow_id: "wf1", session_id: "sess1", group_id: 1, source_id: 1,
                step_index: 1, total_steps: 3, cycle_id: "cyc-1",
                cycle_started_at_ms: 1000, start_frame_seq: 100,
                last_frame_seq: 100, last_message_id: "msg-1",
                steps_data: JSON.stringify({ A: { event_seq: 100, at_ms: 1000 } }),
                actual_sequence: JSON.stringify(["A"]),
            });

            let state = store.getState(key);
            assert.equal(state.step_index, 1);
            assert.equal(state.total_steps, 3);
            assert.ok(JSON.parse(state.steps_data).A);

            store.saveState(key, { ...state, step_index: 2, last_frame_seq: 101 });
            assert.equal(store.getState(key).step_index, 2);

            const prev = store.resetState(key);
            assert.equal(prev.step_index, 2);
            assert.equal(store.getState(key).step_index, 0);
            assert.equal(store.getState(key).cycle_id, null);

            store.saveState(makeStateKey("wf1", "sess1", 1, 2), {
                workflow_id: "wf1", session_id: "sess1", group_id: 1, source_id: 2,
                step_index: 1, total_steps: 3, cycle_id: "cyc-2",
                cycle_started_at_ms: 5000,
            });
            assert.equal(store.listActive().length, 1);

            const counts = store.counts();
            assert.ok(counts.total >= 2);
            assert.equal(counts.active, 1);

            store.close();
        } finally { safeCleanup(dir); }
    });
});

// ---------------------------------------------------------------------------
// FlowRuntime helpers
// ---------------------------------------------------------------------------

describe("FlowRuntime helpers", () => {
    test("makeStateKey, makeStreamId, makeEventId", () => {
        assert.equal(makeStateKey("wf1", "sess1", 1, 2), "wf1:sess1:1:2");
        assert.equal(makeStreamId(1, 2), "group-1/source-2");
        assert.equal(makeEventId("wf1", "s1", "g1/s1", "cyc1", "OK"), "wf1:s1:g1/s1:cyc1:OK");
    });

    test("state names from 3-label topology", () => {
        const ctx = createRuntime(ABC_TOPOLOGY);
        assert.equal(ctx.runtime._stateName(0), "IDLE");
        assert.equal(ctx.runtime._stateName(1), "WAIT_B");
        assert.equal(ctx.runtime._stateName(2), "WAIT_C");
        assert.equal(ctx.runtime._stateName(3), "IDLE");
        ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir);
    });

    test("state names from 4-label topology", () => {
        const ctx = createRuntime(ABDC_TOPOLOGY);
        assert.equal(ctx.runtime._stateName(0), "IDLE");
        assert.equal(ctx.runtime._stateName(1), "WAIT_B");
        assert.equal(ctx.runtime._stateName(2), "WAIT_D");
        assert.equal(ctx.runtime._stateName(3), "WAIT_C");
        assert.equal(ctx.runtime._stateName(4), "IDLE");
        ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir);
    });
});

// ---------------------------------------------------------------------------
// Edge case: Multi-label in same frame (B+C while WAIT_B = NG)
// ---------------------------------------------------------------------------

describe("Edge: multi-label frame", () => {
    test("B+C in same frame while WAIT_B → NG (skip)", () => {
        const ctx = createRuntime(ABC_TOPOLOGY);
        const { runtime } = ctx;
        runtime.process(makeFrame({
            event_seq: 100, event_id: "msg-100",
            label_matches: makeLabelMatches(["A"], ABC_TOPOLOGY),
        }), 1000);

        const events = runtime.process(makeFrame({
            event_seq: 101, event_id: "msg-101",
            label_matches: makeLabelMatches(["B", "C"], ABC_TOPOLOGY),
        }), 2000);
        assert.equal(events[0].type, "terminal");
        assert.equal(events[0].result.result_status, "NG");
        assert.ok(events[0].result.failure_reason.includes("跳步"));

        ctx.store.close(); ctx.audit.close(); safeCleanup(ctx.dir);
    });
});

console.log("\n✅ All Phase 2 topology-driven tests completed.\n");
