"""网络夹具检查不得覆盖测试启动前已确定的补丁失败。"""
import unittest

from network_fixture import check_fixture_result


class FixtureResultTests(unittest.TestCase):
    def test_patch_failure_does_not_require_test_output(self):
        result = dict(completed=True, resolved=False,
                      officialCompleted=False, failureKind="patch_apply")
        self.assertEqual(check_fixture_result(result, "psf/requests", ""), result)

    def test_missing_fixture_still_rejects_test_results(self):
        for result in [dict(completed=True, resolved=True),
                       dict(completed=True, resolved=False),
                       dict(completed=False, resolved=False)]:
            checked = check_fixture_result(result, "psf/requests", "")
            self.assertFalse(checked["completed"])
            self.assertEqual(checked["failureKind"], "network_fixture")

    def test_partial_patch_failure_metadata_does_not_bypass_fixture(self):
        original = dict(completed=True, resolved=False,
                        officialCompleted=False, failureKind="patch_apply")
        for field, value in [("completed", False), ("resolved", True),
                             ("officialCompleted", True),
                             ("failureKind", "test_timeout")]:
            for candidate in [dict(original, **{field: value}),
                              {key: val for key, val in original.items() if key != field}]:
                with self.subTest(field=field, candidate=candidate):
                    checked = check_fixture_result(candidate, "psf/requests", "")
                    self.assertFalse(checked["completed"])
                    self.assertEqual(checked["failureKind"], "network_fixture")

    def test_confirmed_fixture_preserves_result(self):
        result = dict(completed=True, resolved=False)
        self.assertEqual(check_fixture_result(
            result, "psf/requests", "SCORER_TARPIT_CONNECT_TIMEOUT_OK\n"), result)

    def test_other_repositories_are_unchanged(self):
        result = dict(completed=True, resolved=True)
        self.assertEqual(check_fixture_result(result, "django/django", ""), result)


if __name__ == "__main__":
    unittest.main()
