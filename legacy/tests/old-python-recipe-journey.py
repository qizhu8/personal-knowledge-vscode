"""Exact old Recipe runtime qualification, private fixtures only; not a new execution API."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
import zipfile


def main():
    root, archive, node, prefix = map(Path, sys.argv[1:])
    assert root.is_absolute() and root.is_dir()
    original_archive_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert original_archive_digest == "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27"
    extracted = root / "exact-old"
    with zipfile.ZipFile(archive) as source:
        for name in source.namelist():
            relative = name.removeprefix("extension/")
            if name.startswith("extension/dist/workflows/") and name.endswith(".js") or relative in {
                "resources/recipe_runtime.py", "resources/recipe_health.py", "resources/node_runtime.py"
            }:
                target = extracted / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read(name))
    resources = extracted / "resources"
    (resources / "recipe_compiler_config.json").write_text(json.dumps({
        "executable": str(node), "contracts": str(extracted / "dist/workflows/workflow-contracts.js")
    }))
    sys.path.insert(0, str(resources))
    spec = importlib.util.spec_from_file_location("exact_old_recipe", resources / "recipe_runtime.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    store = root / "legacy-recipe-store"
    store.mkdir()
    registry = root / "legacy-recipe-registry.json"
    original_registry = root / "old-manager/registry/registry.json"
    original_registry_digest = hashlib.sha256(original_registry.read_bytes()).hexdigest()
    records = json.loads(original_registry.read_text())
    assert len(records) == 1 and records[0]["id"] == "legacy-conda"
    assert records[0]["path"] == str(prefix) and records[0]["python"] == str(prefix / "bin/python")
    legacy_id = records[0]["id"]
    records += [
        {"id": "missing-python", "name": "Unavailable", "manager": "conda",
         "path": str(root / "absent"), "python": str(root / "absent/bin/python")},
    ]
    registry.write_text(json.dumps(records))
    registry_digest = hashlib.sha256(registry.read_bytes()).hexdigest()

    class PrivateTools:
        def __init__(self):
            self.tools = {}
            self.annotations = {}

        def tool(self, annotations=None):
            def register(function):
                self.tools[function.__name__] = function
                self.annotations[function.__name__] = annotations or {}
                return function
            return register

    def connect():
        tools = PrivateTools()
        module.register_recipe_tools(tools, store, environments_registry=registry)
        return tools

    connection = connect()
    allowed = None
    owned_runs = set()

    def call(name, *args, **kwargs):
        assert name in {"recipe_run_start_adhoc", "recipe_run_next", "recipe_run_get", "recipe_run_progress"}
        if name == "recipe_run_start_adhoc":
            assert args[1] == allowed, "Only exact native fixture definitions may execute."
            assert kwargs.get("autonomous", False) is False, "Preserve the old default-lazy behavior."
        else:
            assert args[0] in owned_runs, "No unrelated run access."
        result = connection.tools[name](*args, **kwargs)
        if isinstance(result, str):
            result = json.loads(result)
        if name == "recipe_run_start_adhoc":
            assert result["ok"], result
            owned_runs.add(result["run_id"])
        return result

    def definition(script, environment=legacy_id, args=()):
        return json.dumps({"schema": "pkm.workflow.definition/v1", "spec": {
            "inputs": {}, "outputs": {}, "nodes": [{"nodeId": "python", "kind": "pkm.step.script/v1",
                "dependsOn": [], "config": {"runtime": "python", "environmentId": environment,
                    "script": script, "args": list(args), "timeoutSeconds": 20, "maxOutputBytes": 4096}}],
            "completion": {"requiredNodes": ["python"]}}})

    def wait(run_id):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            result = call("recipe_run_get", run_id)
            if result["status"] != "running":
                return result
            time.sleep(0.05)
        raise AssertionError("Old Recipe background worker did not finish.")

    effect = root / "old-script-effect.txt"
    args = [str(effect), "two words", "--not-cli", "$(touch never-created)", "中文", ""]
    script = ("import json,sys\nfrom pathlib import Path\n"
              "p=Path(sys.argv[1]);p.write_text(p.read_text()+'effect\\n' if p.exists() else 'effect\\n')\n"
              "print(json.dumps({'args':sys.argv[2:],'prefix':sys.prefix},ensure_ascii=False))")
    allowed = definition(script, args=args)
    started = call("recipe_run_start_adhoc", "Exact old Python", allowed, "old-controlled-start")
    time.sleep(0.1)
    assert not effect.exists(), "Old default-lazy start must not be changed into auto-run."
    call("recipe_run_next", started["run_id"], "old-controlled-next")
    completed = wait(started["run_id"])
    assert completed["status"] == "completed", completed
    result = completed["current_result"]["completed_nodes"][-1]["result"]
    assert result["argv"][0] == str(prefix / "bin/python"), result
    assert json.loads(result["stdout"]) == {"args": args[1:], "prefix": str(prefix)}
    assert effect.read_text() == "effect\n"
    assert not Path(result["argv"][1]).exists(), "Original runtime must clean its generated script."

    allowed = definition("raise SystemExit('must never execute')", environment="missing-python")
    missing = call("recipe_run_start_adhoc", "Missing original Python", allowed, "old-missing-start")
    call("recipe_run_next", missing["run_id"], "old-missing-next")
    refused = wait(missing["run_id"])
    assert refused["status"] == "failed", refused
    assert "missing" in json.dumps(refused).lower()

    marker = root / "old-cancel-started.txt"
    allowed = definition("import sys,time\nfrom pathlib import Path\nPath(sys.argv[1]).write_text('started')\n"
                         "while True: time.sleep(0.1)", args=[str(marker)])
    cancellable = call("recipe_run_start_adhoc", "Exact old cancellation", allowed, "old-cancel-start")
    call("recipe_run_next", cancellable["run_id"], "old-cancel-next")
    deadline = time.monotonic() + 20
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert marker.exists()
    cancellation = call("recipe_run_progress", cancellable["run_id"], "python", "old-cancel-request",
                        '{"cancellationRequested":true}')
    assert cancellation["ok"], cancellation
    cancelled = wait(cancellable["run_id"])
    cancellation_result = cancelled["current_result"]["completed_nodes"][-1]["result"]
    assert cancellation_result["cancelled"] is True, cancelled

    connection = connect()
    reopened = call("recipe_run_get", started["run_id"])
    assert reopened["status"] == "completed" and effect.read_text() == "effect\n"
    assert call("recipe_run_get", cancellable["run_id"])["status"] == cancelled["status"]
    assert hashlib.sha256(registry.read_bytes()).hexdigest() == registry_digest
    assert hashlib.sha256(original_registry.read_bytes()).hexdigest() == original_registry_digest
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == original_archive_digest
    evidence = {"scope": "exact old resource runtime, decorated private callbacks and real compiler/worker/subprocess; not HTTP/MCP authentication qualification",
                "arbitraryScriptEndpointAdded": False, "exactFixtureAllowlist": True,
                "defaultLazyStartPreserved": True, "actualCondaEnvironmentBound": True, "exactArgvVerified": True,
                "missingRuntimeFailedNotSuccessful": True, "actualCancellation": True,
                "oldCancelledStatus": cancelled["status"], "reopenedReceiptsWithoutReplay": True,
                "effects": 1, "originalVsixAndRegistryUnchanged": True,
                "originalCreatorRegistryUnchanged": True, "originalEnvironmentIdAndFullRecordPreserved": True,
                "runtimeSourceSha256": hashlib.sha256((resources / "recipe_runtime.py").read_bytes()).hexdigest(),
                "oldGetToolAnnotations": connection.annotations["recipe_run_get"]}
    (root / "old-python-recipe-evidence.json").write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence))


if __name__ == "__main__":
    main()
