import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { packageRoot, hash } from "./migration.mjs";
import ts from "typescript";

const directory = resolve(packageRoot, "src/domain");
await mkdir(directory, { recursive: true });
const files = ["note-work-items.ts", "todo-board.ts", "todo-api-contract.ts", "todo-api.ts"];
const provenance = [];
for (const name of files) {
  const original = await readFile(resolve(packageRoot, "legacy/src/knowledge", name), "utf8");
  let content = original.replaceAll('from "./note-work-items"', 'from "./note-work-items.js"')
    .replaceAll('from "./todo-api-contract"', 'from "./todo-api-contract.js"');
  if (name === "todo-api.ts") {
    const expected = [
      'import { join } from "path";\n',
      'import { apiChatGroupSnapshots } from "../chat/api-chat-store";\n',
      'import { getStorePath, noteGet, noteWorkItemCommand, noteWorkItemNotes, noteWorkItemsRead } from "./filestore";\n',
    ];
    for (const text of expected) {
      if (!content.includes(text)) throw new Error(`Source changed: missing expected adapter boundary ${text}`);
      content = content.replace(text, "");
    }
    content = content.replaceAll(/apiChatGroupSnapshots\(join\(getStorePath\(\),\s*"\.pkm",\s*"state"\)\)/g, "store.listChats()");
    if (/getStorePath|apiChatGroupSnapshots|filestore/.test(content)) throw new Error("Unconverted host/storage dependency.");
    content = content.replace("export function callTodoApi", "function callTodoApi");
    const importsEnd = content.indexOf("\nfunction record");
    if (importsEnd < 0) throw new Error("Source changed: missing API body boundary.");
    const imports = content.slice(0, importsEnd);
    const body = content.slice(importsEnd);
    content = `${imports}
import type { TodoStore } from "../todo-store-contract.js";

export function createTodoApi(store: TodoStore) {
  const { noteGet, noteWorkItemCommand, noteWorkItemNotes, noteWorkItemsRead } = store;
${body}
  return { callTodoApi };
}
`;
  }
  await writeFile(resolve(directory, name), content);
  provenance.push({ source: `src/knowledge/${name}`, sourceSha256: hash(original), captured: `src/domain/${name}`, capturedSha256: hash(content) });
}
const registry = await readFile(resolve(packageRoot, "legacy/src/capabilities/registry.ts"), "utf8");
const parsedRegistry = ts.createSourceFile("registry.ts", registry, ts.ScriptTarget.Latest, true);
const identityDeclaration = parsedRegistry.statements.filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations])
  .find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "todoIds");
if (!identityDeclaration?.initializer || !ts.isObjectLiteralExpression(identityDeclaration.initializer)) throw new Error("Canonical Todo identity map was not found.");
const identitySource = `export const todoIdentities: Record<string, string> = ${identityDeclaration.initializer.getText(parsedRegistry)};\n`;
await writeFile(resolve(directory, "todo-identities.ts"), identitySource);
provenance.push({ source: "src/capabilities/registry.ts", sourceSha256: hash(registry), captured: "src/domain/todo-identities.ts", capturedSha256: hash(identitySource) });
await writeFile(resolve(packageRoot, "migration/todo-provenance.json"), JSON.stringify({
  schema: "pkm.domain-capture/v1",
  transformation: "ESM import suffixes; Todo API host/storage functions replaced with an injected TodoStore. Business reducer, validation, schemas and API branches retained.",
  files: provenance,
}, null, 2) + "\n");
console.log("Captured Todo domain with explicit host-neutral adapter boundary.");
