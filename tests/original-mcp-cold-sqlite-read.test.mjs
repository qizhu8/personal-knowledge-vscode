import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot, acquireOriginalMcpRootFence,
  validateOriginalMcpWorkspace } from "../dist/original-mcp-root.js";
import { withOriginalMcpColdSqliteRead, originalMcpColdSqliteReadDatabase } from "../dist/original-mcp-cold-sqlite-read.js";
import { originalTrashCustodyExceptions } from "../dist/original-native-trash-custody.js";
import { recordActionImplementation } from "../dist/action-runtime-selection.js";
import { legacyRetrievalModelOptionalSchemaGroups } from "../dist/legacy-retrieval-model.js";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the real existing isolated framework.");
const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const directory = resolve("tests", `.cold-sqlite-read-${randomUUID()}`), root = join(directory, "root");
  let opened, fence, sourceFence;
  await mkdir(directory, { mode: 0o700 });
  t.after(async () => { await opened?.owner.close(); await fence?.release(); await sourceFence?.release();
    await rm(directory, { recursive: true, force: true }); });
  for (const name of ["notes", "skills", "papers", ".pkm"]) await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "notes/Entry.md"), "---\ntitle: Entry\n---\nDisposable reader fixture.\n", { mode: 0o600 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "cold-sqlite-read-fixture",
    profileSha256: hash("cold-read-profile"), limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 67108864, maxFileBytes: 33554432 } });
  sourceFence = await acquireOriginalMcpRootFence(root);
  opened = await openOriginalMcpRoot(plan, { writerFence: sourceFence });
  await opened.owner.ensureFull();
  return { root, plan, opened, sourceFence, async close() {
    await opened.owner.close(); fence = await acquireOriginalMcpRootFence(root); return fence;
  } };
}
async function primary(root) {
  const stat = await lstat(join(root, "core.sqlite"), { bigint: true });
  return { pin: [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
    sha256: hash(await readFile(join(root, "core.sqlite"))) };
}
async function noAux(root) {
  assert(!(await readdir(root)).some(name => /^core\.sqlite-(wal|shm|journal|mj)/.test(name)));
}
test("actual owner close, new cold fence and SELECT-only validation preserve main pins/hash and leave no auxiliary files", {
  timeout: 120000,
}, async t => {
  const f = await fixture(t), fence = await f.close(), before = await primary(f.root);
  await noAux(f.root);
  let expired;
  await withOriginalMcpColdSqliteRead(f.plan, fence, async context => {
    const reader = originalMcpColdSqliteReadDatabase(context, f.plan);
    assert.equal(reader.prepare("SELECT lease_until FROM native_runtime_owner WHERE singleton=1").get().lease_until, 0);
    assert.throws(() => reader.prepare("UPDATE native_runtime_owner SET lease_until=1"), { code: "RECOVERY_REQUIRED" });
    assert.throws(() => originalMcpColdSqliteReadDatabase({ ...context }, f.plan), { code: "RECOVERY_REQUIRED" });
    expired = context;
    assert.equal(await validateOriginalMcpWorkspace(f.root, undefined, fence), f.root);
  });
  assert.throws(() => originalMcpColdSqliteReadDatabase(expired, f.plan), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await primary(f.root), before); await noAux(f.root);
  assert.equal(await validateOriginalMcpWorkspace(f.root, undefined, fence), f.root);
  assert.deepEqual(await primary(f.root), before); await noAux(f.root);
});
test("unbranded fences, active owner/auxiliaries and hot journals cannot obtain cold read authority", {
  timeout: 120000,
}, async t => {
  const f = await fixture(t);
  await assert.rejects(withOriginalMcpColdSqliteRead(f.plan, { assertHeld() {} }, async () => true), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(withOriginalMcpColdSqliteRead(f.plan, f.sourceFence, async () => true), { code: "RECOVERY_REQUIRED" });
  const fence = await f.close(), before = await primary(f.root);
  await writeFile(join(f.root, "core.sqlite-journal"), "Owned invalid hot-journal fixture", { mode: 0o600 });
  const names = await readdir(f.root);
  await assert.rejects(withOriginalMcpColdSqliteRead(f.plan, fence, async () => true), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await readdir(f.root), names); assert.deepEqual(await primary(f.root), before);
});
test("invalid native schema is refused after inspection without admitting context or leaving inspector-created sidecars", {
  timeout: 120000,
}, async t => {
  const f = await fixture(t), fence = await f.close();
  const db = new DatabaseSync(join(f.root, "core.sqlite"));
  try { db.exec("CREATE TABLE cold_read_unrecognized_fixture(value INTEGER)"); } finally { db.close(); }
  const before = await primary(f.root), names = await readdir(f.root);
  let called = false;
  await assert.rejects(withOriginalMcpColdSqliteRead(f.plan, fence, async () => { called = true; }), { code: "RECOVERY_REQUIRED" });
  assert.equal(called, false); assert.deepEqual(await primary(f.root), before);
  assert.deepEqual(await readdir(f.root), names); await noAux(f.root);
});
test("exact immutable Action preferences remain readable without granting execution; altered schema, digest and actor stay refused", {
  timeout: 120000,
}, async t => {
  for (const condition of ["retained", "schema", "digest", "actor"]) await t.test(condition, async t => {
    const f = await fixture(t), database = f.opened.storage.connectNative();
    try {
      recordActionImplementation(database, { actorId: condition === "actor" ? "mcp:other" : "mcp:external",
        actionId: "unexecuted-cold-preference", definitionDigest: hash("unexecuted fixture definition"),
        implementationId: "unexecuted-fixture" });
      if (condition === "schema") database.exec("DROP TRIGGER action_runtime_selections_no_update");
      if (condition === "digest") {
        const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE name='action_runtime_selections_no_update'").get().sql;
        database.exec("DROP TRIGGER action_runtime_selections_no_update");
        database.prepare("UPDATE action_runtime_selections SET payload_sha256=?").run(hash("tampered"));
        database.exec(trigger);
      }
    } finally { database.close(); }
    const fence = await f.close(), before = await primary(f.root);
    let called = false;
    const inspect = () => withOriginalMcpColdSqliteRead(f.plan, fence, async context => {
      called = true;
      const reader = originalMcpColdSqliteReadDatabase(context, f.plan);
      assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM action_runtime_selections").get().n, 1);
    });
    if (condition === "retained") {
      await inspect();
      assert.equal(called, true);
    } else {
      await assert.rejects(inspect, /schema|selection|preferences|optional admission DDL/i);
      assert.equal(called, false);
    }
    assert.deepEqual(await primary(f.root), before); await noAux(f.root);
  });
});
test("optional candidate, lifecycle and frozen-model journals require their exact immutable production DDL", {
  timeout: 120000,
}, async t => {
  for (const group of legacyRetrievalModelOptionalSchemaGroups.slice(1)) await t.test(group.tables[0], async t => {
    const f = await fixture(t), database = f.opened.storage.connectNative();
    try {
      database.exec(group.ddl);
      database.exec(`ALTER TABLE ${group.tables[0]} ADD COLUMN unexpected_fixture TEXT`);
    } finally { database.close(); }
    const fence = await f.close(), before = await primary(f.root);
    let called = false;
    await assert.rejects(withOriginalMcpColdSqliteRead(f.plan, fence, async () => { called = true; }),
      /optional admission DDL/i);
    assert.equal(called, false); assert.deepEqual(await primary(f.root), before); await noAux(f.root);
  });
});
test("a linked native database is rejected before opening or creating SQLite metadata", { timeout: 120000 }, async t => {
  const f = await fixture(t), fence = await f.close();
  await link(join(f.root, "core.sqlite"), join(f.root, "owned-hardlink-fixture"));
  const before = await primary(f.root), names = await readdir(f.root);
  await assert.rejects(withOriginalMcpColdSqliteRead(f.plan, fence, async () => true), { code: "RECOVERY_REQUIRED" });
  assert.deepEqual(await primary(f.root), before); assert.deepEqual(await readdir(f.root), names); await noAux(f.root);
});
test("stale main pins during a cold read cause typed uncertainty and still close its owned inspection connection", {
  timeout: 120000,
}, async t => {
  const f = await fixture(t), fence = await f.close();
  await assert.rejects(withOriginalMcpColdSqliteRead(f.plan, fence, async context => {
    const bytes = await readFile(join(f.root, "core.sqlite"));
    await writeFile(join(f.root, "core.sqlite"), bytes);
    originalMcpColdSqliteReadDatabase(context, f.plan);
  }), error => error.code === "RECOVERY_REQUIRED" && error.effect === "unknown");
  await noAux(f.root);
});
test("live readonly custody sees real WAL-only pending data and neither checkpoints nor discards it", {
  timeout: 120000,
}, async t => {
  const f = await fixture(t), db = f.opened.storage.connectNative(), id = randomUUID();
  try {
    db.prepare("INSERT INTO migration_runtime_intents VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, f.opened.workspaceId, f.root, "mcp:external", "knowledge.trash.move",
        hash("invalid live fixture"), "{}", "{}", hash("invalid live fixture"));
    const before = await primary(f.root), wal = hash(await readFile(join(f.root, "core.sqlite-wal")));
    await assert.rejects(originalTrashCustodyExceptions(f.plan, () => undefined), { code: "INVALID_WORKSPACE" });
    assert.deepEqual(await primary(f.root), before);
    assert.equal(hash(await readFile(join(f.root, "core.sqlite-wal"))), wal);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migration_runtime_intents WHERE operation_id=?").get(id).n, 1);
  } finally { db.prepare("DELETE FROM migration_runtime_intents WHERE operation_id=?").run(id); db.close(); }
});
