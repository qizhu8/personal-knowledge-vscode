import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys

os.umask(0o077)
extension, fixture = (Path(value).resolve() for value in sys.argv[1:3])
assert (fixture / "native-ui-fixture-token").is_file()
evidence = json.loads((fixture / "static-branch-source.json").read_text())
sys.path.insert(0, str(extension / "resources"))
spec = importlib.util.spec_from_file_location("actual_original_static_branch_runtime", extension / "resources/recipe_runtime.py")
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


trace = {"scenarios": {}}
if evidence.get("tutorialRecipeId"):
    trace["original_tutorial_start"] = call("start", recipe_id=evidence["tutorialRecipeId"],
                                            command_id="probe-actual-original-tutorial")
    assert not trace["original_tutorial_start"]["ok"], trace["original_tutorial_start"]

for scenario in ["valid", "invalid", "cancel", "io-failure", "inspection-failure"]:
    inputs = {"source": "invalid" if scenario == "invalid" else "valid",
              "expected_sha256": evidence["expectedSha256"]}
    start_args = {"recipe_id": evidence["recipe"]["recipeId"], "command_id": "static-branch-" + scenario,
                  "inputs_json": json.dumps(inputs, separators=(",", ":"), sort_keys=True)}
    started = call("start", **start_args)
    assert started["ok"], started
    run_id = started["run_id"]
    next_args = {"run_id": run_id, "command_id": "claim-static-" + scenario}
    current = call("next", **next_args)
    record = {"inputs": inputs, "start_args": start_args, "start": started,
              "next_args": next_args, "next": current, "reports": []}
    directory = fixture / "workspace" / ("branch-old-" + scenario)
    directory.mkdir(mode=0o700)
    while current["status"] == "running":
        node_id = current["next_action"]["node_id"]
        source = fixture / "workspace" / ("branch-invalid.txt" if inputs["source"] == "invalid" else "recipe-input.txt")
        actual = hashlib.sha256(source.read_bytes()).hexdigest()
        branch = "valid" if actual == inputs["expected_sha256"] else "invalid"
        outcome, error = "succeeded", ""
        if scenario == "inspection-failure":
            outcome, result, error = "failed", None, "Caller inspection failed."
        elif node_id == "inspect":
            outcome, result = branch, {"sha256": actual, "branch": branch,
                                       "valid": branch == "valid", "invalid": branch == "invalid"}
        elif scenario == "cancel":
            progress_args = {"run_id": run_id, "node_id": node_id, "command_id": "cooperative-static-cancel",
                             "progress_json": '{"cancellationRequested":true,"message":"Caller observes cancellation."}'}
            record["progress_args"] = progress_args
            record["progress"] = call("progress", **progress_args)
            outcome, result, error = "failed", None, "Caller cooperatively cancelled."
        elif scenario == "io-failure":
            try:
                (directory / "caller-missing-input").read_bytes()
                raise AssertionError("Missing caller input unexpectedly exists.")
            except FileNotFoundError:
                outcome, result, error = "failed", {"code": "ENOENT"}, "Caller input disappeared."
        elif node_id == "record-valid":
            (directory / "validated.txt").write_text(actual + "\n")
            result = {"artifact": "validated.txt", "sha256": hashlib.sha256((directory / "validated.txt").read_bytes()).hexdigest()}
        elif node_id == "repair":
            (directory / "repaired.txt").write_bytes((fixture / "workspace/recipe-input.txt").read_bytes())
            result = {"artifact": "repaired.txt", "sha256": hashlib.sha256((directory / "repaired.txt").read_bytes()).hexdigest()}
        else:
            assert node_id == "finish"
            artifact = "validated.txt" if branch == "valid" else "repaired.txt"
            result = {"branch": branch, "artifact": artifact, "sha256": hashlib.sha256((directory / artifact).read_bytes()).hexdigest()}
            (directory / "archive.json").write_text(json.dumps(result, separators=(",", ":")))
        args = {"run_id": run_id, "node_id": node_id, "outcome": outcome, "command_id": scenario + "-" + node_id,
                "result_json": json.dumps(result, separators=(",", ":"), sort_keys=True), "error": error, "detail": "full"}
        if node_id == "inspect":
            record["bad_case"] = call("report", **{**args, "outcome": "succeeded"})
        current = call("report", **args)
        assert current["ok"], current
        record["reports"].append({"args": args, "response": current})
    record["final"] = call("get", run_id=run_id)
    record["replay"] = call("report", **record["reports"][0]["args"])
    record["conflict"] = call("report", **{**record["reports"][0]["args"], "result_json": '{"changed":true}'})
    assert record["final"]["status"] == ("completed" if scenario in ("valid", "invalid") else "failed")
    trace["scenarios"][scenario] = record

print(json.dumps(trace, separators=(",", ":"), sort_keys=True))
