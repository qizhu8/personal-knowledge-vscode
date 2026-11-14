import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash } from "./migration.mjs";

await mkdir(resolve(packageRoot, "src/domain"), { recursive: true });
const sourcePath = "src/knowledge/knowledge-contracts.ts";
const source = await readFile(resolve(packageRoot, "..", sourcePath), "utf8");
const capturedPath = "src/domain/knowledge-contracts.ts";
await writeFile(resolve(packageRoot, capturedPath), source);
const testPath = "tests/test-knowledge-contracts.js";
const original = await readFile(resolve(packageRoot, "..", testPath), "utf8");
const parsed = ts.createSourceFile(testPath, original, ts.ScriptTarget.Latest, true);
const declaration = name => parsed.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name));
const start = declaration("first"), end = declaration("root");
if (!start || !end || start.getStart(parsed) >= end.getStart(parsed)) throw new Error("Knowledge contract test boundaries changed.");
const body = original.slice(start.getStart(parsed), end.getStart(parsed)).trimEnd();
if (/\b(?:store|fs|os|path)\./.test(body)) throw new Error("Captured contract assertions unexpectedly depend on filesystem/host adapters.");
const test = `import { test } from "node:test";
import assert from "node:assert";
import * as contracts from "../dist/domain/knowledge-contracts.js";

test("original Knowledge identity, aliases and pinned/floating link contract assertions", () => {
${body}
});
`;
const capturedTest = "tests/legacy-knowledge-contracts.test.mjs";
await writeFile(resolve(packageRoot, capturedTest), test);
await writeFile(resolve(packageRoot, "migration/knowledge-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "Knowledge contracts copied without business changes. Original pure top-level assertions wrapped in node:test with ESM imports; legacy filestore integration assertions explicitly excluded.",
  files: [
    { source: sourcePath, sourceSha256: hash(source), captured: capturedPath, capturedSha256: hash(source) },
    { source: testPath, sourceSha256: hash(original), captured: capturedTest, capturedSha256: hash(test),
      included: "Exact statements from first identity fixture through identity-set collision assertions.",
      excluded: "Legacy filestore Note/Skill/Paper mutation and move integration block; requires later adapter parity qualification." },
  ],
}, null, 2) + "\n");
console.log("Captured original Knowledge identity/link rules and pure assertions with explicit integration exclusions.");
