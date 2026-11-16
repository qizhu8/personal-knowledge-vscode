import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";

const server = resolve(import.meta.dirname, "..");
const root = resolve(server, "legacy");
const hash = value => createHash("sha256").update(value).digest("hex");
const files = [];
async function capture(source, captured, transform) {
  const original = await readFile(resolve(root, source), "utf8");
  const output = transform(original);
  await writeFile(resolve(server, captured), output);
  files.push({ source, captured, sourceSha256: hash(original), capturedSha256: hash(output) });
}
for (const name of ["runtime", "scheduler"]) {
  await capture(`src/workflows/${name}-model.ts`, `src/domain/workflow-runtime-${name}.ts`, text => text);
  await capture(`tests/test-workflow-${name}-model.js`, `tests/workflow-runtime-original-${name}.test.mjs`,
    text => text.replace("#!/usr/bin/env node\n", "")
      .replace('const assert = require("assert");', 'import assert from "node:assert/strict";')
      .replace(`const ${name} = require("../dist/workflows/${name}-model.js");`,
        `import * as ${name} from "../dist/domain/workflow-runtime-${name}.js";`));
}
const excluded = new Set([
  "VersionTuple", "EvidenceCitation", "GateChallenge", "GateDecisionResult", "createGateChallenge", "decideGate",
  "SubflowLock", "SubflowBinding", "SubflowState", "SubflowMutation", "createSubflowState", "bindSubflow",
  "mapSubflowResult", "normalizeEvidence", "validateTuple", "DIGEST",
]);
await capture("src/workflows/control-model.ts", "src/domain/workflow-runtime-control.ts", text => {
  const source = ts.createSourceFile("control.ts", text, ts.ScriptTarget.Latest, true);
  return source.statements.filter(node => {
    const name = node.name?.text ?? (ts.isVariableStatement(node)
      ? node.declarationList.declarations[0].name.getText(source) : "");
    return !excluded.has(name);
  }).map(node => node.getText(source)).join("\n\n")
    .replace('"./workflow-contracts"', '"./project-recipes-workflow-contracts.js"') + "\n";
});
await writeFile(resolve(server, "migration/workflow-runtime-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "Original pure runtime and scheduler reducers unchanged; original runtime/scheduler regressions ESM import rewrites only. AST-selected control expressions, branch/merge/join and loop budgets; human gates and subflow authority deliberately omitted. Durable SQLite adapter is new, not a capture of filesystem journal storage. No executor, provider, process or network adapters.",
  files,
}, null, 2) + "\n");
