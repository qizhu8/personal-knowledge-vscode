import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishCapture } from "./capture-output.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(packageRoot, "legacy");
const hash = value => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !["--check", "--capture"].includes(args[0]))) {
  throw new Error("Usage: node scripts/capture-action-compiler.mjs [--check|--capture]");
}
const check = args[0] === "--check";
const python = String.raw`
import ast, hashlib, json, os, sys
root = os.environ["PKM_REPOSITORY"]
sys.path.insert(0, os.path.join(root, "resources"))
from action_authoring import authoring_contract, definition_diagnostics, definition_schema
from action_components import component_definitions, component_engine_hash, component_scripts
from action_recovery import validate_reconciler
from action_modules import ModuleRuntime, builtin_definitions, digest

def source(path, names):
    text = open(os.path.join(root, path), encoding="utf-8").read()
    tree = ast.parse(text)
    wanted = set(names)
    found = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in wanted and node.name not in found:
                found[node.name] = ast.get_source_segment(text, node)
    missing = wanted - found.keys()
    if missing:
        raise RuntimeError("Capture boundary changed: " + ", ".join(sorted(missing)))
    return found

contract = authoring_contract()
example = contract["examples"]["cli"]
mutations = []
for label, mutate in [
    ("unsupported-kind", lambda value: value["implementations"][0].update(kind="command")),
    ("missing-program", lambda value: value["implementations"][0].pop("program")),
    ("unsupported-platform", lambda value: value["implementations"][0].update(platforms=["linux"])),
    ("invalid-args", lambda value: value["implementations"][0].update(args="python -c")),
    ("invalid-input-schema", lambda value: value["input_schema"].update(type="bogus")),
]:
    import copy
    value = copy.deepcopy(example)
    mutate(value)
    mutations.append({"id": label, "definition": value, "diagnostics": definition_diagnostics(value)})

import copy
ordered = copy.deepcopy(example)
ordered["action_id"] = "x"
ordered["effects"] = []
ordered["implementations"][0]["platforms"] = ["linux"]
module_set = {
    "schema": "pkm.action.module-set/v1",
    "module_set_id": "example.authoring",
    "version": 1,
    "name": "Example authoring fixture",
    "actions": [example["action_id"]],
    "provenance": {},
}
portable = {key: value for key, value in example.items()
            if key not in {"content_hash", "implementation_hash", "source_id"}}
content = json.dumps(portable, sort_keys=True, allow_nan=False).encode("utf-8")
module_set["files"] = {"definitions/" + example["action_id"] + ".json": hashlib.sha256(content).hexdigest()}
module_set["package_hash"] = digest(module_set)

source_hashes = {}
for path in [
    "resources/action_modules.py", "resources/action_run_store.py",
    "resources/action_recovery.py", "resources/recipe_runtime.py",
]:
    source_hashes[path] = hashlib.sha256(open(os.path.join(root, path), "rb").read()).hexdigest()
runtime = object.__new__(ModuleRuntime)
runtime_hash_fixture = runtime.definition_value(example)
builtins = {name: runtime.definition_value(value) for name, value in builtin_definitions().items()}
component_sources = sorted({
    os.path.relpath(str(path), root).replace(os.sep, "/")
    for path in component_scripts().values() if os.path.isfile(path)
})
portable = {key: value for key, value in runtime_hash_fixture.items()
            if key not in {"content_hash", "implementation_hash", "source_id"}}
content = json.dumps(portable, sort_keys=True, allow_nan=False).encode("utf-8")
module_set["files"] = {"definitions/" + example["action_id"] + ".json": hashlib.sha256(content).hexdigest()}
module_set["package_hash"] = digest({key: value for key, value in module_set.items() if key != "package_hash"})
captured = {
    "schema": definition_schema(),
    "example": example,
    "diagnostics": mutations,
    "orderedDiagnostics": definition_diagnostics(ordered),
    "orderedDefinition": ordered,
    "moduleSet": module_set,
    "moduleSetFile": content.decode("utf-8"),
    "originalRuntimeContentHash": runtime_hash_fixture["content_hash"],
    "originalRuntimeDigest": digest(runtime_hash_fixture),
    "componentDefinitions": component_definitions(),
    "builtinDefinitions": builtins,
    "componentEngineHash": component_engine_hash(),
    "componentSources": component_sources,
    "sourceHashes": source_hashes,
    "source": {
        "action_authoring": source("resources/action_authoring.py", ["definition_schema", "definition_diagnostics"]),
        "action_modules": source("resources/action_modules.py", [
            "definition_value", "validate_definition", "definition_check", "dependency_closure", "graph_definition"
        ]),
        "action_components": source("resources/action_components.py", [
            "component_engine_hash", "component_definitions", "validate_steps", "referenced_actions"
        ]),
        "action_recovery": source("resources/action_recovery.py", ["validate_reconciler"]),
    },
    "regression": {
        "test-action-authoring.py": source("tests/test-action-authoring.py", [
            "test_schema_and_nonmutating_preflight",
            "test_invalid_kinds_fields_platforms_and_schemas_have_paths",
            "test_semantic_errors_and_existing_version_are_not_persisted",
        ]),
        "test-action-modules.py": source("tests/test-action-modules.py", [
            "test_numbered_math_ports_in_executable_graph",
            "test_module_set_export_import_selective_load_and_unload",
        ]),
    },
}
print(json.dumps(captured, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
`;

const captured = JSON.parse(execFileSync(process.env.PYTHON ?? "python3", ["-c", python], {
  cwd: repository,
  env: { ...process.env, PKM_REPOSITORY: repository },
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
}));
const sourceFile = resolve(packageRoot, "src/domain/action-compiler-original.ts");
const fixturesFile = resolve(packageRoot, "tests/action-compiler-original-fixtures.mjs");
const provenancePath = resolve(packageRoot, "migration/action-compiler-provenance.json");
let qualificationStatus;
try {
  qualificationStatus = JSON.parse(await readFile(provenancePath, "utf8")).qualificationStatus;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const capturedTs = `export const ORIGINAL_ACTION_COMPILER_CAPTURE = ${JSON.stringify(captured, null, 2)} as const;\n`;
const capturedFixtures = `export const originalActionCompilerFixtures = ${JSON.stringify({
  example: captured.example,
  diagnostics: captured.diagnostics,
  orderedDiagnostics: captured.orderedDiagnostics,
  orderedDefinition: captured.orderedDefinition,
  moduleSet: captured.moduleSet,
  moduleSetFile: captured.moduleSetFile,
  originalRuntimeContentHash: captured.originalRuntimeContentHash,
  originalRuntimeDigest: captured.originalRuntimeDigest,
  componentEngineHash: captured.componentEngineHash,
  sourceHashes: captured.sourceHashes,
  builtins: captured.builtinDefinitions,
}, null, 2)};\n\nexport const originalActionCompilerSource = ${JSON.stringify(captured.source)};\nexport const originalActionCompilerRegression = ${JSON.stringify(captured.regression)};\n`;
const records = [];
for (const [source, target] of [
  ["resources/action_authoring.py", "src/domain/action-compiler-original.ts"],
  ["resources/action_modules.py", "src/domain/action-compiler-original.ts"],
  ["resources/action_components.py", "src/domain/action-compiler-original.ts"],
  ["resources/action_run_store.py", "src/domain/action-compiler-original.ts"],
  ["resources/action_recovery.py", "src/domain/action-compiler-original.ts"],
  ["resources/recipe_runtime.py", "src/domain/action-compiler-original.ts"],
  ["tests/test-action-authoring.py", "tests/action-compiler-original-fixtures.mjs"],
  ["tests/test-action-modules.py", "tests/action-compiler-original-fixtures.mjs"],
]) {
  records.push({
    source,
    captured: target,
    sourceSha256: hash(await readFile(resolve(repository, source))),
    capturedSha256: hash(target === "src/domain/action-compiler-original.ts" ? capturedTs : capturedFixtures),
  });
}
for (const source of captured.componentSources) {
  records.push({
    source,
    captured: "src/domain/action-compiler-original.ts",
    sourceSha256: hash(await readFile(resolve(repository, source))),
    capturedSha256: hash(capturedTs),
  });
}
const provenance = JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "Repeatably capture original Action JSON Schema, built-in component descriptors and engine pin, portable ModuleSet/digest fixtures, original pure validators/compiler source and selected authoring/module regression source. The Node implementation reads only explicit inline snapshots and never initializes the original ModuleRuntime, host services, credentials or filesystem paths.",
  ...(qualificationStatus === undefined ? {} : { qualificationStatus }),
  files: records,
}, null, 2) + "\n";
await publishCapture([
  [sourceFile, capturedTs],
  [fixturesFile, capturedFixtures],
  [provenancePath, provenance],
], check);
