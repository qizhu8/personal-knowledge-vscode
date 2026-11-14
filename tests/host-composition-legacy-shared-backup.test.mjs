import test from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { sharedFixture, transports, call, human, item, hash, fixturePublisher, originalCapture } from "./host-composition-legacy-shared-captures.mjs";

const host = () => ({
  async acquireQuiescence() {
    let held = true;
    return { assertHeld() { assert.equal(held, true); }, release() { held = false; } };
  },
});

test("real shared native backup/restore preserves paused ciphertext, exact inline Markdown/history/global receipts and no implicit replay", async t => {
  const f = await sharedFixture(t);
  const io = await transports(t, f.runtime.core);
  const restoreRequest = f.restoreArgs(), restored = (await io.http("agent.snapshot.restore-paused", restoreRequest)).result;
  assert.equal(restored.state, "paused");
  const request = { slug: "Original", expected_digest: hash(await f.read()), operationId: randomUUID(), command: { action: "create", item } };
  const response = await io.mcp("legacy.note.workitems.command", request);
  assert.equal(response.error, undefined);
  const originalBytes = await f.read();
  await io.close();
  const backupPath = join(f.parent, "backup"), target = join(f.parent, "restored");
  const backup = await createWorkspaceBackup(f.storage, backupPath, host(), { nativePublishNoReplace: f.publish });
  assert.equal(JSON.parse(await readFile(join(backupPath, ".pkm-workspace-backup.json"))).databaseUserVersion, 23);
  await f.close();
  await restoreWorkspaceBackup(backupPath, target, { nativePublishNoReplace: f.publish, nativeRestoreAuthority });
  await f.open(target);
  const native = await transports(t, f.runtime.core);
  assert.deepEqual((await native.mcp("agent.snapshot.restore-get", { restoreId: restored.restoreId }, "capability_read")).result, restored);
  assert.deepEqual((await native.http("agent.snapshot.restore-paused", restoreRequest)).result, restored);
  assert.deepEqual((await native.mcp("legacy.note.workitems.command", request)).result, response.result);
  assert.equal(await readFile(join(target, "notes/Original.md"), "utf8"), originalBytes);
  assert.deepEqual(Buffer.from(f.database.prepare("SELECT original FROM legacy_snapshot_restore_originals").get().original), f.ciphertext);
  assert.deepEqual(await readFile(join(target, "agent-snapshot-reads/.pkm/state/agent-snapshots", `${f.snapshot.snapshotId}.json`)), f.ciphertext);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_snapshot_restore_effects").get().n, 0);
  const claim = { slug: "Original", expected_digest: response.result.digest, operationId: randomUUID(),
    command: { action: "claim", id: item.id } };
  const { writer } = originalCapture();
  writer.setStorePath(backupPath);
  const expected = writer.noteWorkItemCommand("Original", claim.expected_digest, claim.command, { id: human.id, role: "user" });
  const claimed = await native.http("legacy.note.workitems.command", claim);
  assert.deepEqual(claimed.result, JSON.parse(JSON.stringify({ ok: true, ...expected })));
  assert.equal(await readFile(join(target, "notes/Original.md"), "utf8"), await readFile(join(backupPath, "notes/Original.md"), "utf8"));
  assert.equal(backup.workspaceId, f.binding.targetWorkspaceId);
});

test("native transport inline unknown journal restart blocks workspace/backup, partial bytes never replay, exact authorized retry finishes", async t => {
  const f = await sharedFixture(t);
  let fail = true;
  f.inlinePolicy.assertNoLegacySyncEffects = async () => {
    if (fail && f.database?.prepare("SELECT 1 FROM legacy_inline_note_intent").get()) throw new Error("injected native unknown after durable staging");
  };
  const io = await transports(t, f.runtime.core);
  const before = await f.read(), request = { slug: "Original", expected_digest: hash(before), operationId: randomUUID(),
    command: { action: "create", item } };
  const unknown = await io.http("legacy.note.workitems.command", request);
  assert.equal(unknown.error.effect, "unknown");
  const pending = JSON.parse(f.database.prepare("SELECT payload FROM legacy_inline_note_intent").get().payload);
  assert.equal(pending.before, before);
  assert.equal(await f.read(), before);
  assert.equal((await f.runtime.core.dispatch("server_info", {}, human)).error.code, "RECOVERY_REQUIRED");
  assert.equal((await io.mcp("legacy.note.workitems.command", { ...request, operationId: randomUUID() })).error.code, "RECOVERY_REQUIRED");
  await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "blocked-backup"), host(), { nativePublishNoReplace: f.publish }),
    error => error.code === "PENDING_JOURNAL");
  await io.close();
  fail = false;
  await writeFile(join(f.root, "notes/Original.md"), `${before}\npartial external effect`);
  await f.restart();
  assert.equal(await f.read(), `${before}\npartial external effect`);
  const next = await transports(t, f.runtime.core);
  assert.equal((await next.mcp("legacy.note.workitems.command", request)).error.code, "RECOVERY_REQUIRED");
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_inline_note_intent").get().n, 1);
  // Explicit native operator repairs exact-before; restart itself never rolls back or executes.
  await writeFile(join(f.root, "notes/Original.md"), before);
  const retry = await next.http("legacy.note.workitems.command", request);
  assert.deepEqual(retry.result, pending.result);
  assert.equal(await f.read(), pending.after);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM legacy_inline_note_intent").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) n FROM receipts WHERE operation_id=?").get(request.operationId).n, 1);
  assert.deepEqual((await next.mcp("legacy.note.workitems.command", request)).result, pending.result);
});

test("all-before-effects recovery rejects combined/unknown journals and tampered paused staging, never invokes native adapters", async t => {
  const f = await sharedFixture(t);
  const restored = (await call(f.runtime.core, "agent.snapshot.restore-paused", f.restoreArgs())).result;
  let effects = 0;
  f.pausedPolicy.control = {
    resume: async () => { effects++; throw new Error("unknown"); },
    cancel: async () => { effects++; throw new Error("unknown"); },
    inspect: async binding => ({ sessionId: binding.targetSessionId, chatId: binding.targetChatId, state: "unknown" }),
  };
  await f.restart();
  const io = await transports(t, f.runtime.core);
  const unknown = await io.http("agent.snapshot.resume-native", { opId: randomUUID(), restoreId: restored.restoreId, expectedRevision: 1 });
  assert.equal(unknown.result.state, "resume-unknown"); assert.equal(effects, 1);
  await assert.rejects(createWorkspaceBackup(f.storage, join(f.parent, "unknown-backup"), host(), { nativePublishNoReplace: f.publish }),
    error => error.code === "PENDING_JOURNAL");
  await io.close();
  f.database.exec("CREATE TABLE pending_future_journal(value TEXT); INSERT INTO pending_future_journal VALUES('unknown effect')");
  await assert.rejects(f.restart(), error => error.code === "RECOVERY_CONFLICT");
  assert.equal(effects, 1);
  await f.close();
  const db = new DatabaseSync(join(f.root, "core.sqlite"));
  db.exec("DROP TABLE pending_future_journal; UPDATE legacy_snapshot_restore_staging SET record='{}' WHERE kind='task'");
  db.close();
  await assert.rejects(f.open(), error => error.code === "RECOVERY_CONFLICT");
  assert.equal(effects, 1);

  const malicious = await sharedFixture(t);
  const paused = (await call(malicious.runtime.core, "agent.snapshot.restore-paused", malicious.restoreArgs())).result;
  let resumed = 0, published = 0;
  malicious.pausedPolicy.control = {
    resume: async () => { resumed++; },
    cancel: async () => { resumed++; },
    inspect: async binding => ({ sessionId: binding.targetSessionId, chatId: binding.targetChatId, state: "unknown" }),
  };
  await malicious.restart();
  const rows = malicious.database.prepare("SELECT kind,record FROM legacy_snapshot_restore_staging ORDER BY kind").all();
  const staging = Object.fromEntries(rows.map(row => [row.kind, JSON.parse(row.record)]));
  staging.task.task = "Malicious substituted task, never approved by the original ciphertext history";
  const text = JSON.stringify(staging.task);
  malicious.database.prepare("UPDATE legacy_snapshot_restore_staging SET record=?,sha256=? WHERE kind='task'").run(text, hash(text));
  const binding = JSON.parse(malicious.database.prepare("SELECT binding FROM legacy_snapshot_restore_originals").get().binding);
  const record = JSON.parse(malicious.database.prepare("SELECT record FROM legacy_snapshot_restore_records").get().record);
  record.planSha256 = hash(JSON.stringify({ binding, staging }));
  malicious.database.prepare("UPDATE legacy_snapshot_restore_records SET record=?").run(JSON.stringify(record));
  await assert.rejects(createWorkspaceBackup(malicious.storage, join(malicious.parent, "malicious-backup"), host(), {
    nativePublishNoReplace: async () => { published++; throw new Error("Must never publish substituted source state"); },
  }), error => error.code === "RECOVERY_CONFLICT");
  assert.equal((await call(malicious.runtime.core, "agent.snapshot.restore-get", { restoreId: paused.restoreId })).error.code, "RECOVERY_CONFLICT");
  assert.equal((await call(malicious.runtime.core, "agent.snapshot.resume-native", {
    opId: randomUUID(), restoreId: paused.restoreId, expectedRevision: paused.revision,
  })).error.code, "RECOVERY_CONFLICT");
  assert.equal(resumed, 0); assert.equal(published, 0);
  assert.equal(malicious.database.prepare("SELECT COUNT(*) n FROM legacy_snapshot_restore_effects").get().n, 0);
  await assert.rejects(malicious.restart(), error => error.code === "RECOVERY_CONFLICT");
  assert.equal(resumed, 0); assert.equal(published, 0);
});

test("schema12-17 backup inputs restore without new-table assumptions, migrate coherently to23 and preserve historical bytes/receipts", async t => {
  const f = await sharedFixture(t);
  const empty = join(f.parent, "old-source");
  await initialize(empty);
  const storage = await Storage.open(empty);
  const historicalRequest = { operation: "knowledge.document.create", actorId: human.id,
    args: { id: "historical", title: "Historical receipt", content: "Exact older bytes", operationId: randomUUID() } };
  const historical = await storage.request(historicalRequest);
  const pristine = join(f.parent, "pristine-backup");
  await createWorkspaceBackup(storage, pristine, host(), { nativePublishNoReplace: fixturePublisher(f.parent) });
  await storage.close();
  for (const version of [12, 13, 14, 15, 16, 17]) {
    const input = join(f.parent, `schema-${version}-backup`), target = join(f.parent, `schema-${version}-restored`);
    await cp(pristine, input, { recursive: true });
    const db = new DatabaseSync(join(input, "core.sqlite"));
    db.exec(`DROP TRIGGER legacy_inline_global_intent; DROP TRIGGER legacy_inline_global_receipt;
      DROP TRIGGER legacy_snapshot_global_receipt; DROP TABLE legacy_inline_note_intent; DROP TABLE legacy_inline_note_receipt;
      DROP TABLE legacy_snapshot_restore_schema; DROP TABLE legacy_snapshot_restore_originals;
      DROP TABLE legacy_snapshot_restore_records; DROP TABLE legacy_snapshot_restore_staging;
      DROP TABLE legacy_snapshot_restore_receipts; DROP TABLE legacy_snapshot_restore_effects;
      PRAGMA user_version=${version};`);
    db.close();
    const bytes = await readFile(join(input, "core.sqlite"));
    const manifestPath = join(input, ".pkm-workspace-backup.json"), manifest = JSON.parse(await readFile(manifestPath));
    const file = manifest.files.find(file => file.path === "core.sqlite");
    manifest.totalBytes += bytes.length - file.size; file.size = bytes.length; file.sha256 = hash(bytes);
    manifest.databaseUserVersion = version;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await restoreWorkspaceBackup(input, target, { nativePublishNoReplace: fixturePublisher(f.parent), nativeRestoreAuthority });
    const reopened = await Storage.open(target);
    try {
      const runtime = await createNativeRuntime({ storage: reopened });
      assert.deepEqual(await reopened.request(historicalRequest), historical);
      const migrated = reopened.connectNative();
      assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 23);
      assert.equal(migrated.prepare("SELECT COUNT(*) n FROM legacy_inline_note_receipt").get().n, 0);
      assert.equal(migrated.prepare("SELECT COUNT(*) n FROM legacy_snapshot_restore_records").get().n, 0);
      migrated.close();
      await runtime.close();
    } finally { await reopened.close(); }
    assert.equal(await readFile(join(target, "notes/historical.md"), "utf8"), await readFile(join(empty, "notes/historical.md"), "utf8"));
  }
});
