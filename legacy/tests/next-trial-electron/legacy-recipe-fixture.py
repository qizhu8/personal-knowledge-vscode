import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys


os.umask(0o077)
extension, root, workspace = map(lambda value: Path(value).resolve(), sys.argv[1:4])
assert root.is_dir() and workspace.is_dir() and root.parent == workspace.parent
assert root.name == "knowledge" and workspace.name == "workspace"
assert (root.parent / "native-ui-fixture-token").is_file(), "Synthetic private fixture token required."
assert not (root / ".pkm/state/recipe-runs").exists(), "Do not replay an existing Recipe fixture."
sys.path.insert(0, str(extension / "resources"))
spec = importlib.util.spec_from_file_location("original_recipe_fixture_runtime", extension / "resources/recipe_runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class Registration:
    def __init__(self):
        self.tools = {}

    def tool(self, **_options):
        def register(function):
            self.tools[function.__name__] = function
            return function
        return register


registration = Registration()
runtime.register_recipe_tools(registration, root)


def call(name, *args, **kwargs):
    value = registration.tools[name](*args, **kwargs)
    if isinstance(value, str):
        value = json.loads(value)
    assert value["ok"], value
    return value


definition = {
    "schema": "pkm.workflow.definition/v1",
    "spec": {
        "inputs": {"mode": {"type": "string", "required": True, "nullable": False, "schema": {}}},
        "nodes": [
            {"nodeId": "inspect", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [],
             "generalInstruction": "SATURN trusted local fixture: inspect the fixed synthetic input."},
            {"nodeId": "record", "kind": "pkm.step.noop/v1", "config": {},
             "generalInstruction": "SATURN trusted local fixture: append fixed evidence, never run a command.",
             "dependsOn": [{"from": "inspect", "accept": ["succeeded"], "required": True}]},
        ],
        "outputs": {},
        "completion": {"requiredNodes": ["record"]},
    },
}
input_file = workspace / "recipe-input.txt"
input_file.write_text("SATURN synthetic original Recipe input.\n", encoding="utf-8")
os.chmod(input_file, 0o600)
actual_hash = hashlib.sha256(input_file.read_bytes()).hexdigest()
completed = call("recipe_run_start_adhoc", "SATURN trusted original Recipe", json.dumps(definition),
                 "synthetic-old-recipe-complete", inputs_json='{"mode":"complete"}')
run_id = completed["run_id"]
action = call("recipe_run_next", run_id, "synthetic-old-recipe-claim")["next_action"]
for node_id in ["inspect", "record"]:
    assert action["node_id"] == node_id, action
    if node_id == "record":
        with (workspace / "recipe-original-effects.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"runId": run_id, "nodeId": node_id, "sha256": actual_hash}) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    reported = call("recipe_run_report", run_id, node_id, "succeeded", "synthetic-old-report-" + node_id,
                    result_json=json.dumps({"sha256": actual_hash}), detail="full")
    action = reported["next_action"]
assert call("recipe_run_get", run_id)["status"] == "completed"
unknown = call("recipe_run_start_adhoc", "SATURN original claimed unresolved Recipe", json.dumps(definition),
               "synthetic-old-recipe-unresolved", inputs_json='{"mode":"complete"}')
call("recipe_run_next", unknown["run_id"], "synthetic-old-recipe-unresolved-claim")
runs = root / ".pkm/state/recipe-runs"
print(json.dumps({
    "definition": definition, "completedRunId": run_id, "unknownRunId": unknown["run_id"],
    "inputSha256": actual_hash,
    "files": {file.name: hashlib.sha256(file.read_bytes()).hexdigest()
              for file in sorted(runs.iterdir()) if file.is_file()},
}))
