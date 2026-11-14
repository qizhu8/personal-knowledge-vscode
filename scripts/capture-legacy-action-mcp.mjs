import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (process.argv.length !== 3 || !["--check", "--capture"].includes(mode))
  throw new Error("Usage: node scripts/capture-legacy-action-mcp.mjs --check|--capture");
const source = await readFile(resolve(root, "legacy/resources/action_modules.py"), "utf8");
const runStore = await readFile(resolve(root, "legacy/resources/action_run_store.py"), "utf8");
const result = spawnSync("python3", ["-c", `
import ast,json,sys
source=sys.stdin.read()
tree=ast.parse(source)
owner,=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=="ModuleRuntime"]
names={"templates","proposal_result"}
nodes=[n for n in owner.body if isinstance(n,ast.FunctionDef) and n.name in names]
if len(nodes)!=len(names): raise ValueError("Ambiguous Action metadata methods")
for node in nodes: node.decorator_list=[]
scope={}
exec(compile(ast.Module(body=nodes,type_ignores=[]),"<original-action-metadata>","exec"),scope)
authorize,=[n for n in owner.body if isinstance(n,ast.FunctionDef) and n.name=="authorize"]
denial=authorize.body[0].body[0].exc
if not isinstance(denial,ast.Call) or not isinstance(denial.func,ast.Name) or denial.func.id!="PermissionError":
 raise ValueError("Original Action admission contract changed")
print(json.dumps({"templates":scope["templates"](None),"proposalResult":scope["proposal_result"](
 {"proposal_id":"__proposal_id__","action_id":"__action_id__","content_hash":"__content_hash__"}),
 "admissionRequiredReason":ast.literal_eval(denial.args[0])}))
`], { input: source, encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr);
const contract = spawnSync("python3", ["-c", `
import ast,sys
source=sys.stdin.read()
nodes=[n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=="action_contract"]
if len(nodes)!=1: raise ValueError("Ambiguous Action execution contract")
print(ast.get_source_segment(source,nodes[0]))
`], { input: runStore, encoding: "utf8" });
if (contract.status !== 0) throw new Error(contract.stderr);
const captured = { source: "resources/action_modules.py",
  sha256: createHash("sha256").update(source).digest("hex"),
  executionContractSource: "resources/action_run_store.py",
  executionContractSha256: createHash("sha256").update(runStore).digest("hex"),
  executionContractFunction: contract.stdout.trimEnd(), ...JSON.parse(result.stdout) };
const bytes = `export const ORIGINAL_LEGACY_ACTION_MCP = ${JSON.stringify(captured, null, 2)} as const;\n`;
const target = resolve(root, "src/domain/legacy-action-mcp-original.ts");
if (mode === "--capture") await writeFile(target, bytes);
else if (await readFile(target, "utf8") !== bytes)
  throw new Error("Original Action MCP metadata changed; capture and requalify.");
console.log(`Original Action MCP metadata ${mode}: ${captured.sha256}`);
