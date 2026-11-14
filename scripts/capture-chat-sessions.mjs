import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const storeSource = "src/chat/api-chat-store.ts";
const historySource = "src/chat/chat-history-storage.ts";
const testSource = "tests/test-chat-history-storage.js";
const source = await readFile(resolve(repository, storeSource), "utf8");
const ast = ts.createSourceFile(storeSource, source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const found = ast.statements.filter(node => node.name?.text === name);
  if (found.length !== 1) throw new Error(`Original Chat capture boundary changed: ${name}`);
  return found[0].getText(ast);
};
const types = `export interface ChatMessage { id: string; role?: string; content?: string; status?: string; }
export interface ApiConversation { version: 1; id: string; title: string; createdAt: string; updatedAt: string; messages: ChatMessage[]; includeHistory: boolean; context: unknown[]; }
export type ApiChatStatus = "running" | "idle" | "completed" | "new-result" | "awaiting-input" | "awaiting-result" | "paused" | "failed" | "stopped";`;
const projection = "src/domain/chat-session-original.ts";
await writeFile(resolve(root, projection),
  "// Exact original history paging reducer with minimal structural types; regenerate with capture-chat-sessions.mjs.\n"
  + types + "\n\n" + declaration("chatHistoryPage") + "\n");
const history = "src/domain/chat-session-original-history.ts";
const originalHistory = await readFile(resolve(repository, historySource), "utf8");
if (!originalHistory.includes('import type { ApiConversation, ApiChatStatus, ChatMessage } from "./api-chat-store";')) throw new Error("Original history import boundary changed.");
await writeFile(resolve(root, history),
  "// Exact original segmented history storage, exercised only with synthetic test records.\n"
  + originalHistory.replace('import type { ApiConversation, ApiChatStatus, ChatMessage } from "./api-chat-store";',
    'import type { ApiConversation, ApiChatStatus, ChatMessage } from "./chat-session-original.js";'));
const originalTests = await readFile(resolve(repository, testSource), "utf8");
const testAst = ts.createSourceFile(testSource, originalTests, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const selected = [
  "a single large Unicode message spans bounded segments and round-trips exactly",
  "history pages load older evidence by identity without changing model context or stored history",
];
const tests = selected.map(name => {
  const matches = testAst.statements.filter(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(testAst) === "test"
    && node.expression.arguments[0]?.text === name);
  if (matches.length !== 1) throw new Error(`Original Chat regression boundary changed: ${name}`);
  return matches[0].getText(testAst);
});
const regression = "tests/chat-session-original-capture.mjs";
await writeFile(resolve(root, regression),
  "// Exact original regression declarations. Host ApiChatStore fixture is replaced by the original segmented storage adapter.\n"
  + `export const originalTests = ${JSON.stringify(tests)};\n`
  + `export const originalStoreContracts = ${JSON.stringify(["ChatMessage", "ApiConversation"].map(declaration).join("\n\n"))};\n`);
const mappings = [
  [storeSource, projection], [historySource, history], [testSource, regression], [storeSource, regression],
  [storeSource, "src/chat-session-contracts.ts"], [storeSource, "src/chat-session-store.ts"],
  [testSource, "tests/chat-session.test.mjs"], [testSource, "tests/chat-session-original.test.mjs"],
  [storeSource, "tests/chat-session-fixtures.mjs"],
];
const hash = value => createHash("sha256").update(value).digest("hex");
const files = await Promise.all(mappings.map(async ([source, captured]) => ({
  source, captured, sourceSha256: hash(await readFile(resolve(repository, source))),
  capturedSha256: hash(await readFile(resolve(root, captured))),
})));
await writeFile(resolve(root, "migration/chat-sessions-provenance.json"), JSON.stringify({
  schema: "pkm.next.domain-capture/v1",
  notes: "Original ChatMessage/ApiConversation contracts captured as text; exact history paging reducer and segmented storage captured and exercised with two original regression bodies on synthetic records only. New SQLite runtime state intentionally bounds total history, never imports legacy Roots, and disarms streaming/running observations. No permission grants, queued execution, tools, providers or automatic replay are migrated.",
  files,
}, null, 2) + "\n");
