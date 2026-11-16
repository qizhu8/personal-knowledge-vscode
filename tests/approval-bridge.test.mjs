import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createApprovalBridge } from "../dist/approval-bridge.js";
import { ExecutionStateStore } from "../dist/execution-state.js";
import { approvalBridgeDigest, approvalBridgeJSON } from "../dist/domain/approval-bridge-digest.js";
import { recordPortalCommand } from "../dist/domain/approval-bridge-native-activity.js";
import { checkCaptureRecords } from "../scripts/migration.mjs";

const op = randomUUID;
const executionOperations = new Map();
const context = { turnId: "fixture-turn", contextDigest: "a".repeat(64), readOnly: false };
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(db); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function fixture(extra = {}, db = new DatabaseSync(":memory:")) {
  const storage = { read: fn => fn(db), transaction: fn => transaction(db, fn) };
  const bridge = createApprovalBridge({
    workspaceId: "fixture-workspace", storage,
    reviewer: async request => {
      assert.equal(db.isTransaction, false);
      assert.ok(Object.isFrozen(request.record.arguments));
      return { decision: "approve", actorId: request.actorId, decisionId: "fixture-decision" };
    },
    dispatch: async () => {
      assert.equal(db.isTransaction, false);
      return { status: "succeeded", result: { value: "fixture-result" } };
    },
    ...extra,
  });
  return { db, storage, ...bridge };
}
function create(f, overrides = {}) {
  const input = {
    tool: "fixture.operation", arguments: { secret: "fixture-not-in-events" },
    operationId: op(), approvalRequired: true, context, ...overrides,
  };
  const record = f.native.create("alice", input);
  executionOperations.set(record.id, input.operationId);
  return record;
}
function request(f, record, overrides = {}) {
  return f.public.request("alice", { executionId: record.id, expectedRevision: record.revision, operationId: op(), ...overrides });
}
function execInput(record, expectedRevision = record.revision) {
  return { executionId: record.id, expectedRevision, operationId: executionOperations.get(record.id) };
}

test("native exact-record decision, durable started before dispatch, single-use exact gateway proof and repeat result", async () => {
  let f, calls = 0, proof;
  f = fixture({ dispatch: async value => {
    calls++;
    assert.equal(f.db.isTransaction, false);
    assert.equal(new ExecutionStateStore(f.db).get("alice", value.execution.id).status, "running");
    const binding = {
      operation: value.execution.tool, version: 1, arguments: value.execution.arguments,
      argumentsDigest: approvalBridgeDigest(value.execution.arguments), operationId: value.operationId,
      actorId: "alice", workspaceId: "fixture-workspace", ...context,
    };
    proof = value.approval;
    assert.equal(await f.native.verifyApproval(binding, {}, value.signal), false);
    assert.equal(await f.native.verifyApproval(binding, value.approval, value.signal), true);
    assert.equal(await f.native.verifyApproval(binding, value.approval, value.signal), false);
    return { status: "succeeded", result: { host: "fixture" } };
  } });
  try {
    const record = create(f), pending = request(f, record);
    const approved = await f.native.review("alice", pending.id);
    assert.equal(approved.status, "approved");
    assert.equal(approved.resolvedExecutionRevision, 2);
    const input = execInput(record, 2), result = await f.native.execute("alice", input);
    assert.equal(result.execution.status, "succeeded");
    assert.deepEqual(result.result, { host: "fixture" });
    assert.deepEqual(await f.native.execute("alice", input), result);
    assert.equal(calls, 1);
    await assert.rejects(() => f.native.execute("alice", { ...input, operationId: op() }), /cannot be replayed/);
    assert.equal(await f.native.verifyApproval({}, proof, new AbortController().signal), false);
    assert.deepEqual(await f.native.review("alice", pending.id), approved);
    const page1 = f.public.events("alice", pending.id, 0, 1);
    const page2 = f.public.events("alice", pending.id, page1.next, 1);
    assert.deepEqual([...page1.events, ...page2.events].map(value => value.action), ["requested", "approved"]);
    assert.equal(page2.next, null);
    assert.ok(!JSON.stringify(page1).includes("fixture-not-in-events"));
    assert.ok(!JSON.stringify(f.public.get("alice", pending.id)).includes("fixture-not-in-events"));
  } finally { f.db.close(); }
});

test("human rejection is durable, visible and idempotent; no generic remembered grant", async () => {
  let reviews = 0;
  const f = fixture({ reviewer: async () => { reviews++; return { decision: "reject", decisionId: "human-no", actorId: "alice" }; } });
  try {
    const record = create(f), pending = request(f, record);
    const rejected = await f.native.review("alice", pending.id);
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(await f.native.review("alice", pending.id), rejected);
    assert.equal(reviews, 1);
    assert.equal(new ExecutionStateStore(f.db).get("alice", record.id).status, "cancelled");
    await assert.rejects(() => f.native.execute("alice", execInput(record, rejected.resolvedExecutionRevision)), /not authorized/);
    const next = create(f);
    await assert.rejects(() => f.native.execute("alice", execInput(next)), /not authorized/);
    assert.equal(f.public.events("alice", pending.id).events.at(-1).action, "rejected");
  } finally { f.db.close(); }
});

test("cancellation during human await wins, and concurrent/repeated review cannot restore approval", async () => {
  let finish, entered;
  const awaiting = new Promise(resolve => { entered = resolve; });
  const f = fixture({ reviewer: async () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  try {
    const record = create(f), pending = request(f, record);
    const reviewing = f.native.review("alice", pending.id);
    const duplicate = f.native.review("alice", pending.id);
    await awaiting;
    const input = { id: pending.id, expectedRevision: pending.revision, operationId: op() };
    const cancelled = f.public.cancel("alice", input);
    assert.deepEqual(f.public.cancel("alice", input), cancelled);
    finish({ decision: "approve", decisionId: "too-late", actorId: "alice" });
    assert.equal((await reviewing).status, "cancelled");
    assert.equal((await duplicate).status, "cancelled");
    assert.equal(new ExecutionStateStore(f.db).get("alice", record.id).status, "cancelled");
  } finally { f.db.close(); }
});

test("argument revision, actor/workspace/operation/context changes during human review invalidate approval", async () => {
  for (const mutation of ["revision", "digest", "actor", "workspace", "operation", "context"]) {
    let finish;
    const f = fixture({ reviewer: () => new Promise(resolve => { finish = resolve; }) });
    try {
      const record = create(f), pending = request(f, record);
      const reviewing = f.native.review("alice", pending.id);
      if (mutation === "revision") transaction(f.db, () =>
        new ExecutionStateStore(f.db).revise("alice", record.id, record.revision, op(), { changed: true }));
      else if (mutation === "digest") f.db.prepare("UPDATE execution_records SET arguments_json=? WHERE id=?").run('{"changed":true}', record.id);
      else if (mutation === "actor") f.db.prepare("UPDATE execution_records SET actor='bob' WHERE id=?").run(record.id);
      else if (mutation === "workspace") f.db.prepare("UPDATE approval_bridge_bindings SET workspace_id='changed' WHERE execution_id=?").run(record.id);
      else if (mutation === "operation") f.db.prepare("UPDATE approval_bridge_bindings SET operation_id=? WHERE execution_id=?").run(op(), record.id);
      else f.db.prepare("UPDATE approval_bridge_bindings SET context_json=? WHERE execution_id=?")
        .run(JSON.stringify({ ...context, contextDigest: "b".repeat(64) }), record.id);
      finish({ decision: "approve", decisionId: "old-record", actorId: "alice" });
      assert.equal((await reviewing).status, "stale");
      assert.equal(f.db.prepare("SELECT approval_decision_id FROM execution_records WHERE id=?").get(record.id).approval_decision_id, null);
    } finally { f.db.close(); }
  }
});

test("actor/workspace changes, public forgery and native memory decisions fail closed", async () => {
  const f = fixture({ reviewer: async () => ({ decision: "approve", decisionId: "wrong-actor", actorId: "bob" }) });
  try {
    const record = create(f), pending = request(f, record);
    await assert.rejects(() => f.native.review("alice", pending.id), /actor mismatch/);
    assert.throws(() => f.public.get("bob", pending.id), /not found/);
    assert.throws(() => f.public.events("bob", pending.id), /not found/);
    assert.throws(() => request(f, record, { actorId: "bob" }), /unrecognized/i);
    assert.throws(() => request(f, record, { decision: "approve" }), /unrecognized/i);
    assert.throws(() => request(f, record, { result: { status: "succeeded" } }), /unrecognized/i);
    assert.equal(f.public.approve, undefined);
    assert.equal(f.public.resolve, undefined);
    assert.equal(f.public.observe, undefined);
    for (const tool of ["memory.record.confirm", "memory.record.revise", "memory.record.revoke", "memory_record_confirm"])
      assert.throws(() => create(f, { tool }), /separate native exact-memory/);
    const other = fixture({ workspaceId: "other-workspace" }, f.db);
    assert.throws(() => other.public.get("alice", pending.id), /not found/);
    await assert.rejects(() => other.native.execute("alice", execInput(record)), /actor\/workspace/);
    assert.deepEqual(f.public.list("bob").requests, []);
  } finally { f.db.close(); }
});

test("gateway proof rejects each changed binding and cannot be reused after failure", async () => {
  const changes = {
    actorId: "bob", workspaceId: "other", operation: "other", operationId: op(), version: 2,
    turnId: "other", contextDigest: "b".repeat(64), readOnly: true,
    arguments: { injected: true }, argumentsDigest: "c".repeat(64),
  };
  for (const [key, changed] of Object.entries(changes)) {
    let f;
    f = fixture({ dispatch: async value => {
      const bound = {
        operation: value.execution.tool, version: 1, arguments: value.execution.arguments,
        argumentsDigest: approvalBridgeDigest(value.execution.arguments), operationId: value.operationId,
        actorId: "alice", workspaceId: "fixture-workspace", ...context,
      };
      assert.equal(await f.native.verifyApproval({ ...bound, [key]: changed }, value.approval, value.signal), false, key);
      assert.equal(await f.native.verifyApproval(bound, value.approval, value.signal), false);
      return { status: "failed" };
    } });
    try {
      const record = create(f), approved = await f.native.review("alice", request(f, record).id);
      assert.equal((await f.native.execute("alice", execInput(record, approved.resolvedExecutionRevision))).execution.status, "failed");
    } finally { f.db.close(); }
  }
});

test("timeout and thrown/invalid host observations become unknown, never late completion or replay", async () => {
  for (const mode of ["timeout", "throw", "invalid"]) {
    let calls = 0, finish;
    const f = fixture({ timeoutMs: 10, dispatch: async () => {
      calls++;
      if (mode === "throw") throw new Error("host private payload");
      if (mode === "invalid") return { status: "success-forged" };
      return new Promise(resolve => { finish = resolve; });
    } });
    try {
      const record = create(f, { approvalRequired: false }), input = execInput(record);
      const result = await f.native.execute("alice", input);
      assert.equal(result.execution.status, "unknown");
      assert.equal(result.result, undefined);
      finish?.({ status: "succeeded", result: "late" });
      await Promise.resolve();
      assert.deepEqual(await f.native.execute("alice", input), result);
      assert.equal(calls, 1);
    } finally { f.db.close(); }
  }
});

test("completion pins full running revision and cannot overwrite running cancellation", async () => {
  for (const mutation of ["cancel", "digest"]) {
    let finish;
    const f = fixture({ dispatch: () => new Promise(resolve => { finish = resolve; }) });
    try {
      const record = create(f, { approvalRequired: false }), input = execInput(record);
      const executing = f.native.execute("alice", input);
      if (mutation === "cancel") transaction(f.db, () => new ExecutionStateStore(f.db).cancel("alice", record.id, 2, op()));
      else f.db.prepare("UPDATE execution_records SET tool='changed' WHERE id=?").run(record.id);
      finish({ status: "succeeded", result: "must-not-commit" });
      const result = await executing;
      assert.equal(result.execution.status, "unknown");
      assert.equal(result.result, undefined);
      assert.deepEqual(await f.native.execute("alice", input), result);
    } finally { f.db.close(); }
  }
});

test("abort after started is unknown, while pre-aborted input never dispatches", async () => {
  let calls = 0;
  const f = fixture({ dispatch: async request => {
    calls++;
    return new Promise(resolve => request.signal.addEventListener("abort",
      () => resolve({ status: "succeeded", result: "late-after-abort" }), { once: true }));
  } });
  try {
    const record = create(f, { approvalRequired: false }), input = execInput(record);
    const before = new AbortController(); before.abort();
    await assert.rejects(() => f.native.execute("alice", input, { signal: before.signal }), /cancelled before dispatch/);
    assert.equal(calls, 0);
    const during = new AbortController();
    const pending = f.native.execute("alice", input, { signal: during.signal });
    during.abort();
    const result = await pending;
    assert.equal(result.execution.status, "unknown");
    assert.equal(result.result, undefined);
    assert.equal(calls, 1);
    assert.deepEqual(await f.native.execute("alice", input), result);
  } finally { f.db.close(); }
});

test("no transaction held across human await; transactions cannot invoke async authorization", async () => {
  let finish;
  const f = fixture({ reviewer: () => {
    assert.equal(f.db.isTransaction, false);
    return new Promise(resolve => { finish = resolve; });
  } });
  try {
    const record = create(f), pending = request(f, record), reviewing = f.native.review("alice", pending.id);
    assert.equal(f.db.isTransaction, false);
    transaction(f.db, () => f.db.exec("CREATE TABLE unrelated_fixture(value TEXT)"));
    finish(null);
    assert.equal((await reviewing).status, "rejected");
    transaction(f.db, () => assert.throws(() => f.public.get("alice", pending.id), /outside a transaction/));
  } finally { f.db.close(); }
});

test("durable reopen retains requests/rejections/results and crash recovery never redispatches", async () => {
  const directory = fileURLToPath(new URL(`../.approval-bridge-${op()}`, import.meta.url));
  mkdirSync(directory);
  let db = new DatabaseSync(`${directory}/state.sqlite`);
  try {
    let calls = 0;
    let f = fixture({ reviewer: async () => ({ decision: "reject", actorId: "alice", decisionId: "no" }),
      dispatch: async () => { calls++; return { status: "succeeded", result: { reopened: true } }; } }, db);
    const rejectedRecord = create(f), rejected = await f.native.review("alice", request(f, rejectedRecord).id);
    const pendingRecord = create(f), pending = request(f, pendingRecord);
    const completedRecord = create(f, { approvalRequired: false }), completedInput = execInput(completedRecord);
    const completed = await f.native.execute("alice", completedInput);
    const crashRecord = create(f, { approvalRequired: false }), crashInput = execInput(crashRecord);
    transaction(db, () => {
      const running = new ExecutionStateStore(db).observe("alice", crashRecord.id, 1, op(), "started");
      db.prepare("INSERT INTO approval_bridge_runs VALUES(?,?,?,?,?,?, 'running',NULL)")
        .run(crashRecord.id, "fixture-workspace", "alice", crashInput.operationId, 1, running.revision);
    });
    db.close();
    db = new DatabaseSync(`${directory}/state.sqlite`);
    f = fixture({ dispatch: async () => { calls++; throw new Error("must not replay"); } }, db);
    assert.deepEqual(f.public.get("alice", rejected.id), rejected);
    assert.deepEqual(await f.native.review("alice", rejected.id), rejected);
    assert.deepEqual(f.public.get("alice", pending.id), pending);
    assert.deepEqual(await f.native.execute("alice", completedInput), completed);
    assert.deepEqual(f.native.recover(), { unknown: 1 });
    assert.deepEqual(f.native.recover(), { unknown: 0 });
    assert.equal((await f.native.execute("alice", crashInput)).execution.status, "unknown");
    assert.equal(calls, 1);
    assert.equal(f.public.list("alice", "", 1).requests.length, 1);
    assert.throws(() => f.public.list("alice", "", 51));
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("create/request operation receipts are exact and survive repeated calls", () => {
  const f = fixture();
  try {
    const operationId = op(), record = create(f, { operationId });
    assert.deepEqual(create(f, { operationId }), record);
    assert.throws(() => create(f, { operationId, arguments: { different: true } }), /operation ID conflict/);
    const requestId = op(), pending = request(f, record, { operationId: requestId });
    assert.deepEqual(request(f, record, { operationId: requestId }), pending);
    const other = create(f);
    assert.throws(() => request(f, other, { operationId: requestId }), /operation ID conflict/);
    assert.throws(() => create(f, { arguments: { value: undefined } }), /finite, acyclic JSON/);
    assert.equal(approvalBridgeJSON({ b: 2, a: 1 }), '{"a":1,"b":2}');
  } finally { f.db.close(); }
});

test("original Portal activity capture preserves terminal non-downgrade; historical 71ddd provenance names both roots", async () => {
  const activity = {
    requestId: op(), role: "controlled", peerName: "fixture-peer",
    command: { program: "fixture", arguments: [], timeoutSeconds: 30 }, state: "denied",
  };
  const denied = recordPortalCommand([], activity, new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(recordPortalCommand(denied, { ...activity, state: "running" }), denied);
  const provenance = JSON.parse(readFileSync(new URL("../migration/approval-bridge-provenance.json", import.meta.url), "utf8"));
  assert.deepEqual(provenance.roots, { source: "..", captured: "." });
  assert.match(provenance.qualification, /NEW conservative projection/);
  assert.ok(provenance.files.length >= 4);
  assert.deepEqual(await checkCaptureRecords(provenance.files, undefined, undefined, { dataset: "approval-historical-71ddd" }), []);
});
