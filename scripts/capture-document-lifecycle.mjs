import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--check")) {
  throw new Error("Usage: node scripts/capture-document-lifecycle.mjs [--check]");
}
async function emit(path, content) {
  const full = resolve(packageRoot, path);
  if (args[0] === "--check") {
    if (await readFile(full, "utf8") !== content) throw new Error(`Document lifecycle capture is stale: ${path}`);
  } else await writeFile(full, content);
}

const sources = [
  ["src/knowledge/markdown-assets.ts", ["rebaseMarkdownAssets", "assertMarkdownAssetsUnshared", "assertMarkdownResourceTreeUnshared", "markdownResourceReferrer", "previewMarkdownAssetMigration", "migrateMarkdownAssetsForLifecycleUnlocked"]],
  ["src/knowledge/filestore.ts", ["moveMarkdownPair", "writeKnowledgeMarkdownUnlocked", "moveKnowledgePathUnlocked"]],
];
const files = [];
for (const [source, names] of sources) {
  const raw = await readFile(resolve(packageRoot, "..", source), "utf8");
  const ast = ts.createSourceFile(source, raw, ts.ScriptTarget.Latest, true);
  const declarations = Object.fromEntries(names.map(name => {
    const matches = ast.statements.filter(node => node.name?.getText(ast) === name);
    if (matches.length !== 1) throw new Error(`Document lifecycle capture boundary changed: ${name}`);
    return [name, matches[0].getText(ast)];
  }));
  const executable = source.endsWith("markdown-assets.ts");
  const content = executable
    ? `import * as path from "node:path";\nimport { checkedMarkdownPath, markdownAssetDirectory, isMarkdownAssetDirectory, rewriteMarkdownAssetReferences } from "./markdown-assets.js";\n\n${declarations.rebaseMarkdownAssets}\n\n// Evidence only; original mutating functions are never imported or executed.\nexport const documentLifecycleAssetRules = ${JSON.stringify(declarations, null, 2)} as const;\n`
    : `// Evidence only: original paired move, write/rebase and deletion-journal ordering.\nexport const documentLifecycleFilestoreRules = ${JSON.stringify(declarations, null, 2)} as const;\n`;
  const captured = `src/domain/document-lifecycle-${executable ? "original" : "filestore"}.ts`;
  await emit(captured, content);
  files.push({ source, captured, sourceSha256: hash(raw), capturedSha256: hash(content), declarations: names });
}
await emit("migration/document-lifecycle-provenance.json", JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST extraction of unchanged original rebaseMarkdownAssets, reusing captured parser/path helpers; original shared protection, legacy migration and paired move/journal rules retained as non-executable evidence.",
  files,
  qualification: "Bounded within-area document/paired-tree moves only. Legacy _assets migration, Todo/memory descriptors, path-derived identity, shared trees and folder moves explicitly refused. Shared SQLite intent/receipts and locking belong to the caller. Filesystem CAS cannot exclude uncooperative external writers racing checks/rename/unlink.",
}, null, 2) + "\n");
console.log(`Document paired-move original rules ${args[0] === "--check" ? "verified" : "captured"}.`);
