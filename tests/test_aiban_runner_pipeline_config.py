import os
import unittest

from python_runtime.aiban_runner import AibanRunner
from python_runtime.lifecycle import LifecycleState
from python_runtime.sdk_adapter import SdkAdapter


FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "pipeline_config")
MAIN_FLOW = os.path.join(FIXTURE_DIR, "main-flow.yaml")


class AibanRunnerPipelineConfigTests(unittest.TestCase):
    def test_start_uses_parsed_metadata_in_runtime_ready(self):
        runner = AibanRunner(
            pipeline_config=MAIN_FLOW,
            use_mock=False,
            mock_config={"frame_interval_ms": 100000, "model_ids": [1, 2]},
        )
        runner._sdk_adapter = SdkAdapter(
            use_mock=True,
            mock_config={"frame_interval_ms": 100000, "model_ids": [1, 2]},
        )

        try:
            result = runner._cmd_start("start", "req-start", {})
            self.assertEqual(result["message"], "Pipeline started")
            ready_event = self._event_by_type(runner, "runtime_ready")

            payload = ready_event["payload"]
            self.assertIsInstance(payload["groups"][0], dict)
            self.assertEqual(payload["groups"][0]["group_id"], 1)
            self.assertEqual(payload["sources_per_group"], {"1": [101, 102], "2": [201]})
            self.assertEqual(payload["models_loaded"], ["1", "2"])
            self.assertEqual(payload["pipeline_config"]["schema_version"], "pipeline-config/v1")
            self.assertEqual(payload["pipeline_config"]["disabled_groups"], [2])
        finally:
            runner._stop_pipeline(reason="test", force=True)

    def test_parse_error_sets_error_state_before_runtime_ready(self):
        missing_path = os.path.join(FIXTURE_DIR, "missing-main-flow.yaml")
        runner = AibanRunner(pipeline_config=missing_path, use_mock=False)

        with self.assertRaises(RuntimeError) as raised:
            runner._cmd_start("start", "req-start", {})

        self.assertIn("PIPELINE_CONFIG_NOT_FOUND", str(raised.exception))
        self.assertEqual(runner._lifecycle.state, LifecycleState.ERROR)
        event_types = [event["type"] for event in self._drain_events(runner)]
        self.assertIn("runtime_starting", event_types)
        self.assertNotIn("runtime_ready", event_types)

    def test_mock_without_pipeline_config_still_emits_contract_metadata(self):
        runner = AibanRunner(
            use_mock=True,
            mock_config={"num_groups": 2, "num_sources": 2, "model_ids": [3]},
        )

        try:
            runner._cmd_start("start", "req-start", {})
            ready_event = self._event_by_type(runner, "runtime_ready")
            payload = ready_event["payload"]
            self.assertEqual(payload["sources_per_group"], {"1": [1, 2], "2": [1, 2]})
            self.assertEqual(payload["models_loaded"], ["3"])
            self.assertNotEqual(payload["groups"], [1])
            self.assertEqual(payload["groups"][1]["group_id"], 2)
        finally:
            runner._stop_pipeline(reason="test", force=True)

    def _event_by_type(self, runner, event_type):
        for event in self._drain_events(runner):
            if event["type"] == event_type:
                return event
        self.fail(f"event not found: {event_type}")

    @staticmethod
    def _drain_events(runner):
        events = []
        while runner._output_queue.depth:
            event = runner._output_queue.get(timeout=0.1)
            if event is not None:
                events.append(event)
                runner._output_queue.task_done()
        return events


if __name__ == "__main__":
    unittest.main()
