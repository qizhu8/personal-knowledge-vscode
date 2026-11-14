"use strict";
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

const server = process.env.PKM_TRIAL_SERVER_DIST;
if (!server) throw new Error("Set PKM_TRIAL_SERVER_DIST to an isolated Next server build.");
const { selectedChatPermissionStore } = require(path.join(server, "selected-chat-permission-store.js"));
const scope = `tool:${"a".repeat(64)}`;

test("profile-local grants survive restart, are exact-scoped, fenced, and cannot revive after key rotation", t => {
  const dir = path.resolve(".migration-test-work", `selected-permissions-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "grants.sqlite"), program = path.join(dir, "program");
  fs.writeFileSync(program, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const secret = randomBytes(32).toString("base64url"), nextSecret = randomBytes(32).toString("base64url");
  const commands = [{ id: "program", program, cwd: dir, arguments: [["allowed"]] }];
  const identity = { secret, workspaceId: randomUUID(), namespace: "0123456789abcdef",
    chatId: randomUUID(), sourceFingerprint: "b".repeat(64), commands };
  let live = true;
  const assertCurrent = () => { if (!live) throw new Error("owner revoked"); };
  let db = new DatabaseSync(filename);
  const store = overrides => selectedChatPermissionStore({ database: db, ...identity, assertCurrent, ...overrides });
  assert.deepEqual(store().read(), { scopes: [], allowAll: false });
  assert.throws(() => store().remember(scope, "approve", () => { throw new Error("snapshot revoked"); }), /snapshot revoked/);
  assert.deepEqual(store().read(), { scopes: [], allowAll: false });
  store().remember(scope, "approve", assertCurrent);
  db.close();
  db = new DatabaseSync(filename);
  assert.deepEqual(store().read(), { scopes: [scope], allowAll: false });
  for (const change of [
    { secret: nextSecret }, { workspaceId: randomUUID() }, { namespace: "fedcba9876543210" },
    { chatId: randomUUID() }, { sourceFingerprint: "c".repeat(64) },
    { commands: [{ ...commands[0], arguments: [["different"]] }] },
  ]) assert.deepEqual(store(change).read(), { scopes: [], allowAll: false });
  const row = db.prepare("SELECT identity, mac FROM selected_chat_permission_v1 WHERE scope = ?").get(scope);
  db.prepare("UPDATE selected_chat_permission_v1 SET mac = ? WHERE identity = ? AND scope = ?")
    .run("0".repeat(64), row.identity, scope);
  assert.deepEqual(store().read(), { scopes: [], allowAll: false });
  db.prepare("UPDATE selected_chat_permission_v1 SET mac = ? WHERE identity = ? AND scope = ?")
    .run(row.mac, row.identity, scope);
  store().remember(scope, "allow-all", assertCurrent);
  assert.equal(store().read().allowAll, true);
  db.close();
  const oldDatabase = fs.readFileSync(filename);
  db = new DatabaseSync(filename);
  assert.deepEqual(store({ secret: nextSecret }).read(), { scopes: [], allowAll: false });
  fs.renameSync(program, `${program}.old`);
  fs.writeFileSync(program, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.deepEqual(store().read(), { scopes: [], allowAll: false });
  store({ secret: nextSecret }).remember(scope, "approve", assertCurrent);
  assert.deepEqual(store({ secret: nextSecret }).read(), { scopes: [scope], allowAll: false });
  db.close();
  fs.writeFileSync(filename, oldDatabase);
  db = new DatabaseSync(filename);
  assert.deepEqual(store({ secret: nextSecret }).read(), { scopes: [], allowAll: false });
  live = false;
  assert.throws(() => store().remember(scope, "approve", assertCurrent), /owner revoked/);
  db.close();
});
