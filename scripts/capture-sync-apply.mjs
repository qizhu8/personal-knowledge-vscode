import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const sourcePath = "src/sync/github-sync.ts";
const testPath = "tests/test-github-sync-newlines.js";
const sourceText = await readFile(resolve(repository, sourcePath), "utf8");
const testText = await readFile(resolve(repository, testPath), "utf8");
const tree = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
const names = ["githubSyncManagedContent", "githubSyncLocalSnapshotMatches"];
const declarations = names.map(name => {
  const found = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (found.length !== 1) throw new Error(`sync apply capture boundary changed: ${name}`);
  return found[0].getText(tree);
});
const originalAssertion = testText.split("\n").find(line =>
  line.trim() === "assert(fs.readFileSync(path.join(store, relative)).equals(expected));");
if (!originalAssertion) throw new Error("sync byte-preservation assertion capture boundary changed");

const outputs = new Map([
  ["src/domain/sync-apply-original.ts", `type GitHubSyncContentType = string;\n\n${declarations.join("\n\n")}\n`],
  ["tests/sync-apply-original.test.mjs", `import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { githubSyncLocalSnapshotMatches, githubSyncManagedContent } from "../dist/domain/sync-apply-original.js";

test("captured original content preserves bytes outside recipe metadata", () => {
  const bytes = Buffer.from("\\uFEFFfirst\\r\\nsecond\\n");
  assert.equal(githubSyncManagedContent("notes", bytes), bytes);
  assert(githubSyncLocalSnapshotMatches(bytes, Buffer.from("planned"), bytes));
  assert(!githubSyncLocalSnapshotMatches(Buffer.from("base"), Buffer.from("planned"), Buffer.from("external")));
});

test("original guarded pull assertion retains exact selected bytes", () => {
  const directory = mkdtempSync(resolve("tests", ".sync-apply-original-"));
  const fs = { readFileSync };
  const path = { join };
  const store = directory;
  const relative = "notes/source.md";
  const expected = Buffer.from("\\uFEFFfirst\\nremote edited\\n");
  try {
    mkdirSync(join(store, "notes"), { recursive: true });
    writeFileSync(join(store, relative), expected);
${originalAssertion}
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
`],
]);
const hash = value => createHash("sha256").update(value).digest("hex");
const records = [
  [sourcePath, sourceText, "src/domain/sync-apply-original.ts"],
  [testPath, testText, "tests/sync-apply-original.test.mjs"],
].map(([source, content, captured]) => ({
  source, captured, sourceSha256: hash(content), capturedSha256: hash(outputs.get(captured)),
}));
outputs.set("migration/sync-apply-provenance.json", JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST capture of original GitHub sync managed-content and local-snapshot helpers, plus its exact guarded-pull byte-preservation assertion. Filesystem application and journaling are a separate offline implementation.",
  files: records,
}, null, 2) + "\n");
if (process.argv.slice(2).some(argument => argument !== "--check")) throw new Error("usage: node scripts/capture-sync-apply.mjs [--check]");
for (const [file, text] of outputs) {
  if (process.argv.includes("--check")) {
    if (await readFile(resolve(root, file), "utf8") !== text) throw new Error(`capture differs: ${file}`);
  } else await writeFile(resolve(root, file), text);
}
