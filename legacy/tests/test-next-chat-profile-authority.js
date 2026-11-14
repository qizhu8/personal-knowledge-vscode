"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

function provider(vscode) {
  const filename = path.resolve("src/runtime/next-chat-profile-authority.ts");
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", source)(name => name === "vscode" ? vscode : require(name), module, module.exports);
  return module.exports.createNextChatProfileAuthority;
}

test("window profile revokes on workspace/configuration changes and checks live connection", t => {
  const root = path.resolve(".migration-test-work", `chat-profile-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let configuration, folders, secretChanged, connected = true;
  const workspace = { isTrusted: true,
    onDidChangeConfiguration(listener) { configuration = listener; return { dispose() {} }; },
    onDidChangeWorkspaceFolders(listener) { folders = listener; return { dispose() {} }; },
  };
  const create = provider({ workspace });
  const options = { root, workspaceId: randomUUID(), currentRoot: () => root, clientCurrent: () => connected,
    secrets: { onDidChange(listener) { secretChanged = listener; return { dispose() {} }; } } };
  const first = create(options);
  first.assertCurrent();
  configuration({ affectsConfiguration: () => true });
  assert.equal(first.signal.aborted, true);
  assert.throws(() => first.assertCurrent(), /revoked/);
  first.dispose();
  const second = create(options);
  connected = false;
  assert.throws(() => second.assertCurrent(), /revoked/);
  connected = true;
  folders();
  assert.equal(second.signal.aborted, true);
  second.dispose();
  const third = create(options);
  secretChanged({ key: "unrelated" });
  assert.equal(third.signal.aborted, false);
  secretChanged({ key: "personalKnowledge.aiApiKey" });
  assert.equal(third.signal.aborted, true);
  third.dispose();
  const fourth = create(options);
  let catalogChanged;
  fourth.watchModelChanges(listener => { catalogChanged = listener; return { dispose() {} }; });
  catalogChanged();
  assert.equal(fourth.signal.aborted, true);
  fourth.dispose();
  const fifth = create(options);
  let authChanged;
  fifth.watchGithubSessions(listener => { authChanged = listener; return { dispose() {} }; });
  authChanged({ provider: { id: "other" } });
  assert.equal(fifth.signal.aborted, false);
  authChanged({ provider: { id: "github" } });
  assert.equal(fifth.signal.aborted, true);
  fifth.dispose();
  workspace.isTrusted = false;
  assert.throws(() => create(options), /revoked/);
});

test("Chat permission keys are profile-local, restartable, and reset without touching other Chats", async t => {
  const root = path.resolve(".migration-test-work", `chat-profile-key-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const listeners = new Set(), values = new Map(), workspaceId = randomUUID(), chatId = randomUUID();
  const secrets = {
    onDidChange(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
    async get(key) { return values.get(key); },
    async store(key, value) { values.set(key, value); for (const listener of listeners) listener({ key }); },
    async delete(key) { values.delete(key); for (const listener of listeners) listener({ key }); },
  };
  const create = provider({ workspace: { isTrusted: true,
    onDidChangeConfiguration() { return { dispose() {} }; },
    onDidChangeWorkspaceFolders() { return { dispose() {} }; } } });
  const options = { root, workspaceId, currentRoot: () => root, clientCurrent: () => true, secrets };
  const first = create(options), key = await first.preparePermissions("0123456789abcdef", chatId);
  first.dispose();
  const other = create(options);
  const otherKey = await other.preparePermissions("0123456789abcdef", randomUUID());
  assert.notEqual(otherKey, key);
  const second = create(options);
  assert.equal(await second.preparePermissions("0123456789abcdef", chatId), key);
  await second.resetPermissions();
  assert.equal(second.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  second.dispose(); other.dispose();
  const third = create(options);
  assert.notEqual(await third.preparePermissions("0123456789abcdef", chatId), key);
  third.dispose();
});
