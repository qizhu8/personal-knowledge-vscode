import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, delimiter } from "node:path";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

const sourcePath = "modules/pkm-memory-engine/src/pkm_memory_engine/engine.py";
const source = await readFile(resolve(packageRoot, "..", sourcePath), "utf8");
const testPath = "modules/pkm-memory-engine/tests/test_explicit_memory.py";
const testSource = await readFile(resolve(packageRoot, "..", testPath), "utf8");
const adapterPath = "src/capabilities/memory-operations.ts";
const adapter = await readFile(resolve(packageRoot, "..", adapterPath), "utf8");
const parsed = ts.createSourceFile(adapterPath, adapter, ts.ScriptTarget.Latest, true);
const projections = [];
function visit(node) {
  if (ts.isArrowFunction(node) && node.getText(parsed).includes('readOperation: "memory.record.get"')) projections.push(node);
  ts.forEachChild(node, visit);
}
visit(parsed);
if (projections.length !== 1 || projections[0].parameters.length !== 1) throw new Error("Original Memory preview projection boundary changed.");
const arrow = projections[0].getText(parsed).replace(/^record =>/, "(record: MemoryRecord) =>");
if (!arrow.startsWith("(record: MemoryRecord) =>")) throw new Error("Original Memory preview parameter changed.");
const projection = `import type { MemoryRecord } from "../memory-contracts.js";\nexport const projectMemoryPreview = ${arrow};\n`;
const projectedPath = "src/domain/memory-search.ts";
await writeFile(resolve(packageRoot, projectedPath), projection);
const emitted = ts.transpileModule(projection, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { projectMemoryPreview } = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString("base64")}`);
const program = `
import json, tempfile
from pathlib import Path
from pkm_memory_engine import Engine
scope = '{"account":"fixture","project":"fixture","repository":"fixture"}'
sources = [{"id":"input-1","chat":"fixture-chat","revision":"turn-1","locator":"message/input-1"}]
steps = [
 ("propose", {"operation_id":"p","content":"Use SQLite.","sources":sources}),
 ("search", {"query":"sqlite","limit":3}),
 ("confirm", {"id":"record-1","expected_revision":1,"operation_id":"c"}),
 ("get", {"id":"record-1","revision":1}),
 ("search", {"query":"SQLITE","limit":3}),
 ("revise", {"id":"record-1","expected_revision":2,"operation_id":"r","content":"Use SQLite WAL.","sources":sources}),
 ("search", {"query":"sqlite","limit":3}),
 ("confirm", {"id":"record-1","expected_revision":3,"operation_id":"c2"}),
 ("revoke", {"id":"record-1","expected_revision":4,"operation_id":"x"}),
 ("get", {"id":"record-1"}),
 ("search", {"query":"sqlite","limit":3}),
 ("audit", {"id":"record-1","after":0,"limit":10}),
]
def normalized(value):
 if isinstance(value, dict):
  return {key: ("record-1" if key=="id" else "fixture-scope" if key=="scope" else normalized(child))
          for key,child in value.items() if key not in ("created_at","updated_at","revision_created_at")}
 if isinstance(value,list): return [normalized(child) for child in value]
 return value
with tempfile.TemporaryDirectory(prefix="pkm-memory-oracle-") as directory:
 engine = Engine(Path(directory)/"fixture.sqlite", "fixture-owner")
 result = []
 try:
  for action,args in steps:
   if action=="get": value=engine.explicit_get("record-1",scope,args.get("revision"))
   elif action=="search": value={"records":engine.explicit_search(scope,args["query"],args["limit"])}
   elif action=="audit": value=engine.explicit_audit(scope,"record-1",args["after"],args["limit"])
   else:
    params={key:child for key,child in args.items() if key!="operation_id"}
    params.update(id="record-1",scope=scope)
    if action!="propose": params["host_authorization"]={"decision_id":"decision-"+args["operation_id"],"actor_id":"user:local"}
    value=engine.mutate(args["operation_id"],"explicit_"+action,params)
   result.append({"action":action,"arguments":args,"expected":normalized(value)})
 finally: engine.close()
 print(json.dumps({"schema":"pkm.memory-oracle/v1","steps":result},ensure_ascii=False,indent=2))
`;
const rawOracle = execFileSync(process.env.PKM_TEST_PYTHON || "python3", ["-c", program], {
  encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1",
    PYTHONPATH: [resolve(packageRoot, "../modules/pkm-memory-engine/src"), process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
});
const value = JSON.parse(rawOracle);
for (const step of value.steps) if (step.action === "search") {
  step.expected.records = step.expected.records.map(projectMemoryPreview);
}
const oracle = JSON.stringify(value, null, 2) + "\n";
const captured = "migration/memory-oracle.json";
await writeFile(resolve(packageRoot, captured), oracle);
await writeFile(resolve(packageRoot, "migration/memory-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "Golden lifecycle/read/audit outputs executed against the original Python Engine in a disposable temporary database. Original TypeScript preview arrow body captured unchanged with an explicit parameter type. Node tests replay the same contracts against Markdown authority. Runtime timestamps, environment-specific IDs/scope and the additive documentSha256 pin are excluded from comparison.",
  files: [
    { source: sourcePath, sourceSha256: hash(source), captured, capturedSha256: hash(oracle) },
    { source: testPath, sourceSha256: hash(testSource), captured, capturedSha256: hash(oracle) },
    { source: adapterPath, sourceSha256: hash(adapter), captured: projectedPath, capturedSha256: hash(projection) },
  ],
  qualification: "No Chat-memory/model/embedding engine, native UI, full old-layout import or production qualification is claimed. The original explicit-memory unittest suite was separately run without source changes.",
}, null, 2) + "\n");
console.log("Captured original Python explicit-memory semantic oracle without copying its SQLite authority.");
