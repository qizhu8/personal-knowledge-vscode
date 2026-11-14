import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

const sourcePath = "src/knowledge/markdown-assets.ts";
const source = await readFile(resolve(packageRoot, "..", sourcePath), "utf8");
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const names = [
  "MarkdownAssetArea", "MarkdownAsset", "Reference", "isMarkdownAssetDirectory", "markdownAssetDirectory",
  "checkedMarkdownPath", "encodeSegment", "markdownReferences", "rewriteMarkdownAssetReferences",
  "ownedMarkdownAssetPaths", "localAssetReference", "listedMarkdownAssets", "referencedMarkdownAssets",
  "assertMarkdownAssetsUnshared", "assertMarkdownResourceTreeUnshared", "markdownResourceReferrer", "rebaseMarkdownAssets",
];
const selected = new Set(names);
const expose = new Set(["encodeSegment", "markdownReferences", "localAssetReference"]);
const found = [];
const declarations = [];
for (const statement of parsed.statements) {
  if (!("name" in statement) || !statement.name || !ts.isIdentifier(statement.name) || !selected.has(statement.name.text)) continue;
  const name = statement.name.text, text = statement.getText(parsed);
  found.push(name);
  declarations.push(`${expose.has(name) ? "export " : ""}${text}`);
}
if (found.length !== names.length || new Set(found).size !== names.length) throw new Error("Read-only Markdown asset capture boundaries changed.");
const content = `import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

${declarations.join("\n\n")}\n`;
const captured = "src/domain/markdown-assets.ts";
await mkdir(resolve(packageRoot, "src/domain"), { recursive: true });
await writeFile(resolve(packageRoot, captured), content);
await writeFile(resolve(packageRoot, "migration/assets-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST-selected read-only resource/parser/rebase declarations with unchanged bodies; Node ESM imports; parser helpers explicitly exported. Locking, mutation and deletion-journal functions intentionally excluded.",
  files: [{ source: sourcePath, sourceSha256: hash(source), captured, capturedSha256: hash(content), declarations: names }],
  qualification: "Original filesystem/filestore/sync integration tests are not claimed as captured or passing. Separate isolated tests cover the adapter and selected resource semantics.",
}, null, 2) + "\n");
console.log("Captured original read-only Markdown ownership, reference parser and rebase rules.");
