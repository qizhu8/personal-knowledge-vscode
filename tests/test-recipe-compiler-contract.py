"""Cross-language Library authoring uses the actual shipped compiler, not a Python clone."""
import copy
import importlib.util
import json
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("recipe_runtime", ROOT / "resources/recipe_runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

definition = {
    "schema": "pkm.workflow.definition/v1",
    "spec": {
        "inputs": {"label": {"type": "string", "required": False, "nullable": False,
                             "schema": {}, "default": "e\u0301"}},
        "nodes": [
            {"nodeId": "z_source", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": [],
             "generalInstruction": " 来源 e\u0301 "},
            {"nodeId": "b_finish", "kind": "pkm.step.noop/v1", "config": {},
             "dependsOn": [{"from": "z_source"}, {"from": "a_start", "accept": ["skipped", "succeeded"]}]},
            {"nodeId": "a_start", "kind": "pkm.step.noop/v1", "config": {}, "dependsOn": []},
        ],
        "outputs": {},
        "completion": {"requiredNodes": ["b_finish"]},
    },
}


def actual_compiler(value):
    result = subprocess.run(["node", "-e", """
const fs=require('fs');
const c=require('./dist/workflows/workflow-contracts');
process.stdout.write(JSON.stringify(c.compileWorkflowDefinitionV1(JSON.parse(fs.readFileSync(0,'utf8')))));
"""], cwd=ROOT, input=json.dumps(value), text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


compiled = actual_compiler(definition)
assert compiled["ok"], compiled
assert runtime._compile_definition(definition) == compiled
permuted = copy.deepcopy(definition)
permuted["spec"]["nodes"].reverse()
permuted["spec"]["nodes"][1]["dependsOn"].reverse()
assert runtime._compile_definition(permuted)["executableDigest"] == compiled["executableDigest"]
assert runtime._fingerprint(definition) != compiled["executableDigest"]

for canonical in (False, True):
    with tempfile.TemporaryDirectory(prefix="pkm-recipe-contract-") as directory:
        root = pathlib.Path(directory)
        state = root / ".pkm/state"
        state.mkdir(parents=True)
        payload = {"state": {"rootId": "root", "projects": [], "threads": [], "recipes": []}, "receipts": []}
        (state / "projects.json").write_text(json.dumps({
            "schema": 1, "storeVersion": 1, "payload": payload, "digest": runtime._fingerprint(payload),
        }), encoding="utf-8")
        if canonical:
            (root / "recipes").mkdir()
            (state / "recipe-store.json").write_text('{"schema":1}', encoding="utf-8")
        recipe, replayed = runtime._author_recipe_from_skill(
            root, "Unicode 来源", "description", "Examples", definition, "author",
            "knowledge_source", "a" * 64)
        assert not replayed
        assert recipe["definition"] == compiled["model"]
        assert recipe["executableDigest"] == compiled["executableDigest"]
        assert recipe["nodeBindings"][0]["nodeId"] == "z_source", "binding must survive compiler sorting"
        assert runtime._author_recipe_from_skill(
            root, "Unicode 来源", "description", "Examples", definition, "author",
            "knowledge_source", "a" * 64)[1]
        explicit, _ = runtime._author_recipe_from_skill(
            root, "Explicit", "", "Examples", permuted, "explicit",
            "knowledge_source", "a" * 64, source_skill_node_id="z_source")
        assert explicit["nodeBindings"][0]["nodeId"] == "z_source"
        assert len(runtime._project_recipes(root)) == 2
        # Validate the serialized Recipe through the real Sync validator.
        subprocess.run(["node", "-e", """
const fs=require('fs'),s=require('./dist/sync/github-sync');
const r=JSON.parse(fs.readFileSync(0,'utf8'));
s.validateGitHubSyncCandidate('recipes/Examples/Test.'+r.recipeId+'.json',Buffer.from(JSON.stringify(r)));
"""], cwd=ROOT, input=json.dumps(recipe), text=True, check=True)
        try:
            runtime._author_recipe_from_skill(root, "Invalid", "", "", definition, "bad",
                                            "knowledge_source", "a" * 64, source_skill_node_id="missing")
            raise AssertionError("missing node must fail")
        except ValueError as error:
            assert "source_skill_node_id" in str(error)

# Ports, loops and control are transported verbatim and normalized by TS.
control = copy.deepcopy(definition)
control["spec"]["nodes"][0]["ports"] = {"inputs": ["z", "a"], "outputs": ["y", "b"]}
control["spec"]["nodes"][0]["control"] = {"mode": "repeat", "count": {"kind": "fixed", "value": 2}}
control["spec"]["nodes"][1]["dependsOn"][0]["loop"] = {
    "termination": {"condition": " done ", "maxIterations": 3}}
assert runtime._compile_definition(control) == actual_compiler(control)
try:
    runtime._compile_definition({"schema": "invalid"})
    raise AssertionError("invalid definition must fail closed")
except ValueError as error:
    assert "Recipe definition is invalid" in str(error) and '"pointer"' in str(error)

# Installed MCP runtime uses explicit executable/contracts paths, not a PATH guess.
with tempfile.TemporaryDirectory(prefix="pkm-installed-compiler-") as directory:
    installed = pathlib.Path(directory)
    for name in ("recipe_runtime.py", "recipe_health.py", "recipe_compiler_bridge.js"):
        shutil.copyfile(ROOT / "resources" / name, installed / name)
    (installed / "recipe_compiler_config.json").write_text(json.dumps({
        "executable": shutil.which("node"),
        "contracts": str(ROOT / "dist/workflows/workflow-contracts.js"),
    }), encoding="utf-8")
    installed_spec = importlib.util.spec_from_file_location("installed_recipe_runtime", installed / "recipe_runtime.py")
    installed_runtime = importlib.util.module_from_spec(installed_spec)
    installed_spec.loader.exec_module(installed_runtime)
    assert installed_runtime._compile_definition(definition) == compiled
    (installed / "recipe_compiler_config.json").write_text(json.dumps({
        "executable": str(installed / "missing-node"),
        "contracts": str(ROOT / "dist/workflows/workflow-contracts.js"),
    }), encoding="utf-8")
    try:
        installed_runtime._compile_definition(definition)
        raise AssertionError("unavailable compiler must never fall back to raw hashing")
    except RuntimeError as error:
        assert "could not run" in str(error)

    # Upgrade the compiler without reloading this already-imported Python runtime.
    extension = installed / "extension-3.2.48"
    for version in ("3.2.48", "3.2.49"):
        extension = installed / ("extension-" + version)
        (extension / "dist/workflows").mkdir(parents=True)
        (extension / "package.json").write_text(json.dumps({"version": version}))
        for name in ("workflow-contracts.js", "value-contracts.js"):
            shutil.copyfile(ROOT / "dist/workflows" / name, extension / "dist/workflows" / name)
        if version == "3.2.48":
            (installed / "recipe_compiler_config.json").write_text(json.dumps({
                "executable": shutil.which("node"),
                "contracts": str(extension / "dist/workflows/workflow-contracts.js"),
            }))
            assert installed_runtime._compile_definition(definition) == compiled
        subprocess.run(["node", "-e", """
const {ensureRecipeCompiler}=require(process.argv[1]);
ensureRecipeCompiler(process.argv[2],process.argv[3],process.execPath);
""", str(ROOT / "dist/mcp/recipe-compiler.js"), str(extension), str(installed)], check=True)
        shutil.rmtree(extension)
        assert installed_runtime._compile_definition(definition) == compiled
        config = json.loads((installed / "recipe_compiler_config.json").read_text())
        assert config["extensionVersion"] == version
        assert str(installed / "recipe-compiler") in config["contracts"]
    older = installed / "older-host"
    older.mkdir()
    (older / "package.json").write_text('{"version":"3.2.48"}')
    result = subprocess.run(["node", "-e", """
require(process.argv[1]).ensureRecipeCompiler(process.argv[2],process.argv[3],process.execPath);
""", str(ROOT / "dist/mcp/recipe-compiler.js"), str(older), str(installed)], capture_output=True, text=True)
    assert result.returncode != 0 and "newer extension 3.2.49" in result.stderr
    assert json.loads((installed / "recipe_compiler_config.json").read_text()) == config
    config["contracts"] = str(installed / "missing-contracts.js")
    (installed / "recipe_compiler_config.json").write_text(json.dumps(config))
    try:
        installed_runtime._compile_definition(definition)
        raise AssertionError("missing contracts must be actionable")
    except RuntimeError as error:
        assert str(installed / "recipe_compiler_config.json") in str(error)
        assert config["contracts"] in str(error)
print("Recipe Python/TypeScript compiler contract tests passed")
