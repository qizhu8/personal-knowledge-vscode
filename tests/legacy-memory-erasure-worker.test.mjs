import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { LegacyMemoryErasureService } from "../dist/legacy-memory-erasure.js";
import { LegacyMemoryErasureOwnedWorker } from "../dist/legacy-memory-erasure-worker.js";

const server = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.COMPUTE_TEST_PYTHON || execFileSync("python3",
  ["-I", "-S", "-B", "-c", "import sys; print(sys.executable)"], {
    encoding: "utf8", cwd: server, env: { ...process.env, TMPDIR: join(server, "tests"),
      TMP: join(server, "tests"), TEMP: join(server, "tests") },
  }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
const scope = "fixture/actor/chat";
const actorId = "fixture-actor";
const isCode = code => error => error?.code === code;

async function fixture(t) {
  const root = join(server, "tests", `.legacy-memory-erasure-worker-${randomUUID()}`);
  await mkdir(root);
  const workspace = await initialize(join(root, "workspace"));
  const runtimeDirectory = join(root, "runtime");
  await mkdir(runtimeDirectory);
  const storage = await Storage.open(workspace);
  const options = { python, runtimeDirectory, database: join(runtimeDirectory, "memory.sqlite3"),
    identity: `owned-fixture-${randomUUID()}` };
  let owned = true, epochAllowed = true, replayAllowed = true;
  const policy = {
    scope: "exclusive-native-disposable-fixture",
    assertFixtureOwnership: binding => owned && binding.database === options.database && binding.identity === options.identity,
    authorizeEffect: request => epochAllowed && request.actorId === actorId && request.expectedEpoch === 0,
  };
  const worker = await LegacyMemoryErasureOwnedWorker.open(options, policy);
  const sql = {
    assertSqlLease(db) { assert(db.isTransaction); },
    assertSqlAdmission(db) { assert(db.isTransaction); },
    readGlobalReceipt(db, id) {
      const row = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(id);
      return row ? { operationId: row.operation_id, actorId: row.actor_id, fingerprint: row.fingerprint,
        operation: row.operation, result: JSON.parse(row.result) } : null;
    },
    writeGlobalReceipt(db, receipt) {
      db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(receipt.operationId, receipt.fingerprint,
        JSON.stringify(receipt.result), receipt.actorId, receipt.operation, new Date().toISOString());
    },
    authorizeReceiptReplay() { return replayAllowed; },
  };
  const host = {
    actorId,
    acquireMemoryQuiescence: () => worker.acquireMemoryQuiescence(),
    assertEffectAuthority: request => worker.assertEffectAuthority(request),
    authorizeForget: request => ({ actorId, decisionId: "fixture-approval", requestSha256: hash(JSON.stringify(request)) }),
    sql,
  };
  t.after(async () => {
    await worker.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  return { worker, storage, options, host, policy,
    service: () => new LegacyMemoryErasureService(storage, worker.engineBinding(), host),
    setOwned: value => { owned = value; }, setEpochAllowed: value => { epochAllowed = value; },
    setReplayAllowed: value => { replayAllowed = value; } };
}

test("native fixture ownership required; raw worker never exposed", async t => {
  await assert.rejects(LegacyMemoryErasureOwnedWorker.open({}, undefined), isCode("AUTHORITY_REQUIRED"));
  const f = await fixture(t);
  const adapter = f.worker.engineBinding().worker;
  assert.equal(adapter.createPiece, undefined);
  assert.equal(adapter.reopen, undefined);
  assert.equal(f.worker.worker, undefined);
  assert.deepEqual(Reflect.ownKeys(f.worker), []);
  assert.throws(() => adapter.forgetScope({ scope }), isCode("BUSY"));
  assert.throws(() => f.worker.dispatch("forgetScope", { scope }), isCode("NOT_AVAILABLE"));
  const lease = await f.worker.acquireMemoryQuiescence();
  const erased = await adapter.forgetScope({ scope: "fixture/isolated/adapter" });
  assert.equal(erased.removed_statements, 0);
  lease.release();
  assert.throws(() => adapter.forgetScope({ scope }), isCode("BUSY"));
});

test("admission closes synchronously, drains actual writer and reopens only on lease release", async t => {
  const f = await fixture(t);
  const write = f.worker.dispatch("createPiece", "fixture-create", {
    piece: "fixture-piece", label: "Synthetic fixture", kind: "topic", scope,
  });
  const draining = f.worker.acquireMemoryQuiescence();
  assert.throws(() => f.worker.dispatch("usage", { scope }), isCode("BUSY"));
  assert.throws(() => f.worker.dispatch("createPiece", "second", {
    piece: "other", label: "Synthetic other", scope,
  }), isCode("BUSY"));
  const lease = await draining;
  await write;
  lease.assertHeld();
  assert.throws(() => f.worker.dispatch("usage", { scope }), isCode("BUSY"));
  await assert.rejects(f.worker.close(), isCode("BUSY"));
  lease.release();
  assert.equal((await f.worker.dispatch("usage", { scope })).pieces, 1);
});

test("owned fixture writer and guarded forget commit global receipt; revocations deny", async t => {
  const f = await fixture(t);
  await f.worker.dispatch("createPiece", "create", {
    piece: "fixture-piece", label: "Synthetic fixture", kind: "topic", scope,
  });
  await f.worker.dispatch("appendStatement", "append", {
    piece: "fixture-piece", statement_id: "fixture-statement", expected_revision: 0,
    body: "Synthetic fixture content.", status: "observation",
    sources: [{ id: "fixture-source", chat: scope, revision: "fixture-revision", locator: "message/fixture" }],
  });
  const service = f.service();
  const preview = await service.preview(scope);
  const input = { operationId: "abcdefab-cdef-4def-8def-abcdefabcdef",
    scope, expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch };
  f.setEpochAllowed(false);
  await assert.rejects(service.forget(input), isCode("AUTHORITY_REQUIRED"));
  assert.equal((await service.inspectPending())[0].engineState, "not-applied");
  f.setEpochAllowed(true);
  const receipt = await service.forget(input);
  assert.equal(receipt.removedStatements, 1);
  const db = f.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM receipts WHERE operation_id=?").get(input.operationId).count, 1); }
  finally { db.close(); }
  f.setReplayAllowed(false);
  await assert.rejects(service.forget(input), isCode("AUTHORITY_REQUIRED"));
  f.setReplayAllowed(true);
  assert.deepEqual(await service.forget(input), receipt);
  f.setEpochAllowed(false);
  await assert.rejects(service.forget(input), isCode("AUTHORITY_REQUIRED"));
});

test("replaced engine file and denied ownership fence the fixture worker without reopening", async t => {
  const f = await fixture(t);
  const replacement = join(f.options.runtimeDirectory, "replacement.sqlite");
  await copyFile(f.options.database, replacement);
  await rename(f.options.database, join(f.options.runtimeDirectory, "original.sqlite"));
  await rename(replacement, f.options.database);
  assert.throws(() => f.worker.dispatch("usage", { scope }), isCode("ENGINE_MISMATCH"));
  assert.throws(() => f.worker.dispatch("usage", { scope }), isCode("BUSY"));
  await assert.rejects(f.service().inspectPending(), isCode("BUSY"));
});

test("external ownership revocation fences dispatch", async t => {
  const f = await fixture(t);
  f.setOwned(false);
  assert.throws(() => f.worker.dispatch("usage", { scope }), isCode("AUTHORITY_REQUIRED"));
  f.setOwned(true);
  assert.throws(() => f.worker.dispatch("usage", { scope }), isCode("BUSY"));
});

test("closed fixture cannot dispatch, acquire, or reopen a worker", async t => {
  const f = await fixture(t);
  await f.worker.close();
  assert.throws(() => f.worker.dispatch("usage", { scope }), isCode("BUSY"));
  await assert.rejects(f.worker.acquireMemoryQuiescence(), isCode("BUSY"));
  assert.equal(f.worker.reopen, undefined);
  await assert.rejects(f.service().inspectPending(), isCode("BUSY"));
});
