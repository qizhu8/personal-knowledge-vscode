import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createAgentRuntime } from "../dist/agent-runtime.js";
import { createAgentRuntimeStore, initializeAgentRuntimeSchema, AGENT_RUNTIME_TABLES } from "../dist/agent-runtime-store.js";
import { agentRuntimeDefinitions, AGENT_RUNTIME_LIMITS } from "../dist/agent-runtime-contracts.js";
import { agentRuntimeHash, validateAgentRuntimeSnapshot } from "../dist/domain/agent-runtime-policy.js";
import {
  fixture, database, syntheticHost, tasks, owner, snapshots, syntheticSnapshot, snapshotDigest,
  spawnArgs, reconnectArgs, transaction,
} from "./agent-runtime-fixtures.mjs";

const code = expected => error => error?.code === expected;
async function publicAgentFixture(t, options = {}) {
  const root = resolve("tests", ".agent-public-" + randomUUID());
  await initialize(root);
  const storage = await Storage.open(root);
  const actor = { id: owner.actorId, canWrite: true };
  const calls = [], sessions = new Map();
  let nativeOwnerId = owner.nativeOwnerId;
  const nativeOptions = {
    storage,
    agents: {
      tasks, snapshots,
      ownerForActor: actorId => ({ actorId, nativeOwnerId }),
      host: {
        async spawn(request) {
          calls.push({ kind: "spawn", id: request.sessionId });
          if (options.unknownSpawn) throw new Error("Ambiguous synthetic spawn");
          const observation = { state: "running", handle: "synthetic:" + request.sessionId };
          sessions.set(request.sessionId, observation);
          return observation;
        },
        async inspect(request) {
          calls.push({ kind: "inspect", id: request.sessionId });
          options.onInspect?.(() => { nativeOwnerId = "changed-native-owner"; });
          return sessions.get(request.sessionId) ?? { state: "unknown" };
        },
        async cancel(request) { calls.push({ kind: "cancel", id: request.sessionId }); },
      },
    },
  };
  let runtime = await createNativeRuntime(nativeOptions);
  t.after(async () => {
    await runtime.close();
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get runtime() { return runtime; }, actor, calls, sessions,
    changeOwner() { nativeOwnerId = "changed-native-owner"; },
    async reopen() {
      await runtime.close();
      runtime = await createNativeRuntime(nativeOptions);
    },
    async call(operation, args, principal = actor, method = "capability_call") {
      return runtime.core.dispatch(method, { operation, version: 1, arguments: args }, principal);
    },
  };
}

test("public Core restores exact host-pinned synthetic trees and reconnects owned handles", async t => {
  const f = await publicAgentFixture(t);
  const spawned = await f.call("agent.runtime.spawn", spawnArgs());
  assert.ok(spawned.result, JSON.stringify(spawned));
  const reconnect = { opId: randomUUID(), id: spawned.result.session.id, expectedRevision: spawned.result.session.revision };
  const connected = await f.call("agent.runtime.reconnect", reconnect);
  const args = { opId: randomUUID(), snapshotId: syntheticSnapshot.snapshotId, digest: snapshotDigest };
  const restored = await f.call("agent.runtime.restore", args);
  assert.ok(connected.result && restored.result, JSON.stringify({ connected, restored }));
  assert.equal(connected.result.id, reconnect.id);
  assert.equal(restored.result.receipt.ids.length, syntheticSnapshot.nodes.length);
  assert.deepEqual(restored.result.session.restoredFrom, { snapshotId: args.snapshotId, digest: args.digest });
  const beforeReplay = f.calls.length;
  const replay = await f.call("agent.runtime.restore", args);
  assert.deepEqual(replay.result, restored.result);
  assert.equal(f.calls.length, beforeReplay);
  const reconnectReplay = await f.call("agent.runtime.reconnect", reconnect);
  assert.equal(reconnectReplay.result.id, reconnect.id);
  assert.equal(f.calls.length, beforeReplay);
});

test("public Agent restore/reconnect preserve actor permission, pins, ownership and exact revision", async t => {
  const f = await publicAgentFixture(t);
  const spawned = await f.call("agent.runtime.spawn", spawnArgs());
  const reconnect = { opId: randomUUID(), id: spawned.result.session.id, expectedRevision: spawned.result.session.revision };
  const restore = { opId: randomUUID(), snapshotId: syntheticSnapshot.snapshotId, digest: snapshotDigest };
  const before = f.calls.length;
  for (const [operation, args] of [["agent.runtime.reconnect", reconnect], ["agent.runtime.restore", restore]]) {
    assert.equal((await f.call(operation, args, { ...f.actor, canWrite: false })).error.code, "ACCESS_DENIED");
    assert.equal((await f.call(operation, args, f.actor, "capability_read")).error.code, "ACCESS_DENIED");
    assert.equal((await f.call(operation, { ...args, ownerToken: {}, actorId: f.actor.id })).error.code, "INVALID_ARGUMENT");
  }
  const foreign = { id: "synthetic-foreign-actor", canWrite: true };
  assert.equal((await f.call("agent.runtime.reconnect", reconnect, foreign)).error.code, "NOT_FOUND");
  assert.equal((await f.call("agent.runtime.restore", restore, foreign)).error.code, "ACCESS_DENIED");
  assert.equal((await f.call("agent.runtime.reconnect", { ...reconnect, expectedRevision: reconnect.expectedRevision - 1 })).error.code, "CONFLICT");
  assert.equal((await f.call("agent.runtime.restore", { ...restore, digest: "0".repeat(64) })).error.code, "ACCESS_DENIED");
  assert.equal((await f.call("agent.runtime.restore", { ...restore, opId: spawned.result.receipt.opId })).error.code, "CONFLICT");
  assert.equal(f.calls.length, before);
  const discovered = await f.runtime.core.dispatch("capabilities_search", { query: "agent.runtime", limit: 20 }, f.actor);
  assert.ok(discovered.result, JSON.stringify(discovered));
  for (const operation of ["agent.runtime.restore", "agent.runtime.reconnect"])
    assert.ok(discovered.result.items.some(item => item.operation === operation));
  const readOnly = await f.runtime.core.dispatch("capabilities_search", { query: "agent.runtime", limit: 20 }, { ...f.actor, canWrite: false });
  assert.ok(readOnly.result.items.every(item => item.readOnly));
  f.changeOwner();
  assert.equal((await f.call("agent.runtime.reconnect", reconnect)).error.code, "NOT_FOUND");
  assert.equal((await f.call("agent.runtime.restore", restore)).error.code, "ACCESS_DENIED");
  assert.equal((await f.call("agent.runtime.spawn", { opId: randomUUID(), taskKey: tasks[1].key,
    parentId: reconnect.id, expectedParentRevision: reconnect.expectedRevision })).error.code, "NOT_FOUND");
  assert.equal(f.calls.length, before);
});

test("public reconnect and native reopen never replay an unknown spawn or restore receipt", async t => {
  const f = await publicAgentFixture(t, { unknownSpawn: true });
  const spawned = await f.call("agent.runtime.spawn", spawnArgs());
  assert.equal(spawned.result.session.state, "spawn-unknown");
  const reconnect = { opId: randomUUID(), id: spawned.result.session.id, expectedRevision: spawned.result.session.revision };
  for (let index = 0; index < 2; index++) {
    const result = await f.call("agent.runtime.reconnect", { ...reconnect, opId: randomUUID() });
    assert.equal(result.result.state, "spawn-unknown");
  }
  const restore = { opId: randomUUID(), snapshotId: syntheticSnapshot.snapshotId, digest: snapshotDigest };
  const restored = await f.call("agent.runtime.restore", restore);
  assert.equal(restored.result.session.state, "spawn-unknown");
  const beforeReplay = f.calls.length;
  assert.equal((await f.call("agent.runtime.restore", restore)).result.session.id, restored.result.session.id);
  assert.equal(f.calls.length, beforeReplay);
  await f.reopen();
  assert.equal(f.calls.length, beforeReplay);
  assert.equal((await f.call("agent.runtime.restore", restore)).result.session.id, restored.result.session.id);
  assert.equal(f.calls.length, beforeReplay);
  const afterRestart = await f.call("agent.runtime.reconnect", { ...reconnect, opId: randomUUID() });
  assert.equal(afterRestart.result.state, "spawn-unknown");
  assert.equal(f.calls.filter(call => call.kind === "spawn" && call.id === reconnect.id).length, 1);
  assert.equal(f.calls.filter(call => call.kind === "inspect").length, 3);
});

test("public reconnect fences a changed native source during host inspection", async t => {
  const f = await publicAgentFixture(t, { onInspect: change => change() });
  const spawned = await f.call("agent.runtime.spawn", spawnArgs());
  const result = await f.call("agent.runtime.reconnect", {
    opId: randomUUID(), id: spawned.result.session.id, expectedRevision: spawned.result.session.revision,
  });
  assert.equal(result.error.code, "ACCESS_DENIED", JSON.stringify(result));
  assert.equal(result.error.effect, "unknown");
  assert.equal(f.calls.filter(call => call.kind === "spawn").length, 1);
  assert.equal((await f.call("agent.runtime.get", { id: spawned.result.session.id }, f.actor, "capability_read")).error.code, "NOT_FOUND");
});

test("schema-only contracts reject identity, prompts, grants, magic codes and completion reports", () => {
  assert.equal(agentRuntimeDefinitions.length, 6);
  for (const extra of [
    { actorId: "foreign" }, { nativeOwnerId: owner.nativeOwnerId }, { prompt: "do anything" },
    { capabilities: ["admin"] }, { state: "completed" }, { ownerToken: {} }, { approvedTotal: 100 },
  ]) assert.equal(agentRuntimeDefinitions[0].input.safeParse({ ...spawnArgs(), ...extra }).success, false);
  assert.equal(agentRuntimeDefinitions[2].input.safeParse({ opId: randomUUID(), magicCode: "PKM-SNAP-FAKE" }).success, false);
  assert.equal(agentRuntimeDefinitions[0].input.safeParse({ ...spawnArgs(), parentId: "agent_session_" + randomUUID() }).success, false);
  assert.equal(agentRuntimeDefinitions.some(item => /complete|submit|report/.test(item.id)), false);
});

test("shared schema initialization and all mutations require parent transactions; rollback includes receipts", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA user_version=271");
  assert.throws(() => initializeAgentRuntimeSchema(db), code("TRANSACTION_REQUIRED"));
  transaction(db, () => initializeAgentRuntimeSchema(db));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 271);
  const store = createAgentRuntimeStore(db, { tasks, snapshots });
  const input = spawnArgs();
  assert.throws(() => store.execute(owner, "spawn", input), code("TRANSACTION_REQUIRED"));
  assert.throws(() => transaction(db, () => {
    store.execute(owner, "spawn", input);
    throw new Error("parent receipt failure");
  }), /parent receipt/);
  assert.equal(store.list(owner).total, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM agent_runtime_receipts").get().n, 0);
  db.exec("BEGIN IMMEDIATE");
  const receipt = store.execute(owner, "spawn", input);
  assert.deepEqual(store.execute(owner, "spawn", input), receipt);
  db.exec("COMMIT");
  assert.equal(store.list(owner).total, 1);
  assert.equal(AGENT_RUNTIME_TABLES.length, 3);
  transaction(db, () => initializeAgentRuntimeSchema(db));
  db.prepare("UPDATE agent_runtime_schema SET version=99").run();
  assert.throws(() => transaction(db, () => initializeAgentRuntimeSchema(db)), code("UNSUPPORTED_SCHEMA"));
  assert.throws(() => store.list(owner), code("UNSUPPORTED_SCHEMA"));
});

test("native token ownership, actor access and no-host fail closed without creating sessions", async t => {
  const f = fixture(); t.after(f.close);
  await assert.rejects(f.runtime.spawn({ ...owner }, spawnArgs()), code("UNAUTHORIZED"));
  await assert.rejects(f.runtime.spawn("synthetic-native-owner", spawnArgs()), code("UNAUTHORIZED"));
  const created = await f.runtime.spawn(f.token, spawnArgs());
  const foreign = f.native.token({ actorId: "another-actor", nativeOwnerId: owner.nativeOwnerId });
  const foreignOwner = f.native.token({ ...owner, nativeOwnerId: "another-owner" });
  for (const token of [foreign, foreignOwner]) {
    assert.throws(() => f.runtime.get(token, { id: created.session.id }), code("NOT_FOUND"));
    assert.equal(f.runtime.list(token).total, 0);
    await assert.rejects(f.runtime.cancel(token, {
      opId: randomUUID(), id: created.session.id, expectedRevision: created.session.revision,
    }), code("NOT_FOUND"));
    await assert.rejects(f.runtime.spawn(token, spawnArgs("synthetic.reader", created.session)), code("NOT_FOUND"));
    assert.throws(() => f.runtime.list(token, { treeId: created.session.id }), code("NOT_FOUND"));
  }
  const unavailable = createAgentRuntime(f.db, { tasks });
  await assert.rejects(unavailable.spawn(f.token, spawnArgs()), code("HOST_UNAVAILABLE"));
  assert.equal(f.runtime.list(f.token).total, 1);
});

test("spawn commits before host, exact receipts replay, parent-child CAS and policy narrowing", async t => {
  const f = fixture(); t.after(f.close);
  const input = spawnArgs();
  const root = await f.runtime.spawn(f.token, input);
  assert.equal(root.session.state, "running");
  assert.equal(root.session.revision, 3);
  const replay = await f.runtime.spawn(f.token, { taskKey: input.taskKey, opId: input.opId });
  assert.deepEqual(replay, root);
  assert.equal(f.native.calls.filter(call => call.kind === "spawn").length, 1);
  await assert.rejects(f.runtime.spawn(f.token, { ...input, taskKey: "synthetic.reader" }), code("OPERATION_CONFLICT"));
  const childInput = spawnArgs("synthetic.reader", root.session);
  const child = await f.runtime.spawn(f.token, childInput);
  assert.equal(child.session.parentId, root.session.id);
  assert.equal(child.session.treeId, root.session.id);
  assert.equal(child.session.groupId, root.session.groupId);
  assert.equal(child.session.depth, 1);
  assert.equal(f.runtime.get(f.token, { id: root.session.id }).revision, 4);
  await assert.rejects(f.runtime.spawn(f.token, spawnArgs("synthetic.reader", root.session)), code("REVISION_CONFLICT"));
  await assert.rejects(f.runtime.spawn(f.token, spawnArgs("synthetic.writer", child.session)), code("POLICY_DENIED"));
  await assert.rejects(f.runtime.spawn(f.token, spawnArgs("unconfigured.task")), code("POLICY_DENIED"));
  assert.equal(f.runtime.list(f.token).total, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_runtime_receipts").get().n, 2);
  const grandchild = await f.runtime.spawn(f.token, spawnArgs("synthetic.reader", child.session));
  assert.equal(grandchild.session.depth, 2);
  assert.equal(f.runtime.list(f.token, { treeId: root.session.id, limit: 1 }).items.length, 1);
  assert.equal(f.runtime.list(f.token, { treeId: root.session.id, offset: 1 }).items[0].id, child.session.id);
  assert.equal("handle" in child.session, false);
  assert.equal("actorId" in child.session, false);
});

test("concurrent child reservations use parent CAS and leave no partial receipt", async t => {
  const f = fixture(); t.after(f.close);
  const { session: root } = await f.runtime.spawn(f.token, spawnArgs());
  const result = await Promise.allSettled([
    f.runtime.spawn(f.token, spawnArgs("synthetic.reader", root)),
    f.runtime.spawn(f.token, spawnArgs("synthetic.reader", root)),
  ]);
  assert.equal(result.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(result.find(item => item.status === "rejected").reason.code, "REVISION_CONFLICT");
  assert.equal(f.runtime.list(f.token).total, 2);
});

test("cancel is durable subtree intent, children-first, actor scoped and terminal host confirmed", async t => {
  const f = fixture(); t.after(f.close);
  const { session: root } = await f.runtime.spawn(f.token, spawnArgs());
  const { session: child } = await f.runtime.spawn(f.token, spawnArgs("synthetic.reader", root));
  const { session: nested } = await f.runtime.spawn(f.token, spawnArgs("synthetic.reader", child));
  const other = await f.runtime.spawn(f.token, spawnArgs());
  const current = f.runtime.get(f.token, { id: root.id });
  await assert.rejects(f.runtime.cancel(f.token, { opId: randomUUID(), id: root.id, expectedRevision: 1 }), code("REVISION_CONFLICT"));
  const input = { opId: randomUUID(), id: root.id, expectedRevision: current.revision };
  const result = await f.runtime.cancel(f.token, input);
  assert.equal(result.session.state, "cancelled");
  assert.equal(f.runtime.get(f.token, { id: child.id }).state, "cancelled");
  assert.equal(f.runtime.get(f.token, { id: nested.id }).state, "cancelled");
  assert.equal(f.runtime.get(f.token, { id: other.session.id }).state, "running");
  assert.deepEqual(f.native.calls.filter(call => call.kind === "cancel").map(call => call.id), [nested.id, child.id, root.id]);
  assert.deepEqual((await f.runtime.cancel(f.token, input)).receipt, result.receipt);
  await assert.rejects(f.runtime.spawn(f.token, spawnArgs("synthetic.reader", result.session)), code("PARENT_INACTIVE"));
});

test("native-only reconnect observes completion without trusting request completion fields", async t => {
  const f = fixture(); t.after(f.close);
  const { session } = await f.runtime.spawn(f.token, spawnArgs());
  await assert.rejects(f.runtime.reconnect(f.token, { ...reconnectArgs(session), state: "completed" }), code("INVALID_INPUT"));
  f.native.sessions.get(session.id).state = "completed";
  const completed = await f.runtime.reconnect(f.token, reconnectArgs(session));
  assert.equal(completed.state, "completed");
  await assert.rejects(f.runtime.reconnect(f.token, reconnectArgs(session)), code("REVISION_CONFLICT"));
  f.native.sessions.get(session.id).state = "running";
  assert.deepEqual(await f.runtime.reconnect(f.token, reconnectArgs(completed)), completed);
  assert.equal(f.native.calls.filter(call => call.kind === "spawn").length, 1);
});

test("public results match their exact schema contracts; reconnect has replayable CAS receipts", async t => {
  const f = fixture(); t.after(f.close);
  const spawned = await f.runtime.spawn(f.token, spawnArgs());
  assert.deepEqual(agentRuntimeDefinitions[0].output.parse(spawned), spawned);
  assert.deepEqual(agentRuntimeDefinitions[3].output.parse(f.runtime.get(f.token, { id: spawned.session.id })), spawned.session);
  const listing = f.runtime.list(f.token);
  assert.deepEqual(agentRuntimeDefinitions[4].output.parse(listing), listing);
  const args = reconnectArgs(spawned.session);
  const reconnected = await f.runtime.reconnect(f.token, args);
  assert.deepEqual(agentRuntimeDefinitions[5].output.parse(reconnected), reconnected);
  const receiptCount = f.db.prepare("SELECT count(*) AS n FROM agent_runtime_receipts").get().n;
  await f.runtime.reconnect(f.token, args);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_runtime_receipts").get().n, receiptCount);
  await assert.rejects(f.runtime.reconnect(f.token, { ...args, expectedRevision: reconnected.revision }), code("OPERATION_CONFLICT"));
  const cancelled = await f.runtime.cancel(f.token, {
    opId: randomUUID(), id: spawned.session.id, expectedRevision: f.runtime.get(f.token, { id: spawned.session.id }).revision,
  });
  assert.deepEqual(agentRuntimeDefinitions[1].output.parse(cancelled), cancelled);
  const restored = await f.runtime.restore(f.token, {
    opId: randomUUID(), snapshotId: syntheticSnapshot.snapshotId, digest: snapshotDigest,
  });
  assert.deepEqual(agentRuntimeDefinitions[2].output.parse(restored), restored);
});

test("host exceptions and missing lookup remain unknown; reconnect never duplicates spawn", async t => {
  const f = fixture(); t.after(f.close);
  const original = f.native.host.spawn;
  f.native.host.spawn = async invocation => {
    await original(invocation);
    throw new Error("response lost after native effect");
  };
  const input = spawnArgs();
  const { session } = await f.runtime.spawn(f.token, input);
  assert.equal(session.state, "spawn-unknown");
  assert.equal((await f.runtime.spawn(f.token, input)).session.state, "spawn-unknown");
  const known = await f.runtime.reconnect(f.token, reconnectArgs(session));
  assert.equal(known.state, "running");
  f.native.host.spawn = async () => { throw new Error("dispatch outcome cannot be proven"); };
  const unknown = await f.runtime.spawn(f.token, spawnArgs());
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.runtime.reconnect(f.token, reconnectArgs(unknown.session))).state, "spawn-unknown");
  }
  assert.equal(f.native.calls.filter(call => call.kind === "spawn").length, 1);
});

test("cancellation during unresolved spawn cannot revive it; reconnect cancels by committed intent identity", async t => {
  const f = fixture(); t.after(f.close);
  const original = f.native.host.spawn;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.native.host.spawn = async invocation => { const result = await original(invocation); await gate; return result; };
  const pending = f.runtime.spawn(f.token, spawnArgs());
  const record = f.runtime.list(f.token).items[0];
  assert.equal(record.state, "spawn-unknown");
  const cancelled = await f.runtime.cancel(f.token, { opId: randomUUID(), id: record.id, expectedRevision: record.revision });
  assert.equal(cancelled.session.state, "cancelled");
  release();
  assert.equal((await pending).session.state, "cancelled");
  assert.equal(f.native.calls.filter(call => call.kind === "spawn").length, 1);
});

test("failed cancel remains requested, confirmed cancellation can be retried after reconnect", async t => {
  const f = fixture(); t.after(f.close);
  const { session } = await f.runtime.spawn(f.token, spawnArgs());
  const original = f.native.host.cancel;
  f.native.host.cancel = async () => { throw new Error("native host unavailable"); };
  const result = await f.runtime.cancel(f.token, { opId: randomUUID(), id: session.id, expectedRevision: session.revision });
  assert.equal(result.session.state, "cancel-requested");
  f.native.host.cancel = original;
  assert.equal((await f.runtime.reconnect(f.token, reconnectArgs(result.session))).state, "cancelled");
});

test("pinned synthetic restore makes fresh identities, preserves hierarchy and never accepts arbitrary payload or magic-code authority", async t => {
  const f = fixture(); t.after(f.close);
  const input = { opId: randomUUID(), snapshotId: syntheticSnapshot.snapshotId, digest: snapshotDigest };
  const original = JSON.stringify(syntheticSnapshot);
  const result = await f.runtime.restore(f.token, input);
  assert.equal(result.receipt.ids.length, 3);
  assert.equal(f.runtime.list(f.token).items.every(record => record.state === "running"), true);
  const records = f.runtime.list(f.token).items;
  assert.equal(records[1].parentId, records[0].id);
  assert.equal(records[2].parentId, records[1].id);
  assert.equal(records.every(record => record.restoredFrom.digest === snapshotDigest), true);
  assert.equal(records.every(record => !syntheticSnapshot.nodes.some(node => node.sourceId === record.id)), true);
  assert.equal(JSON.stringify(syntheticSnapshot), original);
  assert.deepEqual((await f.runtime.restore(f.token, input)).receipt, result.receipt);
  assert.equal(f.native.calls.filter(call => call.kind === "spawn").length, 3);
  const another = await f.runtime.restore(f.token, { ...input, opId: randomUUID() });
  assert.notEqual(another.session.id, result.session.id);
  await assert.rejects(f.runtime.restore(f.token, { ...input, opId: randomUUID(), digest: "0".repeat(64) }), code("SNAPSHOT_DENIED"));
  await assert.rejects(f.runtime.restore(f.native.token({ ...owner, actorId: "foreign" }), { ...input, opId: randomUUID() }), code("SNAPSHOT_DENIED"));
  await assert.rejects(f.runtime.restore(f.token, { ...input, snapshot: syntheticSnapshot }), code("INVALID_INPUT"));
});

test("invalid/cyclic/foreign synthetic trees and privilege expansion reject atomically", async t => {
  const f = fixture(); t.after(f.close);
  for (const nodes of [
    [{ sourceId: "a", parentSourceId: "a", taskKey: "synthetic.reader" }],
    [{ sourceId: "a", parentSourceId: null, taskKey: "synthetic.reader" }, { sourceId: "a", parentSourceId: "a", taskKey: "synthetic.reader" }],
    [{ sourceId: "a", parentSourceId: null, taskKey: "synthetic.reader" }, { sourceId: "b", parentSourceId: "missing", taskKey: "synthetic.reader" }],
    [{ sourceId: "a", parentSourceId: null, taskKey: "synthetic.reader" }, { sourceId: "b", parentSourceId: null, taskKey: "synthetic.reader" }],
  ]) assert.throws(() => validateAgentRuntimeSnapshot({ ...syntheticSnapshot, nodes }), code("INVALID_TREE"));
  assert.throws(() => validateAgentRuntimeSnapshot({ ...syntheticSnapshot, synthetic: false }), code("INVALID_SNAPSHOT"));
  assert.throws(() => validateAgentRuntimeSnapshot({ ...syntheticSnapshot, prompts: ["untrusted"] }), code("INVALID_SNAPSHOT"));
  const snapshot = { ...syntheticSnapshot, nodes: [
    { sourceId: "root", parentSourceId: null, taskKey: "synthetic.reader" },
    { sourceId: "bad", parentSourceId: "root", taskKey: "synthetic.writer" },
  ] };
  const digest = agentRuntimeHash(snapshot);
  const runtime = createAgentRuntime(f.db, { tasks, host: f.native.host, snapshots: [{ ...owner, digest, snapshot }] });
  await assert.rejects(runtime.restore(f.token, { opId: randomUUID(), snapshotId: snapshot.snapshotId, digest }), code("POLICY_DENIED"));
  assert.equal(f.runtime.list(f.token).total, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_runtime_receipts").get().n, 0);
  assert.equal(f.native.calls.length, 0);
});

test("hard depth/fanout/bytes bounds, rejected attempts make no host calls", async t => {
  const f = fixture(); t.after(f.close);
  const { session: root } = await f.runtime.spawn(f.token, spawnArgs());
  for (let i = 0; i < AGENT_RUNTIME_LIMITS.fanout; i++) {
    const parent = f.runtime.get(f.token, { id: root.id });
    await f.runtime.spawn(f.token, spawnArgs("synthetic.reader", parent));
  }
  const count = f.native.calls.length;
  await assert.rejects(f.runtime.spawn(f.token, spawnArgs("synthetic.reader", f.runtime.get(f.token, { id: root.id }))), code("LIMIT_EXCEEDED"));
  assert.equal(f.native.calls.length, count);
  let deep = (await f.runtime.spawn(f.token, spawnArgs())).session;
  for (let i = 0; i < AGENT_RUNTIME_LIMITS.depth; i++) deep = (await f.runtime.spawn(f.token, spawnArgs("synthetic.reader", deep))).session;
  await assert.rejects(f.runtime.spawn(f.token, spawnArgs("synthetic.reader", deep)), code("LIMIT_EXCEEDED"));
  await assert.rejects(f.runtime.spawn(f.token, { ...spawnArgs(), prompt: "x".repeat(8193) }), code("LIMIT_EXCEEDED"));
  assert.throws(() => f.runtime.list(f.token, { limit: 101 }), code("INVALID_INPUT"));
  assert.throws(() => validateAgentRuntimeSnapshot({ ...syntheticSnapshot, extra: "x".repeat(65537) }), code("LIMIT_EXCEEDED"));
});

test("tree-node history, actor-session and receipt capacities cannot be bypassed by terminal or alternate-owner records", t => {
  const db = database(); t.after(() => db.close());
  const nodes = Array.from({ length: 64 }, (_, index) => ({
    sourceId: "node-" + index, parentSourceId: index ? "node-" + Math.floor((index - 1) / 8) : null,
    taskKey: "synthetic.manager",
  }));
  const snapshot = { ...syntheticSnapshot, nodes };
  const digest = agentRuntimeHash(snapshot);
  const store = createAgentRuntimeStore(db, { tasks, snapshots: [{ ...owner, digest, snapshot }] });
  const restored = transaction(db, () => store.execute(owner, "restore", { opId: randomUUID(), snapshotId: snapshot.snapshotId, digest }));
  const last = store.get(owner, restored.ids.at(-1));
  assert.throws(() => transaction(db, () => store.execute(owner, "spawn", spawnArgs("synthetic.reader", last))), code("LIMIT_EXCEEDED"));
  assert.equal(store.list(owner, { limit: 100 }).total, 64);
  transaction(db, () => {
    for (let index = 64; index < AGENT_RUNTIME_LIMITS.sessionsPerActor; index++) store.execute(owner, "spawn", spawnArgs());
  });
  const alternateOwner = { ...owner, nativeOwnerId: "synthetic-another-owner" };
  assert.throws(() => transaction(db, () => store.execute(alternateOwner, "spawn", spawnArgs())), code("LIMIT_EXCEEDED"));
  assert.equal(store.list(owner).total, 256);
  const existing = db.prepare("SELECT record FROM agent_runtime_receipts LIMIT 1").get().record;
  transaction(db, () => {
    const insert = db.prepare("INSERT INTO agent_runtime_receipts VALUES(?,?,?,?,?)");
    const count = Number(db.prepare("SELECT count(*) AS n FROM agent_runtime_receipts WHERE actor_id=?").get(owner.actorId).n);
    for (let index = count; index < AGENT_RUNTIME_LIMITS.receiptsPerActor; index++) {
      insert.run(owner.actorId, "synthetic-capacity-owner", randomUUID(), "0".repeat(64), existing);
    }
  });
  const record = store.get(owner, restored.rootId);
  assert.throws(() => transaction(db, () => store.execute(owner, "cancel", {
    opId: randomUUID(), id: record.id, expectedRevision: record.revision,
  })), code("LIMIT_EXCEEDED"));
  assert.equal(store.get(owner, record.id).state, "intent");
  assert.equal(db.prepare("SELECT count(*) AS n FROM agent_runtime_receipts").get().n, 4096);
});

test("changed configured policy prevents pending dispatch, invalid host output cannot forge durable state", async t => {
  const f = fixture(); t.after(f.close);
  const store = createAgentRuntimeStore(f.db, { tasks });
  const receipt = transaction(f.db, () => store.execute(owner, "spawn", spawnArgs()));
  const runtime = createAgentRuntime(f.db, { tasks: [{ ...tasks[0], capabilities: [] }], host: f.native.host });
  await assert.rejects(runtime.reconnect(f.token, reconnectArgs(store.get(owner, receipt.rootId))), code("POLICY_CHANGED"));
  assert.equal(f.native.calls.length, 0);
  f.native.host.spawn = async () => ({ state: "completed", handle: "synthetic-handle", grant: "admin" });
  await assert.rejects(f.runtime.reconnect(f.token, reconnectArgs(store.get(owner, receipt.rootId))), code("HOST_PROTOCOL"));
  assert.equal(store.get(owner, receipt.rootId).state, "spawn-unknown");
});

test("host handle cannot be rebound and schema corruption is not silently discarded", async t => {
  const f = fixture(); t.after(f.close);
  const { session } = await f.runtime.spawn(f.token, spawnArgs());
  f.native.host.inspect = async () => ({ state: "completed", handle: "foreign-handle" });
  await assert.rejects(f.runtime.reconnect(f.token, reconnectArgs(session)), code("HOST_PROTOCOL"));
  assert.equal(f.runtime.get(f.token, { id: session.id }).state, "running");
  f.db.prepare("UPDATE agent_runtime_sessions SET revision=999 WHERE id=?").run(session.id);
  assert.throws(() => f.runtime.get(f.token, { id: session.id }), code("STATE_CORRUPT"));
});

test("coordinator rejects caller transactions and never invokes host from them", async t => {
  const f = fixture(); t.after(f.close);
  f.db.exec("BEGIN IMMEDIATE");
  await assert.rejects(f.runtime.spawn(f.token, spawnArgs()), code("TRANSACTION_BOUNDARY"));
  f.db.exec("ROLLBACK");
  assert.equal(f.native.calls.length, 0);
});

test("real SQLite restart after claimed intent never replays crash-unknown effects; unclaimed intents may dispatch once", async t => {
  const directory = resolve("tests", ".agent-runtime-" + randomUUID());
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, "synthetic.sqlite");
  const child = spawnSync(process.execPath, ["tests/agent-runtime-child.mjs", path], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const { claimedId, pendingId, input, receipt } = JSON.parse(child.stdout);
  let db = database(path);
  let native = syntheticHost(db);
  let runtime = createAgentRuntime(db, { tasks, host: native.host });
  let token = native.token();
  assert.equal(runtime.list(token).total, 2);
  const current = runtime.get(token, { id: claimedId });
  assert.equal(current.state, "spawn-unknown");
  assert.equal((await runtime.reconnect(token, reconnectArgs(current))).state, "spawn-unknown");
  assert.deepEqual((await runtime.spawn(token, input)).receipt, receipt);
  assert.equal(native.calls.filter(call => call.kind === "spawn").length, 0);
  const pending = runtime.get(token, { id: pendingId });
  assert.equal((await runtime.reconnect(token, reconnectArgs(pending))).state, "running");
  const cancelled = await runtime.cancel(token, { opId: randomUUID(), id: claimedId, expectedRevision: current.revision });
  assert.equal(cancelled.session.state, "cancel-requested", "unknown host outcome is not claimed cancelled");
  db.close();
  db = database(path);
  native = syntheticHost(db);
  runtime = createAgentRuntime(db, { tasks, host: native.host });
  token = native.token();
  const durable = runtime.get(token, { id: claimedId });
  assert.equal(durable.state, "cancel-requested");
  await runtime.reconnect(token, reconnectArgs(durable));
  assert.equal(native.calls.filter(call => call.kind === "spawn").length, 0);
  db.close();
});
