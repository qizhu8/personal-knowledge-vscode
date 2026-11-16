import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash, readOriginalSource } from "./migration.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--check")) throw new Error("Usage: node scripts/capture-resource-lifecycle.mjs [--check]");
const originalMetadata = JSON.parse(await readFile(resolve(packageRoot, "migration/resource-lifecycle-provenance.json"), "utf8"));
const originalText = async source => (await readOriginalSource(source, {
  sha256: originalMetadata.files.find(record => record.source === source)?.sourceSha256,
  dataset: "knowledge-resource-lifecycle-historical",
})).toString("utf8");
async function emit(path, content) {
  const full = resolve(packageRoot, path);
  if (args[0] === "--check") {
    if (await readFile(full, "utf8") !== content) throw new Error(`Resource lifecycle capture is stale: ${path}`);
  } else await writeFile(full, content);
}

const sourcePath = "src/knowledge/markdown-assets.ts";
const source = await originalText(sourcePath);
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
function declaration(name) {
  const matches = parsed.statements.filter(node => node.name?.getText(parsed) === name);
  if (matches.length !== 1) throw new Error(`Resource capture boundary changed: ${name}`);
  return matches[0];
}
const edit = declaration("editMarkdownAssetUnlocked");
const expressions = [];
function visit(node) {
  if (ts.isCallExpression(node) && ["markdownReferences", "rewriteMarkdownAssetReferences"].includes(node.expression.getText(parsed))) {
    expressions.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(edit);
const rewrite = expressions.filter(node => node.expression.getText(parsed) === "rewriteMarkdownAssetReferences");
const reference = expressions.filter(node => node.expression.getText(parsed) === "markdownReferences");
if (rewrite.length !== 1 || reference.length !== 1 || !ts.isPropertyAccessExpression(reference[0].parent)
  || reference[0].parent.name.text !== "some" || !ts.isCallExpression(reference[0].parent.parent)) {
  throw new Error("Original rename/delete pure-expression boundaries changed.");
}
const names = ["editMarkdownAssetUnlocked", "assertMarkdownAssetsUnshared", "assertMarkdownResourceTreeUnshared", "markdownResourceReferrer"];
const content = `import * as path from "node:path";
import { markdownReferences, localAssetReference, rewriteMarkdownAssetReferences } from "./markdown-assets.js";

export function resourceLifecycleRenameMarkdown(original: string, document: string, source: string, destination: string): string {
  return ${rewrite[0].getText(parsed)};
}

export function resourceLifecycleIsReferenced(original: string, document: string, source: string): boolean {
  return ${reference[0].parent.parent.getText(parsed)};
}

// Original destructive functions are evidence strings, never executable imports.
export const resourceLifecycleOriginalRules = ${JSON.stringify(Object.fromEntries(names.map(name => [name, declaration(name).getText(parsed)])), null, 2)} as const;
`;
const captured = "src/domain/resource-lifecycle-original.ts";
await emit(captured, content);
const filestorePath = "src/knowledge/filestore.ts";
const filestore = await originalText(filestorePath);
const filestoreAst = ts.createSourceFile(filestorePath, filestore, ts.ScriptTarget.Latest, true);
const moves = filestoreAst.statements.filter(node => node.name?.getText(filestoreAst) === "moveKnowledgePathUnlocked");
if (moves.length !== 1) throw new Error("Original filestore lifecycle boundary changed.");
const filestoreCaptured = "src/domain/resource-lifecycle-filestore.ts";
const filestoreContent = `// Evidence only: original coupled document/resource move and deletion-journal rules.\nexport const resourceLifecycleFilestoreOriginal = ${JSON.stringify(moves[0].getText(filestoreAst))};\n`;
await emit(filestoreCaptured, filestoreContent);
await emit("migration/resource-lifecycle-provenance.json", JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST-extracted original rename rewrite and delete-reference expressions, unchanged; reused captured Markdown parser. Original destructive/shared-reference and filestore journal functions retained as non-executable evidence strings.",
  files: [
    { source: sourcePath, captured, sourceSha256: hash(source), capturedSha256: hash(content), declarations: names },
    { source: filestorePath, captured: filestoreCaptured, sourceSha256: hash(filestore), capturedSha256: hash(filestoreContent), declarations: ["moveKnowledgePathUnlocked"] },
  ],
  qualification: "Pure plans only. Three-area bounded fail-closed protection strengthens the original same-area scan. No original locks, filesystem writes, rollback or deletion journal are executed. Compound journal persistence/recovery belongs to the parent.",
}, null, 2) + "\n");
console.log("Captured original resource lifecycle pure rules and filestore journal evidence.");
