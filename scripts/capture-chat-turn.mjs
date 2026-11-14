import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const sourcePath = "src/chat/api-chat-client.ts";
const testPath = "tests/test-api-chat.js";
const source = await readFile(resolve(repository, sourcePath), "utf8");
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const names = ["chatToolRoundLimit", "chatToolRoundBudgetNotice"];
const declarations = names.map(name => {
  const found = ast.statements.filter(node => node.name?.text === name);
  if (found.length !== 1) throw new Error(`Original Chat turn capture boundary changed: ${name}`);
  return found[0].getText(ast);
});
const projection = "src/domain/chat-turn-original.ts";
await writeFile(resolve(root, projection),
  "// Exact original pure inference-round reducers; regenerate with capture-chat-turn.mjs.\n" + declarations.join("\n\n") + "\n");
const tests = await readFile(resolve(repository, testPath), "utf8");
const testAst = ts.createSourceFile(testPath, tests, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const original = testAst.statements.find(node => node.name?.text === "testToolLoop");
if (!original) throw new Error("Original testToolLoop regression boundary changed.");
const selected = original.body.statements.filter(node =>
  node.getText(testAst) === "assert.strictEqual(chatToolRoundLimit(), 30);");
if (selected.length !== 1) throw new Error("Original round-limit assertion boundary changed.");
const captured = "tests/chat-turn-original-capture.mjs";
await writeFile(resolve(root, captured), "// Exact original assertion from testToolLoop; evaluated against captured pure reducer.\n"
  + `export const originalAssertions = ${JSON.stringify(selected.map(node => node.getText(testAst)))};\n`);
const targets = [projection, captured, "src/chat-turn-contracts.ts", "src/chat-turn-store.ts", "src/chat-turn.ts",
  "src/chat-turn-adapters.ts", "tests/chat-turn.test.mjs", "tests/chat-turn-original.test.mjs", "tests/chat-turn-fixtures.mjs"];
targets.push("tests/chat-turn-chain.test.mjs", "tests/chat-turn-memory.test.mjs", "tests/chat-turn-native-fixtures.mjs");
const hash = value => createHash("sha256").update(value).digest("hex");
const files = await Promise.all(targets.map(async captured => {
  const original = captured.includes("original") && captured.startsWith("tests/") ? testPath : sourcePath;
  return { source: original, captured, sourceSha256: hash(await readFile(resolve(repository, original))),
    capturedSha256: hash(await readFile(resolve(root, captured))) };
}));
await writeFile(resolve(root, "migration/chat-turn-provenance.json"), JSON.stringify({
  schema: "pkm.next.domain-capture/v1",
  sourceRoot: "..", capturedRoot: ".",
  notes: "Two exact original pure round-budget reducers and one exact original testToolLoop assertion. New host-neutral orchestration reimplements the original bounded inference/tool-message loop with shared-SQLite intents and native ports; it does not claim capture of the original network/VSCode orchestration or entire tests. Synthetic records only; no legacy Roots, attachments, credentials, permission grants or automatic replay.",
  files,
}, null, 2) + "\n");
