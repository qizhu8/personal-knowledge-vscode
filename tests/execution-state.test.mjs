import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ExecutionStateStore } from "../dist/execution-state.js";
import { executionStateFixture } from "./execution-state-fixtures.mjs";

const op = () => randomUUID();
function tx(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = callback(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
const input = (approvalRequired = true) => ({ tool: "run_process", arguments: { command: "echo fixture" }, approvalRequired, operationId: op() });

test("durable actor-scoped lifecycle, native exact-record approval, CAS and uncertain effects", async () => {
  const dir = fileURLToPath(new URL(`../.execution-state-test-${randomUUID()}`, import.meta.url));
  mkdirSync(dir);
  let db = new DatabaseSync(`${dir}/state.sqlite`);
  try {
    let seen;
    let store = new ExecutionStateStore(db, async request => {
      seen = request;
      assert.ok(Object.isFrozen(request.record.arguments));
      return { actorId: request.record.actor, decisionId: "native-decision" };
    });
    tx(db, () => store.initialize());
    const first = tx(db, () => store.create("alice", input()));
    assert.equal(first.status, "awaiting_approval");
    assert.equal(store.get("bob", first.id), null);
    assert.throws(() => store.events("bob", first.id), /not found/);
    assert.throws(() => store.cancel("alice", first.id, 1, op()), /transaction/);
    const stale = await store.authorize("alice", first.id, 1, op());
    assert.deepEqual(seen.record.arguments, { command: "echo fixture" });
    const revised = tx(db, () => store.revise("alice", first.id, 1, op(), { command: "echo changed" }));
    assert.equal(revised.revision, 2);
    assert.throws(() => tx(db, () => store.commitApproval(stale)), /stale/);
    assert.throws(() => tx(db, () => store.observe("alice", first.id, 2, op(), "started")), /not authorized/);
    const grant = await store.authorize("alice", first.id, 2, op());
    const approved = tx(db, () => store.commitApproval(grant));
    assert.equal(approved.status, "pending");
    assert.throws(() => tx(db, () => store.commitApproval(grant)), /Invalid native approval/);
    assert.throws(() => tx(db, () => store.cancel("alice", first.id, 2, op())), /conflict/);
    const running = tx(db, () => store.observe("alice", first.id, 3, op(), "started"));
    assert.equal(running.status, "running");
    const uncertain = tx(db, () => store.cancel("alice", first.id, 4, op()));
    assert.equal(uncertain.status, "unknown");
    assert.throws(() => tx(db, () => store.observe("alice", first.id, 5, op(), "started")), /not authorized/);
    assert.throws(() => tx(db, () => store.observe("alice", first.id, 5, op(), "succeeded")), /not running/);
    db.close();
    db = new DatabaseSync(`${dir}/state.sqlite`);
    store = new ExecutionStateStore(db);
    tx(db, () => store.initialize());
    assert.equal(store.get("alice", first.id).status, "unknown");
    assert.equal(store.list("bob").records.length, 0);
    const page1 = store.events("alice", first.id, 0, 2);
    const page2 = store.events("alice", first.id, page1.next, 2);
    const page3 = store.events("alice", first.id, page2.next, 2);
    assert.deepEqual([...page1.events, ...page2.events, ...page3.events].map(e => e.action),
      ["created", "revised", "approved", "started", "cancel_requested"]);
    assert.equal(page3.next, null);
    assert.throws(() => store.events("alice", first.id, 0, 51), /limit/);
    assert.throws(() => store.list("alice", "", 0), /limit/);
    const second = tx(db, () => store.create("alice", input()));
    await assert.rejects(() => store.authorize("alice", second.id, 1, op()), /unavailable/);
    await assert.rejects(() => store.authorize("bob", second.id, 1, op()), /no longer pending/);
    assert.equal(tx(db, () => store.cancel("alice", second.id, 1, op())).status, "cancelled");
    const human = new ExecutionStateStore(db, async () => ({ actorId: "alice", decisionId: "decision" }));
    const check = tx(db, () => human.create("bob", input()));
    await assert.rejects(() => human.authorize("bob", check.id, 1, op()), /actor mismatch/);
    const humanCarol = new ExecutionStateStore(db, async () => ({ actorId: "carol", decisionId: "decision" }));
    const reviseAfterApproval = tx(db, () => humanCarol.create("carol", input()));
    const awaited = await humanCarol.authorize("carol", reviseAfterApproval.id, 1, op());
    const approvedAgain = tx(db, () => humanCarol.commitApproval(awaited));
    const changed = tx(db, () => humanCarol.revise("carol", reviseAfterApproval.id, approvedAgain.revision, op(), { command: "different" }));
    assert.equal(changed.approvalDecisionId, null);
    assert.equal(changed.status, "awaiting_approval");
    assert.throws(() => tx(db, () => humanCarol.observe("carol", changed.id, changed.revision, op(), "started")), /not authorized/);
    const third = tx(db, () => store.create("alice", input(false)));
    tx(db, () => store.observe("alice", third.id, 1, op(), "started"));
    assert.equal(tx(db, () => store.observe("alice", third.id, 2, op(), "interrupted")).status, "unknown");
    const fourth = tx(db, () => store.create("alice", input(false)));
    tx(db, () => store.observe("alice", fourth.id, 1, op(), "started"));
    assert.equal(tx(db, () => store.observe("alice", fourth.id, 2, op(), "succeeded")).status, "succeeded");
    const fifth = tx(db, () => store.create("bob", executionStateFixture.create));
    assert.deepEqual(fifth.arguments, executionStateFixture.create.arguments);
    const sixth = tx(db, () => store.create("bob", input(false)));
    tx(db, () => store.observe("bob", sixth.id, 1, op(), "started"));
    assert.equal(tx(db, () => store.observe("bob", sixth.id, 2, op(), "failed")).status, "failed");
    const list1 = store.list("alice", "", 2);
    const list2 = store.list("alice", list1.next, 2);
    assert.equal(list1.records.length + list2.records.length, 4);
    assert.equal(list2.next, null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("schema version and transactional operation ID enforcement", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ExecutionStateStore(db);
    tx(db, () => store.initialize());
    const operationId = op();
    const first = tx(db, () => store.create("alice", { ...input(false), operationId }));
    assert.throws(() => tx(db, () => store.cancel("alice", first.id, 1, operationId)), /UNIQUE/);
    assert.equal(store.get("alice", first.id).status, "pending");
    assert.throws(() => tx(db, () => store.create("alice", { ...input(), operationId: "bad" })), /operation ID/);
    db.exec("PRAGMA ignore_check_constraints=ON; UPDATE execution_schema SET version=2");
    assert.throws(() => tx(db, () => store.initialize()), /Unsupported/);
    db.exec("UPDATE execution_schema SET version=1; PRAGMA ignore_check_constraints=OFF");
    db.exec("DROP TABLE execution_events");
    assert.throws(() => tx(db, () => store.initialize()), /Incomplete/);
  } finally { db.close(); }
});
