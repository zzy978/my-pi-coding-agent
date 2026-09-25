"""按已冻结的公开任务清单准备评分资料，不参与挑题。"""
import json
from pathlib import Path

from swebench.harness.test_spec.test_spec import make_test_spec


def prepare_selected(root):
    root = Path(root)
    selection = json.loads((root / "selection.json").read_text())
    rows = {row["instance_id"]: row for row in json.loads((root / "dataset-private.json").read_text())}
    private = root / "private"
    private.mkdir(exist_ok=True)
    tasks = []
    for task in selection["tasks"]:
        row = rows[task["instance_id"]]
        public = {key: row[key] for key in ("instance_id", "repo", "base_commit", "problem_statement")}
        if public != task:
            raise ValueError("Selected public task binding mismatch")
        spec = make_test_spec(row, namespace="swebench")
        (private / (row["instance_id"] + ".json")).write_text(json.dumps(row))
        tasks.append(dict(public, image=spec.instance_image_key))
    catalog = dict(selection, harness="4.1.0", tasks=tasks)
    path = root / "catalog.json"
    if path.exists() and json.loads(path.read_text()) != catalog:
        raise ValueError("Frozen catalog drift")
    path.write_text(json.dumps(catalog, indent=2))
    print(json.dumps({"selected": len(tasks), "repositories": len({task["repo"] for task in tasks})}), flush=True)


if __name__ == "__main__":
    prepare_selected("/data")
