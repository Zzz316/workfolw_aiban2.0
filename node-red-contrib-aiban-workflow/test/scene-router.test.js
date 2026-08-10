"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const {
    ROUTING_DIAGNOSTICS,
    SceneRoutingEngine,
} = require("../lib/scene-routing");

function frame(groupId = 1, sourceId = 1) {
    return {
        payload: {
            group_id: groupId,
            source_id: sourceId,
            session_id: "session-1",
            event_seq: 10,
        },
        aiban: { group_id: groupId, source_id: sourceId, session_id: "session-1" },
    };
}

function scene(overrides = {}) {
    return {
        group_id: 1,
        scene_id: "exclusive-a",
        mode: "exclusive",
        workflow_id: "group/1/scene/exclusive-a",
        enabled: true,
        ...overrides,
    };
}

function engine() {
    return new SceneRoutingEngine({
        now: () => "2026-07-29T10:00:00.000Z",
        routes: [
            { route_id: "route-a", group_id: 1, scene_id: "exclusive-a" },
            { route_id: "route-b", group_id: 1, scene_id: "exclusive-b" },
            { route_id: "route-p", group_id: 1, scene_id: "parallel-p" },
        ],
    });
}

describe("SceneRoutingEngine", () => {
    test("keeps groups isolated and reports an unknown group instead of dropping", () => {
        const outputs = engine().route(frame(2), {
            groups: [{ group_id: 1 }],
            scenes: [scene()],
            selection: { group_id: 1, scene_id: "exclusive-a" },
        });
        assert.equal(outputs.slice(0, 3).flat().length, 0);
        assert.equal(outputs[3][0].payload.code, ROUTING_DIAGNOSTICS.UNKNOWN_GROUP);
    });

    test("a disabled Runtime group interrupts previous routes and emits no new frames", () => {
        const router = engine();
        router.route(frame(), {
            groups: [{ group_id: 1, enabled: true }],
            scenes: [scene()],
            selection: { group_id: 1, scene_id: "exclusive-a" },
        });
        const outputs = router.route(frame(), {
            groups: [{ group_id: 1, enabled: false }],
            scenes: [scene()],
            selection: { group_id: 1, scene_id: "exclusive-a" },
        });
        assert.equal(outputs[0].length, 1);
        assert.equal(outputs[0][0].topic, "aiban-interrupt");
        assert.equal(
            outputs[3][0].payload.code,
            ROUTING_DIAGNOSTICS.NO_ACTIVE_SCENE
        );
        assert.match(outputs[3][0].payload.message, /disabled/);
    });

    test("routes only the selected enabled exclusive scene", () => {
        const outputs = engine().route(frame(), {
            groups: [{ group_id: 1 }],
            scenes: [
                scene(),
                scene({
                    scene_id: "exclusive-b",
                    workflow_id: "group/1/scene/exclusive-b",
                }),
            ],
            selection: { group_id: 1, scene_id: "exclusive-b" },
        });
        assert.equal(outputs[0].length, 0);
        assert.equal(outputs[1].length, 1);
        assert.equal(outputs[1][0].aiban.scene_id, "exclusive-b");
        assert.equal(outputs[1][0].workflow.route_id, "route-b");
        assert.equal(outputs[1][0].aiban.routed_at, "2026-07-29T10:00:00.000Z");
    });

    test("switch emits INTERRUPTED to the old route and frames only to the new route", () => {
        const router = engine();
        const scenes = [
            scene(),
            scene({
                scene_id: "exclusive-b",
                workflow_id: "group/1/scene/exclusive-b",
            }),
        ];
        router.route(frame(), {
            groups: [1],
            scenes,
            selection: { group_id: 1, scene_id: "exclusive-a" },
        });
        const outputs = router.route(frame(), {
            groups: [1],
            scenes,
            selection: { group_id: 1, scene_id: "exclusive-b" },
        });
        assert.equal(outputs[0].length, 1);
        assert.equal(outputs[0][0].topic, "aiban-interrupt");
        assert.equal(outputs[0][0].payload.workflow_id, "group/1/scene/exclusive-a");
        assert.equal(outputs[1].length, 1);
        assert.notStrictEqual(outputs[0][0], outputs[1][0]);
    });

    test("parallel and exclusive scenes receive independent message copies", () => {
        const outputs = engine().route(frame(), {
            groups: [1],
            scenes: [
                scene(),
                scene({
                    scene_id: "parallel-p",
                    mode: "parallel",
                    workflow_id: "group/1/scene/parallel-p",
                }),
            ],
            selection: { group_id: 1, scene_id: "exclusive-a" },
        });
        assert.equal(outputs[0].length, 1);
        assert.equal(outputs[2].length, 1);
        assert.notStrictEqual(outputs[0][0], outputs[2][0]);
        outputs[0][0].payload.changed = true;
        assert.equal(outputs[2][0].payload.changed, undefined);
    });

    test("reports disabled selection, missing active scene and unbound route", () => {
        const router = engine();
        const disabled = router.route(frame(), {
            groups: [1],
            scenes: [scene({ enabled: false })],
            selection: { group_id: 1, scene_id: "exclusive-a" },
        });
        assert.deepEqual(
            disabled[3].map((msg) => msg.payload.code).sort(),
            [ROUTING_DIAGNOSTICS.NO_ACTIVE_SCENE, ROUTING_DIAGNOSTICS.SCENE_DISABLED].sort()
        );

        const unbound = router.route(frame(1, 2), {
            groups: [1],
            scenes: [scene({
                scene_id: "unbound",
                mode: "parallel",
                workflow_id: "group/1/scene/unbound",
            })],
            selection: { group_id: 1, scene_id: null },
        });
        assert.equal(unbound[3][0].payload.code, ROUTING_DIAGNOSTICS.ROUTE_NOT_BOUND);
    });
});
