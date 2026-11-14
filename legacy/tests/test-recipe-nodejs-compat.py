"""Compare the installed 4.0.22 and current Recipe compiler with an explicit nodejs alias."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
original = Path(os.environ["PKM_LEGACY_422_PATH"]).resolve()
old_recipe = original / "resources/recipe_runtime.py"
assert hashlib.sha256(old_recipe.read_bytes()).hexdigest() == (
    "8fb3baf4e7f76a21cd953aa866fb402a8b5636e8d2afd8b3e009d9463645621c"
)
node = Path(shutil.which("node")).resolve()
definition = {
    "schema": "pkm.workflow.definition/v1",
    "spec": {
        "inputs": {},
        "nodes": [{"nodeId": "step", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": []}],
        "outputs": {},
        "completion": {"requiredNodes": ["step"]},
    },
}
with tempfile.TemporaryDirectory(prefix=".recipe-nodejs-", dir=root / ".migration-test-work") as directory:
    fixture = Path(directory)
    alias = fixture / "nodejs"
    alias.symlink_to(node)
    contracts = original / "dist/workflows/workflow-contracts.js"
    command = """
import json, sys
sys.path.insert(0, sys.argv[1])
import recipe_runtime
if hasattr(recipe_runtime, "resolve_node"):
    resolver = recipe_runtime.resolve_node
    recipe_runtime.resolve_node = lambda configured: resolver(configured, start_pid=1, environ={})
print(json.dumps(recipe_runtime._compile_definition(json.loads(sys.stdin.read())), sort_keys=True))
"""
    results = []
    for label, source in (("original", original / "resources"), ("current", root / "resources")):
        target = fixture / label
        target.mkdir()
        for name in ("recipe_runtime.py", "recipe_health.py", "recipe_compiler_bridge.js"):
            shutil.copyfile(source / name, target / name)
        if label == "current":
            shutil.copyfile(source / "node_runtime.py", target / "node_runtime.py")
        (target / "recipe_compiler_config.json").write_text(json.dumps({
            "executable": str(alias), "contracts": str(contracts),
        }), encoding="utf-8")
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        environment.pop("PKM_NODE_EXECUTABLE", None)
        result = subprocess.run(
            [sys.executable, "-c", command, str(target)], input=json.dumps(definition),
            capture_output=True, text=True, env=environment, timeout=30,
        )
        assert result.returncode == 0, f"{label}: {result.stderr}"
        results.append(json.loads(result.stdout))
    assert results[0] == results[1]
print("4.0.22 and current Recipe compiler accept the explicit nodejs alias")
