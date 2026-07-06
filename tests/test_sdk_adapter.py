import unittest

from python_runtime.sdk_adapter import SdkAdapter


class SdkEventTests(unittest.TestCase):
    def setUp(self):
        self.adapter = SdkAdapter(use_mock=True)
        self.events = []
        self.adapter.set_event_handler(
            lambda level, message: self.events.append((level, message))
        )

    def test_periodic_accredit_success_is_suppressed(self):
        self.adapter._on_sdk_event(
            "abMsgEventType.accredit",
            True,
            ["", "1068680599", "HASP-HL", "-1"],
        )
        self.assertEqual(self.events, [])

    def test_sdk_true_status_is_info(self):
        self.adapter._on_sdk_event("model_loaded", True, ["ok"])
        self.assertEqual(self.events[0][0], "info")

    def test_sdk_false_status_is_error(self):
        self.adapter._on_sdk_event("model_loaded", False, ["failed"])
        self.assertEqual(self.events[0][0], "error")


if __name__ == "__main__":
    unittest.main()
