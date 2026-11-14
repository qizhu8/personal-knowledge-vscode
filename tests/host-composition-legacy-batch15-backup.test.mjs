import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { fixture, transports, fixturePublisher, actor, hash } from "./host-composition-legacy-batch15-captures.mjs";

const host = () => ({
  async acquireQuiescence() {
    let held = true;
    return { assertHeld() { assert.equal(held, true); }, release() { held = false; } };
  },
});
const nativeRestoreAuthority = {
  actorId: actor.id,
  async authorize(request) {
    return { authorityId: "disposable-fixture", actorId: request.actorId, requestSha256: hash(JSON.stringify(request)),
      expiresAt: Date.now() + 60_000, lineage: "unrelated", trustedEpoch: null };
  },
};
async function repinBackup(path) {
  const manifestPath = join(path, ".pkm-workspace-backup.json");
  const manifest = JSON.parse(await readFile(manifestPath));
  for (const file of manifest.files) {
    const bytes = await readFile(join(path, file.path));
    manifest.totalBytes += bytes.length - file.size;
    file.size = bytes.length; file.sha256 = hash(bytes);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  return manifest;
}

test("actual native Skill effect backup/restore retains complete original source/target and global receipts, default host never grants effects", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor), request = f.input();
  const installed = await io.http("legacy.skill.router.inject", request);
  assert.equal(installed.error, undefined);
  const bytes = await f.bytes();
  await io.close();
  const backup = join(f.parent, "backup"), destination = join(f.parent, "restored");
  const result = await createWorkspaceBackup(f.storage, backup, host(), { nativePublishNoReplace: fixturePublisher(f.parent) });
  assert.equal(result.workspaceId, f.grant().binding.workspaceId);
  assert.equal(JSON.parse(await readFile(join(backup, ".pkm-workspace-backup.json"))).databaseUserVersion, 23);
  await f.close();
  await restoreWorkspaceBackup(backup, destination, { nativePublishNoReplace: fixturePublisher(f.parent), nativeRestoreAuthority });
  const plain = await Storage.open(destination);
  const { Core } = await import("../dist/core.js");
  assert.equal((await new Core(plain).dispatch("capability_call", { operation: "legacy.skill.router.inject", version: 1, arguments: request }, actor)).error.code, "NOT_AVAILABLE");
  await plain.close();
  await f.open(destination);
  const next = await transports(t, f.runtime.core, actor);
  assert.deepEqual(await f.bytes(), bytes);
  assert.deepEqual((await next.mcp("legacy.skill.router.inject", request)).result, installed.result);
  const removal = f.input("remove");
  assert.equal((await next.http("legacy.skill.router.remove", removal)).error, undefined);
  await assert.rejects(f.bytes(), { code: "ENOENT" });
});

test("pending before/after/partial Skill journals block backup; byte or global receipt tampering blocks reads, startup and restore", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor);
  f.state.stageFault = true;
  const request = f.input();
  assert.equal((await io.mcp("legacy.skill.router.inject", request)).error.effect, "unknown");
  await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "pending-backup"), host(), { nativePublishNoReplace: fixturePublisher(f.parent) }), { code: "PENDING_JOURNAL" });
  f.state.stageFault = false; f.state.retry = true;
  assert.equal((await io.http("legacy.skill.router.inject", request)).error, undefined);
  const bytes = await f.bytes();
  const backup = join(f.parent, "good");
  await createWorkspaceBackup(f.storage, backup, host(), { nativePublishNoReplace: fixturePublisher(f.parent) });
  await writeFile(join(f.root, "packages/target/pkm-skills/SKILL.md"), "tampered installed projection");
  assert.equal((await f.runtime.core.dispatch("server_info", {}, actor)).error.code, "RECOVERY_CONFLICT");
  await assert.rejects(f.storage.request({ operation: "knowledge.document.list", args: { offset: 0, limit: 10 }, actorId: actor.id }), { code: "RECOVERY_CONFLICT" });
  await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "bad-current"), host(), { nativePublishNoReplace: fixturePublisher(f.parent) }));
  await writeFile(join(f.root, "packages/target/pkm-skills/SKILL.md"), bytes);
  const bad = join(f.parent, "bad-backup");
  await cp(backup, bad, { recursive: true });
  await writeFile(join(bad, "packages/target/pkm-skills/SKILL.md"), "tampered backup projection");
  await repinBackup(bad);
  await assert.rejects(restoreWorkspaceBackup(bad, join(f.parent, "bad-restored"), { nativePublishNoReplace: fixturePublisher(f.parent) }), { code: "RECOVERY_CONFLICT" });
  f.database.prepare("UPDATE receipts SET fingerprint=? WHERE operation_id=?").run("0".repeat(64), request.operationId);
  assert.equal((await f.runtime.core.dispatch("server_info", {}, actor)).error.code, "RECOVERY_CONFLICT");
  await io.close(); await f.close();
  await assert.rejects(f.open(), { code: "RECOVERY_CONFLICT" });
});

test("global operation IDs are shared with document writes and every unknown journal blocks new Skill effects", async t => {
  const f = await fixture(t), io = await transports(t, f.runtime.core, actor), request = f.input();
  const doc = await io.http("knowledge.document.create", { id: "collision", title: "Collision", content: "unchanged", operationId: request.operationId });
  assert.equal(doc.error, undefined);
  assert.equal((await io.mcp("legacy.skill.router.inject", request)).error.code, "CONFLICT");
  await assert.rejects(f.bytes(), { code: "ENOENT" });
  f.database.exec("CREATE TABLE legacy_unrecognized_intent (id TEXT); INSERT INTO legacy_unrecognized_intent VALUES('unknown');");
  const newRequest = f.input();
  assert.equal((await io.http("legacy.skill.router.inject", newRequest)).error.code, "RECOVERY_CONFLICT");
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_skill_native_intent").get().n, 0);
  f.database.exec("DROP TABLE legacy_unrecognized_intent");
  assert.equal((await io.mcp("legacy.skill.router.inject", newRequest)).error, undefined);
  assert.equal((await io.http("knowledge.document.create", { id: "second", title: "Collision", content: "unchanged", operationId: newRequest.operationId })).error.code, "CONFLICT");
});

test("schema12-22 backup inputs retain historical receipts and migrate only on explicit isolated open", async t => {
  const f = await fixture(t);
  const source = await initialize(join(f.parent, "historic-source"));
  const storage = await Storage.open(source);
  const request = { operation: "knowledge.document.create", actorId: actor.id,
    args: { id: "historical", title: "Historical", content: "Original preserved bytes", operationId: randomUUID() } };
  const historical = await storage.request(request);
  const pristine = join(f.parent, "historic-pristine");
  await createWorkspaceBackup(storage, pristine, host(), { nativePublishNoReplace: fixturePublisher(f.parent) });
  await storage.close();
  for (const version of [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]) {
    const input = join(f.parent, `v${version}-backup`), destination = join(f.parent, `v${version}-restore`);
    await cp(pristine, input, { recursive: true });
    const db = new DatabaseSync(join(input, "core.sqlite"));
    db.exec("DROP TABLE legacy_skill_source_native_intent; DROP TABLE legacy_skill_source_native_receipt; DROP TABLE legacy_skill_source_native_history; DROP TABLE legacy_skill_source_native_adoption;");
    if (version < 22) db.exec("DROP TABLE legacy_classification_command_intent; DROP TABLE legacy_classification_command_receipt; DROP TABLE legacy_classification_command_adoption;");
    if (version < 21) db.exec("DROP TABLE legacy_classification_native_adoption;");
    if (version < 20) db.exec("DROP TABLE legacy_classification_native_receipt; DROP TABLE legacy_classification_native_intent; DROP TABLE legacy_memory_erasure_operations; DROP TABLE legacy_memory_erasure_state; DROP TABLE legacy_memory_erasure_schema;");
    if (version < 19) db.exec("DROP TABLE legacy_skill_native_history; DROP TABLE legacy_skill_native_receipt; DROP TABLE legacy_skill_native_intent;");
    db.exec(`PRAGMA user_version=${version};`);
    db.close();
    const manifest = await repinBackup(input);
    manifest.databaseUserVersion = version;
    await writeFile(join(input, ".pkm-workspace-backup.json"), JSON.stringify(manifest));
    await restoreWorkspaceBackup(input, destination, { nativePublishNoReplace: fixturePublisher(f.parent), nativeRestoreAuthority });
    const untouched = new DatabaseSync(join(destination, "core.sqlite"), { readOnly: true });
    assert.equal(untouched.prepare("PRAGMA user_version").get().user_version, version);
    untouched.close();
    const upgraded = await Storage.open(destination);
    try {
      const current = upgraded.connectNative();
      assert.equal(current.prepare("PRAGMA user_version").get().user_version, 23);
      assert.equal(current.prepare("SELECT COUNT(*) n FROM legacy_skill_native_intent").get().n, 0);
      current.close();
      assert.deepEqual(await upgraded.request(request), historical);
      assert.equal(await readFile(join(destination, "notes/historical.md"), "utf8"), await readFile(join(source, "notes/historical.md"), "utf8"));
    } finally { await upgraded.close(); }
  }
});

test("schema23 reopen refuses altered immutable history DDL instead of silently recreating it", async t => {
  const f = await fixture(t);
  f.database.exec("DROP TRIGGER legacy_skill_native_history_no_delete");
  await f.close();
  await assert.rejects(f.open(), /Skill history schema changed/);
  const db = new DatabaseSync(join(f.root, "core.sqlite"), { readOnly: true });
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_skill_native_history_no_delete'").get(), undefined);
  db.close();
});
