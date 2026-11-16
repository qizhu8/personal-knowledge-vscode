import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash, readOriginalSource } from "./migration.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--check")) throw new Error("Usage: node scripts/capture-trash-lifecycle.mjs [--check]");
const originalMetadata = JSON.parse(await readFile(resolve(packageRoot, "migration/trash-lifecycle-provenance.json"), "utf8"));
async function emit(path, content) {
  const full = resolve(packageRoot, path);
  if (args[0] === "--check") {
    if (await readFile(full, "utf8") !== content) throw new Error(`Trash lifecycle capture is stale: ${path}`);
  } else await writeFile(full, content);
}

const sources = [
  ["src/knowledge/filestore.ts", [
    "KnowledgeTrashEntry", "SkillTrashEntry", "knowledgeDeletionPaths", "recordKnowledgeTrashDeletion",
    "moveMarkdownPair", "knowledgeTrashPath", "knowledgeMoveToTrashUnlocked", "knowledgeTrashRestoreUnlocked",
    "moveSkillPathToTrashUnlocked", "skillTrashRestoreUnlocked", "knowledgePathMoveToTrash", "skillFolderMoveToTrash",
  ]],
  ["src/knowledge/knowledge-deletion-journal.ts", [
    "KnowledgeSyncDeletionRecord", "knowledgeDeletionFile", "load", "withKnowledgeDeletionJournal", "recordKnowledgeResourceMutation",
  ]],
  ["src/knowledge/markdown-assets.ts", ["assertMarkdownAssetsUnshared", "assertMarkdownResourceTreeUnshared", "markdownResourceReferrer"]],
];
const captures = {}, records = [];
for (const [source, names] of sources) {
  const raw = (await readOriginalSource(source, {
    sha256: originalMetadata.files.find(record => record.source === source)?.sourceSha256,
    dataset: "knowledge-trash-lifecycle-historical",
  })).toString("utf8");
  const ast = ts.createSourceFile(source, raw, ts.ScriptTarget.Latest, true);
  const declarations = {};
  for (const name of names) {
    const matches = ast.statements.filter(node => node.name?.getText(ast) === name
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === name));
    if (matches.length !== 1) throw new Error(`Trash capture boundary changed: ${source}:${name}`);
    declarations[name] = matches[0].getText(ast);
  }
  captures[source] = declarations;
  records.push({ source, sourceSha256: hash(raw), declarations: names });
}
const captured = "src/domain/trash-lifecycle-original.ts";
const content = `// Evidence only. Original mutating lifecycle declarations are never executed.\nexport const trashLifecycleOriginalRules = ${JSON.stringify(captures, null, 2)} as const;\n`;
await emit(captured, content);
await emit("migration/trash-lifecycle-provenance.json", JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "Unmodified AST declaration evidence for original paired document/folder/skill trash, original-location restore, outside resource guards and knowledge sync deletion records.",
  files: records.map(r => ({ ...r, captured, capturedSha256: hash(content) })),
  qualification: "New explicit host-qualified notes|skills|papers/.trash/<UUID>/{metadata.json,payload,assets} layout. No generic knowledge.delete/restore duplication; physical recoverable trash is distinct from tombstoning. Exact stable-identity paired/subtree subset only; no asset migration, Board/memory/System lifecycle, legacy Trash import, source-parent pruning or permanent deletion in this capture's lifecycle surface. Missing restore parents are created component by component after durable intent, rejecting symlink/file components; allowlisted area/Trash roots remain required. Host must persist exact intent under its shared writer lock, then atomically reindex identities/history, trash index, global receipt, original removed/restored sync deletion records and intent clear. Original sync journal is never written directly; host must reconcile it through authorized state lifecycle. Shared no-replace helper uses Linux renameat2 or Windows MoveFileExW; native Windows verification is deferred to Portal and is not claimed. Linux directory/parent fsync is retained. Unknown phases fail closed without rollback. External non-cooperative writers can race checks; identity/content pins reject observed changes, but an external writer racing the final rename is outside the lock guarantee.",
}, null, 2) + "\n");
console.log("Captured original trash lifecycle rules.");
