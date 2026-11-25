import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { RootOwner, assertRootOwner, assertRootReadScope } from "../dist/root-owner.js";
import { initialize, Storage, assertStorage } from "../dist/storage.js";
import { CoreError } from "../dist/contracts.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { classifyStorageStartup, bootstrapHash } from "../dist/storage-startup-classification.js";
import { STORAGE_BOOTSTRAP_PROFILE_JSON, STORAGE_BOOTSTRAP_PROFILE_SHA256 } from "../dist/storage-bootstrap-profile.js";
import { bootstrapSourceFiles } from "../scripts/generate-storage-bootstrap-profile.mjs";
import { importLegacyWorkspace, planLegacyImport } from "../dist/legacy-import.js";
import { initializeFreshNoteQuerySchema } from "../dist/fresh-note-query-model.js";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";

const note = "---\ntitle: Entry\ndocumentId: entry\nrevision: 1\ndeleted: false\n---\nSynthetic authoritative Note.\n";
const rootOwnerUrl = new URL("../dist/root-owner.js", import.meta.url).href;
const fenceUrl = new URL("../dist/linux-root-writer-fence.js", import.meta.url).href;
async function fixture(t, { full = true } = {}) {
  const directory = resolve(".migration-test-work", `root-owner-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await initialize(join(directory, "root"));
  await writeFile(join(root, "notes/entry.md"), note, { mode: 0o600 });
  if (full) {
    const storage = await Storage.open(root);
    await storage.close();
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root };
}
function database(root, work) {
  const db = new DatabaseSync(join(root, "core.sqlite"));
  try { return work(db); } finally { db.close(); }
}
function competitor(root, expected = "busy") {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const {acquireLinuxRootWriterFence} = await import(process.argv[1]);
    try { const fence=await acquireLinuxRootWriterFence(process.argv[2],100); await fence.release(); console.log("acquired"); }
    catch(error) { if(error.code!=="BUSY") throw error; console.log("busy"); }
  `, fenceUrl, root], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), expected);
}
async function canonicalFailure(root) {
  let storage;
  try {
    storage = await Storage.open(root, { deferRecovery: true });
    const runtime = await createNativeRuntime({ storage });
    await runtime.close();
    assert.fail("Expected canonical native startup failure.");
  } catch (error) {
    return { code: error.code, message: error.message, effect: error.effect };
  } finally { await storage?.close(); }
}
function addReceipt(root) {
  database(root, db => db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
    .run(randomUUID(), "a".repeat(64), "{}", "synthetic-reader", "knowledge.document.create", new Date().toISOString()));
}
function addConflictingWrite(root) {
  database(root, db => db.prepare(`INSERT INTO pending_write
    (singleton,operation_id,fingerprint,actor_id,operation,document_id,before_sha256,after_markdown,document_path,document_area)
    VALUES(1,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), "b".repeat(64), "synthetic-writer",
    "knowledge.document.update", "entry", "0".repeat(64), note.replace("Synthetic", "Uncommitted"), "entry.md", "notes"));
}

test("release profile is bound to actual canonical schema, exhaustive table roles and source closure", async t => {
  const { root } = await fixture(t);
  assert.equal(bootstrapHash(STORAGE_BOOTSTRAP_PROFILE_JSON), STORAGE_BOOTSTRAP_PROFILE_SHA256);
  const profile = JSON.parse(STORAGE_BOOTSTRAP_PROFILE_JSON);
  assert.deepEqual(await bootstrapSourceFiles(), profile.sourceFiles, "Rebuild and regenerate the profile after changing a canonical bootstrap source.");
  const actual = database(root, db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name));
  assert.deepEqual(profile.tables.map(table => table.name), actual);
  assert.equal(profile.tables.find(table => table.name === "receipts").role, "empty");
  assert.equal(classifyStorageStartup(root).kind, "plain");
});

test("plain classification reuses one live empty-table check without caching row or schema verdicts", async t => {
  const { root } = await fixture(t);
  const db = new DatabaseSync(join(root, "core.sqlite"));
  const prepare = db.prepare.bind(db);
  let prepares = 0, reads = 0;
  t.mock.method(db, "prepare", (sql, ...args) => {
    const statement = prepare(sql, ...args);
    if (sql.startsWith("SELECT 1")) {
      prepares++;
      const get = statement.get.bind(statement);
      t.mock.method(statement, "get", (...parameters) => { reads++; return get(...parameters); });
    }
    return statement;
  });
  try {
    assert.deepEqual(classifyStorageStartup(root, db), { kind: "plain", database: "plain-v23" });
    assert.deepEqual(classifyStorageStartup(root, db), { kind: "plain", database: "plain-v23" });
    assert.equal(prepares, 1, "repeated qualification must not prepare a query per empty table");
    assert.equal(reads, 2, "each qualification must still query the actual current rows");
    addReceipt(root);
    assert.deepEqual(classifyStorageStartup(root, db), { kind: "full-required", reason: "durable-state" });
    db.exec("DELETE FROM receipts");
    assert.equal(classifyStorageStartup(root, db).kind, "plain");
    db.exec("DELETE FROM approval_bridge_schema");
    assert.deepEqual(classifyStorageStartup(root, db), { kind: "full-required", reason: "durable-state" });
    db.exec("INSERT INTO approval_bridge_schema(version) VALUES(1)");
    assert.equal(classifyStorageStartup(root, db).kind, "plain");
    db.exec("CREATE TABLE unknown_admission_state(value TEXT)");
    assert.deepEqual(classifyStorageStartup(root, db), { kind: "full-required", reason: "schema" });
    db.exec("DROP TABLE unknown_admission_state");
    assert.equal(classifyStorageStartup(root, db).kind, "plain");
    assert.equal(prepares, 1, "schema requalification must not turn statement reuse into a cached verdict");
  } finally { db.close(); }
  assert.equal(classifyStorageStartup(root).kind, "plain", "statement ownership must not leak into another connection");
});

test("unknown, damaged and source-unbound release profiles fail full, never false plain", async t => {
  const { root } = await fixture(t);
  const code = await readFile(new URL("../dist/storage-startup-classification.js", import.meta.url), "utf8");
  const profile = JSON.parse(STORAGE_BOOTSTRAP_PROFILE_JSON);
  const variants = [
    { json: STORAGE_BOOTSTRAP_PROFILE_JSON, sha: "0".repeat(64) },
    { json: JSON.stringify({ ...profile, schema: "pkm.storage-bootstrap-profile/v99" }) },
    { json: JSON.stringify({ ...profile, databaseVersion: 28 }) },
    { json: JSON.stringify({ ...profile, sourceSha256: "0".repeat(64) }) },
  ];
  for (const [index, variant] of variants.entries()) {
    const descriptor = "data:text/javascript," + encodeURIComponent(
      `export const STORAGE_BOOTSTRAP_PROFILE_JSON=${JSON.stringify(variant.json)};`
      + `export const STORAGE_BOOTSTRAP_PROFILE_SHA256=${JSON.stringify(variant.sha ?? bootstrapHash(variant.json))};`);
    const isolated = "data:text/javascript," + encodeURIComponent(code
      .replace("./storage-bootstrap-profile.js", descriptor)
      .replace("./workspace-storage-paths.js", new URL("../dist/workspace-storage-paths.js", import.meta.url).href)) + `#negative-${index}`;
    const { classifyStorageStartup: classify } = await import(isolated);
    assert.deepEqual(classify(root), { kind: "full-required", reason: "profile" });
  }
});

test("v23 ordinary startup imports neither Storage, Core, contracts, NativeRuntime nor worker", async t => {
  const { root } = await fixture(t);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {registerHooks} from "node:module";
    const seen=[];
    registerHooks({load(url,context,next){ if(url.includes("/dist/")) seen.push(url); return next(url,context); }});
    const {RootOwner}=await import(process.argv[1]);
    const owner=await RootOwner.open(process.argv[2]);
    try {
      const result=await owner.withReadScope(scope=>({kind:scope.full?"full":"plain",root:scope.root}));
      console.log(JSON.stringify({seen,result,classification:owner.startupClassification()}));
    } finally { await owner.close(); }
  `, rootOwnerUrl, root], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.result.kind, "plain");
  assert.deepEqual(observed.classification, { kind: "plain", database: "plain-v23" });
  assert(!observed.seen.some(url => /\/(?:storage|storage-worker|core|contracts|native-runtime)\.js$/.test(url)), observed.seen.join("\n"));
});

test("public Storage.open still performs full schema bootstrap, while opt-in fresh owner starts at v0", async t => {
  const { root } = await fixture(t, { full: false });
  let owner = await RootOwner.open(root);
  assert.equal(database(root, db => db.prepare("PRAGMA user_version").get().user_version), 0);
  assert.deepEqual(database(root, db => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)), ["native_runtime_owner"]);
  const lease = owner.workspaceLease();
  await owner.close();
  const storage = await Storage.open(root);
  try {
    assert.equal(database(root, db => db.prepare("PRAGMA user_version").get().user_version), 23);
    assert.equal(storage.workspaceLease().fence, lease.fence + 1);
    assertStorage(storage);
  } finally { await storage.close(); }
  owner = await RootOwner.open(root);
  try { assert.deepEqual(owner.startupClassification(), { kind: "plain", database: "plain-v23" }); }
  finally { await owner.close(); }
});

test("exact disposable Note query schemas requalify under both actual v0 and v23 owners", async t => {
  for (const full of [false, true]) {
    const { root } = await fixture(t, { full });
    const owner = await RootOwner.open(root);
    try {
      const lease = { ...owner.workspaceLease() };
      const stat = await lstat(root, { bigint: true });
      const workspaceId = await owner.workspaceId(), rootPin = `${stat.dev}:${stat.ino}`;
      const db = owner.connectNative();
      try {
        initializeFreshNoteQuerySchema(db, { assert() { owner.assertWorkspaceLease(); return { workspaceId, rootPin }; } });
        db.prepare("INSERT INTO fresh_note_query_meta VALUES(1,1,?,?,0,'disposable')").run(workspaceId, rootPin);
      } finally { db.close(); }
      await owner.withReadScope(scope => assert.equal(scope.full, undefined));
      assert.deepEqual(owner.workspaceLease(), lease);
      assert.equal(owner.startupClassification().database, full ? "plain-v23" : "owner-only-v0");
    } finally { await owner.close(); }
  }
});

test("canonical basic Note attachment survives v0/v23 reopen and closes its query connection before full mutation", async t => {
  for (const full of [false, true]) {
    const { root } = await fixture(t, { full });
    let owner = await RootOwner.open(root);
    const list = () => owner.withReadScope(scope => owner.readBasicLegacyNotes(scope, { kind: "list", arguments: {} }));
    try {
      const leaseConnection = owner.leaseDatabase, connect = owner.connectNative.bind(owner);
      let queryConnection;
      t.mock.method(owner, "connectNative", () => { queryConnection = connect(); return queryConnection; });
      const first = await list();
      assert.equal(JSON.parse(first.text).notes[0].slug, "entry");
      assert(queryConnection && queryConnection !== leaseConnection);
      assert.equal(leaseConnection.isTransaction, false);
      assert.equal(owner.leaseDatabase, leaseConnection);
      assert.equal(database(root, db => db.prepare("PRAGMA user_version").get().user_version), full ? 23 : 0);
      await owner.withReadScope(scope => assert.equal(scope.full, undefined));
      await owner.close();
      assert.equal(queryConnection.isOpen, false);
      owner = await RootOwner.open(root);
      assert.equal(owner.startupClassification().kind, "plain");
      assert.equal((await list()).text, first.text);
      const query = owner.basicNoteTask;
      const attachment = await owner.ensureFull();
      assert.equal(owner.basicNoteTask, undefined);
      await assert.rejects(async () => (await query).read({}, { kind: "list", arguments: {} }), { code: "STORAGE_UNAVAILABLE" });
      const created = await attachment.runtime.core.dispatch("capability_call", {
        operation: "knowledge.document.create", version: 1,
        arguments: { operationId: randomUUID(), id: "after-basic", title: "After basic", content: "Authoritative mutation.\n" },
      }, { id: "synthetic-writer", canWrite: true });
      assert.equal(created.result.id, "after-basic");
      assert.match(await readFile(join(root, "notes/after-basic.md"), "utf8"), /Authoritative mutation/);
    } finally { await owner.close(); }
  }
});

test("basic Note reads serialize live scopes and full upgrade/close drain admitted work without a fence gap", async t => {
  for (const closing of [false, true]) {
    const { root } = await fixture(t);
    const owner = await RootOwner.open(root);
    const qualify = owner.qualifyFreshLegacyReadScope.bind(owner);
    let entered, allAdmitted, finish, calls = 0, admitted = 0, inside = 0, maximum = 0;
    const enteredRead = new Promise(resolveEntered => { entered = resolveEntered; });
    const admittedReads = new Promise(resolveAdmitted => { allAdmitted = resolveAdmitted; });
    const gate = new Promise(resolveFinish => { finish = resolveFinish; });
    t.mock.method(owner, "qualifyFreshLegacyReadScope", async scope => {
      inside++; maximum = Math.max(maximum, inside);
      try {
        if (++calls === 1) { entered(); await gate; }
        return await qualify(scope);
      } finally { inside--; }
    });
    let retained;
    try {
      const reads = [0, 1, 2].map(() => owner.withReadScope(scope => {
        retained = scope;
        if (++admitted === 3) allAdmitted();
        return owner.readBasicLegacyNotes(scope, { kind: "list", arguments: {} });
      }));
      await enteredRead;
      await admittedReads;
      const lease = owner.leaseDatabase;
      const drain = closing ? owner.close() : owner.ensureFull();
      let drained = false;
      drain.then(() => { drained = true; });
      await Promise.resolve();
      assert.equal(drained, false);
      assert.equal(lease.isOpen, true);
      if (process.platform === "linux") competitor(root);
      if (closing) await assert.rejects(owner.withReadScope(() => assert.fail("Closing owner admitted a new read.")), { code: "STORAGE_UNAVAILABLE" });
      finish();
      const results = await Promise.all(reads);
      assert(results.every(result => result.text === results[0].text));
      assert.equal(maximum, 1, "the owner connection must never be rebound between concurrent active query scopes");
      await drain;
      assert.equal(owner.basicNoteTask, undefined);
      await assert.rejects(owner.readBasicLegacyNotes(retained, { kind: "list", arguments: {} }), { code: "STORAGE_UNAVAILABLE" });
      if (closing) assert.equal(lease.isOpen, false);
      else assert.equal(lease, owner.leaseDatabase);
    } finally { finish(); await owner.close(); }
  }
});

test("actual same-owner upgrade drains reads, is single-flight, and never opens a Linux fence gap", { skip: process.platform !== "linux" }, async t => {
  const { root } = await fixture(t);
  const owner = await RootOwner.open(root);
  t.after(() => owner.close());
  const lease = { ...owner.workspaceLease() };
  let enter, finish;
  const entered = new Promise(resolveEnter => { enter = resolveEnter; });
  const finishRead = new Promise(resolveFinish => { finish = resolveFinish; });
  const read = owner.withReadScope(async scope => {
    enter();
    await finishRead;
    scope.assertHeld();
    return readFile(join(scope.root, "notes/entry.md"), "utf8");
  });
  await entered;
  const first = owner.ensureFull(), second = owner.ensureFull();
  assert.equal(first, second);
  competitor(root);
  assert.deepEqual(owner.workspaceLease(), lease);
  finish();
  assert.equal(await read, note);
  const full = await first;
  assertStorage(full.storage);
  assert.deepEqual(full.storage.workspaceLease(), lease);
  assert.equal(await Storage.attach(owner), full.storage);
  const response = await full.runtime.core.dispatch("capability_read", {
    operation: "knowledge.document.get", version: 1, arguments: { id: "entry" },
  }, { id: "synthetic-reader", canWrite: false });
  assert.equal(response.result.content, "Synthetic authoritative Note.\n");
  const created = await full.runtime.core.dispatch("capability_call", {
    operation: "knowledge.document.create", version: 1,
    arguments: { operationId: randomUUID(), id: "created-after-upgrade", title: "Created", content: "Native mutation after same-owner upgrade.\n" },
  }, { id: "synthetic-writer", canWrite: true });
  assert.equal(created.result.id, "created-after-upgrade");
  assert.deepEqual(full.storage.workspaceLease(), lease);
  competitor(root);
  await owner.close();
  competitor(root, "acquired");
  const reopened = await RootOwner.open(root);
  try {
    assert.deepEqual(reopened.startupClassification(), { kind: "full-required", reason: "durable-state" });
    await reopened.withReadScope(scope => assert(scope.full));
  } finally { await reopened.close(); }
});

test("real SQLite foreign commit invalidates plain admission and attaches full under the same lease", async t => {
  const { root } = await fixture(t);
  const owner = await RootOwner.open(root);
  t.after(() => owner.close());
  const lease = { ...owner.workspaceLease() };
  addReceipt(root);
  await owner.withReadScope(scope => {
    assert(scope.full);
    assert.deepEqual(scope.full.storage.workspaceLease(), lease);
  });
  assert.deepEqual(owner.startupClassification(), { kind: "full-required", reason: "durable-state" });
});

test("the same actual fence cannot manufacture two root owners or release its first owner's lock", { skip: process.platform !== "linux" }, async t => {
  const { root } = await fixture(t);
  const fence = await acquireLinuxRootWriterFence(root);
  const owner = await RootOwner.open(root, { writerFence: fence });
  try {
    await assert.rejects(RootOwner.acquire(root, { writerFence: fence }), { code: "BUSY" });
    await assert.rejects(Storage.open(root, { writerFence: fence }), { code: "BUSY" });
    await owner.withReadScope(scope => scope.assertHeld());
    competitor(root);
  } finally { await owner.close(); }
});

test("expired or SQL-fenced leases cannot publish reads and next ownership remains monotonic", { skip: process.platform !== "linux" }, async t => {
  for (const edit of ["lease_until=0", "owner_id='foreign-owner',fence=fence+1"]) {
    const { root } = await fixture(t);
    const owner = await RootOwner.open(root);
    const prior = { ...owner.workspaceLease() };
    await assert.rejects(owner.withReadScope(() => {
      database(root, db => db.exec(`UPDATE native_runtime_owner SET ${edit} WHERE singleton=1`));
      return "must-not-publish";
    }), { code: "STORAGE_UNAVAILABLE", effect: "unknown" });
    competitor(root);
    await owner.close();
    const next = await Storage.open(root);
    try { assert.equal(next.workspaceLease().fence, prior.fence + (edit.includes("fence+1") ? 2 : 1)); }
    finally { await next.close(); }
  }
});

test("foreign commit during a read does not publish its stale plain result or replay the callback", async t => {
  const { root } = await fixture(t);
  const owner = await RootOwner.open(root);
  t.after(() => owner.close());
  let calls = 0;
  await assert.rejects(owner.withReadScope(() => { calls++; addReceipt(root); return "must-not-publish"; }), { code: "CONFLICT" });
  assert.equal(calls, 1);
  await owner.withReadScope(scope => assert(scope.full));
});

test("a real SQLite commit between census and guard capture cannot certify stale plain admission", async t => {
  const { root } = await fixture(t);
  const owner = await RootOwner.open(root);
  t.after(() => owner.close());
  database(root, db => db.exec("UPDATE documents SET title=title||'-derived-delta'"));
  const connection = owner.leaseDatabase;
  const prepare = connection.prepare.bind(connection);
  let versions = 0;
  connection.prepare = sql => {
    if (sql === "PRAGMA data_version" && ++versions === 2) addReceipt(root);
    return prepare(sql);
  };
  await owner.withReadScope(scope => assert(scope.full, "Post-census commit must force canonical full attachment."));
  assert.equal(owner.startupClassification().reason, "durable-state");
});

test("unknown schema and old version fall back instead of rejecting valid canonical features", async t => {
  for (const change of [db => db.exec("CREATE TABLE unrelated_native_state(value TEXT)"),
    db => db.exec("PRAGMA user_version=22")]) {
    const { root } = await fixture(t);
    database(root, change);
    const owner = await RootOwner.open(root);
    try {
      assert.deepEqual(owner.startupClassification(), { kind: "full-required", reason: "schema" });
      await owner.withReadScope(scope => assert(scope.full));
      assert.equal(database(root, db => db.prepare("PRAGMA user_version").get().user_version), 23);
    } finally { await owner.close(); }
  }
});

test("unsupported versions are neither thin-admitted nor mutated by a new ownership bootstrap", async t => {
  const { root } = await fixture(t);
  database(root, db => db.exec("PRAGMA user_version=99"));
  const before = database(root, db => db.prepare("SELECT * FROM native_runtime_owner").get());
  await assert.rejects(RootOwner.open(root), /Unsupported workspace database version 99/);
  assert.equal(database(root, db => db.prepare("PRAGMA user_version").get().user_version), 99);
  assert.deepEqual(database(root, db => db.prepare("SELECT * FROM native_runtime_owner").get()), before);
});

test("root native context and valid inert surfaces use full composition without feature loss", async t => {
  for (const nativeContext of [false, true]) {
    const { root } = await fixture(t);
    if (!nativeContext) await writeFile(join(root, ".gitignore"), "*.scratch\n", { mode: 0o600 });
    const owner = await RootOwner.open(root, nativeContext ? { native: {} } : {});
    try {
      assert.equal(owner.startupClassification().reason, nativeContext ? "native-context" : "layout");
      await owner.withReadScope(scope => assert(scope.full));
    } finally { await owner.close(); }
  }
});

test("canonical private Room, .pkm and paired-publication validation errors remain unchanged", async t => {
  for (const surface of [".pkm-room-admission", ".pkm", ".pkm-paired-memory-backup.json"]) {
    const { root } = await fixture(t);
    if (surface.endsWith(".json")) await writeFile(join(root, surface), "{}", { mode: 0o600 });
    else await mkdir(join(root, surface), { mode: 0o700 });
    let expected;
    try { await Storage.open(root); assert.fail("Expected canonical root validation error."); }
    catch (error) { expected = { code: error.code, message: error.message, effect: error.effect }; }
    await assert.rejects(RootOwner.open(root), error => {
      assert.deepEqual({ code: error.code, message: error.message, effect: error.effect }, expected);
      return true;
    });
  }
});

test("pending conflict preserves canonical native errors, does not replay unknown bytes, and never rolls back to thin", { skip: process.platform !== "linux" }, async t => {
  const { root } = await fixture(t);
  const owner = await RootOwner.open(root);
  addConflictingWrite(root);
  const first = owner.ensureFull();
  await assert.rejects(first);
  assert.equal(owner.ensureFull(), first);
  await assert.rejects(owner.withReadScope(() => assert.fail("Failed attachment must close admission.")));
  assert.equal(await readFile(join(root, "notes/entry.md"), "utf8"), note);
  assert.equal(database(root, db => db.prepare("SELECT COUNT(*) AS n FROM pending_write").get().n), 1);
  competitor(root);
  let actual;
  try { await first; } catch (error) { actual = { code: error.code, message: error.message, effect: error.effect }; }
  await owner.close();
  assert.deepEqual(await canonicalFailure(root), actual);
  assert.equal(await readFile(join(root, "notes/entry.md"), "utf8"), note);
});

test("close racing a held-read upgrade drains actual attachments before releasing the fence", { skip: process.platform !== "linux" }, async t => {
  const { root } = await fixture(t);
  const owner = await RootOwner.open(root);
  let enter, finish;
  const entered = new Promise(resolveEnter => { enter = resolveEnter; });
  const gate = new Promise(resolveFinish => { finish = resolveFinish; });
  const read = owner.withReadScope(async () => { enter(); await gate; });
  await entered;
  const upgrade = owner.ensureFull();
  const close = owner.close();
  competitor(root);
  finish();
  await read;
  await upgrade;
  await close;
  competitor(root, "acquired");
});

test("failed resource drain retains the actual fence and can finish without a second owner", { skip: process.platform !== "linux" }, async t => {
  const { root } = await fixture(t);
  const owner = await RootOwner.open(root);
  let finished = false;
  owner.retainResource({ release() { if (!finished) throw new Error("active native resource"); } });
  await assert.rejects(owner.close(), /active native resource/);
  competitor(root);
  await assert.rejects(owner.withReadScope(() => assert.fail("Admission must remain closed.")));
  finished = true;
  await owner.close();
  competitor(root, "acquired");
});

test("full native bootstrap with an undrained injected host keeps its actual owner fenced until cleanup succeeds", { skip: process.platform !== "linux" }, async t => {
  const { root } = await fixture(t);
  let finished = false;
  const owner = await RootOwner.acquire(root, { native: {
    agents: { host: { close() { if (!finished) throw new Error("native host drain not verified"); } } },
  } });
  const attachment = owner.ensureFull();
  await assert.rejects(attachment, /native host drain not verified/);
  assert.equal(owner.ensureFull(), attachment);
  await assert.rejects(owner.close(), /native host drain not verified/);
  competitor(root);
  finished = true;
  await owner.close();
  competitor(root, "acquired");
});

test("structural owners, Storage impostors, serialized and expired scope proofs are rejected", async t => {
  assert.throws(() => new RootOwner(), { code: "STORAGE_UNAVAILABLE" });
  assert.throws(() => new Storage(), { code: "STORAGE_UNAVAILABLE" });
  for (const value of [{}, Object.create(RootOwner.prototype), { workspaceRoot: () => "/synthetic", workspaceLease: () => ({ ownerId: "fake", fence: 1 }) }]) {
    assert.throws(() => assertRootOwner(value), error => error instanceof CoreError && error.code === "STORAGE_UNAVAILABLE");
    assert.throws(() => Storage.attach(value), { code: "STORAGE_UNAVAILABLE" });
  }
  await assert.rejects(createNativeRuntime({ storage: { connectNative() { assert.fail("Structural Storage must not execute."); } } }), { code: "STORAGE_UNAVAILABLE" });
  const { root } = await fixture(t);
  const owner = await RootOwner.open(root);
  try {
    let retained;
    await owner.withReadScope(scope => {
      retained = scope;
      assertRootReadScope(scope, owner);
      assert.throws(() => assertRootReadScope(JSON.parse(JSON.stringify(scope)), owner), { code: "STORAGE_UNAVAILABLE" });
    });
    assert.throws(() => retained.assertHeld(), { code: "STORAGE_UNAVAILABLE" });
    await assert.rejects(owner.readBasicLegacyNotes(retained, { kind: "list", arguments: {} }), { code: "STORAGE_UNAVAILABLE" });
    await assert.rejects(owner.readBasicLegacyNotes({
      root, workspaceId: await owner.workspaceId(), full: undefined, assertHeld() {},
    }, { kind: "list", arguments: {} }), { code: "STORAGE_UNAVAILABLE" });
  } finally { await owner.close(); }
});

test("actual Note-only canonical import qualifies fast and upgrades to the canonical authenticated reader", async t => {
  const { directory } = await fixture(t, { full: false });
  const source = join(directory, "source"), destination = join(directory, "imported");
  await mkdir(join(source, "notes"), { recursive: true, mode: 0o700 });
  await writeFile(join(source, "notes/entry.md"), note, { mode: 0o600 });
  const plan = await planLegacyImport(source);
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const pythonExecutable = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  await importLegacyWorkspace(plan, destination, { pythonExecutable });
  const owner = await RootOwner.open(destination);
  try {
    const classification = owner.startupClassification();
    assert.deepEqual(classification, { kind: "plain", database: "plain-v23" });
    const entries = await readdir(destination);
    await owner.withReadScope(async scope => {
      assert.equal(scope.full, undefined);
      assert.equal(await readFile(join(scope.root, "notes/entry.md"), "utf8"), note);
    });
    const lease = { ...owner.workspaceLease() };
    const full = await owner.ensureFull();
    const response = await full.runtime.core.dispatch("capability_read", {
      operation: "knowledge.document.get", version: 1, arguments: { id: "entry" },
    }, { id: "synthetic-reader", canWrite: false });
    assert.equal(response.result.content, "Synthetic authoritative Note.\n");
    assert.deepEqual(full.storage.workspaceLease(), lease);
    t.diagnostic(`Actual Note-only import eligible: ${classification.database}; root controls: ${entries.join(",")}`);
  } finally { await owner.close(); }
});

test("prepareNative stays lazy, captures its factory and runs once on actual attached Storage before recovery", async t => {
  const { root } = await fixture(t);
  let calls = 0, attached, entered, finish;
  const preparing = new Promise(resolveEnter => { entered = resolveEnter; });
  const gate = new Promise(resolveFinish => { finish = resolveFinish; });
  const options = { prepareNative: async storage => {
    calls++;
    assertStorage(storage);
    attached = storage;
    assert.equal(database(root, db => db.prepare("PRAGMA user_version").get().user_version), 23);
    await assert.rejects(storage.request({
      operation: "knowledge.document.get", args: { id: "entry" }, actorId: "synthetic-reader",
    }), { code: "STORAGE_UNAVAILABLE" });
    entered();
    await gate;
    return {
      workspaceId: await storage.workspaceId(),
      storage: { connectNative() { assert.fail("Prepared structural Storage must never be used."); } },
    };
  } };
  const owner = await RootOwner.open(root, options);
  t.after(() => owner.close());
  assert.equal(calls, 0);
  assert.deepEqual(owner.startupClassification(), { kind: "plain", database: "plain-v23" });
  options.prepareNative = async () => { assert.fail("Factory identity must be captured at owner admission."); };
  const lease = { ...owner.workspaceLease() };
  const first = owner.ensureFull(), second = owner.ensureFull();
  assert.equal(first, second);
  await preparing;
  assert.equal(calls, 1);
  assert.deepEqual(attached.workspaceLease(), lease);
  let published = false;
  const read = owner.withReadScope(scope => {
    assert.equal(scope.full.storage, attached);
    published = true;
  });
  assert.equal(published, false);
  finish();
  const full = await first;
  await read;
  assert.equal(full.storage, attached);
  assert.deepEqual(full.storage.workspaceLease(), lease);
  assert.equal(calls, 1);
  const response = await full.runtime.core.dispatch("capability_read", {
    operation: "knowledge.document.get", version: 1, arguments: { id: "entry" },
  }, { id: "synthetic-reader", canWrite: false });
  assert.equal(response.result.content, "Synthetic authoritative Note.\n");
});

test("prepareNative preserves explicit native eager classification and forwards explicit options", async t => {
  const { root } = await fixture(t);
  let calls = 0;
  const owner = await RootOwner.open(root, { native: {}, prepareNative: async storage => {
    assertStorage(storage);
    calls++;
    return {};
  } });
  try {
    assert.equal(calls, 1);
    assert.deepEqual(owner.startupClassification(), { kind: "full-required", reason: "native-context" });
    await owner.withReadScope(scope => assert(scope.full));
  } finally { await owner.close(); }
  await assert.rejects(RootOwner.open(root, {
    native: { workspaceId: "not-the-actual-workspace" },
    prepareNative: async () => ({}),
  }), { code: "INVALID_CONFIGURATION" });
});

test("prepareNative failure closes admission without retry and retains the actual fence until callback cleanup succeeds", { skip: process.platform !== "linux" }, async t => {
  const { root } = await fixture(t);
  const failure = new CoreError("ACCESS_DENIED", "Deferred native policy preparation failed.");
  let calls = 0, cleaned = false, finishCleanup = false;
  const owner = await RootOwner.open(root, { prepareNative: async storage => {
    assertStorage(storage);
    calls++;
    storage.retainNativeCleanup({ release() {
      if (!finishCleanup) throw new Error("deferred native cleanup not verified");
      storage.assertWorkspaceLease();
      cleaned = true;
    } });
    throw failure;
  } });
  const first = owner.ensureFull();
  await assert.rejects(first, error => error === failure);
  assert.equal(owner.ensureFull(), first);
  await assert.rejects(owner.withReadScope(() => assert.fail("Failed preparation must not resume thin admission.")), error => error === failure);
  assert.equal(calls, 1);
  competitor(root);
  await assert.rejects(owner.close(), /deferred native cleanup not verified/);
  assert.equal(cleaned, false);
  competitor(root);
  finishCleanup = true;
  await owner.close();
  assert.equal(cleaned, true);
  assert.equal(calls, 1);
  competitor(root, "acquired");
});

test("prepareNative pending during close drains the factory and its actual attachment before releasing ownership", { skip: process.platform !== "linux" }, async t => {
  const { root } = await fixture(t);
  let entered, finish, cleaned = false;
  const preparing = new Promise(resolveEnter => { entered = resolveEnter; });
  const gate = new Promise(resolveFinish => { finish = resolveFinish; });
  const owner = await RootOwner.open(root, { prepareNative: async storage => {
    assertStorage(storage);
    storage.retainNativeCleanup({ release() { storage.assertWorkspaceLease(); cleaned = true; } });
    entered();
    await gate;
    return {};
  } });
  const upgrade = owner.ensureFull();
  await preparing;
  const close = owner.close();
  await assert.rejects(owner.withReadScope(() => assert.fail("Closing preparation must not admit readers.")), { code: "STORAGE_UNAVAILABLE" });
  competitor(root);
  assert.equal(cleaned, false);
  finish();
  await upgrade;
  await close;
  assert.equal(cleaned, true);
  competitor(root, "acquired");
});

test("prepareNative rejects serialized factories before ownership and malformed returned options fail closed", async t => {
  const { root } = await fixture(t, { full: false });
  for (const prepareNative of ["native-factory", { trusted: true }, null]) {
    await assert.rejects(RootOwner.open(root, { prepareNative }), { code: "INVALID_CONFIGURATION" });
  }
  await assert.rejects(lstat(join(root, "core.sqlite")), { code: "ENOENT" });
  await assert.rejects(lstat(join(root, ".pkm-next-writer-fenced.json")), { code: "ENOENT" });
  for (const returned of [undefined, [], { workspaceId: "not-the-prepared-workspace" }]) {
    let calls = 0;
    const owner = await RootOwner.open(root, { prepareNative: async () => { calls++; return returned; } });
    const first = owner.ensureFull();
    await assert.rejects(first, { code: "INVALID_CONFIGURATION" });
    assert.equal(owner.ensureFull(), first);
    await assert.rejects(owner.withReadScope(() => assert.fail("Malformed native preparation must stay closed.")));
    assert.equal(calls, 1);
    await owner.close();
  }
});

test("prepareNative cannot publish full services after SQL ownership changes while its factory awaits", { skip: process.platform !== "linux" }, async t => {
  const { root } = await fixture(t);
  let entered, finish, calls = 0;
  const preparing = new Promise(resolveEnter => { entered = resolveEnter; });
  const gate = new Promise(resolveFinish => { finish = resolveFinish; });
  const owner = await RootOwner.open(root, { prepareNative: async () => {
    calls++;
    entered();
    await gate;
    return {};
  } });
  const upgrade = owner.ensureFull();
  await preparing;
  database(root, db => db.exec("UPDATE native_runtime_owner SET owner_id='foreign-owner',fence=fence+1 WHERE singleton=1"));
  const foreign = database(root, db => db.prepare("SELECT * FROM native_runtime_owner").get());
  finish();
  await assert.rejects(upgrade, { code: "STORAGE_UNAVAILABLE", effect: "unknown" });
  assert.equal(owner.ensureFull(), upgrade);
  assert.equal(calls, 1);
  await assert.rejects(owner.withReadScope(() => assert.fail("Fenced preparation cannot publish services.")), { code: "STORAGE_UNAVAILABLE" });
  competitor(root);
  await owner.close();
  assert.deepEqual(database(root, db => db.prepare("SELECT * FROM native_runtime_owner").get()), foreign);
  competitor(root, "acquired");
});
