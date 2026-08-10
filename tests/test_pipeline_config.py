import os
import tempfile
import unittest

from python_runtime.pipeline_config import (
    PipelineConfigError,
    build_mock_pipeline_metadata,
    parse_pipeline_config,
)


FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "pipeline_config")
MAIN_FLOW = os.path.join(FIXTURE_DIR, "main-flow.yaml")


class PipelineConfigParserTests(unittest.TestCase):
    def test_parse_multi_group_multi_source_and_disabled_group(self):
        metadata = parse_pipeline_config(MAIN_FLOW)

        self.assertEqual(metadata["schema_version"], "pipeline-config/v1")
        self.assertEqual(metadata["config_path"], MAIN_FLOW)
        self.assertEqual(len(metadata["groups"]), 2)
        self.assertEqual(metadata["sources_per_group"], {"1": [101, 102], "2": [201]})
        self.assertEqual(metadata["models_loaded"], ["1", "2"])
        self.assertEqual(metadata["disabled_groups"], [2])

        group1 = metadata["groups"][0]
        self.assertEqual(group1["group_id"], 1)
        self.assertIsInstance(group1["group_id"], int)
        self.assertEqual(group1["group_id_str"], "1")
        self.assertTrue(group1["enabled"])
        self.assertEqual(group1["model_ids"], [1, 2])

        source102 = group1["sources"][1]
        self.assertEqual(source102["source_id"], 102)
        self.assertIsInstance(source102["source_id"], int)
        self.assertEqual(source102["config_path"], ".\\camera-102.yaml")
        self.assertTrue(source102["config_path_normalized"].endswith(
            os.path.join("pipeline_config", "camera-102.yaml")
        ))

        model2 = metadata["models"][1]
        self.assertEqual(model2["model_id"], 2)
        self.assertEqual(model2["model_path"], r"D:\AiBan\models\helmet.onnx")
        self.assertEqual(model2["model_path_normalized"], os.path.normpath(model2["model_path"]))

    def test_duplicate_group_id_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            main_flow = os.path.join(temp_dir, "main-flow.yaml")
            self._write(main_flow, """
GroupArrary:
  - groupid: 1
  - groupid: "1"
ModelArrary:
  Models: []
""")

            with self.assertRaises(PipelineConfigError) as raised:
                parse_pipeline_config(main_flow)
            self.assertEqual(raised.exception.code, "PIPELINE_CONFIG_DUPLICATE_GROUP_ID")

    def test_missing_source_config_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            main_flow = os.path.join(temp_dir, "main-flow.yaml")
            self._write(main_flow, """
GroupArrary:
  - groupid: 1
    Sources:
      - {}
ModelArrary:
  Models: []
""")

            with self.assertRaises(PipelineConfigError) as raised:
                parse_pipeline_config(main_flow)
            self.assertEqual(raised.exception.code, "PIPELINE_CONFIG_MISSING_SOURCE_CONFIG")

    def test_unknown_model_reference_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_yaml = os.path.join(temp_dir, "camera-1.yaml")
            main_flow = os.path.join(temp_dir, "main-flow.yaml")
            self._write(source_yaml, """
id: 1
name: camera-1
""")
            self._write(main_flow, """
GroupArrary:
  - groupid: 1
    Sources:
      - config: camera-1.yaml
    Infers:
      - modeid: 99
ModelArrary:
  Models:
    - modelid: 1
""")

            with self.assertRaises(PipelineConfigError) as raised:
                parse_pipeline_config(main_flow)
            self.assertEqual(raised.exception.code, "PIPELINE_CONFIG_UNKNOWN_MODEL_REF")

    def test_mock_metadata_uses_full_group_contract(self):
        metadata = build_mock_pipeline_metadata(num_groups=2, num_sources=3, model_ids=["7", 8])

        self.assertEqual(metadata["sources_per_group"], {"1": [1, 2, 3], "2": [1, 2, 3]})
        self.assertEqual(metadata["models_loaded"], ["7", "8"])
        self.assertNotEqual(metadata["groups"], [1])
        self.assertEqual(metadata["groups"][0]["group_id"], 1)
        self.assertEqual(metadata["groups"][0]["sources"][2]["source_id"], 3)

    @staticmethod
    def _write(path, content):
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content.strip() + "\n")


if __name__ == "__main__":
    unittest.main()
