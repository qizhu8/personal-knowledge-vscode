import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { LegacyMemoryErasureOwnedWorker } from "../dist/legacy-memory-erasure-worker.js";
import { createWorkspaceBackup } from "../dist/workspace-backup.js";
import { fixture, transports, actor, hash, fixturePublisher } from "./host-composition-legacy-batch15-captures.mjs";

test("native owned derived-memory forget through HTTP/MCP atomically binds global receipt and fences backup", async t => {
  const f = await fixture(t);
  const runtimeDirectory = join(f.parent, "memory-runtime");
  await mkdir(runtimeDirectory);
  const python = execFileSync("python3", ["-I", "-S", "-B", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  const workerOptions = { python, runtimeDirectory, database: join(runtimeDirectory, "memory.sqlite3"), identity: `batch16-${randomUUID()}` };
  const state = { allowed: true, epochAllowed: true };
  const worker = await LegacyMemoryErasureOwnedWorker.open(workerOptions, {
    scope: "exclusive-native-disposable-fixture",
    assertFixtureOwnership: binding => binding.database === workerOptions.database,
    authorizeEffect: request => state.epochAllowed && request.actorId === actor.id && request.expectedEpoch === 0,
  });
  t.after(() => worker.close());
  const scope = "fixture-derived-memory";
  await worker.dispatch("createPiece", "fixture-create", { piece: "fixture-piece", label: "Synthetic", kind: "topic", scope });
  await worker.dispatch("appendStatement", "fixture-append", { piece: "fixture-piece", statement_id: "fixture-statement",
    expected_revision: 0, body: "Synthetic content.", status: "observation",
    sources: [{ id: "fixture-source", chat: scope, revision: "fixture-revision", locator: "message/fixture" }] });
  const policy = {
    scope: "exclusive-native-disposable-fixture", worker,
    authorizeActor: who => state.allowed && who.id === actor.id,
    authorizeForget: request => ({ actorId: actor.id, decisionId: "fixture-human-approval", requestSha256: hash(JSON.stringify(request)) }),
    assertSqlAuthority(_db, who) { if (!state.allowed || !state.epochAllowed || who.id !== actor.id) throw new Error("native authority revoked"); },
  };
  await f.close();
  let storage = await Storage.open(f.root, { deferRecovery: true });
  let runtime = await createNativeRuntime({ storage, batch16Memory: policy });
  t.after(async () => { await runtime?.close(); await storage?.close(); });
  let io = await transports(t, runtime.core, actor);
  const preview = await runtime.batch16Memory.preview(actor, scope);
  const input = { operationId: randomUUID(), scope, expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch };
  const faultDb = storage.connectNative();
  try {
    faultDb.exec("CREATE TRIGGER fixture_fail_memory_receipt BEFORE INSERT ON receipts WHEN NEW.operation='memory.scope.forget.native' BEGIN SELECT RAISE(ABORT,'synthetic receipt fault'); END");
  } finally { faultDb.close(); }
  const unknown = await io.http("memory.scope.forget.native", input);
  assert(unknown.error);
  const pendingDb = storage.connectNative();
  try {
    assert.equal(pendingDb.prepare("SELECT status FROM legacy_memory_erasure_operations WHERE operation_id=?").get(input.operationId).status, "pending");
    assert.equal(pendingDb.prepare("SELECT COUNT(*) n FROM receipts WHERE operation_id=?").get(input.operationId).n, 0);
    pendingDb.exec("DROP TRIGGER fixture_fail_memory_receipt");
  } finally { pendingDb.close(); }
  assert.equal((await io.mcp("knowledge.document.create", { operationId: randomUUID(), id: "blocked", title: "Blocked", content: "unchanged" })).error.code, "RECOVERY_REQUIRED");
  await io.close(); await runtime.close(); await storage.close();
  storage = await Storage.open(f.root, { deferRecovery: true });
  runtime = await createNativeRuntime({ storage, batch16Memory: policy });
  io = await transports(t, runtime.core, actor);
  const response = await io.http("memory.scope.forget.native", input);
  assert.equal(response.error, undefined);
  assert.equal(response.result.removedStatements, 1);
  assert.equal(response.result.erasure, "logical-only");
  const db = storage.connectNative();
  try {
    const row = db.prepare("SELECT actor_id,operation,result FROM receipts WHERE operation_id=?").get(input.operationId);
    assert.equal(row.actor_id, actor.id);
    assert.equal(row.operation, "memory.scope.forget.native");
    assert.deepEqual(JSON.parse(row.result), response.result);
  } finally { db.close(); }
  assert.deepEqual((await io.mcp("memory.scope.forget.native", input)).result, response.result);
  assert((await io.http("memory.scope.forget.native", { ...input, expectedEpoch: 1 })).error);
  state.allowed = false;
  assert.equal((await io.http("memory.scope.forget.native", input)).error.code, "NOT_AVAILABLE");
  state.allowed = true;
  state.epochAllowed = false;
  assert((await io.mcp("memory.scope.forget.native", input)).error);
  state.epochAllowed = true;
  const adapter = { async acquireQuiescence() { return { assertHeld() {}, release() {} }; } };
  await assert.rejects(createWorkspaceBackup(storage, join(f.parent, "backup"), adapter,
    { nativePublishNoReplace: fixturePublisher(f.parent) }), { code: "AUTHORITY_REQUIRED" });
  await io.close(); await runtime.close(); await storage.close();
  storage = await Storage.open(f.root, { deferRecovery: true });
  runtime = await createNativeRuntime({ storage, batch16Memory: policy });
  io = await transports(t, runtime.core, actor);
  assert.deepEqual((await io.mcp("memory.scope.forget.native", input)).result, response.result);
  const tamperDb = storage.connectNative();
  try { tamperDb.prepare("UPDATE receipts SET actor_id=? WHERE operation_id=?").run("other-actor", input.operationId); }
  finally { tamperDb.close(); }
  assert((await io.http("memory.scope.forget.native", input)).error);
  await io.close(); await runtime.close(); await storage.close();
  storage = await Storage.open(f.root, { deferRecovery: true });
  await assert.rejects(createNativeRuntime({ storage, batch16Memory: policy }), /receipt|disagrees/i);
});
