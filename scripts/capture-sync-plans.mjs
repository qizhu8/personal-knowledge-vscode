import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "legacy");
const source = "src/sync/github-sync.ts";
const test = "tests/test-github-sync-model.js";
const partialTest = "tests/test-github-sync-partial.js";
const publication = "src/sync/github-sync-publication-plan.ts";
const sourceText = await readFile(resolve(repo, source), "utf8");
const testText = await readFile(resolve(repo, test), "utf8");
const partialText = await readFile(resolve(repo, partialTest), "utf8");
const pubText = await readFile(resolve(repo, publication), "utf8");
const tree = ts.createSourceFile(source, sourceText, ts.ScriptTarget.Latest, true);
const names = ["githubSyncSafeRelativePath", "githubSyncIgnoredPath", "githubSyncUnrecordedAbsenceNeedsReview"];
const declarations = names.map(name => {
  const found = tree.statements.filter(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (found.length !== 1) throw new Error(`capture boundary changed: ${name}`);
  return found[0].getText(tree);
});
const lines = testText.split("\n");
const regression = lines.filter(line =>
  line.startsWith("for (const ignored of ") || line.startsWith("for (const retained of ") ||
  line.startsWith("assert.strictEqual(githubSyncUnrecordedAbsenceNeedsReview("));
if (regression.length !== 9) throw new Error("sync regression capture boundary changed");
const partialTree = ts.createSourceFile(partialTest, partialText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const partialRegression = partialTree.statements.filter(s => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)
  && s.expression.expression.getText(partialTree) === "test"
  && s.expression.arguments[0]?.getText(partialTree) === '"pure planner isolates required groups and portable destination collisions without mutating inputs"');
if (partialRegression.length !== 1) throw new Error("publication regression capture boundary changed");
const outputs = new Map([
  ["src/domain/sync-plan-original.ts", `${declarations.join("\n\n")}\n\n${pubText}`],
  ["tests/sync-plan-original.test.mjs", `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { githubSyncIgnoredPath, githubSyncUnrecordedAbsenceNeedsReview, planGitHubSyncPublication } from "../dist/domain/sync-plan-original.js";\n\n${regression.join("\n")}\n\n${partialRegression[0].getText(partialTree)}\n`],
]);
const hash = text => createHash("sha256").update(text).digest("hex");
const records = [
  [source, sourceText, "src/domain/sync-plan-original.ts"],
  [publication, pubText, "src/domain/sync-plan-original.ts"],
  [test, testText, "tests/sync-plan-original.test.mjs"],
  [partialTest, partialText, "tests/sync-plan-original.test.mjs"],
].map(([sourcePath, text, captured]) => ({
  source: sourcePath, captured, sourceSha256: hash(text), capturedSha256: hash(outputs.get(captured)),
}));
const metadata = JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "AST capture of original portable path, ignore and unrecorded-absence functions; exact publication planner and selected original model regression assertions. Offline wrapper is separate.",
  files: records,
}, null, 2) + "\n";
outputs.set("migration/sync-plans-provenance.json", metadata);
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: node scripts/capture-sync-plans.mjs [--check]");
for (const [file, text] of outputs) {
  if (process.argv.includes("--check")) {
    if (await readFile(resolve(root, file), "utf8") !== text) throw new Error(`capture differs: ${file}`);
  } else await writeFile(resolve(root, file), text);
}
