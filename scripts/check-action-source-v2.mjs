import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ACTION_SOURCE_V2_CAPTURE as capture } from "../src/domain/action-source-v2-original.ts";

if (process.argv.length !== 3 || process.argv[2] !== "--check")
  throw new Error("Usage: node scripts/check-action-source-v2.mjs --check (read-only fixture verification, not qualification)");

const root = new URL(`../${capture.sourceRoot}/`, import.meta.url);
for (const [path, expected] of Object.entries(capture.sourceHashes)) {
  const actual = createHash("sha256").update(await readFile(new URL(path, root))).digest("hex");
  assert.equal(actual, expected, `Versioned Action source changed: ${path}; create and qualify a new identity, never overwrite this capture.`);
}
const result = spawnSync("python3", ["-c", `
import ast,hashlib,json,sys
from pathlib import Path
path=Path(sys.argv[1])/"resources/action_components.py"
tree=ast.parse(path.read_text(encoding="utf-8"))
names={"component_scripts","component_engine_hash"}
nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
if len(nodes)!=len(names): raise ValueError("Ambiguous component identity functions")
scope={"__file__":str(path),"Path":Path,"hashlib":hashlib,"json":json}
exec(compile(ast.Module(body=nodes,type_ignores=[]),"<versioned-component-identity>","exec"),scope)
sys.path.insert(0,str(path.parent))
from action_modules import ModuleRuntime,builtin_definitions
runtime=object.__new__(ModuleRuntime)
print(json.dumps({"componentEngineHash":scope["component_engine_hash"](),
 "builtinContentHashes":{key:runtime.definition_value(value)["content_hash"]
 for key,value in builtin_definitions().items()}}))
`, fileURLToPath(root)], {
  encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
if (result.status !== 0) throw new Error(result.stderr || "Cannot verify the versioned component engine.");
const actual = JSON.parse(result.stdout);
assert.equal(actual.componentEngineHash, capture.componentEngineHash, "Versioned component engine changed; new capture and qualification required.");
assert.deepEqual(actual.builtinContentHashes, capture.builtinContentHashes, "Versioned builtin contracts changed; new capture and qualification required.");
