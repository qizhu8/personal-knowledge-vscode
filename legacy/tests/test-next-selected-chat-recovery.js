"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/runtime/next-selected-chat-recovery.ts"), "utf8");
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", javascript)(require, loaded, loaded.exports);
const { saveSelectedChatRecoveryPin, loadSelectedChatRecoveryPins } = loaded.exports;

test("profile recovery requires the exact private workspace, source and snapshot identities", async t => {
  const root = path.join(__dirname, "../.migration-test-work", `selected-recovery-${randomUUID()}`);
  const parent = path.join(root, "trial"), workspace = path.join(parent, "workspace"), legacyRoot = path.join(root, "legacy");
  const snapshotRoot = path.join(parent, "control", `selected-chat-${randomUUID()}`, `chat-snapshot-${randomUUID()}`);
  for (const dir of [workspace, legacyRoot, snapshotRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceId = randomUUID();
  fs.writeFileSync(path.join(workspace, ".pkm-next-workspace"), JSON.stringify({ id: workspaceId }), { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, "core.sqlite"), "fixture", { mode: 0o600 });
  const values = new Map(), secrets = { async get(key) { return values.get(key); }, async store(key, value) { values.set(key, value); } };
  const input = { workspace, legacyRoot, workspaceId, namespace: "0123456789abcdef", chatId: randomUUID(),
    snapshotRoot, sourceFingerprint: "a".repeat(64) };
  const pin = await saveSelectedChatRecoveryPin(secrets, input);
  assert.deepEqual(await loadSelectedChatRecoveryPins(secrets, parent, legacyRoot), [pin]);
  assert.deepEqual(await loadSelectedChatRecoveryPins(secrets, path.join(root, "other"), legacyRoot), []);
  await assert.rejects(() => saveSelectedChatRecoveryPin(secrets, { ...input, sourceFingerprint: "b".repeat(64) }), /different recovery/);
  fs.renameSync(path.join(workspace, "core.sqlite"), path.join(workspace, "old.sqlite"));
  fs.writeFileSync(path.join(workspace, "core.sqlite"), "replacement", { mode: 0o600 });
  await assert.rejects(() => loadSelectedChatRecoveryPins(secrets, parent, legacyRoot), /changed/);
});
