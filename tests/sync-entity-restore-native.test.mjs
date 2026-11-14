import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { httpCall, invocation, nativeWorkspace } from "./batch06-manager-fixtures.mjs";
import { restoreActor, restoreFixture, writeLocal } from "./sync-entity-restore-fixtures.mjs";

async function remoteDecision(f, url, fixture) {
  const create = await httpCall(url, f.bearer, "capability_call", invocation("sync.plan.create", {
    sessionId: fixture.sessionId, operationId: randomUUID(), input: fixture.input,
  }));
  assert.equal(create.status, 200, JSON.stringify(create.body));
  const decision = await httpCall(url, f.bearer, "capability_call", invocation("sync.plan.decide", {
    sessionId: fixture.sessionId, operationId: randomUUID(), expectedRevision: create.body.result.revision,
    conflictId: create.body.result.plan.conflicts[0].id, choice: "remote",
    reason: "Restore the full synthetic entity, including its dependency and attachment.",
  }));
  assert.equal(decision.status, 200, JSON.stringify(decision.body));
  return { sessionId: fixture.sessionId, input: fixture.input };
}
async function preview(f, url, args) {
  return httpCall(url, f.bearer, "capability_read", invocation("sync.apply.preview", args));
}
function assertRemote(root, fixture) {
  for (const file of fixture.remote) assert.deepEqual(fs.readFileSync(join(root, file.path)), Buffer.from(file.contentBase64, "base64"));
}
async function mcp(t, root, actorId) {
  const client = new Client({ name: "sync-entity-offline", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, "native-runtime-mcp-child.mjs"), root, actorId, join(root, "unused-synthetic-provider-counter")],
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", chunk => { diagnostics += chunk.toString(); });
  t.after(() => client.close());
  try { await client.connect(transport); }
  catch (error) { throw new Error(`Synthetic native MCP failed: ${diagnostics}`, { cause: error }); }
  return {
    async call(method, operation, args) {
      const result = await client.callTool({ name: method, arguments: invocation(operation, args) });
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    },
    close: () => client.close(),
  };
}

test("native Core HTTP rejects incomplete remote entity before writes and cannot accept caller JSON authority", async t => {
  const fixture = restoreFixture({ missingMember: true });
  const f = await nativeWorkspace(t);
  const url = await f.listen(restoreActor);
  const args = await remoteDecision(f, url, fixture);
  assert.equal((await preview(f, url, args)).body.error.code, "CONFLICT");
  const rejected = await httpCall(url, f.bearer, "capability_call", invocation("sync.apply", {
    ...args, operationId: randomUUID(), expectedPlanHash: "a".repeat(64),
  }));
  assert.equal(rejected.body.error.code, "CONFLICT");
  assert.equal(fs.existsSync(join(f.root, "skills", "synthetic-restore")), false);
  const forged = await httpCall(url, f.bearer, "capability_read", invocation("sync.apply.preview", {
    ...args, actorId: restoreActor.id,
  }));
  assert.equal(forged.body.error.code, "INVALID_ARGUMENT");
  const foreign = await f.listen({ id: "native:foreign-sync-actor", canWrite: true });
  const denied = await preview(f, foreign, args);
  assert.equal(denied.body.error.code, "ACCESS_DENIED");
});

test("native Core HTTP restores all members, and authenticated MCP restart replays the same global receipt", async t => {
  const fixture = restoreFixture({ partial: true, previousLocal: true });
  const f = await nativeWorkspace(t, root => { writeLocal(root, fixture); return {}; });
  const url = await f.listen(restoreActor);
  const args = await remoteDecision(f, url, fixture);
  const planned = await preview(f, url, args);
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const applyArgs = { ...args, operationId: randomUUID(), expectedPlanHash: planned.body.result.planHash };
  const applied = await httpCall(url, f.bearer, "capability_call", invocation("sync.apply", applyArgs));
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.result.operations.length, 2, "unchanged attachment is guarded, not rewritten");
  assert.equal(applied.body.result.actorId, restoreActor.id);
  assertRemote(f.root, fixture);
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sync_apply_journal").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(applyArgs.operationId).n, 1);
  } finally { db.close(); }
  await f.close();
  const child = await mcp(t, f.root, restoreActor.id);
  const retry = await child.call("capability_call", "sync.apply", applyArgs);
  assert.deepEqual(retry.result, applied.body.result);
  assertRemote(f.root, fixture);
  await child.close();
  const foreign = await mcp(t, f.root, "native:foreign-sync-actor");
  const denied = await foreign.call("capability_call", "sync.apply", applyArgs);
  assert.equal(denied.error.code, "CONFLICT");
  await foreign.close();
});

test("native shared intent rolls an interrupted entity forward at restart with one durable receipt", async t => {
  const fixture = restoreFixture({ partial: true, previousLocal: true });
  const f = await nativeWorkspace(t, root => { writeLocal(root, fixture); return {}; });
  const url = await f.listen(restoreActor);
  const args = await remoteDecision(f, url, fixture);
  const planned = await preview(f, url, args);
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const applyArgs = { ...args, operationId: randomUUID(), expectedPlanHash: planned.body.result.planHash };
  const rename = fs.renameSync;
  const interruptedTarget = join(f.root, fixture.remote[2].path);
  fs.renameSync = (source, target) => {
    if (target === interruptedTarget) throw new Error("synthetic sync member interruption");
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    const interrupted = await httpCall(url, f.bearer, "capability_call", invocation("sync.apply", applyArgs));
    assert.notEqual(interrupted.status, 200);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readFileSync(join(f.root, fixture.remote[0].path)), fixture.bytes[0]);
  assert.equal(fs.existsSync(interruptedTarget), false);
  let pending;
  const db = f.storage.connectNative();
  try {
    pending = db.prepare("SELECT apply_id,state FROM sync_apply_journal").get();
    assert.equal(pending.state, "prepared");
    assert.equal(db.prepare("SELECT count(*) AS n FROM data_runtime_intents WHERE operation_id=?").get(applyArgs.operationId).n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(applyArgs.operationId).n, 0);
  } finally { db.close(); }
  await f.reopen();
  assertRemote(f.root, fixture);
  const recoveredUrl = await f.listen(restoreActor);
  const retry = await httpCall(recoveredUrl, f.bearer, "capability_call", invocation("sync.apply", applyArgs));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.result.applyId, pending.apply_id);
  const recoveredDb = f.storage.connectNative();
  try {
    assert.equal(recoveredDb.prepare("SELECT count(*) AS n FROM data_runtime_intents").get().n, 0);
    assert.equal(recoveredDb.prepare("SELECT count(*) AS n FROM sync_apply_journal").get().n, 1);
    assert.equal(recoveredDb.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(applyArgs.operationId).n, 1);
  } finally { recoveredDb.close(); }
});

test("native apply detects external attachment mutation before any member write and persists needs-review", async t => {
  const fixture = restoreFixture({ partial: true, previousLocal: true });
  const f = await nativeWorkspace(t, root => { writeLocal(root, fixture); return {}; });
  const url = await f.listen(restoreActor);
  const args = await remoteDecision(f, url, fixture);
  const planned = await preview(f, url, args);
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const bodyBefore = fs.readFileSync(join(f.root, fixture.remote[0].path));
  const external = Buffer.from([1, 2, 0xff, 0, 4]);
  fs.writeFileSync(join(f.root, fixture.remote[1].path), external);
  const rejected = await httpCall(url, f.bearer, "capability_call", invocation("sync.apply", {
    ...args, operationId: randomUUID(), expectedPlanHash: planned.body.result.planHash,
  }));
  assert.equal(rejected.body.error.code, "RECOVERY_CONFLICT");
  assert.deepEqual(fs.readFileSync(join(f.root, fixture.remote[0].path)), bodyBefore);
  assert.deepEqual(fs.readFileSync(join(f.root, fixture.remote[1].path)), external);
  assert.equal(fs.existsSync(join(f.root, fixture.remote[2].path)), false);
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT state FROM sync_apply_journal").get().state, "needs-review");
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation='sync.apply'").get().n, 0);
  } finally { db.close(); }
});
