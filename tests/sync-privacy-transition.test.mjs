import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applySyncPlan, initializeSyncApplyJournal, inspectSyncApplyRecovery, readSyncApplyReceipt, recoverSyncApply, serializeSyncApplyPlan } from "../dist/sync-apply.js";
import { syncApplyPlanSchema } from "../dist/sync-apply-contracts.js";
import { initializeSyncPlanStore, SyncPlanStore } from "../dist/sync-plan-store.js";
import { syncPlanHash } from "../dist/sync-plan.js";
import { httpCall, invocation, nativeWorkspace } from "./batch06-manager-fixtures.mjs";
import { syncApplyFixtureInput } from "./sync-apply-fixture.mjs";

const actor = { id: "native:sync-privacy-owner", canWrite: true };
const unsupported = /Historic byte-only public-to-private sync transition/;
function inputFixture(conflict = false, changedBytes = false) {
  const remoteFile = { ...syncApplyFixtureInput.remote.manifest.files[0], privacy: "private" };
  const publicFile = { ...remoteFile, privacy: "public" };
  const snapshot = files => {
    const manifest = { ...syncApplyFixtureInput.remote.manifest, files };
    return { manifest, sha256: syncPlanHash(manifest) };
  };
  if (changedBytes) {
    remoteFile.contentBase64 = Buffer.from("changed private bytes\r\n").toString("base64");
    // The digest is a content hash, not the canonical JSON manifest hash.
    remoteFile.digest = createHash("sha256").update(Buffer.from(remoteFile.contentBase64, "base64")).digest("hex");
  }
  return { base: snapshot(conflict ? [] : [publicFile]), local: snapshot([publicFile]), remote: snapshot([remoteFile]) };
}
function seed(store, db, input, sessionId = randomUUID()) {
  const created = store.create({ sessionId, operationId: randomUUID(), actorId: actor.id, input });
  db.prepare("INSERT INTO sync_plan_owners VALUES (?, ?)").run(sessionId, actor.id);
  if (created.plan.conflicts.length) store.decide({
    sessionId, operationId: randomUUID(), actorId: actor.id, expectedRevision: created.revision,
    conflictId: created.plan.conflicts[0].id, choice: "remote", reason: "Select the pinned remote privacy.",
  });
  return { sessionId, actorId: actor.id, input };
}
function writePublic(root, input) {
  const file = input.local.manifest.files[0], destination = join(root, file.path);
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(destination, Buffer.from(file.contentBase64, "base64"));
  chmodSync(destination, 0o644);
  return destination;
}
function workspace(t, input) {
  const folder = resolve(import.meta.dirname, `.sync-privacy-${randomUUID()}`);
  const root = join(folder, "knowledge"), database = join(folder, "journal.sqlite");
  mkdirSync(root, { recursive: true });
  const destination = writePublic(root, input);
  let db, store;
  const open = () => {
    db = new DatabaseSync(database); initializeSyncPlanStore(db); initializeSyncApplyJournal(db);
    store = new SyncPlanStore(db);
  };
  open();
  const request = seed(store, db, input);
  t.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  return {
    root, destination, request, get store() { return store; }, get db() { return db; },
    reopen() { db.close(); open(); },
  };
}

for (const conflict of [false, true]) {
  test(`identical bytes public-to-private ${conflict ? "remote decision" : "remote proposal"} changes only mode and replays`, t => {
    const input = inputFixture(conflict);
    const f = workspace(t, input), before = readFileSync(f.destination);
    const plan = serializeSyncApplyPlan(f.store, f.request);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].beforeSha256, plan.actions[0].afterSha256);
    assert.equal(plan.actions[0].afterMode, 0o600);
    assert.equal(plan.actions[0].beforeMode, undefined, "preview intent does not guess the filesystem mode");
    const receipt = applySyncPlan(f.store, f.request, f.root);
    assert.deepEqual(readFileSync(f.destination), before);
    assert.equal(statSync(f.destination).mode & 0o777, 0o600);
    assert.deepEqual(receipt.operations, [{
      path: input.local.manifest.files[0].path,
      beforeSha256: input.local.manifest.files[0].digest,
      afterSha256: input.local.manifest.files[0].digest,
      beforeMode: 0o644, afterMode: 0o600,
    }]);
    assert.deepEqual(applySyncPlan(f.store, f.request, f.root), receipt);
  });
}

for (const boundary of ["recover", "inspect", "owner-transaction"]) {
test(`historic byte-only prepared privacy transition becomes needs-review through ${boundary} without filesystem writes`, t => {
  const input = inputFixture(), f = workspace(t, input), session = f.store.get(f.request.sessionId);
  const unsigned = {
    schema: "pkm.sync-apply-plan/v1", sessionId: session.sessionId, revision: session.revision, actorId: actor.id,
    sourcePins: session.plan.pins,
    sessionHash: syncPlanHash({ sessionId: session.sessionId, revision: session.revision, plan: session.plan, decisions: session.decisions }),
    decisions: [], guards: [{ path: input.local.manifest.files[0].path, sha256: input.local.manifest.files[0].digest }],
    actions: [], tombstones: [],
  };
  const plan = { ...unsigned, planHash: syncPlanHash(unsigned) };
  assert(syncApplyPlanSchema.safeParse(plan).success, "the historical byte-only no-op remains readable");
  const applyId = randomUUID();
  f.db.prepare(`INSERT INTO sync_apply_journal
    (apply_id,apply_key,session_id,actor_id,root_path,plan_hash,session_hash,input_json,plan_json,state,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,'prepared',?)`).run(
    applyId, syncPlanHash({ planHash: plan.planHash, root: f.root }), session.sessionId, actor.id, f.root,
    plan.planHash, plan.sessionHash, JSON.stringify(input), JSON.stringify(plan), new Date().toISOString(),
  );
  const before = readFileSync(f.destination);
  f.reopen();
  if (boundary === "owner-transaction") f.db.exec("BEGIN IMMEDIATE");
  assert.throws(() => boundary === "recover" ? recoverSyncApply(f.store, f.root) : inspectSyncApplyRecovery(f.store, f.root), unsupported);
  if (boundary === "owner-transaction") {
    assert.equal(f.db.isTransaction, true, "preflight must not commit the owner's transaction");
    assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "needs-review");
    f.db.exec("ROLLBACK");
    assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "prepared");
    assert.throws(() => inspectSyncApplyRecovery(f.store, f.root), unsupported);
  }
  assert.deepEqual({ ...f.db.prepare("SELECT state,receipt_json FROM sync_apply_journal").get() }, { state: "needs-review", receipt_json: null });
  assert.deepEqual(readFileSync(f.destination), before);
  assert.equal(statSync(f.destination).mode & 0o777, 0o644);
  f.reopen();
  assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "needs-review");
  assert.throws(() => inspectSyncApplyRecovery(f.store, f.root), /requires manual review/);
});
}

test("mode-only interruption survives restart, completes one durable receipt, and replays", t => {
  const input = inputFixture(), f = workspace(t, input), bytes = readFileSync(f.destination);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: (_action, _index, phase) => {
      if (phase === undefined) throw new Error("synthetic interruption after chmod");
    },
  }), /synthetic interruption/);
  assert.deepEqual(readFileSync(f.destination), bytes);
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);
  assert.deepEqual({ ...f.db.prepare("SELECT state,receipt_json FROM sync_apply_journal").get() },
    { state: "prepared", receipt_json: null });
  f.reopen();
  const [receipt] = recoverSyncApply(f.store, f.root);
  assert.equal(receipt.operations[0].beforeMode, 0o644);
  assert.equal(receipt.operations[0].afterMode, 0o600);
  assert.deepEqual(readFileSync(f.destination), bytes);
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);
  assert.deepEqual(applySyncPlan(f.store, f.request, f.root), receipt);
  assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "completed");
});

test("failed mode-change preflight becomes needs-review and never receipts", t => {
  const input = inputFixture(), f = workspace(t, input), bytes = readFileSync(f.destination);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: (_action, _index, phase) => {
      if (phase === "before-mode-change") throw new Error("synthetic chmod failure");
    },
  }), /interrupted before execution/);
  assert.deepEqual(readFileSync(f.destination), bytes);
  assert.equal(statSync(f.destination).mode & 0o777, 0o644);
  assert.deepEqual({ ...f.db.prepare("SELECT state,receipt_json FROM sync_apply_journal").get() },
    { state: "needs-review", receipt_json: null });
  f.reopen();
  assert.deepEqual(recoverSyncApply(f.store, f.root), []);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root), /requires manual review/);
});

for (const tamper of ["mode", "bytes"]) {
  test(`unknown ${tamper} after interrupted permission transition requires review without a receipt`, t => {
    const input = inputFixture(), f = workspace(t, input), bytes = readFileSync(f.destination);
    assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
      faultInjector: (_action, _index, phase) => {
        if (phase !== undefined) return;
        if (tamper === "mode") chmodSync(f.destination, 0o640);
        else writeFileSync(f.destination, Buffer.from("external mutation\r\n"));
        throw new Error("synthetic interruption with external tamper");
      },
    }), /synthetic interruption/);
    f.reopen();
    assert.throws(() => recoverSyncApply(f.store, f.root), /Unknown (?:sync journal bytes or permission mode|before\/after bytes or mode)|External write detected/);
    assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "needs-review");
    assert.equal(f.db.prepare("SELECT receipt_json FROM sync_apply_journal").get().receipt_json, null);
    if (tamper === "mode") {
      assert.deepEqual(readFileSync(f.destination), bytes);
      assert.equal(statSync(f.destination).mode & 0o777, 0o640);
    } else {
      assert.deepEqual(readFileSync(f.destination), Buffer.from("external mutation\r\n"));
      assert.equal(statSync(f.destination).mode & 0o777, 0o600);
    }
    assert.throws(() => applySyncPlan(f.store, f.request, f.root), /requires manual review/);
  });
}

test("tampered persisted permission baseline requires review before receipt", t => {
  const input = inputFixture(), f = workspace(t, input);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: (_action, _index, phase) => {
      if (phase === undefined) throw new Error("synthetic interruption after chmod");
    },
  }), /synthetic interruption/);
  const stored = JSON.parse(f.db.prepare("SELECT plan_json FROM sync_apply_journal").get().plan_json);
  stored.actions[0].beforeMode = 0o640;
  f.db.prepare("UPDATE sync_apply_journal SET plan_json=?").run(JSON.stringify(stored));
  f.reopen();
  assert.throws(() => recoverSyncApply(f.store, f.root), /permission baseline hash is invalid/);
  assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "needs-review");
  assert.equal(f.db.prepare("SELECT receipt_json FROM sync_apply_journal").get().receipt_json, null);
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);
});

test("changed-byte public-to-private writes still enforce 0600 and recover with the same receipt", t => {
  const input = inputFixture(false, true), f = workspace(t, input);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: () => { throw new Error("synthetic interruption"); },
  }), /synthetic interruption/);
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);
  const pending = f.db.prepare("SELECT apply_id FROM sync_apply_journal").get();
  f.reopen();
  const [receipt] = recoverSyncApply(f.store, f.root);
  assert.equal(receipt.applyId, pending.apply_id);
  assert.deepEqual(applySyncPlan(f.store, f.request, f.root), receipt);
  assert.deepEqual(readFileSync(f.destination), Buffer.from(input.remote.manifest.files[0].contentBase64, "base64"));
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);
});

test("changed-byte private recovery rejects an external chmod before issuing any receipt", t => {
  const input = inputFixture(false, true), f = workspace(t, input);
  const desired = Buffer.from(input.remote.manifest.files[0].contentBase64, "base64");
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    faultInjector: (_action, _index, phase) => {
      if (phase === undefined) throw new Error("synthetic interruption after private write");
    },
  }), /synthetic interruption/);
  assert.deepEqual(readFileSync(f.destination), desired);
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);
  assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "prepared");
  assert.equal(f.db.prepare("SELECT receipt_json FROM sync_apply_journal").get().receipt_json, null);

  chmodSync(f.destination, 0o644);
  f.reopen();
  assert.throws(() => recoverSyncApply(f.store, f.root), /unexpected permission mode/);
  assert.equal(f.db.prepare("SELECT state FROM sync_apply_journal").get().state, "needs-review");
  assert.equal(f.db.prepare("SELECT receipt_json FROM sync_apply_journal").get().receipt_json, null);
  assert.deepEqual(readFileSync(f.destination), desired);
  assert.equal(statSync(f.destination).mode & 0o777, 0o644);
  assert.throws(() => applySyncPlan(f.store, f.request, f.root), /requires manual review/);
});

test("completed private receipt replay is historical after chmod and later file changes", t => {
  const input = inputFixture(false, true), f = workspace(t, input);
  const desired = Buffer.from(input.remote.manifest.files[0].contentBase64, "base64");
  const receipt = applySyncPlan(f.store, f.request, f.root);
  assert.deepEqual(readFileSync(f.destination), desired);
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);

  const commits = [];
  chmodSync(f.destination, 0o644);
  const afterChmod = applySyncPlan(f.store, f.request, f.root, {
    beforeCommit: historical => commits.push(historical),
  });
  assert.deepEqual(afterChmod, receipt);
  assert.deepEqual(readSyncApplyReceipt(f.store, receipt.planHash, f.root), receipt);
  assert.equal(statSync(f.destination).mode & 0o777, 0o644, "historical retry does not repair or claim current mode");
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], receipt);

  const laterBytes = Buffer.from("legitimate later private-file edit\r\n");
  writeFileSync(f.destination, laterBytes);
  chmodSync(f.destination, 0o600);
  const afterLaterEdit = applySyncPlan(f.store, f.request, f.root, {
    beforeCommit: historical => commits.push(historical),
  });
  assert.deepEqual(afterLaterEdit, receipt);
  assert.deepEqual(readFileSync(f.destination), laterBytes, "historical retry does not overwrite subsequent content");
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);
  assert.equal(commits.length, 2);
  assert(commits.every(historical => historical.completedAt === receipt.completedAt));
});

test("completed receipt tampering fails before the shared beforeCommit callback", t => {
  const input = inputFixture(false, true), f = workspace(t, input);
  const receipt = applySyncPlan(f.store, f.request, f.root);
  assert.equal(receipt.operations[0].afterMode, undefined, "historical byte-write receipts have no mode field");
  assert.deepEqual(readSyncApplyReceipt(f.store, receipt.planHash, f.root), receipt);
  const stored = JSON.parse(f.db.prepare("SELECT receipt_json FROM sync_apply_journal").get().receipt_json);
  stored.operations[0].afterMode = 0o644;
  f.db.prepare("UPDATE sync_apply_journal SET receipt_json=?").run(JSON.stringify(stored));
  assert.throws(() => readSyncApplyReceipt(f.store, receipt.planHash, f.root), /does not match its journaled result/);
  assert.equal(f.db.isTransaction, false, "receipt reads do not open a transaction");
  let committed = false;
  assert.throws(() => applySyncPlan(f.store, f.request, f.root, {
    beforeCommit: () => { committed = true; },
  }), /does not match its journaled result/);
  assert.equal(committed, false);
  assert.equal(f.db.isTransaction, false, "invalid completed receipt must roll back the replay transaction");
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);
  f.db.exec("BEGIN IMMEDIATE");
  f.db.exec("ROLLBACK");
  assert.equal(f.db.isTransaction, false, "the owner connection remains usable after rejection");
  f.db.prepare("UPDATE sync_apply_journal SET receipt_json=?").run(JSON.stringify(receipt));
  assert.deepEqual(readSyncApplyReceipt(f.store, receipt.planHash, f.root), receipt);
});

test("native Core HTTP applies identical-byte privacy change only after plan preflight", async t => {
  const input = inputFixture(), f = await nativeWorkspace(t, root => { writePublic(root, input); return {}; });
  const url = await f.listen(actor), sessionId = randomUUID();
  const created = await httpCall(url, f.bearer, "capability_call", invocation("sync.plan.create", {
    sessionId, operationId: randomUUID(), input,
  }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const preview = await httpCall(url, f.bearer, "capability_read", invocation("sync.apply.preview", { sessionId, input }));
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.result.actions.length, 1);
  assert.equal(preview.body.result.actions[0].beforeSha256, preview.body.result.actions[0].afterSha256);
  assert.equal(preview.body.result.actions[0].afterMode, 0o600);
  const operationId = randomUUID(), applyArgs = {
    sessionId, input, operationId, expectedPlanHash: preview.body.result.planHash,
  };
  const result = await httpCall(url, f.bearer, "capability_call", invocation("sync.apply", applyArgs));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.operations[0].beforeMode, 0o644);
  assert.equal(result.body.result.operations[0].afterMode, 0o600);
  const destination = join(f.root, input.local.manifest.files[0].path);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(destination), Buffer.from(input.local.manifest.files[0].contentBase64, "base64"));
  await f.reopen({});
  const restartedUrl = await f.listen(actor);
  const replay = await httpCall(restartedUrl, f.bearer, "capability_call", invocation("sync.apply", applyArgs));
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body.result, result.body.result);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sync_apply_journal").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM data_runtime_intents").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(operationId).n, 1);
  } finally { db.close(); }
});
