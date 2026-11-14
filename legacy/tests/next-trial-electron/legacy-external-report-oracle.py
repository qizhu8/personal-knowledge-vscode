import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

os.umask(0o077)
extension, fixture = (Path(value).resolve() for value in sys.argv[1:3])
assert (fixture / "native-ui-fixture-token").is_file()
evidence = json.loads((fixture / "external-report-recipe.json").read_text())
sys.path.insert(0, str(extension / "resources"))
spec = importlib.util.spec_from_file_location("actual_original_external_report_runtime", extension / "resources/recipe_runtime.py")
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


start_args = {"recipe_id": evidence["recipeId"], "command_id": "universal-real-external-caller",
              "inputs_json": '{"task":"Read the exact synthetic file and preserve its evidence."}'}
trace = {"start": call("start", **start_args)}
run_id = trace["start"]["run_id"]
trace["get_initial"] = call("get", run_id=run_id)
trace["next"] = call("next", run_id=run_id, command_id="claim-universal-first")
trace["get_claimed"] = call("get", run_id=run_id)
trace["progress_args"] = {"run_id": run_id, "node_id": trace["next"]["next_action"]["node_id"],
                          "command_id": "progress-original-external-caller",
                          "progress_json": '{"phase":"inspecting","message":"External caller reading fixture","toolCallCount":1,"cancellationRequested":true}'}
trace["progress_claimed"] = call("progress", **trace["progress_args"])
current = trace["next"]
reports = []
while current["status"] == "running":
    node_id = current["next_action"]["node_id"]
    actual = hashlib.sha256((fixture / "workspace/recipe-input.txt").read_bytes()).hexdigest()
    result = {"sha256": actual, "node": node_id}
    usage = {"estimated_tokens": len(node_id), "unknown_model_calls": 0}
    if not reports:
        usage.update(measured_tokens={"input_tokens": 10, "output_tokens": 3, "cached_input_tokens": 2,
                                      "reasoning_tokens": 1, "total_tokens": 13},
                     provider="fixture", model="measured-fixture", derived_cost={
                         "amount_micros": 7, "currency": "USD", "price_version": "fixture-v1"})
    args = {"run_id": run_id, "node_id": node_id, "outcome": "succeeded", "command_id": "report-" + node_id,
            "result_json": json.dumps(result, separators=(",", ":"), sort_keys=True),
            "usage_json": json.dumps(usage, separators=(",", ":"), sort_keys=True), "detail": "full"}
    if not reports:
        trace["bad_outcome"] = call("report", **{**args, "outcome": "unknown"})
        trace["bad_usage"] = call("report", **{**args, "usage_json": '{"estimated_tokens":true}'})
        trace["usage_errors"] = []
        for value in [[], {}, {"unexpected": 1}, {"measured_tokens": {}},
                      {"measured_tokens": {"input_tokens": 1}}, {"unknown_model_calls": -1},
                      {"estimated_tokens": 1000000000001}, {"estimated_tokens": 1.0},
                      {"unknown_model_calls": 1e0}, {"provider": "fixture"},
                      {"estimated_tokens": 1, "provider": " "},
                      {"estimated_tokens": 1, "derived_cost": {}},
                      {"estimated_tokens": 1, "derived_cost": {"amount_micros": 1, "currency": "usd", "price_version": "v1"}}]:
            invalid = {**args, "usage_json": json.dumps(value, separators=(",", ":"), sort_keys=True)}
            trace["usage_errors"].append({"args": invalid, "response": call("report", **invalid)})
    current = call("report", **args)
    assert current["ok"], current
    with (fixture / "workspace/old-external-caller-effects.jsonl").open("a") as output:
        output.write(json.dumps({"node": node_id, "sha256": actual}) + "\n")
        output.flush()
        os.fsync(output.fileno())
    reports.append({"args": args, "response": current})
trace["reports"] = reports
trace["replay"] = call("report", **reports[0]["args"])
trace["conflict"] = call("report", **{**reports[0]["args"], "result_json": '{"changed":true}'})
trace["final"] = call("get", run_id=run_id)
assert trace["final"]["status"] == "completed" and len(reports) == 6
failure = {"start": call("start", **{**start_args, "command_id": "universal-real-external-failure"})}
failure_id = failure["start"]["run_id"]
failure["next"] = call("next", run_id=failure_id, command_id="claim-failure-first")
current = failure["next"]
failure["reports"] = []
for index, result in enumerate([None, ["zero", False, 0], {"failure": "verified by caller"}]):
    args = {"run_id": failure_id, "node_id": current["next_action"]["node_id"],
            "outcome": "failed" if index == 2 else "succeeded", "command_id": "failure-" + str(index),
            "result_json": json.dumps(result, separators=(",", ":"), sort_keys=True),
            "error": "Caller diagnostic retained." if index == 0 else "Caller verified failure." if index == 2 else "",
            "detail": "full"}
    current = call("report", **args)
    assert current["ok"], current
    failure["reports"].append({"args": args, "response": current})
assert current["status"] == "failed"
trace["failure"] = failure
print(json.dumps(trace))
