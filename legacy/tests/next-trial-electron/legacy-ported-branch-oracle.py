import importlib.util
import json
import os
from pathlib import Path
import sys

os.umask(0o077)
extension, fixture = (Path(value).resolve() for value in sys.argv[1:3])
assert (fixture / "native-ui-fixture-token").is_file()
evidence = json.loads((fixture / "ported-branch-source.json").read_text())
sys.path.insert(0, str(extension / "resources"))
spec = importlib.util.spec_from_file_location("actual_original_ported_branch_runtime",
                                              extension / "resources/recipe_runtime.py")
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
runtime.register_recipe_tools(registration, fixture / "knowledge")


def call(name, **args):
    value = registration.tools["recipe_run_" + name](**args)
    return json.loads(value) if isinstance(value, str) else value


inputs = {"seed": "root-seed"}
start_args = {"recipe_id": evidence["recipe"]["recipeId"], "command_id": "ported-branch-oracle",
              "inputs_json": json.dumps(inputs, separators=(",", ":"), sort_keys=True)}
started = call("start", **start_args)
assert started["ok"], started
run_id = started["run_id"]
next_args = {"run_id": run_id, "command_id": "claim-ported-branch"}
current = call("next", **next_args)
trace = {"inputs": inputs, "start_args": start_args, "start": started, "next_args": next_args,
         "initial_next": current, "legacy_inputs": [], "reports": []}
results = {
    "inspect": ("valid", {"rawLegacyEvidence": "no-declared-output-keys"}, ""),
    "record-valid": ("succeeded", {"checked": "mapped-token"}, ""),
    "join": ("succeeded", {"joined": True}, ""),
}
while current["status"] == "running":
    action = current["next_action"]
    node_id = action["node_id"]
    trace["legacy_inputs"].append({"node_id": node_id, "inputs": action["inputs"]})
    outcome, result, error = results[node_id]
    args = {"run_id": run_id, "node_id": node_id, "command_id": "ported-" + node_id,
            "outcome": outcome, "result_json": json.dumps(result, separators=(",", ":"), sort_keys=True),
            "error": error, "detail": "full"}
    current = call("report", **args)
    assert current["ok"], current
    trace["reports"].append({"args": args, "response": current})
trace["final"] = call("get", run_id=run_id)
assert trace["final"]["status"] == "completed", trace["final"]
assert [item["node_id"] for item in trace["legacy_inputs"]] == ["inspect", "record-valid", "join"]
assert all(item["inputs"] == inputs for item in trace["legacy_inputs"]), trace["legacy_inputs"]

failure_start_args = {"recipe_id": evidence["recipe"]["recipeId"], "command_id": "ported-branch-failure",
                      "inputs_json": json.dumps(inputs, separators=(",", ":"), sort_keys=True)}
failure_start = call("start", **failure_start_args)
assert failure_start["ok"], failure_start
failure_next_args = {"run_id": failure_start["run_id"], "command_id": "claim-ported-failure"}
failure_next = call("next", **failure_next_args)
assert failure_next["next_action"]["node_id"] == "inspect", failure_next
failure_report_args = {"run_id": failure_start["run_id"], "node_id": "inspect", "command_id": "fail-ported-inspect",
                       "outcome": "failed", "result_json": '{"raw":"caller-evidence"}',
                       "error": "Caller inspection failed.", "detail": "full"}
failure_report = call("report", **failure_report_args)
failure_final = call("get", run_id=failure_start["run_id"])
assert failure_report["status"] == "failed", failure_report
assert failure_final["current_result"]["completed_nodes"][0]["result"] == {"raw": "caller-evidence"}, failure_final
assert failure_final["current_result"]["completed_nodes"][0]["error"] == "Caller inspection failed.", failure_final
trace["failure"] = {"start_args": failure_start_args, "start": failure_start, "next_args": failure_next_args,
                    "next": failure_next, "report_args": failure_report_args,
                    "report": failure_report, "final": failure_final}
print(json.dumps(trace, separators=(",", ":"), sort_keys=True))
