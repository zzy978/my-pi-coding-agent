"""SWE-bench 4.1.0 的数据准备与独立评分桥接；只由宿主执行。"""
import json
import os
import sys
from pathlib import Path

import docker
from datasets import load_dataset
from huggingface_hub import HfApi
from swebench.harness.test_spec.test_spec import make_test_spec
from swebench.harness.run_evaluation import run_instance
from swebench.harness.constants import APPLY_PATCH_FAIL, RUN_EVALUATION_LOG_DIR, LOG_INSTANCE

ROOT = Path("/data")
DATASET = "MariusHobbhahn/swe-bench-verified-mini"


def normalize_score(result, log):
    result = dict(result, officialCompleted=result["completed"])
    if not result["completed"]:
        reason = "patch_apply" if APPLY_PATCH_FAIL in log else "test_timeout" if "Test timed out after" in log else None
        if reason:
            result.update(completed=True, resolved=False, failureKind=reason)
    return result


def prepare():
    revision = HfApi().dataset_info(DATASET).sha
    rows = list(load_dataset(DATASET, split="test", revision=revision))
    if len(rows) != 50 or len({r["instance_id"] for r in rows}) != 50:
        raise ValueError("Expected exactly 50 unique instances")
    tasks = []
    private = ROOT / "private"
    private.mkdir(parents=True, exist_ok=True)
    for row in rows:
        spec = make_test_spec(row, namespace="swebench")
        (private / (row["instance_id"] + ".json")).write_text(json.dumps(row))
        public = {k: row[k] for k in ("instance_id", "repo", "base_commit", "problem_statement")}
        public["image"] = spec.instance_image_key
        tasks.append(public)
    catalog = {"dataset": DATASET, "revision": revision, "harness": "4.1.0", "tasks": tasks}
    (ROOT / "catalog.json").write_text(json.dumps(catalog, indent=2))
    print(json.dumps({"prepared": len(tasks), "revision": revision}), flush=True)


def evaluate(instance_id, patch_path, run_id):
    row = json.loads((ROOT / "private" / (instance_id + ".json")).read_text())
    spec = make_test_spec(row, namespace="swebench")
    from network_fixture import configure_network_fixture, check_fixture_result
    configure_network_fixture(spec, row["repo"])
    # Images were pulled and pinned before model execution. Refuse tag drift.
    client = docker.from_env()
    pinned = json.loads((ROOT / "images.json").read_text())
    if client.images.get(spec.instance_image_key).id != pinned[instance_id]:
        raise ValueError("Evaluation image drift")
    patch = row["patch"] if patch_path == "gold" else Path(patch_path).read_text()
    if not patch.strip():
        result = {"completed": True, "resolved": False, "emptyPatch": True}
    else:
        pred = {"instance_id": instance_id, "model_name_or_path": "picode", "model_patch": patch}
        os.chdir(ROOT)
        result = run_instance(spec, pred, False, False, client, run_id, timeout=300)
        log_path = ROOT / RUN_EVALUATION_LOG_DIR / run_id / "picode" / instance_id / LOG_INSTANCE
        result = normalize_score(result, log_path.read_text() if log_path.exists() else "")
        output_path = log_path.parent / "test_output.txt"
        result = check_fixture_result(result, row["repo"], output_path.read_text() if output_path.exists() else "")
    (ROOT / (run_id + ".score.json")).write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)


def prepare_holdout():
    from holdout import DATASET as dataset, REVISION, SEED, QUOTAS, select_tasks
    sources = json.loads((ROOT / "source-catalog.json").read_text())["tasks"]
    rows = list(load_dataset(dataset, split="test", revision=REVISION))
    selected = select_tasks(rows, sources)
    private = ROOT / "private"
    private.mkdir(parents=True, exist_ok=True)
    tasks = []
    for row in selected:
        spec = make_test_spec(row, namespace="swebench")
        (private / (row["instance_id"] + ".json")).write_text(json.dumps(row))
        public = {k: row[k] for k in ("instance_id", "repo", "base_commit", "problem_statement")}
        public["image"] = spec.instance_image_key
        tasks.append(public)
    catalog = {"dataset": dataset, "revision": REVISION, "harness": "4.1.0", "seed": SEED, "quotas": QUOTAS, "tasks": tasks}
    (ROOT / "catalog.json").write_text(json.dumps(catalog, indent=2))
    print(json.dumps({"prepared": len(tasks), "revision": REVISION}), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "prepare":
        prepare()
    elif sys.argv[1] == "prepare-holdout":
        prepare_holdout()
    elif sys.argv[1] == "evaluate":
        evaluate(*sys.argv[2:])
    else:
        raise ValueError("Unknown operation")
