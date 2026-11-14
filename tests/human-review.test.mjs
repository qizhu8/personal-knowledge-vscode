import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { createHumanReviewQueue, presentNativeHumanReview, humanReviewDetail } from "../dist/human-review.js";
import { createApprovalBridge } from "../dist/approval-bridge.js";
import { executionReview, memoryReview } from "./human-review-fixtures.mjs";
import nativeMemoryEvidence from "./approval-bridge-original-explicit-memory-tools.mjs";

function storage(db) {
  return { read: fn => fn(db), transaction(fn) {
    assert.equal(db.isTransaction, false); db.exec("BEGIN IMMEDIATE");
    try { const result = fn(db); assert.equal(typeof result?.then, "undefined"); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
}
function fixture(overrides = {}, db = new DatabaseSync(":memory:")) {
  const evidence = Object.freeze({ native: randomUUID() });
  const queue = createHumanReviewQueue({
    workspaceId: "synthetic-workspace", storage: storage(db),
    authenticateHuman: value => value === evidence ? { actorId: "alice", workspaceId: "synthetic-workspace",
      readOnly: false, authorities: ["approval", "memory"] } : null,
    validateCurrent: () => { assert.equal(db.isTransaction, false); return true; },
    ...overrides,
  });
  return { ...queue, db, evidence, async session() { return queue.native.openSession(evidence); },
    close() { queue.native.shutdown(); db.close(); } };
}
function pin(entry, decision = "approve") {
  return { id: entry.id, expectedRevision: entry.revision, intentDigest: entry.intentDigest, decision };
}

test("actual durable ApprovalBridgeReviewer waits outside transaction for explicit native modal choice", async () => {
  const f = fixture();
  const bridge = createApprovalBridge({ workspaceId: "synthetic-workspace", storage: storage(f.db), reviewer: f.native.reviewer });
  try {
    const execution = bridge.native.create("alice", { tool: "fixture.document.edit", arguments: { documentId: "synthetic-document" },
      approvalRequired: true, operationId: randomUUID(), context: { turnId: "turn", contextDigest: "a".repeat(64), readOnly: false } });
    const approval = bridge.public.request("alice", { executionId: execution.id, expectedRevision: 1, operationId: randomUUID() });
    const waiting = bridge.native.review("alice", approval.id), cap = await f.session();
    const entry = f.handlers.read(cap, {}).entries[0];
    assert.ok(Object.isFrozen(entry.intent.request.record.arguments));
    await presentNativeHumanReview(f, cap, entry.id, async (title, options, ...choices) => {
      assert.equal(f.db.isTransaction, false); assert.equal(options.modal, true);
      assert.match(options.detail, /documentId/); assert.match(options.detail, /Record pin:/);
      assert.deepEqual(choices, ["Approve exact record", "Reject", "Cancel"]);
      return choices[0];
    });
    assert.equal((await waiting).status, "approved");
    assert.throws(() => f.handlers.decide(cap, pin(entry)), /stale/);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM human_review_events").get().n, 2);
  } finally { f.close(); }
});

test("missing native authentication/recheck is unavailable, never allow-all", async () => {
  for (const overrides of [{ authenticateHuman: undefined }, { validateCurrent: undefined }]) {
    const f = fixture(overrides);
    try { await assert.rejects(f.native.reviewer(executionReview()), /unavailable/); }
    finally { f.close(); }
  }
});

test("machine bearer, forged object, copied capability, wrong actor/workspace and read-only actor cannot decide", async () => {
  const f = fixture();
  try {
    const pending = f.native.reviewer(executionReview()), cap = await f.session(), entry = f.handlers.read(cap, {}).entries[0];
    for (const fake of ["owner-bearer", { bearer: "owner", actorId: "alice" }, {}, structuredClone(cap)]) {
      assert.throws(() => f.handlers.read(fake, {}), /session/);
      assert.throws(() => f.handlers.decide(fake, pin(entry)), /session/);
    }
    await assert.rejects(f.native.openSession("owner-bearer"), /authentication/);
    f.native.cancel(entry.id); assert.equal(await pending, null);
    for (const identity of [{ actorId: "bob" }, { workspaceId: "wrong" }, { readOnly: true }]) {
      const g = fixture({ authenticateHuman: () => ({ actorId: "alice", workspaceId: "synthetic-workspace",
        authorities: ["approval"], readOnly: false, ...identity }) });
      try {
        if (identity.actorId) {
          const task = g.native.reviewer(executionReview()), other = await g.session();
          assert.deepEqual(g.handlers.read(other, {}).entries, []);
          const row = g.db.prepare("SELECT id,intent_digest FROM human_review_queue").get();
          assert.throws(() => g.handlers.decide(other, { id: row.id, expectedRevision: 1, intentDigest: row.intent_digest, decision: "approve" }), /unavailable/);
          g.native.cancel(row.id); await task;
        } else await assert.rejects(g.session(), /session/);
      } finally { g.close(); }
    }
  } finally { f.close(); }
});

test("stale source/current record and replayed intent/operation pins never return approval", async () => {
  let valid = true;
  const f = fixture({ validateCurrent: () => valid });
  try {
    const review = executionReview(), pending = f.native.reviewer(review), cap = await f.session(), entry = f.handlers.read(cap, {}).entries[0];
    assert.throws(() => f.handlers.decide(cap, { ...pin(entry), intentDigest: "f".repeat(64) }), /stale/);
    assert.throws(() => f.handlers.decide(cap, { ...pin(entry), expectedRevision: 2 }), /stale/);
    valid = false; assert.equal(f.handlers.decide(cap, pin(entry)).status, "stale");
    assert.equal(await pending, null); valid = true;
    assert.equal(await f.native.reviewer(review), null);
    const changed = structuredClone(review); changed.record.arguments.documentId = "changed";
    await assert.rejects(f.native.reviewer(changed), /pins/);
  } finally { f.close(); }
});

test("explicit reject, cancellation signal, queue cancellation, expiry and shutdown all settle without proof", async () => {
  for (const action of ["reject", "cancel", "signal", "shutdown", "expiry"]) {
    const f = fixture({ leaseMs: action === "expiry" ? 20 : 1000 });
    try {
      const signal = new AbortController(), pending = f.native.reviewerWithSignal(executionReview(), signal.signal);
      const cap = await f.session(), entry = f.handlers.read(cap, {}).entries[0];
      if (action === "reject" || action === "cancel") f.handlers.decide(cap, pin(entry, action));
      if (action === "signal") signal.abort();
      if (action === "shutdown") f.native.shutdown();
      const result = await pending;
      if (action === "reject") assert.equal(result.decision, "reject"); else assert.equal(result, null);
      const status = f.db.prepare("SELECT status FROM human_review_queue").get().status;
      assert.equal(status, { reject: "rejected", cancel: "cancelled", signal: "cancelled", shutdown: "unknown", expiry: "expired" }[action]);
    } finally { f.close(); }
  }
});

test("persistent shared DB restart marks unknown and does not reuse a reviewed record", async () => {
  const directory = new URL(`./.human-review-${randomUUID()}/`, import.meta.url);
  mkdirSync(directory);
  const path = new URL("shared.sqlite", directory);
  let f = fixture({}, new DatabaseSync(path)), g;
  try {
    const review = executionReview(), waiting = f.native.reviewer(review), cap = await f.session(), entry = f.handlers.read(cap, {}).entries[0];
    g = fixture({}, new DatabaseSync(path));
    assert.equal(g.db.prepare("SELECT status FROM human_review_queue").get().status, "unknown");
    assert.equal(await g.native.reviewer(review), null);
    assert.throws(() => f.handlers.decide(cap, pin(entry)), /stale/);
    f.native.shutdown(); assert.equal(await waiting, null);
  } finally { f.close(); g?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("separate exact memory confirm/revise/revoke displays actual source and replacement pins", async () => {
  for (const operation of ["memory.record.confirm", "memory.record.revise", "memory.record.revoke"]) {
    const f = fixture();
    try {
      const request = memoryReview(operation), pending = f.native.memoryAuthorizerFor("alice")(request);
      const cap = await f.session(), entry = f.handlers.read(cap, {}).entries[0], detail = humanReviewDetail(entry.intent);
      assert.equal(entry.authority, "memory"); assert.match(detail, /Source ID: synthetic-source/);
      assert.match(detail, /Revision: 7/); assert.match(detail, /Document pin: b{64}/);
      if (operation.endsWith("revise")) { assert.match(detail, /Replacement sourced fact/); assert.match(detail, /Revision: 8/); }
      f.handlers.decide(cap, pin(entry)); assert.equal((await pending).actorId, "alice");
      assert.equal(await f.native.memoryAuthorizerFor("alice")(request), null);
      await assert.rejects(Promise.resolve().then(() => f.native.memoryAuthorizer(request)), /binding/);
    } finally { f.close(); }
  }
});

test("memory authority cannot approve execution, and generic execution cannot authorize memory decisions", async () => {
  const f = fixture({ authenticateHuman: () => ({ actorId: "alice", workspaceId: "synthetic-workspace", readOnly: false, authorities: ["memory"] }) });
  try {
    const pending = f.native.reviewer(executionReview()), cap = await f.session();
    assert.deepEqual(f.handlers.read(cap, {}).entries, []);
    const value = f.db.prepare("SELECT * FROM human_review_queue").get();
    assert.throws(() => f.handlers.decide(cap, { id: value.id, expectedRevision: 1, intentDigest: value.intent_digest, decision: "approve" }), /unavailable/);
    f.native.cancel(value.id); await pending;
    await assert.rejects(f.native.reviewer(executionReview({ tool: "memory.record.confirm" })), /pins/);
  } finally { f.close(); }
});

test("credential-bearing arguments are refused before persistence and events contain no content", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.native.reviewer(executionReview({ arguments: { nested: { api_key: "synthetic-secret" } } })), /Credential/);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM human_review_queue").get().n, 0);
    const pending = f.native.reviewer(executionReview()), cap = await f.session(), entry = f.handlers.read(cap, {}).entries[0];
    f.handlers.decide(cap, pin(entry, "cancel")); await pending;
    assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM human_review_events").all()).includes("onerror"));
  } finally { f.close(); }
});

test("synthetic loopback machine HTTP bearer cannot forge a human button/session", async () => {
  const f = fixture(), server = createServer((request, response) => {
    try {
      f.handlers.read({ authorization: request.headers.authorization }, {});
      response.writeHead(200).end("unexpected");
    } catch { response.writeHead(403).end("Native human session unavailable."); }
  });

  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const pending = f.native.reviewer(executionReview());
    const response = await fetch(`http://127.0.0.1:${server.address().port}/review/decide`, {
      method: "POST", headers: { authorization: "Bearer synthetic-owner" },
      body: JSON.stringify({ decision: "approve", trustedUserButton: true }),
    });
    assert.equal(response.status, 403);
    const entry = f.handlers.read(await f.session(), {}).entries[0];
    f.native.cancel(entry.id); assert.equal(await pending, null);
  } finally { await new Promise(resolve => server.close(resolve)); f.close(); }
});

test("native session expiry/close and cancellation immediately after human approval cannot mint a proof", async () => {
  const f = fixture({ leaseMs: 20 });
  try {
    const cap = await f.session();
    f.native.closeSession(cap); assert.throws(() => f.handlers.read(cap, {}), /session/);
    const next = await f.session();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.throws(() => f.handlers.read(next, {}), /session/);
  } finally { f.close(); }
  const g = fixture();
  try {
    const controller = new AbortController(), waiting = g.native.reviewerWithSignal(executionReview(), controller.signal);
    const cap = await g.session(), entry = g.handlers.read(cap, {}).entries[0];
    g.handlers.decide(cap, pin(entry)); controller.abort();
    assert.equal(await waiting, null);
  } finally { g.close(); }
});

test("memory source-pin changes and cancelled native modal are rejected without a generic grant", async () => {
  let sourceRevision = "7";
  const f = fixture({ validateCurrent: intent => intent.authority === "memory"
    && intent.request.record.sources[0].revision === sourceRevision });
  try {
    const pending = f.native.memoryAuthorizerFor("alice")(memoryReview());
    const cap = await f.session(), entry = f.handlers.read(cap, {}).entries[0];
    sourceRevision = "8";
    assert.equal(f.handlers.decide(cap, pin(entry)).status, "stale");
    assert.equal(await pending, null);
  } finally { f.close(); }
  const g = fixture();
  try {
    const pending = g.native.reviewer(executionReview()), cap = await g.session(), entry = g.handlers.read(cap, {}).entries[0];
    assert.equal((await presentNativeHumanReview(g, cap, entry.id, async () => undefined)).status, "cancelled");
    assert.equal(await pending, null);
  } finally { g.close(); }
});

test("memory UI detail retains source-grounded native exact-revision/effect vocabulary", () => {
  const evidence = nativeMemoryEvidence.find(value => value.name === "formatExplicitMemoryDecision").source;
  assert.match(evidence, /Expected revision:/);
  assert.match(evidence, /prior confirmation does not carry forward/);
  assert.match(evidence, /future active Memory search/);
  const detail = humanReviewDetail({ authority: "memory", workspaceId: "synthetic-workspace",
    actorId: "alice", operationId: "synthetic-operation", request: memoryReview("memory.record.revise") });
  assert.match(detail, /revision 1/); assert.match(detail, /prior confirmation does not carry forward/);
  assert.match(detail, /Current source pins:/); assert.match(detail, /Replacement source pins:/);
});
