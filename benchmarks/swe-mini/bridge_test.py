import unittest
from bridge import normalize_score, APPLY_PATCH_FAIL


class ScoreTests(unittest.TestCase):
    def test_apply_failure_is_finished_unsolved_submission(self):
        result = normalize_score({"completed": False, "resolved": False}, APPLY_PATCH_FAIL + ": cannot apply patch")
        self.assertTrue(result["completed"])
        self.assertFalse(result["resolved"])
        self.assertFalse(result["officialCompleted"])

    def test_test_timeout_does_not_retry_forever(self):
        result = normalize_score({"completed": False, "resolved": False}, "Test timed out after 300 seconds.")
        self.assertTrue(result["completed"])
        self.assertEqual(result["failureKind"], "test_timeout")

    def test_environment_error_remains_unknown(self):
        self.assertFalse(normalize_score({"completed": False, "resolved": False}, "Docker container failed to start")["completed"])


if __name__ == "__main__":
    unittest.main()
