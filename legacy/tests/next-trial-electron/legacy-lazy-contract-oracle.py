import importlib.util
import json
import os
from pathlib import Path
import sys
import time


os.umask(0o077)
extension, fixture = (Path(value).resolve() for value in sys.argv[1:3])
root = fixture / "knowledge"
assert (fixture / "native-ui-fixture-token").is_file()
evidence = json.loads((fixture / "controlled-lazy-recipe-evidence.json").read_text())
sys.path.insert(0, str(extension / "resources"))
spec = importlib.util.spec_from_file_location("actual_original_lazy_runtime", extension / "resources/recipe_runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class Registration:
    def __init__(self):
        self.tools = {}
        self.options = {}

    def tool(self, **options):
        def register(function):
            self.tools[function.__name__] = function
            self.options[function.__name__] = options
            return function
        return register


registration = Registration()
runtime.register_recipe_tools(registration, root)
assert "recipe_run_cancel" not in registration.tools


def call(name, **args):
    value = registration.tools[name](**args)
    return json.loads(value) if isinstance(value, str) else value


def effects():
    file = Path(evidence["effects"])
    return len(file.read_text().splitlines()) if file.exists() else 0


def poll(run_id, predicate):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        value = call("recipe_run_get", run_id=run_id)
        if predicate(value):
            return value
        time.sleep(0.02)
    raise AssertionError(value)


if len(sys.argv) > 3 and sys.argv[3] == "autonomous":
    trace = {}
    for name, maximum in (("complete", 100), ("node_bound", 1)):
        args = {"recipe_id": evidence["recipeId"], "command_id": "autonomous-" + name,
                "inputs_json": '{"mode":"complete"}', "autonomous": True,
                "max_auto_nodes": maximum}
        trace[name + "_start"] = call("recipe_run_start", **args)
        assert trace[name + "_start"]["ok"], trace[name + "_start"]
        trace[name] = poll(trace[name + "_start"]["run_id"], lambda value: value["status"] != "running")
        trace[name + "_replay"] = call("recipe_run_start", **args)
    assert trace["complete"]["status"] == "completed", trace
    assert trace["complete"]["automation"]["startedNodes"] == 2, trace
    assert trace["node_bound"]["automation"]["stopReason"] == "automation-budget-exceeded", trace
    assert effects() == 3
    print(json.dumps({"trace": trace, "actual_effects": effects(),
                      "actual_original_compiler_and_worker": True}))
    sys.exit(0)

trace = {"get_originally_misannotated_read_only": registration.options["recipe_run_get"]}
trace["revision_mismatch"] = call(
    "recipe_run_start", recipe_id=evidence["recipeId"], command_id="invalid-source-revision",
    expected_revision=evidence["recipe"]["revision"] + 1)
trace["digest_mismatch"] = call(
    "recipe_run_start", recipe_id=evidence["recipeId"], command_id="invalid-source-digest",
    expected_digest="f" * 64)
start_args = {"recipe_id": evidence["recipeId"], "command_id": "controlled-lazy-success",
              "inputs_json": '{"mode":"complete"}'}
trace["start"] = call("recipe_run_start", **start_args)
run_id = trace["start"]["run_id"]
trace["get_initial"] = call("recipe_run_get", run_id=run_id)
assert effects() == 0
trace["next_first"] = call("recipe_run_next", run_id=run_id, command_id="first-request")
trace["read_first"] = poll(run_id, lambda value: value["current_result"]["counts"]["succeeded"] == 1)
assert trace["read_first"]["current_result"]["counts"]["pending"] == 1
time.sleep(0.15)
assert effects() == 1
trace["replay_first"] = call("recipe_run_next", run_id=run_id, command_id="first-request")
trace["command_conflict"] = call("recipe_run_next", run_id=run_id, command_id="first-request", detail="full")
trace["next_second"] = call("recipe_run_next", run_id=run_id, command_id="second-request")
trace["completed"] = poll(run_id, lambda value: value["status"] == "completed")
assert effects() == 2
trace["cancel_start"] = call("recipe_run_start", recipe_id=evidence["recipeId"],
                           command_id="controlled-lazy-cancel", inputs_json='{"mode":"hold"}')
cancel_id = trace["cancel_start"]["run_id"]
trace["invalid_progress"] = call("recipe_run_progress", run_id=cancel_id, node_id="first",
                               command_id="too-early", progress_json='{"cancellationRequested":true}')
trace["cancel_next"] = call("recipe_run_next", run_id=cancel_id, command_id="claim-cancel")
deadline = time.monotonic() + 10
while effects() < 3 and time.monotonic() < deadline:
    time.sleep(0.01)
assert effects() == 3
trace["cancel_progress"] = call("recipe_run_progress", run_id=cancel_id, node_id="first",
                              command_id="cancel-request", progress_json='{"cancellationRequested":true}')
trace["cancelled"] = poll(cancel_id, lambda value: value["status"] == "failed")
assert trace["cancelled"]["current_result"]["completed_nodes"][0]["result"]["cancelled"] is True
trace["cancel_replayed"] = call("recipe_run_progress", run_id=cancel_id, node_id="first",
                              command_id="cancel-request", progress_json='{"cancellationRequested":true}')
assert effects() == 3
(fixture / "actual-old-lazy-contract.json").write_text(json.dumps(trace))
print(json.dumps({"trace": trace, "actual_effects": effects(), "actual_original_compiler_and_worker": True}))
