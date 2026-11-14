import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

const captures = [];
for (const name of ["test-note-work-items.js", "test-note-work-item-lifecycle.js"]) {
  const original = await readFile(resolve(packageRoot, "../tests", name), "utf8");
  const source = ts.createSourceFile(name, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = [];
  const tests = [];
  const excluded = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.every(node => ts.isIdentifier(node.name) && ["user", "worker", "other", "item"].includes(node.name.text))) declarations.push(statement.getText(source));
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === "lifecycle") declarations.push(statement.getText(source));
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) || statement.expression.expression.getText(source) !== "test") continue;
    const text = statement.getText(source);
    const title = statement.expression.arguments[0].text;
    if (/\b(?:store|fs|path|vm)\s*\.|\bbridge\s*\(|\b__dirname\b|\brequire\s*\(/.test(text)) { excluded.push(title); continue; }
    tests.push({ title, text });
  }
  if (!tests.length) throw new Error(`No pure regression tests selected from ${name}.`);
  const captured = `tests/legacy-${name.replace(/^test-/, "").replace(/\.js$/, ".test.mjs")}`;
  const content = `import { test } from "node:test";
import assert from "node:assert/strict";
import { commandNoteWorkItem, readNoteWorkItems, upsertNoteWorkItem, validateNoteWorkItem, workItemIcons } from "../dist/domain/note-work-items.js";

${declarations.join("\n")}

${tests.map(test => test.text).join("\n\n")}
`;
  await writeFile(resolve(packageRoot, captured), content);
  captures.push({ source: `tests/${name}`, sourceSha256: hash(original), captured, capturedSha256: hash(content), included: tests.map(test => test.title), excluded });
}
await writeFile(resolve(packageRoot, "migration/todo-test-provenance.json"), JSON.stringify({
  schema: "pkm.regression-capture/v1",
  transformation: "TypeScript AST selects unchanged top-level pure test bodies and their fixture constants/lifecycle helper. Host/filesystem/VM/bridge tests explicitly excluded; replacement persistence tests live in todo.test.mjs.",
  files: captures,
}, null, 2) + "\n");
console.log(`Captured ${captures.reduce((sum, capture) => sum + capture.included.length, 0)} unchanged pure legacy regression tests.`);
