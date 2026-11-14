import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createSelectedChatProfilePolicy } from "../dist/selected-chat-profile-policy.js";

function fixture(t) {
  const dir = resolve("tests", `.selected-policy-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "archive"), cwd = join(dir, "cwd"), program = join(dir, "program");
  mkdirSync(root); mkdirSync(cwd);
  writeFileSync(program, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  let live = true, writers = false;
  const selected = { workspaceId: "workspace", actorId: "local:owner",
    assertCurrent() { if (!live) throw new Error("owner revoked"); } };
  const profile = { id: "profile", workspaceId: "workspace", actorId: "local:owner", sourceRoot: root,
    assertCurrent() { if (!live) throw new Error("profile revoked"); },
    async policy() { return { available: true, trusted: true, localControls: true }; }, async remember() {} };
  const archive = { root, assertNoWriters() { if (writers) throw new Error("writer active"); } };
  const connection = new AbortController();
  const options = { selected, profile, archive, connection: connection.signal,
    commands: [{ id: "only", program, cwd, arguments: [["allowed"], []] }] };
  const binding = { root, workspaceId: "workspace", actorId: "local:owner", sourceFingerprint: "source",
    namespace: "0123456789abcdef", chatId: randomUUID() };
  return { dir, root, cwd, program, options, binding, connection,
    revoke: () => { live = false; }, writers: value => { writers = value; } };
}

test("profile requires a synchronous live writer fence and exact owner identity", async t => {
  const f = fixture(t);
  assert.throws(() => createSelectedChatProfilePolicy({ ...f.options, archive: { root: f.root } }), /fence/);
  assert.throws(() => createSelectedChatProfilePolicy({ ...f.options, archive: { root: f.root, async assertNoWriters() {} } }), /synchronous/);
  assert.throws(() => createSelectedChatProfilePolicy({ ...f.options, profile: { ...f.options.profile, actorId: "other" } }), /identity/);
  const policy = createSelectedChatProfilePolicy(f.options);
  assert.equal(policy.commands[0].arguments(["allowed"]), true);
  assert.equal(policy.commands[0].arguments(["other"]), false);
  await assert.rejects(policy.policy({ ...f.binding, actorId: "other" }), /binding/);
  f.writers(true);
  assert.throws(() => policy.chatSource.assertCurrent(), /writer active/);
  assert.throws(() => policy.commands[0].arguments(["allowed"]), /writer active/);
  f.writers(false);
  f.connection.abort();
  assert.throws(() => policy.assertProfile(), /connection/);
});

test("policy and executable are rechecked after asynchronous work and replacement", async t => {
  const f = fixture(t);
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; });
  const called = new Promise(resolve => { entered = resolve; });
  f.options.profile.policy = async () => { entered(); await wait; return { available: true }; };
  const policy = createSelectedChatProfilePolicy(f.options);
  const pending = policy.policy(f.binding);
  await called; f.revoke(); release();
  await assert.rejects(pending, /revoked/);

  const second = fixture(t);
  const policy2 = createSelectedChatProfilePolicy(second.options);
  renameSync(second.program, `${second.program}.old`);
  writeFileSync(second.program, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.throws(() => policy2.commands[0].arguments(["allowed"]), /changed/);
  const third = fixture(t);
  const policy3 = createSelectedChatProfilePolicy(third.options);
  renameSync(third.cwd, `${third.cwd}.old`);
  mkdirSync(third.cwd);
  assert.throws(() => policy3.commands[0].arguments(["allowed"]), /changed/);
  renameSync(third.root, `${third.root}.old`);
  mkdirSync(third.root);
  assert.throws(() => policy3.chatSource.assertCurrent(), /archive root changed/);
});

test("optimistic snapshot requires its own live synchronous conflict check", async t => {
  const f = fixture(t);
  let current = true;
  const archive = { kind: "optimistic-snapshot", root: f.root,
    assertSnapshotCurrent() { if (!current) throw new Error("snapshot conflict"); } };
  const options = { ...f.options, archive };
  const policy = createSelectedChatProfilePolicy(options);
  assert.equal(policy.commands[0].arguments(["allowed"]), true);
  current = false;
  assert.throws(() => policy.chatSource.assertCurrent(), /snapshot conflict/);
  assert.throws(() => policy.commands[0].arguments(["allowed"]), /snapshot conflict/);
  assert.throws(() => createSelectedChatProfilePolicy({ ...options,
    archive: { kind: "optimistic-snapshot", root: f.root, async assertSnapshotCurrent() {} } }), /synchronous/);
  assert.throws(() => createSelectedChatProfilePolicy({ ...options,
    archive: { kind: "optimistic-snapshot", root: f.root, assertNoWriters() {} } }), /fence/);
});
