"""为评分容器设置真实 CPU 配额，避免旧版工具误读默认 CPU 权重。"""
from docker import DockerClient
from docker.models.containers import ContainerCollection


class EvaluationContainers(ContainerCollection):
    def create(self, image, command=None, **kwargs):
        # 与模型容器的 --cpus 2 一致；不改测试或伪造 CPU 检测结果。
        kwargs["nano_cpus"] = 2_000_000_000
        return super().create(image, command=command, **kwargs)


class EvaluationClient(DockerClient):
    @property
    def containers(self):
        return EvaluationContainers(client=self)
