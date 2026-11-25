import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applySyncPlan, initializeSyncApplyJournal, readSyncApplyReceipt, recoverSyncApply, serializeSyncApplyPlan } from "../dist/sync-apply.js";
import { initializeSyncPlanStore, SyncPlanStore } from "../dist/sync-plan-store.js";
import { syncApplyReceiptSchema } from "../dist/sync-apply-contracts.js";
import { syncPlanHash } from "../dist/sync-plan.js";
import {
  syncApplyFixtureBytes, syncApplyFixtureCreate, syncApplyFixtureExpectedPlan, syncApplyFixtureIdentity, syncApplyFixtureInput,
  newSyncApplyConflictFixture,
} from "./sync-apply-fixture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const workspace = () => mkdtempSync(resolve("tests", ".sync-apply-workspace-"));

function openStore(database = ":memory:") {
  const db = new DatabaseSync(database);
  initializeSyncPlanStore(db);
  initializeSyncApplyJournal(db);
  return { db, store: new SyncPlanStore(db) };
}

function addOwner(db, sessionId, actorId) {
  db.prepare("INSERT INTO sync_plan_owners VALUES (?, ?)").run(sessionId, actorId);
}

function createRemoteAdd(db, store) {
  const session = store.create(syncApplyFixtureCreate);
  addOwner(db, session.sessionId, syncApplyFixtureCreate.actorId);
  return session;
}

function conflictRequest(fixture) {
  const { db, store } = openStore();
  const created = store.create(fixture.create);
  addOwner(db, fixture.create.sessionId, fixture.create.actorId);
  const decision = {
    sessionId: fixture.create.sessionId,
    operationId: randomUUID(),
    actorId: "fixture-owner",
    expectedRevision: 1,
    conflictId: created.plan.conflicts[0].id,
    choice: "remote",
    reason: "Use the pinned remote bytes.",
  };
  store.decide(decision);
  return { db, store, decision };
}

test("serializes exact staged actions from the source-pinned persisted plan", () => {
  const { db, store } = openStore();
  try {
    createRemoteAdd(db, store);
    const plan = serializeSyncApplyPlan(store, syncApplyFixtureIdentity);
    assert.deepEqual(plan, syncApplyFixtureExpectedPlan);
    assert.equal(plan.schema, "pkm.sync-apply-plan/v1");
    assert.deepEqual(plan.sourcePins, {
      base: syncApplyFixtureInput.base.sha256,
      local: syncApplyFixtureInput.local.sha256,
      remote: syncApplyFixtureInput.remote.sha256,
    });
    assert.deepEqual(plan.guards, [{ path: "notes/offline-apply.md", sha256: null }]);
    assert.deepEqual(plan.actions, [{
      path: "notes/offline-apply.md", type: "notes", itemId: "offline-apply", member: "", privacy: "public",
      beforeSha256: null, afterSha256: hash(syncApplyFixtureBytes),
      contentBase64: syncApplyFixtureBytes.toString("base64"),
    }]);
    assert.deepEqual(plan.tombstones, []);
    assert.equal(plan.planHash.length, 64);
    assert.throws(() => applySyncPlan(store, { ...syncApplyFixtureIdentity, plan }, resolve("tests")), /Unrecognized key|input|required/);
  } finally { db.close(); }
});

test("applies exact Markdown bytes and returns the same receipt on replay", () => {
  const folder = workspace();
  const root = join(folder, "knowledge");
  mkdirSync(root);
  const { db, store } = openStore();
  try {
    createRemoteAdd(db, store);
    const first = applySyncPlan(store, syncApplyFixtureIdentity, root);
    const second = applySyncPlan(store, syncApplyFixtureIdentity, root);
    assert.deepEqual(first, second);
    assert(syncApplyReceiptSchema.safeParse(first).success);
    assert.deepEqual(readSyncApplyReceipt(store, first.planHash, root), first);
    assert.deepEqual(readFileSync(join(root, "notes", "offline-apply.md")), syncApplyFixtureBytes);
    assert.equal(first.operations[0].beforeSha256, null);
    assert.equal(first.operations[0].afterSha256, hash(syncApplyFixtureBytes));
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("sync apply accepts Notes above the former per-file content quota", () => {
  const { db, store } = openStore();
  const bytes = Buffer.alloc(1_048_577, 7);
  const file = {
    path: "notes/oversized.png", type: "notes", itemId: "oversized", member: "",
    category: "", privacy: "public", digest: hash(bytes), contentBase64: bytes.toString("base64"),
  };
  const manifest = files => ({
    schema: 3, capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] },
    files, deletions: [],
  });
  const snapshot = manifest => ({ manifest, sha256: syncPlanHash(manifest) });
  const empty = manifest([]);
  const input = { base: snapshot(empty), local: snapshot(empty), remote: snapshot(manifest([file])) };
  try {
    const session = store.create({
      sessionId: randomUUID(), operationId: randomUUID(), actorId: "fixture-owner", input,
    });
    assert.equal(session.plan.proposals.length, 1);
    assert.equal(session.plan.proposals[0].state.files[0].contentBase64, bytes.toString("base64"));
  } finally { db.close(); }
});

test("requires persisted owner decisions and revalidates every source pin", () => {
  const fixture = newSyncApplyConflictFixture();
  const { db, store, decision } = conflictRequest(fixture);
  try {
    const current = store.get(fixture.create.sessionId);
    assert(current);
    const acceptedRequest = { sessionId: fixture.create.sessionId, actorId: "fixture-owner", input: fixture.input };
    const plan = serializeSyncApplyPlan(store, acceptedRequest);
    assert.equal(plan.decisions.length, 1);
    assert.equal(plan.decisions[0].operationId, decision.operationId);
    assert.deepEqual(plan.actions, [{
      path: "notes/conflict.md", type: "notes", itemId: "conflict", member: "", privacy: "public",
      beforeSha256: hash(fixture.contents[1]), afterSha256: hash(fixture.contents[2]),
      contentBase64: fixture.contents[2].toString("base64"),
    }]);
    assert.throws(() => serializeSyncApplyPlan(store, { ...acceptedRequest, actorId: "forged-actor" }), /owner/);
    const changed = structuredClone(fixture.input);
    changed.local.sha256 = syncPlanHash(changed.local.manifest);
    changed.local.manifest.files[0].contentBase64 = Buffer.from("external\n").toString("base64");
    changed.local.manifest.files[0].digest = hash(Buffer.from("external\n"));
    changed.local.sha256 = syncPlanHash(changed.local.manifest);
    assert.throws(() => serializeSyncApplyPlan(store, { ...acceptedRequest, input: changed }), /source pins/);
    assert.throws(() => serializeSyncApplyPlan(store, {
      sessionId: fixture.create.sessionId, actorId: "fixture-owner", input: fixture.input,
      plan: { ...plan, actions: [] },
    }), /unrecognized|strict/i);
  } finally { db.close(); }
});

test("decision deletion removes the verified local entity and receipts a tombstone", () => {
  const fixture = newSyncApplyConflictFixture();
  const { db, store } = conflictRequest(fixture);
  const rootFolder = workspace();
  const root = join(rootFolder, "knowledge");
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "conflict.md"), fixture.contents[1]);
  try {
    const current = store.get(fixture.create.sessionId);
    assert(current);
    store.decide({
      sessionId: fixture.create.sessionId, operationId: randomUUID(), actorId: "fixture-owner",
      expectedRevision: current.revision, conflictId: current.plan.conflicts[0].id,
      choice: "delete", reason: "Remove the entity explicitly.",
    });
    const receipt = applySyncPlan(store, {
      sessionId: fixture.create.sessionId, actorId: "fixture-owner", input: fixture.input,
    }, root);
    assert.deepEqual(receipt.tombstones, [{
      type: "notes", itemId: "conflict", source: "decision", conflictId: current.plan.conflicts[0].id,
    }]);
    assert.throws(() => readFileSync(join(root, "notes", "conflict.md")), { code: "ENOENT" });
  } finally {
    db.close();
    rmSync(rootFolder, { recursive: true, force: true });
  }
});

test("remote tombstones delete only the pinned local bytes", () => {
  const folder = workspace();
  const root = join(folder, "knowledge");
  mkdirSync(join(root, "notes"), { recursive: true });
  const localBytes = Buffer.from("local\n");
  writeFileSync(join(root, "notes", "deleted.md"), localBytes);
  const file = {
    path: "notes/deleted.md", type: "notes", itemId: "deleted", member: "",
    category: "", privacy: "public", digest: hash(localBytes), contentBase64: localBytes.toString("base64"),
  };
  const manifest = (files, deletions = []) => ({
    schema: 3, capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] },
    files, deletions,
  });
  const tombstone = { type: "notes", itemId: "deleted", deletedAt: "2026-01-01T00:00:00Z", category: "", privacy: "public" };
  const snap = manifest => ({ manifest, sha256: syncPlanHash(manifest) });
  const input = {
    base: snap(manifest([file])), local: snap(manifest([file])), remote: snap(manifest([], [tombstone])),
  };
  const { db, store } = openStore();
  const sessionId = randomUUID();
  try {
    store.create({ sessionId, operationId: randomUUID(), actorId: "fixture-owner", input });
    addOwner(db, sessionId, "fixture-owner");
    const receipt = applySyncPlan(store, { sessionId, actorId: "fixture-owner", input }, root);
    assert.equal(receipt.tombstones[0].deletedAt, tombstone.deletedAt);
    assert.throws(() => readFileSync(join(root, "notes", "deleted.md")), { code: "ENOENT" });
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("durable recovery rolls forward an interrupted write and is idempotent", () => {
  const folder = workspace();
  const root = join(folder, "knowledge");
  const database = join(folder, "host.sqlite");
  mkdirSync(root);
  let { db, store } = openStore(database);
  try {
    createRemoteAdd(db, store);
    assert.throws(() => applySyncPlan(store, syncApplyFixtureIdentity, root, {
      faultInjector: () => { throw new Error("simulated interruption after filesystem write"); },
    }), /simulated interruption/);
    assert.deepEqual(readFileSync(join(root, "notes", "offline-apply.md")), syncApplyFixtureBytes);
    db.close();
    ({ db, store } = openStore(database));
    const recovered = recoverSyncApply(store, root);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].planHash, serializeSyncApplyPlan(store, syncApplyFixtureIdentity).planHash);
    assert.deepEqual(applySyncPlan(store, syncApplyFixtureIdentity, root), recovered[0]);
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("external writes and changed decisions fail closed without clobbering bytes", () => {
  const folder = workspace();
  const root = join(folder, "knowledge");
  mkdirSync(join(root, "notes"), { recursive: true });
  const external = Buffer.from("external\n");
  writeFileSync(join(root, "notes", "offline-apply.md"), external);
  const { db, store } = openStore();
  try {
    createRemoteAdd(db, store);
    assert.throws(() => applySyncPlan(store, syncApplyFixtureIdentity, root), /External write detected/);
    assert.deepEqual(readFileSync(join(root, "notes", "offline-apply.md")), external);
    const status = db.prepare("SELECT state FROM sync_apply_journal").get();
    assert.equal(status.state, "needs-review");
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("recovery refuses a newer decision revision after an interrupted application", () => {
  const fixture = newSyncApplyConflictFixture();
  const { db, store } = conflictRequest(fixture);
  const folder = workspace();
  const root = join(folder, "knowledge");
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "conflict.md"), fixture.contents[1]);
  try {
    const request = { sessionId: fixture.create.sessionId, actorId: "fixture-owner", input: fixture.input };
    assert.throws(() => applySyncPlan(store, request, root, {
      faultInjector: () => { throw new Error("interrupted"); },
    }), /interrupted/);
    const current = store.get(fixture.create.sessionId);
    assert(current);
    store.decide({
      sessionId: fixture.create.sessionId, operationId: randomUUID(), actorId: "fixture-owner",
      expectedRevision: current.revision, conflictId: current.plan.conflicts[0].id,
      choice: "local", reason: "The decision changed after interruption.",
    });
    assert.throws(() => recoverSyncApply(store, root), /decision or source pins changed/);
    assert.deepEqual(readFileSync(join(root, "notes", "conflict.md")), fixture.contents[2]);
    assert.equal(db.prepare("SELECT state FROM sync_apply_journal").get().state, "needs-review");
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("symlink traversal, canonical Todo Board, generic Todo and unowned Script descriptors are rejected", () => {
  const folder = workspace();
  const root = join(folder, "knowledge");
  const outside = join(folder, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(join(root, "notes"));
  symlinkSync(outside, join(root, "notes", "linked"));
  const { db, store } = openStore();
  const makeInput = path => {
    const bytes = Buffer.from("fixture\n");
    const file = {
      path, type: path.split("/")[0], itemId: "fixture", member: "", category: "", privacy: "public",
      digest: hash(bytes), contentBase64: bytes.toString("base64"),
    };
    const manifest = files => ({
      schema: 3, capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] },
      files, deletions: [],
    });
    const snap = manifest => ({ manifest, sha256: syncPlanHash(manifest) });
    return { base: snap(manifest([])), local: snap(manifest([])), remote: snap(manifest([file])) };
  };
  try {
    for (const [index, path] of [
      "notes/linked/escape.md",
      "notes/Research/PKM/Migration/Migration Board.md",
      "notes/todo/item.md",
      "scripts/run.sh",
    ].entries()) {
      const input = makeInput(path);
      const sessionId = randomUUID();
      store.create({ sessionId, operationId: randomUUID(), actorId: "fixture-owner", input });
      addOwner(db, sessionId, "fixture-owner");
      if (index === 0) {
        assert.throws(() => applySyncPlan(store, { sessionId, actorId: "fixture-owner", input }, root), /Symlink/);
      } else {
        assert.throws(() => serializeSyncApplyPlan(store, { sessionId, actorId: "fixture-owner", input }),
          /Todo Board|Todo\/memory|restricted|Unsupported|Script primary identity/);
      }
    }
    assert.throws(() => readFileSync(join(outside, "escape.md")), { code: "ENOENT" });
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
