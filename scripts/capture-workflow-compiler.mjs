import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

const root = resolve(packageRoot, "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--check")) {
  throw new Error("Usage: node scripts/capture-workflow-compiler.mjs [--check]");
}
async function emit(path, content) {
  const full = resolve(packageRoot, path);
  if (args[0] === "--check") {
    if (await readFile(full, "utf8") !== content) throw new Error(`Workflow compiler capture is stale: ${path}`);
  } else await writeFile(full, content);
}
const files = [];
async function text(source) { return readFile(resolve(root, source), "utf8"); }
async function record(source, captured) {
  files.push({ source, captured, sourceSha256: hash(await text(source)),
    capturedSha256: hash(await readFile(resolve(packageRoot, captured))) });
}
function declarations(source, names) {
  const parsed = ts.createSourceFile("capture.ts", source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const matches = parsed.statements.filter(node =>
      node.name?.text === name || (ts.isVariableStatement(node)
        && node.declarationList.declarations.some(item => item.name.getText(parsed) === name)));
    if (matches.length !== 1) throw new Error(`Workflow capture boundary changed: ${name}`);
    return matches[0].getText(parsed);
  }).join("\n\n");
}
const catalogSource = "src/workflows/catalog-model.ts";
const catalogTarget = "src/domain/workflow-compiler-catalog.ts";
await emit(catalogTarget, `import { createHash } from "node:crypto";
import { canonicalJson } from "./project-recipes-workflow-contracts.js";
import { type WorkflowPortDescriptor, normalizePortDescriptor } from "./project-recipes-value-contracts.js";

${declarations(await text(catalogSource), [
  "NodeKindSupportState", "AdapterClass", "NodeKindRegistration", "NodeKindRegistry",
  "WorkflowCatalogError", "KIND_ID", "DIGEST", "BUILTIN_NODE_KIND_IDS",
  "digestCanonical", "createNodeKindRegistry", "createBuiltinNodeKindRegistry",
  "normalizeRegistration", "normalizePorts", "builtinRegistration", "normalizeSet", "deepFreeze",
])}
`);
await record(catalogSource, catalogTarget);
const bindingSource = "src/workflows/project-model.ts";
const bindingTarget = "src/domain/workflow-compiler-bindings.ts";
await emit(bindingTarget, `import type { RecipeKnowledgeBinding } from "../project-recipes-contracts.js";
type RecipeNodeBindings = { nodeId: string; bindings: RecipeKnowledgeBinding[] };
class ProjectModelError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

${declarations(await text(bindingSource), ["normalizeRecipeNodeBindings"])
  .replace("function normalizeRecipeNodeBindings(", "export function normalizeRecipeNodeBindings(")}
`);
await record(bindingSource, bindingTarget);

const testSource = "tests/test-workflow-contracts.js";
const testTarget = "tests/workflow-compiler-original.test.mjs";
let regression = await text(testSource);
const fixtures = {
  schema: "definition.schema.json", orderRegistry: "canonical-order.json",
  diagnosticRegistry: "diagnostics.json", yamlProfile: "yaml-profile.json",
  positiveFixture: "fixtures/minimal-noop.json", negativeFixture: "fixtures/rejected-duplicates.json",
};
regression = regression.replace('#!/usr/bin/env node\n', "")
  .replace('const assert = require("assert");', 'import assert from "node:assert/strict";')
  .replace('const fs = require("fs");\nconst path = require("path");\n', "")
  .replace('const { canonicalJson, compileWorkflowDefinitionV1 } = require("../dist/workflows/workflow-contracts.js");',
    'import { canonicalJson, compileWorkflowDefinitionV1 } from "../dist/domain/project-recipes-workflow-contracts.js";')
  .replace('const valueContracts = require("../dist/workflows/value-contracts.js");',
    `import * as capturedValueContracts from "../dist/domain/project-recipes-value-contracts.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const valueContracts = { ...capturedValueContracts };
const module = { exports: {} };
const localRequire = createRequire(import.meta.url);
const compilerSource = readFileSync(new URL("../src/domain/project-recipes-workflow-contracts.ts", import.meta.url), "utf8");
const compilerCommonJs = ts.transpileModule(compilerSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;
runInNewContext(compilerCommonJs, {
  exports: module.exports, module, Buffer,
  require: name => name === "./project-recipes-value-contracts.js" ? valueContracts : localRequire(name),
});
const compileWorkflowWithMutableValues = module.exports.compileWorkflowDefinitionV1;`)
  .replace('const canonicalFailure = compileWorkflowDefinitionV1(definition({ inputs: { broken: {} } }));',
    'const canonicalFailure = compileWorkflowWithMutableValues(definition({ inputs: { broken: {} } }));')
  .replace('const root = path.resolve(__dirname, "..");\nconst contracts = path.join(root, "resources", "workflow-contracts", "v1");\n', "")
  .replace('const fixtures = path.join(contracts, "fixtures");\n', "");
for (const [name, path] of Object.entries(fixtures)) {
  const expression = new RegExp(`const ${name} = JSON\\.parse\\(fs\\.readFileSync\\([^\\n]+\\);`);
  if (!expression.test(regression)) throw new Error(`Workflow regression capture changed: ${name}`);
  regression = regression.replace(expression,
    `const ${name} = ${JSON.stringify(JSON.parse(await text(`resources/workflow-contracts/v1/${path}`)))};`);
}
await emit(testTarget, regression);
await record(testSource, testTarget);
for (const path of Object.values(fixtures)) await record(`resources/workflow-contracts/v1/${path}`, testTarget);
// Reuse the already captured validators; never maintain a second compiler.
await record("src/workflows/workflow-contracts.ts", "src/domain/project-recipes-workflow-contracts.ts");
await record("src/workflows/value-contracts.ts", "src/domain/project-recipes-value-contracts.ts");
await emit("migration/workflow-compiler-provenance.json", JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST capture of original catalog descriptor/registry reads and Recipe binding normalization; original compiler regression with embedded original JSON fixtures and ESM import rewrites. Reuses project-recipes compiler/value captures unchanged. Host compiler artifact installer, execution, natural-language generation, publication and run lifecycle mutations are intentionally excluded.",
  files,
}, null, 2) + "\n");
