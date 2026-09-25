import unittest
from unittest.mock import patch

from docker.models.containers import ContainerCollection
from evaluation_resources import EvaluationClient


class EvaluationResourcesTests(unittest.TestCase):
    def test_container_creation_sets_real_two_cpu_quota(self):
        client = EvaluationClient(base_url="unix:///unused", version="1.41")
        with patch.object(ContainerCollection, "create", return_value="container") as create:
            self.assertEqual(client.containers.create("image", command="sleep infinity", name="test"), "container")
            create.assert_called_once_with("image", command="sleep infinity", name="test", nano_cpus=2_000_000_000)
        client.close()

    def test_creation_failure_is_not_suppressed(self):
        client = EvaluationClient(base_url="unix:///unused", version="1.41")
        with patch.object(ContainerCollection, "create", side_effect=RuntimeError("failed")):
            with self.assertRaisesRegex(RuntimeError, "failed"):
                client.containers.create("image")
        client.close()


if __name__ == "__main__":
    unittest.main()
