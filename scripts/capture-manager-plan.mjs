import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const boundaries = [
  ["src/chat/tool-paths.ts", ["relativeToolPath"]],
  ["src/chat/worker-scope.ts", ["WorkerScope", "canonicalPath", "containsPath", "workerScope", "assertIndependentWorkerScopes", "assertWorkerScopeWithin"]],
  ["src/chat/worker-tree.ts", ["WorkerLimits", "workerLimits"]],
  ["src/chat/chat-work-goal.ts", ["rootWorkCriterion"]],
];
const declarations = [], sources = [];
const hash = value => createHash("sha256").update(value).digest("hex");
for (const [sourcePath, names] of boundaries) {
  const source = await readFile(resolve(repository, sourcePath), "utf8");
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  for (const name of names) {
    const nodes = ast.statements.filter(node => node.name?.text === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === name));
    if (nodes.length !== 1) throw new Error(`Original Manager boundary changed: ${sourcePath}:${name}`);
    declarations.push(nodes[0].getText(ast));
  }
  sources.push({ source: sourcePath, sourceSha256: hash(source), symbols: names });
}
const captured = "src/domain/manager-plan-original.ts";
const capturedText = "// Exact original native Manager scope/budget guards and root acceptance; regenerate with capture-manager-plan.mjs.\n"
  + declarations.join("\n\n") + "\n";
await writeFile(resolve(root, captured), capturedText);
await writeFile(resolve(root, "migration/manager-plan-provenance.json"), JSON.stringify({
  schema: "pkm.next.domain-capture/v1", sourceRoot: "..", capturedRoot: ".",
  notes: "Only the listed native Chat Manager scope/budget declarations and root acceptance constant are exact captures. New structured completion/plan validation extends the original Chat plan DAG, scope ownership, work-goal preservation and Manager-integrated verification semantics; no model, runtime, live designs or complete legacy planning implementation is claimed as captured.",
  files: sources.map(source => ({ ...source, captured, capturedSha256: hash(capturedText) })),
}, null, 2) + "\n");
