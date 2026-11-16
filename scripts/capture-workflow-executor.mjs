import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { checkCaptureRecords, checkNativeRecords } from "./migration.mjs";

const server = resolve(import.meta.dirname, ".."), root = resolve(server, "legacy");
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || !["--check", "--refresh-native"].includes(args[0]))) {
  throw new Error("Usage: node scripts/capture-workflow-executor.mjs [--check|--refresh-native]");
}
const nativeFiles = [
  "src/workflow-executor.ts", "src/workflow-executor-contracts.ts", "src/domain/workflow-executor-state.ts",
  "tests/workflow-executor.test.mjs", "tests/workflow-executor-fixtures.mjs",
  "tests/workflow-executor-restart-child.mjs",
];
if (args[0] === "--check") {
  const record = JSON.parse(await readFile(resolve(server, "migration/workflow-executor-provenance.json"), "utf8"));
  const issues = await checkCaptureRecords(record.files, undefined, undefined, {
    dataset: "runtime-workflow-executor-historical",
  });
  for (const dependency of record.dependencies) {
    if (createHash("sha256").update(await readFile(resolve(root, dependency.source))).digest("hex") !== dependency.sourceSha256) {
      issues.push({ kind: "dependency", path: dependency.source, reason: "hash-changed" });
    }
  }
  issues.push(...await checkNativeRecords(record.native));
  if (issues.length) throw new Error(JSON.stringify(issues));
  console.log(`workflow-executor: ${record.files.length} historical captures and ${record.native.length} selected native pins verified`);
} else if (args[0] === "--refresh-native") {
  const path = resolve(server, "migration/workflow-executor-provenance.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  const issues = await checkCaptureRecords(record.files);
  for (const dependency of record.dependencies) {
    if (createHash("sha256").update(await readFile(resolve(root, dependency.source))).digest("hex") !== dependency.sourceSha256) {
      issues.push({ kind: "dependency", path: dependency.source, reason: "hash-changed" });
    }
  }
  if (issues.length) throw new Error(JSON.stringify(issues));
  record.native = await Promise.all(nativeFiles.map(async file => ({
    file, sha256: createHash("sha256").update(await readFile(resolve(server, file))).digest("hex"),
  })));
  const bytes = JSON.stringify(record, null, 2) + "\n";
  if (bytes !== await readFile(path, "utf8")) await writeFile(path, bytes);
  console.log(`workflow-executor provenance: ${record.files.length} unchanged captures; ${record.native.length} refreshed native pins`);
} else {
const outputs = new Map();
function emit(path, content) { outputs.set(resolve(server, path), content); }
const hash = text => createHash("sha256").update(text).digest("hex");
const files = [];
const selections = {
  "resources/action_run_store.py": ["prepare", "claim", "finish", "transition"],
  "resources/action_recovery.py": ["step_result", "step_commit"],
  "resources/recipe_runtime.py": ["_ready_nodes", "_skip_unselected_nodes", "_execute_native_operation", "_apply_loop_outcome"],
  "tests/test-action-durable-runs.py": ["test_duplicate_worker_and_stale_completion_are_fenced", "test_parallel_duplicate_submission_after_host_crash_executes_once"],
  "tests/test-action-recovery-e2e.py": ["test_expired_live_worker_lease_fences_effect_completion", "test_deadline_review_cancel_and_no_auto_replay"],
};
const actionSource = JSON.parse(execFileSync(process.env.PYTHON ?? "python3", ["-c", `
import ast,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
selections=json.loads(sys.argv[2])
captured={}
for path,names in selections.items():
    text=(root/path).read_text(encoding="utf-8")
    tree=ast.parse(text)
    functions={node.name:ast.get_source_segment(text,node) for node in ast.walk(tree) if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name in names}
    if set(functions)!=set(names): raise ValueError("Source capture boundary changed: "+path)
    captured[path]=functions
print(json.dumps(captured))
`, root, JSON.stringify(selections)], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
const capturedAction = "src/domain/workflow-executor-action-source.ts";
const actionText = `// Source evidence only; these filesystem/Python adapters are not executed by the native scheduler.\nexport const workflowExecutorOriginalActionSource = ${JSON.stringify(actionSource, null, 2)} as const;\n`;
emit(capturedAction, actionText);
for (const source of Object.keys(selections)) files.push({
  source, captured: capturedAction, sourceSha256: hash(await readFile(resolve(root, source))), capturedSha256: hash(actionText),
});
for (const [source, captured, transform] of [
  ["src/workflows/executor-model.ts", "src/domain/workflow-executor-original.ts",
    text => text.replace('"./workflow-contracts"', '"./project-recipes-workflow-contracts.js"')],
  ["tests/test-workflow-executor-model.js", "tests/workflow-executor-original.test.mjs",
    text => text.replace("#!/usr/bin/env node\n", "")
      .replace('const assert = require("assert");', 'import assert from "node:assert/strict";')
      .replace('const executor = require("../dist/workflows/executor-model.js");', 'import * as executor from "../dist/domain/workflow-executor-original.js";')],
]) {
  const original = await readFile(resolve(root, source), "utf8"), output = transform(original);
  emit(captured, output);
  files.push({ source, captured, sourceSha256: hash(original), capturedSha256: hash(output) });
}
const dependencies = [];
for (const source of [
  "src/workflows/scheduler-model.ts", "src/workflows/control-model.ts", "src/workflows/runtime-model.ts",
  "src/workflows/workflow-contracts.ts", "tests/test-workflow-scheduler-model.js",
  "tests/test-workflow-control-model.js", "tests/test-workflow-runtime-model.js",
]) {
  dependencies.push({ source, sourceSha256: hash(await readFile(resolve(root, source))) });
}
const native = [];
for (const file of nativeFiles) native.push({ file, sha256: hash(await readFile(resolve(server, file))) });
emit("migration/workflow-executor-provenance.json", JSON.stringify({
  schema: "pkm.domain-capture/v1",
  qualification: "bounded-native-injected-executor-not-full-scheduler-parity",
  transformation: "Original executor reducer and original regression suite with ESM import rewrite only. AST-selected original Action/Recipe reducers and real original regression methods are source evidence, not executed Python parity tests. Existing captured scheduler reducers govern offers, claims, leases, revocation and output authority. New SQLite executor uses explicit injected native adapters and exact host definition/source authorization; no public completion/result submission.",
  qualified: ["dependency DAG", "declared native branch verdicts", "fixed repeat", "bounded self-loop with native termination verdict", "failure and cancellation closure", "lease expiry fencing", "committed start intent", "no replay of interrupted running effects", "exact adapter/output-contract pins", "actor isolation", "definition/source pins"],
  unavailable: ["cron", "multi-node loop bodies", "dynamic repeats/cases", "general expression evaluation", "subflows", "human gates", "automatic process/tool/model adapters", "run output mapping", "distributed effect rollback", "automatic effect retries", "exact safe reconciliation", "full original executor profile/attestation parity"],
  files, dependencies, native,
}, null, 2) + "\n");
for (const [path, content] of outputs) {
  let actual;
  try { actual = await readFile(path, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (actual === content) continue;
  if (args[0] === "--check") throw new Error(`Workflow executor capture is stale: ${path}`);
  await writeFile(path, content);
}
}
