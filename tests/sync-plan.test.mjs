import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { planSync, syncPlanHash } from "../dist/sync-plan.js";
import { initializeSyncPlanStore, SyncPlanStore } from "../dist/sync-plan-store.js";
import { syncPlanDefinitions, syncPlanManifestSchema, syncPlanResultSchema, syncPlanSessionSchema } from "../dist/sync-plan-contracts.js";
import { syncPlanFixtureInput, syncPlanFixtureResult, syncPlanCreateFixture, syncPlanDecisionFixture } from "./sync-plan-fixture.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const file = (text, path = "notes/Café.md", itemId = "cafe") => ({
  path, type: "notes", itemId, member: "", category: "", privacy: "public",
  digest: digest(text), contentBase64: Buffer.from(text).toString("base64"),
});
const tomb = (itemId = "cafe", deletedAt = "2026-01-01T00:00:00Z") =>
  ({ type: "notes", itemId, deletedAt, category: "", privacy: "public" });
const manifest = (files = [], deletions = []) => ({
  schema: 3, capabilities: { storage: "pkm.github.publication/v1", required: ["explicit-deletions", "stable-entity-identity"] }, files, deletions,
});
const snap = manifest => ({ manifest, sha256: syncPlanHash(manifest) });
const input = (base, local, remote) => ({ base: snap(base), local: snap(local), remote: snap(remote) });
const run = (base, local, remote) => planSync(input(base, local, remote));
const a = manifest([file("a")]), b = manifest([file("b")]), c = manifest([file("c")]);
const empty = manifest(), deleted = manifest([], [tomb()]);

test("public fixture supplies complete exact plan and store requests", () => {
  assert.deepEqual(planSync(syncPlanFixtureInput), syncPlanFixtureResult);
  const db = new DatabaseSync(":memory:");
  try {
    initializeSyncPlanStore(db);
    const store = new SyncPlanStore(db);
    const session = store.create(syncPlanCreateFixture);
    const request = syncPlanDecisionFixture(session.plan.conflicts[0].id);
    const decided = store.decide(request);
    assert.deepEqual(decided.decisions, [{
      operationId: request.operationId, actorId: request.actorId, conflictId: request.conflictId,
      choice: request.choice, reason: request.reason, revision: 2,
    }]);
  } finally { db.close(); }
});

test("offline additions, edits, matching changes and durable explicit deletion", () => {
  assert.equal(run(empty, a, empty).proposals[0].source, "local");
  assert.equal(run(empty, empty, a).proposals[0].source, "remote");
  assert.equal(run(a, b, a).proposals[0].source, "local");
  assert.equal(run(a, a, b).proposals[0].source, "remote");
  assert.equal(run(a, b, b).proposals[0].source, "both");
  const plan = run(a, deleted, a);
  assert.equal(plan.proposals[0].state.kind, "deleted");
  assert.deepEqual(plan.deletionHistory, [{ source: "local", deletion: tomb() }]);
  assert.equal(run(a, deleted, deleted).deletionHistory.length, 2);
  assert.equal(run(deleted, a, deleted).deletionHistory.length, 2);
  assert.equal(run(a, empty, a).conflicts[0].reason, "unrecorded-absence");
  assert.equal(run(a, empty, empty).conflicts[0].reason, "unrecorded-absence");
  assert.equal(run(deleted, empty, deleted).conflicts[0].reason, "missing-deletion-history");
  assert(syncPlanResultSchema.safeParse(plan).success);
});

test("concurrent changes, rename and cross-snapshot path ownership remain explicit", () => {
  assert.equal(run(a, b, c).conflicts[0].reason, "concurrent-change");
  assert.equal(run(a, deleted, b).conflicts[0].reason, "concurrent-change");
  assert.equal(run(a, manifest([file("a", "notes/moved.md")]), a).conflicts[0].reason, "move-review");
  const caseMove = manifest([file("a", "notes/café.md")]);
  assert.equal(run(a, caseMove, a).conflicts[0].reason, "path-collision");
  const replacement = manifest([file("a", "notes/Café.md", "other")], [tomb()]);
  const result = run(a, replacement, a);
  assert.equal(result.conflicts.length, 2);
  assert(result.conflicts.every(c => c.reason === "path-collision"));
  const prefix = manifest([file("a", "notes/Café.md/child", "other")]);
  assert(run(a, empty, prefix).conflicts.every(c => c.reason === "path-collision"));
  const memberA = { ...file("a", "notes/folder/a"), member: "a" };
  const memberB = { ...file("b", "notes/folder/b"), member: "b" };
  assert.equal(run(manifest([memberA, memberB]), manifest([memberA]), manifest([memberA, memberB])).conflicts[0].reason, "unrecorded-member-absence");
});

test("strict manifest, content, unicode, path and resource validation", () => {
  const mismatch = input(a, a, a); mismatch.local.sha256 = "0".repeat(64);
  assert.throws(() => planSync(mismatch), /pin mismatch/);
  assert.throws(() => run(empty, manifest([file("a", "notes/Cafe\u0301.md")]), empty), /Unsafe/);
  for (const path of ["/notes/a", "notes/../a", "notes/.GIT/config", "notes/node_modules/a", "notes/CON", "notes/a\\b", "notes/_.pyc"]) {
    assert.throws(() => run(empty, manifest([file("a", path)]), empty), /Unsafe|invalid/);
  }
  assert.throws(() => run(empty, manifest([file("a"), file("b", "notes/café.md", "another")]), empty), /Duplicate portable/);
  assert.throws(() => run(empty, manifest([file("a", "notes/a"), file("x", "notes/a-", "b"), file("b", "notes/a/b", "c")]), empty), /directory/);
  assert.throws(() => run(empty, manifest([file("a")], [tomb()]), empty), /tombstone/);
  assert.throws(() => run(empty, manifest([{ ...file("a"), digest: digest("b") }]), empty), /digest/);
  assert.throws(() => run(empty, manifest([{ ...file("a"), contentBase64: "YQ" }]), empty), /encoding/);
  const many = manifest(Array.from({ length: 1001 }, (_, i) => file(String(i), `notes/${i}.md`, String(i))));
  assert.equal(run(empty, many, empty).proposals.length, 1001);
  const large = Buffer.alloc(1_048_577, 97);
  assert.equal(run(empty, manifest([file(large, "notes/large.md")]), empty).proposals.length, 1);
  const largerSet = Array.from({ length: 9 }, (_, i) => ({
    ...file("a", `notes/${i}.md`, String(i)), contentBase64: large.toString("base64"), digest: digest(large),
  }));
  assert.equal(run(empty, manifest(largerSet), empty).proposals.length, 9);
  const largeBoard = Buffer.alloc(8 * 1024 * 1024 + 1, 97);
  assert.equal(run(empty, manifest([file(largeBoard, "notes/Board.assets/pkm-todo-board.json", "board")]), empty).proposals.length, 1);
  const oversizedSkill = file(Buffer.alloc(1_048_577, 97), "skills/large.md", "large");
  oversizedSkill.type = "skills";
  assert.throws(() => run(empty, manifest([oversizedSkill]), empty), /Non-Notes sync file exceeds/);
  const manySkills = manifest(Array.from({ length: 1001 }, (_, i) => ({
    ...file(String(i), `skills/${i}.md`, String(i)), type: "skills",
  })));
  assert.equal(syncPlanManifestSchema.safeParse(manySkills).success, false);
  const noCapabilities = manifest(); noCapabilities.capabilities.required = [];
  assert.throws(() => run(empty, noCapabilities, empty), /capabilities/);
});

test("durable revision CAS, operation idempotency, append-only decisions and crash recovery", () => {
  const dbPath = `tests/sync-plan-db-${randomUUID()}.sqlite`;
  let db = new DatabaseSync(dbPath);
  try {
    initializeSyncPlanStore(db);
    let store = new SyncPlanStore(db);
    const create = { sessionId: randomUUID(), operationId: randomUUID(), actorId: "alice", input: input(a, b, c) };
    const initial = store.create(create);
    assert.equal(initial.revision, 1);
    assert.deepEqual(store.create(create), initial);
    const request = {
      sessionId: create.sessionId, operationId: randomUUID(), actorId: "alice", expectedRevision: 1,
      conflictId: initial.plan.conflicts[0].id, choice: "remote", reason: "reviewed remote",
    };
    const accepted = store.decide(request);
    assert.equal(accepted.revision, 2);
    assert(syncPlanSessionSchema.safeParse(accepted).success);
    assert.deepEqual(store.decide(request), accepted);
    assert.throws(() => store.decide({ ...request, reason: "different" }), /reused/);
    assert.throws(() => store.decide({ ...request, operationId: randomUUID() }), /revision mismatch/);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE sync_plan_sessions SET revision = 99 WHERE session_id = ?").run(create.sessionId);
    db.close();
    db = new DatabaseSync(dbPath); initializeSyncPlanStore(db); store = new SyncPlanStore(db);
    assert.deepEqual(store.get(create.sessionId), accepted);
    const next = store.decide({ ...request, operationId: randomUUID(), actorId: "bob", expectedRevision: 2, choice: "delete", reason: "propose removal" });
    assert.equal(next.revision, 3);
    assert.deepEqual(next.decisions.map(d => [d.actorId, d.choice]), [["alice", "remote"], ["bob", "delete"]]);
    assert.deepEqual(store.decide(request), accepted);
    assert.deepEqual(store.get(create.sessionId), next);
    assert.equal(syncPlanDefinitions[0].readOnly, true);
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { unlinkSync(dbPath + suffix); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
});
