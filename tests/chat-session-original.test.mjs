import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { chatHistoryPage } from "../dist/domain/chat-session-original.js";
import { ChatHistoryStorage } from "../dist/domain/chat-session-original-history.js";
import { originalTests, originalStoreContracts } from "./chat-session-original-capture.mjs";

function message(content, extra = {}) { return { id: randomUUID(), role: "assistant", content, status: "complete", ...extra }; }
function fixture(t) {
  const directory = path.resolve("tests", `chat-session-original-work-${randomUUID()}`);
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const chat = {
    version: 1, id: randomUUID(), title: "Synthetic only", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), messages: [], context: [], includeHistory: false,
  };
  const file = path.join(directory, "synthetic.json");
  const storage = new ChatHistoryStorage(directory);
  const store = {
    save(value) { fs.writeFileSync(file, JSON.stringify(storage.pack(value, { status: "completed", workerManager: false }))); },
    load() { return storage.unpack(JSON.parse(fs.readFileSync(file, "utf8"))); },
  };
  return { directory, chat, file, store };
}
for (const body of originalTests) {
  // Only declarations captured from the trusted original repository are evaluated; no host registration is loaded.
  Function("test", "assert", "fs", "path", "message", "fixture", "chatHistoryPage", "ChatHistoryStorage", body)(
    test, assert, fs, path, message, fixture, chatHistoryPage, ChatHistoryStorage,
  );
}
test("captured original contracts retain portable transcript fields and distinguish execution authority", () => {
  for (const field of ["toolCalls", "recordedAt", "retrieval", "usage", "permissionGrants", "queuedInputs"]) assert(originalStoreContracts.includes(field));
});
