"""固定抽样规则；不能使用答案、测试或模型结果选择任务。"""
import hashlib

DATASET = "princeton-nlp/SWE-bench_Verified"
REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a"
SEED = "mini-transfer-v1"
QUOTAS = {"django/django": 10, "sphinx-doc/sphinx": 10, "pytest-dev/pytest": 5,
          "psf/requests": 5, "scikit-learn/scikit-learn": 5, "sympy/sympy": 5}


def normalized(row):
    return " ".join(row["problem_statement"].lower().split())


def select_tasks(rows, sources):
    excluded = {row["instance_id"] for row in sources}
    seen = {normalized(row) for row in sources}
    selected = []
    ranked = sorted(rows, key=lambda row: (hashlib.sha256((SEED + ":" + row["instance_id"]).encode()).hexdigest(), row["instance_id"]))
    for repo, count in QUOTAS.items():
        current = []
        for row in ranked:
            if row["repo"] != repo or row["instance_id"] in excluded or normalized(row) in seen:
                continue
            current.append(row)
            excluded.add(row["instance_id"])
            seen.add(normalized(row))
            if len(current) == count:
                break
        if len(current) != count:
            raise ValueError("Insufficient unique tasks for " + repo)
        selected.extend(current)
    return selected
