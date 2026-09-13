import unittest
from types import SimpleNamespace
from network_fixture import configure_network_fixture, check_fixture_result


class FixtureTests(unittest.TestCase):
    def test_missing_fixture_is_infrastructure_failure_not_wrong_answer(self):
        result = check_fixture_result({'completed': True, 'resolved': False}, 'psf/requests', '')
        self.assertFalse(result['completed'])
        self.assertEqual(result['failureKind'], 'network_fixture')
        self.assertTrue(check_fixture_result({'completed': True, 'resolved': False}, 'psf/requests', 'SCORER_TARPIT_CONNECT_TIMEOUT_OK\n')['completed'])
    def test_requests_only_scoring_setup_preserves_test_commands(self):
        spec = SimpleNamespace(docker_specs={}, eval_script_list=['pytest -rA test_requests.py'])
        configure_network_fixture(spec, 'psf/requests')
        self.assertEqual(spec.docker_specs['run_args']['cap_add'], ['NET_ADMIN'])
        self.assertEqual(spec.eval_script_list[-1], 'pytest -rA test_requests.py')
        self.assertIn('10.255.255.1', spec.eval_script_list[0])

    def test_other_repositories_unchanged(self):
        spec = SimpleNamespace(docker_specs={}, eval_script_list=['pytest'])
        configure_network_fixture(spec, 'django/django')
        self.assertEqual(spec.docker_specs, {})
        self.assertEqual(spec.eval_script_list, ['pytest'])


if __name__ == '__main__':
    unittest.main()
