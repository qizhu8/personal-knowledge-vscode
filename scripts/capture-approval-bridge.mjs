import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { packageRoot, hash, checkCaptureRecords } from "./migration.mjs";

const sourceRoot = resolve(packageRoot, "legacy");
const records = [];
const source = "src/chat/portal-command-activity.ts";
const captured = "src/domain/approval-bridge-native-activity.ts";
const activity = await readFile(resolve(sourceRoot, source), "utf8");
await writeFile(resolve(packageRoot, captured), activity);
records.push({ source, captured, sourceSha256: hash(activity), capturedSha256: hash(activity) });
const boundaries = [
  ["src/chat/api-chat-view.ts", ["resolveApproval", "requestPermission"]],
  ["src/chat/api-chat-store.ts", ["load"]],
  ["src/chat/explicit-memory-tools.ts", ["createExplicitMemoryTools", "formatExplicitMemoryDecision"]],
];
for (const [source, names] of boundaries) {
  const original = await readFile(resolve(sourceRoot, source), "utf8");
  const parsed = ts.createSourceFile(source, original, ts.ScriptTarget.Latest, true);
  const selections = [];
  function visit(node) {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && names.includes(node.name.getText(parsed))) {
      const content = node.getText(parsed);
      if (source.endsWith("api-chat-store.ts") && !content.includes("Execution may already have occurred.")) return;
      selections.push({ name: node.name.getText(parsed), source: content });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (selections.length !== names.length) throw new Error(`Native capture boundary changed: ${source}`);
  const captured = `tests/approval-bridge-original-${source.split("/").at(-1).replace(".ts", "")}.mjs`;
  const content = `// Verbatim AST-selected native source evidence, not executable durable parity.\nexport default ${JSON.stringify(selections, null, 2)};\n`;
  await writeFile(resolve(packageRoot, captured), content);
  records.push({ source, captured, sourceSha256: hash(original), capturedSha256: hash(content) });
}
await writeFile(resolve(packageRoot, "migration/approval-bridge-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  roots: { source: "..", captured: "." },
  transformation: "Portal command activity module copied byte-for-byte; native approval, reconnect and exact-memory methods selected by TypeScript AST and preserved verbatim as evidence strings.",
  files: records,
  qualification: "Only the original Portal activity reducer is executable source parity. Exact-record approval/execution durability is a NEW conservative projection. Native UI grants are not migrated as generic durable authority; interrupted execution becomes unknown and is never replayed.",
}, null, 2) + "\n");
const issues = await checkCaptureRecords(records, sourceRoot, packageRoot);
if (issues.length) throw new Error(JSON.stringify(issues));
