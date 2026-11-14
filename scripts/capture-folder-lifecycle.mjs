import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

const sources = [
  ["src/knowledge/filestore.ts", [
    "safeFolderOperationPath", "folderRename", "FolderDeleteOperations", "FOLDER_DELETE_RETRY_DELAYS_MS",
    "RETRYABLE_FOLDER_DELETE_ERRORS", "folderDeletePromote", "moveKnowledgePathUnlocked", "repathFolderPins",
    "knowledgeTrashPath", "knowledgeMoveToTrashUnlocked", "SkillTrashEntry", "moveSkillPathToTrashUnlocked",
    "skillFolderMoveToTrash", "skillTrashRestoreUnlocked", "skillTrashDelete", "skillTrashEmpty",
  ]],
  ["src/knowledge/markdown-assets.ts", [
    "rebaseMarkdownAssets", "assertMarkdownResourceTreeUnshared", "markdownResourceReferrer",
  ]],
];

const captures = {};
const records = [];
for (const [source, names] of sources) {
  const raw = await readFile(resolve(packageRoot, "..", source), "utf8");
  const ast = ts.createSourceFile(source, raw, ts.ScriptTarget.Latest, true);
  const declarations = {};
  for (const name of names) {
    const matches = ast.statements.flatMap(node => ts.isVariableStatement(node)
      ? node.declarationList.declarations.filter(declaration => declaration.name.getText(ast) === name)
        .map(() => node)
      : node.name?.getText(ast) === name ? [node] : []);
    if (matches.length !== 1) throw new Error(`Folder lifecycle capture boundary changed: ${name}`);
    declarations[name] = matches[0].getText(ast);
  }
  captures[source] = declarations;
  records.push({ source, sourceSha256: hash(raw), declarations: names });
}

const captured = "src/domain/folder-lifecycle-original.ts";
const content = `// Evidence only: original folder move/delete/trash semantics; mutating legacy functions are never imported or executed.\nexport const folderLifecycleOriginalRules = ${JSON.stringify(captures, null, 2)} as const;\n`;
await writeFile(resolve(packageRoot, captured), content);
await writeFile(resolve(packageRoot, "migration/folder-lifecycle-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST capture of unchanged original folder rename/move/promote-delete/skill-trash/restore rules and the paired-resource reference rebase/shared-tree guards. Captured declarations are evidence only and are never executed.",
  files: records.map(record => ({
    source: record.source,
    captured,
    sourceSha256: record.sourceSha256,
    capturedSha256: hash(content),
    declarations: record.declarations,
  })),
  qualification: "Supports a bounded notes/skills/papers folder move only. Original container-delete promotion and recoverable skill Trash are captured but not exposed: a durable Trash/restore journal and its metadata/index lifecycle are not qualified. Permanent delete/empty-trash is intentionally absent. Legacy Notes pinned-folder sidecar entries are captured but are not changed because this isolated server has no authoritative folder-pin store; reconcile them through a dedicated state lifecycle before exposure. Parent must persist the exact serialized folder intent and hold the shared SQLite writer lock before apply/recovery, then atomically commit path/identity reindex, receipt and intent removal. External writers may still race source/reference checks; Linux RENAME_NOREPLACE prevents destination replacement.",
}, null, 2) + "\n");
console.log("Captured original folder lifecycle rules.");
