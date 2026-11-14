import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash, checkCaptureRecords } from "./migration.mjs";

const sourceRoot = resolve(packageRoot, "legacy");
const files = [];
async function capture(source, captured, transform) {
  const original = await readFile(resolve(sourceRoot, source), "utf8");
  const content = transform(original);
  await writeFile(resolve(packageRoot, captured), content);
  files.push({ source, captured, sourceSha256: hash(original), capturedSha256: hash(content) });
}
function functions(source, names) {
  const parsed = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const nodes = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  if (nodes.length !== names.length) throw new Error("Original capture boundaries changed.");
  return nodes.map(node => {
    const text = node.getText(parsed);
    return text.startsWith("export ") ? text : `export ${text}`;
  }).join("\n\n") + "\n";
}
await capture("src/subscriptions/subscription-fork.ts", "src/domain/subscription-materialize-original-fork.ts",
  value => 'import { createHash } from "node:crypto";\n\n' + functions(value, ["forkRootName"]));
await capture("src/subscriptions/subscription-materialize-worker.ts", "src/domain/subscription-materialize-original-worker.ts",
  value => 'import { createHash } from "node:crypto";\n\n' + functions(value, ["hash", "safeRelativePath"]));
await capture("tests/test-subscription-fork.js", "tests/subscription-materialize-original.test.mjs", value => {
  const start = value.indexOf("  const creativeRoot =");
  const end = value.indexOf("\n  const skillPath", start);
  if (start < 0 || end < 0) throw new Error("Original test capture boundaries changed.");
  return 'import assert from "node:assert/strict";\nimport { forkRootName } from "../dist/domain/subscription-materialize-original-fork.js";\n' + value.slice(start, end).replace(/^  /gm, "") + "\n";
});
const provenance = {
  schema: "pkm.domain-capture/v1",
  transformation: "AST-selected forkRootName, worker hash and safeRelativePath function bodies unchanged, exported for isolated ESM; root-name assertions selected unchanged from original executable, with import rewritten.",
  files,
  requiredDependencies: {},
  qualification: "Pure original naming and worker primitives and tests only. No broker, network, encrypted transfer, keys, worker process or original filesystem fork execution.",
};
await writeFile(resolve(packageRoot, "migration/subscription-materialize-provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
const issues = await checkCaptureRecords(files, sourceRoot, packageRoot);
if (issues.length) throw new Error(JSON.stringify(issues));
console.log(`Captured and checked ${files.length} original sources.`);
