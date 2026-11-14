import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const dist = resolve(process.env.PKM_TEST_NEXT_DIST || "next-server/dist");
const { prepareMembershipIntent, finishMembershipIntent, readMembershipIntent, readMembershipOutcome } =
  await import(pathToFileURL(resolve(dist, "legacy-subscription-membership-intent.js")));
const { Storage, initialize } = await import(pathToFileURL(resolve(dist, "storage.js")));
const { issueMembershipRecoveryAuthority } = await import(pathToFileURL(resolve(dist, "legacy-subscription-membership-authority.js")));
const { createWorkspaceBackup } = await import(pathToFileURL(resolve(dist, "workspace-backup.js")));

function database(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE receipts (
    operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
    actor_id TEXT NOT NULL, operation TEXT NOT NULL, committed_at TEXT NOT NULL
  )`);
  return db;
}
function intent(action = "add") {
  return { schema: "pkm.subscription-membership-intent/v1", workspaceId: randomUUID(), operationId: randomUUID(),
    action, publisherNodeId: "a".repeat(64), shareId: "remote-share",
    subscriptionId: action === "add" ? null : "subscriber-id", expectedHead: null,
    baselineSha256: "b".repeat(64), requestSha256: "c".repeat(64) };
}
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
const lease = () => {};

test("pending intent blocks another action until explicitly resolved", () => {
  const db = database(), first = intent();
  transaction(db, () => prepareMembershipIntent(db, first, null, lease));
  assert.deepEqual(readMembershipIntent(db, first.workspaceId).intent, first);
  transaction(db, () => prepareMembershipIntent(db, first, null, lease));
  assert.throws(() => transaction(db, () => prepareMembershipIntent(db,
    { ...first, operationId: randomUUID() }, null, lease)), { code: "CONFLICT" });
  assert.throws(() => transaction(db, () => finishMembershipIntent(db, first.workspaceId, first.operationId,
    "cancelled", null, "d".repeat(64), lease)), { code: "CONFLICT" });
  assert.deepEqual(readMembershipIntent(db, first.workspaceId).intent, first);
  transaction(db, () => finishMembershipIntent(db, first.workspaceId, first.operationId,
    "cancelled", null, first.baselineSha256, lease));
  assert.equal(readMembershipIntent(db, first.workspaceId), undefined);
  db.close();
});

test("pending and committed outcomes survive an actual SQLite reopen without replaying host actions", () => {
  const dir = resolve("next-server/.migration-test-work", `membership-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = resolve(dir, "core.sqlite"), first = intent();
  let db = database(file);
  try {
    transaction(db, () => prepareMembershipIntent(db, first, null, lease));
    db.close(); db = new DatabaseSync(file);
    assert.deepEqual(readMembershipIntent(db, first.workspaceId).intent, first);
    transaction(db, () => finishMembershipIntent(db, first.workspaceId, first.operationId,
      "committed", "d".repeat(64), "e".repeat(64), lease));
    db.close(); db = new DatabaseSync(file);
    const outcome = readMembershipOutcome(db, first.workspaceId, first.operationId);
    assert.equal(outcome.terminal.outcome, "committed");
    transaction(db, () => finishMembershipIntent(db, first.workspaceId, first.operationId,
      "committed", "d".repeat(64), "e".repeat(64), lease));
    assert.throws(() => transaction(db, () => prepareMembershipIntent(db, first, null, lease)), { code: "CONFLICT" });
    assert.throws(() => transaction(db, () => finishMembershipIntent(db, first.workspaceId, first.operationId,
      "committed", "d".repeat(64), "f".repeat(64), lease)), { code: "CONFLICT" });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("terminal receipt and native publication roll back together", () => {
  const db = database(), first = intent("remove");
  db.exec("CREATE TABLE native_head (head TEXT NOT NULL)");
  transaction(db, () => prepareMembershipIntent(db, first, null, lease));
  assert.throws(() => transaction(db, () => {
    db.prepare("INSERT INTO native_head VALUES(?)").run("d".repeat(64));
    finishMembershipIntent(db, first.workspaceId, first.operationId, "committed", "d".repeat(64), "e".repeat(64), lease);
    throw new Error("lost before commit");
  }), /lost before commit/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM native_head").get().n, 0);
  assert.deepEqual(readMembershipIntent(db, first.workspaceId).intent, first);
  transaction(db, () => {
    db.prepare("INSERT INTO native_head VALUES(?)").run("d".repeat(64));
    finishMembershipIntent(db, first.workspaceId, first.operationId, "committed", "d".repeat(64), "e".repeat(64), lease);
  });
  assert.equal(readMembershipIntent(db, first.workspaceId), undefined);
  assert.equal(db.prepare("SELECT head FROM native_head").get().head, "d".repeat(64));
  db.close();
});

test("stale heads, forged data, and missing receipt anchors fail closed", () => {
  const db = database(), first = intent();
  assert.throws(() => prepareMembershipIntent(db, first, null, lease), { code: "FORBIDDEN" });
  assert.throws(() => transaction(db, () => prepareMembershipIntent(db, first, "d".repeat(64), lease)), { code: "CONFLICT" });
  assert.throws(() => transaction(db, () => prepareMembershipIntent(db, { ...first, secret: "not allowed" }, null, lease)),
    { code: "INVALID_ARGUMENT" });
  transaction(db, () => prepareMembershipIntent(db, first, null, lease));
  db.exec("DELETE FROM receipts WHERE operation='subscription.membership.intent'");
  assert.throws(() => readMembershipIntent(db, first.workspaceId), { code: "IMPORT_RECEIPT_INVALID" });
  db.close();
});

test("pending membership fences workspace requests across restart until explicit unchanged cancellation", async () => {
  const dir = resolve("next-server/.migration-test-work", `membership-workspace-${randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let storage;
  try {
    const root = await initialize(resolve(dir, "workspace"));
    storage = await Storage.open(root);
    const first = { ...intent(), workspaceId: await storage.workspaceId() };
    const db = storage.connectNative();
    try { transaction(db, () => prepareMembershipIntent(db, first, null, () => storage.assertWorkspaceLease())); }
    finally { db.close(); }
    await assert.rejects(storage.request({ operation: "knowledge.document.list", actorId: "user:local", args: { offset: 0, limit: 10 } }), { code: "RECOVERY_REQUIRED" });
    await assert.rejects(storage.request({ operation: "knowledge.document.create", actorId: "user:local", args: {} }), { code: "RECOVERY_REQUIRED" });
    await assert.rejects(storage.requestNativeTodoUser({}, []), { code: "RECOVERY_REQUIRED" });
    let dispatched = false;
    await assert.rejects(storage.withWorkspaceExclusive(() => { dispatched = true; }), { code: "RECOVERY_REQUIRED" });
    await assert.rejects(storage.withWorkspaceExclusive(() => storage.requestLegacyTodoBoardCreate({
      operationId: randomUUID(), title: "Test", category: "",
    }, "mcp:external")), { code: "RECOVERY_REQUIRED" });
    assert.equal(dispatched, false);
    await assert.rejects(storage.withWorkspaceExclusive(() => { dispatched = true; }, { authority: {}, phase: "publish" }),
      { code: "FORBIDDEN" });
    assert.equal(dispatched, false);
    await assert.rejects(createWorkspaceBackup(storage, resolve(dir, "backup"), {
      async acquireQuiescence() { return { assertHeld() {}, async release() {} }; },
    }), { code: "RECOVERY_REQUIRED" });
    await storage.close();
    storage = await Storage.open(root);
    await assert.rejects(storage.request({ operation: "knowledge.document.list", actorId: "user:local", args: { offset: 0, limit: 10 } }), { code: "STORAGE_UNAVAILABLE" });
    const reopened = storage.connectNative();
    try {
      assert.equal(readMembershipIntent(reopened, first.workspaceId).intent.operationId, first.operationId);
      transaction(reopened, () => finishMembershipIntent(reopened, first.workspaceId, first.operationId,
        "cancelled", null, first.baselineSha256, () => storage.assertWorkspaceLease()));
    } finally { reopened.close(); }
    await storage.close();
    storage = await Storage.open(root);
    assert.ok(await storage.request({ operation: "knowledge.document.list", actorId: "user:local", args: { offset: 0, limit: 10 } }));
  } finally { await storage?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("private recovery authority is single-use, exact-phase, host-locked and tied to the live workspace", async () => {
  const fixture = resolve(".migration-test-work", `pkm-protected-state-fixture-${randomUUID()}`);
  const original = resolve(fixture, "original"), profile = resolve(fixture, "profile"), root = resolve(fixture, "imported");
  const oldFixture = process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT, oldUi = process.env.PKM_PRIVATE_SUBSCRIPTION_UI;
  let storage;
  try {
    for (const dir of [fixture, original, profile]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    await initialize(root);
    const rootPin = lstatSync(original, { bigint: true }), profilePin = lstatSync(profile, { bigint: true }), nonce = randomUUID();
    const marker = resolve(fixture, "subscription-state-fixture.json");
    const markerBytes = JSON.stringify({ schema: "pkm.protected-subscription-state-fixture/v1", nonce,
      rootPin: `${rootPin.dev}:${rootPin.ino}`, profilePin: `${profilePin.dev}:${profilePin.ino}` });
    writeFileSync(marker, markerBytes, { mode: 0o600 });
    const lock = resolve(profile, "subscriptions-state.lock"), lockNonce = randomUUID();
    mkdirSync(lock, { mode: 0o700 });
    const owner = resolve(lock, `${lockNonce}.json`);
    const ownerBytes = JSON.stringify({ pid: process.ppid, owner: "Subscription state mutation", nonce: lockNonce });
    writeFileSync(owner, ownerBytes, { mode: 0o600 });
    process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT = fixture;
    process.env.PKM_PRIVATE_SUBSCRIPTION_UI = "1";
    storage = await Storage.open(root);
    const first = { ...intent(), workspaceId: await storage.workspaceId() };
    const db = storage.connectNative();
    try { transaction(db, () => prepareMembershipIntent(db, first, null, () => storage.assertWorkspaceLease())); }
    finally { db.close(); }
    const issue = phase => issueMembershipRecoveryAuthority(storage, profile, nonce, first.operationId, phase);
    assert.throws(() => issueMembershipRecoveryAuthority(storage, profile, nonce, randomUUID(), "check"), { code: "FORBIDDEN" });
    assert.throws(() => issueMembershipRecoveryAuthority(storage, profile, randomUUID(), first.operationId, "check"), { code: "FORBIDDEN" });
    let calls = 0;
    const wrongPhase = issue("check");
    await assert.rejects(storage.withWorkspaceExclusive(() => calls++, { authority: wrongPhase, phase: "publish" }), { code: "FORBIDDEN" });
    await assert.rejects(storage.withWorkspaceExclusive(() => calls++, { authority: wrongPhase, phase: "check" }), { code: "FORBIDDEN" });
    const right = issue("check");
    await storage.withWorkspaceExclusive(() => calls++, { authority: right, phase: "check" });
    await assert.rejects(storage.withWorkspaceExclusive(() => calls++, { authority: right, phase: "check" }), { code: "FORBIDDEN" });
    const otherRoot = await initialize(resolve(fixture, "other-workspace"));
    const otherStorage = await Storage.open(otherRoot);
    try {
      const wrongWorkspace = issue("publish");
      await assert.rejects(otherStorage.withWorkspaceExclusive(() => calls++,
        { authority: wrongWorkspace, phase: "publish" }), { code: "FORBIDDEN" });
    } finally { await otherStorage.close(); }
    const otherPending = storage.connectNative();
    try {
      otherPending.prepare(`INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,document_id,after_markdown)
        VALUES(1,?,?,?,?,?,?)`).run(randomUUID(), "x", "user:local", "test", "note", "unchanged");
      const blocked = issue("cancel");
      await assert.rejects(storage.withWorkspaceExclusive(() => calls++,
        { authority: blocked, phase: "cancel" }), { code: "RECOVERY_REQUIRED" });
      otherPending.exec("DELETE FROM pending_write WHERE singleton=1");
    } finally { otherPending.close(); }
    const replacedMarker = issue("publish");
    renameSync(marker, `${marker}.old`);
    writeFileSync(marker, markerBytes, { mode: 0o600 });
    await assert.rejects(storage.withWorkspaceExclusive(() => calls++, { authority: replacedMarker, phase: "publish" }), { code: "FORBIDDEN" });
    rmSync(marker); renameSync(`${marker}.old`, marker);
    const changedOwner = issue("cancel");
    writeFileSync(owner, JSON.stringify({ pid: process.pid, owner: "Subscription state mutation", nonce: lockNonce }));
    await assert.rejects(storage.withWorkspaceExclusive(() => calls++, { authority: changedOwner, phase: "cancel" }), { code: "FORBIDDEN" });
    writeFileSync(owner, ownerBytes);
    const oldAuthority = issue("publish");
    await storage.close();
    storage = await Storage.open(root);
    await assert.rejects(storage.withWorkspaceExclusive(() => calls++, { authority: oldAuthority, phase: "publish" }), { code: "FORBIDDEN" });
    assert.equal(calls, 1);
    const reopened = storage.connectNative();
    try { assert.equal(readMembershipIntent(reopened, first.workspaceId).intent.operationId, first.operationId); }
    finally { reopened.close(); }
  } finally {
    await storage?.close();
    if (oldFixture === undefined) delete process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT;
    else process.env.PKM_PRIVATE_SUBSCRIPTION_STATE_IMPORT = oldFixture;
    if (oldUi === undefined) delete process.env.PKM_PRIVATE_SUBSCRIPTION_UI;
    else process.env.PKM_PRIVATE_SUBSCRIPTION_UI = oldUi;
    rmSync(fixture, { recursive: true, force: true });
  }
});
