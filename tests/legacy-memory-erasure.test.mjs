import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ChatMemoryWorker } from "../dist/compute/chat-memory-worker.js";
import { initialize, Storage } from "../dist/storage.js";
import {
  assertLegacyMemoryRestoreAdmitted, legacyMemoryBackupEpochMatches,
  LEGACY_MEMORY_ERASURE_DDL, LegacyMemoryErasureError, LegacyMemoryErasureService, validateLegacyMemoryErasureLedger,
} from "../dist/legacy-memory-erasure.js";

const server = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.COMPUTE_TEST_PYTHON || execFileSync("python3",
  ["-I", "-S", "-B", "-c", "import sys; print(sys.executable)"], {
    encoding: "utf8", cwd: server, env: { ...process.env, TMPDIR: join(server, "tests"),
      TEMP: join(server, "tests"), TMP: join(server, "tests") },
  }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
const scope = "fixture-workspace/fixture-actor/fixture-chat";
const actorId = "fixture-actor";
const targetPiece = "fixture-target-piece";
const dependentPiece = "fixture-dependent-piece";
const decisionId = "11111111-1111-4111-8111-111111111111";

function isErasureError(code) {
  return value => value instanceof LegacyMemoryErasureError && value.code === code;
}

function lease() {
  let held = true;
  return {
    assertHeld() { assert.equal(held, true); },
    async release() { held = false; },
  };
}

function makeHost(actor = actorId, answer = true) {
  const approvals = [];
  return {
    approvals,
    actorId: actor,
    acquireMemoryQuiescence: async () => lease(),
    assertEffectAuthority: () => true,
    sql: { authorizeReceiptReplay: () => true },
    authorizeForget(request) {
      approvals.push(structuredClone(request));
      if (!answer) return null;
      return { actorId: actor, decisionId, requestSha256: hash(JSON.stringify(request)) };
    },
  };
}

function globalReceiptHooks({ allowed = () => true, failWrite = false } = {}) {
  const calls = { lease: 0, admission: 0, read: 0, write: 0, replay: 0 };
  const hooks = {
    calls,
    assertSqlLease(db, context) {
      assert.equal(db.isTransaction, true);
      assert.equal(context.actorId, actorId);
      calls.lease++;
    },
    assertSqlAdmission(db, context) {
      assert.equal(db.isTransaction, true);
      assert(context.operationId);
      calls.admission++;
    },
    readGlobalReceipt(db, operationId) {
      calls.read++;
      const row = db.prepare(`SELECT operation_id,actor_id,fingerprint,operation,result
        FROM receipts WHERE operation_id=?`).get(operationId);
      return row ? {
        operationId: row.operation_id, actorId: row.actor_id, fingerprint: row.fingerprint,
        operation: row.operation, result: JSON.parse(row.result),
      } : null;
    },
    writeGlobalReceipt(db, receipt) {
      assert.equal(db.isTransaction, true);
      calls.write++;
      db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(
        receipt.operationId, receipt.fingerprint, JSON.stringify(receipt.result), receipt.actorId,
        receipt.operation, new Date().toISOString());
      if (failWrite) throw new Error("Injected global receipt failure.");
    },
    authorizeReceiptReplay(db, receipt) {
      assert.equal(db.isTransaction, true);
      assert.equal(receipt.actorId, actorId);
      calls.replay++;
      return allowed();
    },
  };
  return hooks;
}

async function fixture(t, name = "main") {
  const directory = join(server, "tests", `.legacy-memory-erasure-${randomUUID()}`);
  await mkdir(directory);
  const workspaceRoot = await initialize(join(directory, "workspace"));
  const runtimeDirectory = join(directory, "memory-runtime");
  await mkdir(runtimeDirectory);
  const workerOptions = {
    python, runtimeDirectory, database: join(runtimeDirectory, "memory.sqlite3"),
    identity: `disposable-${name}-${randomUUID()}`,
  };
  let storage = await Storage.open(workspaceRoot);
  let worker = await ChatMemoryWorker.open(workerOptions);
  const host = makeHost();
  const createService = (nativeHost = host, nativeWorker = worker) => new LegacyMemoryErasureService(storage, {
    worker: nativeWorker, runtimeDirectory, database: workerOptions.database, identity: workerOptions.identity,
  }, nativeHost);
  const close = async () => {
    await worker?.close();
    await storage?.close();
    await rm(directory, { recursive: true, force: true });
  };
  t.after(close);
  return {
    directory, workspaceRoot, runtimeDirectory, workerOptions, host, createService,
    get storage() { return storage; },
    get worker() { return worker; },
    async restart() {
      await worker.close();
      await storage.close();
      storage = await Storage.open(workspaceRoot);
      worker = await ChatMemoryWorker.open(workerOptions);
    },
  };
}

async function seed(worker) {
  const source = { id: "fixture-source-id", chat: scope, revision: "fixture-revision",
    locator: "message/fixture-user" };
  const targetSummary = "Synthetic target summary for the forget oracle.";
  const dependentSummary = "Synthetic dependent summary requiring source invalidation.";
  await worker.createPiece("fixture-create-target", {
    piece: targetPiece, label: "Synthetic target", kind: "topic", scope,
  });
  await worker.appendStatement("fixture-append-target", {
    piece: targetPiece, statement_id: "fixture-target-statement", expected_revision: 0,
    body: "Synthetic target statement.", status: "observation", sources: [source],
  });
  await worker.commitSummary("fixture-summary-target", {
    piece: targetPiece, expected_revision: 1, body: targetSummary, through: 1,
  });
  await worker.putEmbedding("fixture-embedding-target", {
    piece: targetPiece, representation: "summary", revision: 1,
    input_content_hash: hash(JSON.stringify(targetSummary)), embedding_space_id: "fixture-summary-v1",
    dimensions: 2, distance_metric: "cosine", embedding: [0.6, 0.8],
  });
  await worker.createPiece("fixture-create-dependent", {
    piece: dependentPiece, label: "Synthetic dependent topic", kind: "topic", scope: "unrelated-fixture-chat",
  });
  await worker.appendStatement("fixture-append-dependent", {
    piece: dependentPiece, statement_id: "fixture-dependent-statement", expected_revision: 0,
    body: "Synthetic statement derived from the target source.", status: "observation", sources: [source],
  });
  await worker.commitSummary("fixture-summary-dependent", {
    piece: dependentPiece, expected_revision: 1, body: dependentSummary, through: 1,
  });
  await worker.putEmbedding("fixture-embedding-dependent", {
    piece: dependentPiece, representation: "summary", revision: 1,
    input_content_hash: hash(JSON.stringify(dependentSummary)), embedding_space_id: "fixture-summary-v1",
    dimensions: 2, distance_metric: "cosine", embedding: [0.8, 0.6],
  });
  await worker.beginTurn({ scope, turn: "fixture-pending-turn",
    input: { id: "fixture-user-message", text: "Synthetic disposable conversation." } });
}

function inspectEngine(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    const rows = (sql, ...args) => db.prepare(sql).all(...args).map(row => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array
        ? { bytes: value.byteLength, sha256: hash(Buffer.from(value)) } : value])));
    return {
      tombstones: rows("SELECT chat FROM deleted_chats ORDER BY chat"),
      sources: rows("SELECT id,chat,revision,locator,deleted FROM sources ORDER BY id"),
      pieces: rows("SELECT id,label,kind,scope,level,revision,evicted,bytes FROM pieces ORDER BY id"),
      statements: rows("SELECT id,piece,sequence,body,status FROM statements ORDER BY id"),
      provenance: rows("SELECT statement,source FROM provenance ORDER BY statement,source"),
      summaries: rows("SELECT piece,input_revision,body,content_hash,through FROM summaries ORDER BY piece"),
      embeddings: rows(`SELECT piece,representation,revision,input_content_hash,embedding_space_id,
        dimensions,encoding,distance_metric,embedding,status FROM piece_embeddings ORDER BY piece,representation,revision,embedding_space_id`),
      leases: rows("SELECT id,piece,revision,expires_at FROM leases ORDER BY id"),
      edges: rows("SELECT parent,child,relation FROM edges ORDER BY parent,child,relation"),
      embeddingCount: db.prepare("SELECT count(*) AS count FROM piece_embeddings WHERE embedding IS NOT NULL").get().count,
      turns: rows("SELECT id,scope FROM turns ORDER BY id"),
      changes: rows("SELECT sequence,kind,piece FROM changes ORDER BY sequence"),
      operations: rows("SELECT id,request_hash,result FROM operations ORDER BY id"),
    };
  } finally { db.close(); }
}

test("native forget matches the original durable engine writer and invalidates derived references", async t => {
  const native = await fixture(t, "native");
  const oracle = await fixture(t, "source-oracle");
  await seed(native.worker);
  await seed(oracle.worker);
  const preview = await native.createService().preview(scope);
  assert.equal(preview.livePieces, 1);
  assert.equal(preview.sourceReferences, 1);
  assert.equal(preview.dependentStatements, 1);
  assert.equal(preview.sourceStatements, 2);
  assert.equal(native.host.approvals.length, 0, "preview never enrolls a human or verifier");

  const input = {
    operationId: "22222222-2222-4222-8222-222222222222",
    scope, expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  };
  const result = await native.createService().forget(input);
  const oracleResult = await oracle.worker.forgetScope({ scope });
  assert.equal(result.removedStatements, oracleResult.removed_statements);
  assert.equal(result.removedStatements, 2);
  assert.equal(result.erasure, "logical-only");
  assert.equal(result.backupProtection, "local-ledger-only");
  assert.deepEqual(inspectEngine(native.workerOptions.database), inspectEngine(oracle.workerOptions.database));

  const state = inspectEngine(native.workerOptions.database);
  assert.deepEqual(state.tombstones, [{ chat: scope }]);
  assert.deepEqual(state.sources, [{
    id: "fixture-source-id", chat: scope, revision: "fixture-revision", locator: "", deleted: 1,
  }]);
  assert(state.pieces.every(piece => piece.label === "" && piece.evicted === 1 && piece.bytes === 0));
  assert.deepEqual(state.statements, []);
  assert.deepEqual(state.summaries, []);
  assert.equal(state.embeddingCount, 0);
  assert.deepEqual(state.turns, []);
  assert(state.changes.some(change => change.kind === "purged"));
  assert.equal(native.host.approvals.length, 1);
  assert.equal(native.host.approvals[0].actorId, actorId);
  assert.equal(native.host.approvals[0].scopeSha256, hash(scope));
  assert.equal(native.host.approvals[0].sourcePin, preview.sourcePin);
});

test("strict actor approval and source/epoch CAS deny stale, denied and cross-actor requests", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const service = f.createService();
  const preview = await service.preview(scope);
  const denied = f.createService(makeHost(actorId, false));
  await assert.rejects(denied.forget({
    operationId: "33333333-3333-4333-8333-333333333333", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  }), isErasureError("AUTHORITY_REQUIRED"));
  assert.equal(inspectEngine(f.workerOptions.database).tombstones.length, 0);

  const stale = { operationId: "44444444-4444-4444-8444-444444444444", scope,
    expectedSourcePin: "a".repeat(64), expectedEpoch: preview.expectedEpoch };
  await assert.rejects(service.forget(stale), isErasureError("STALE_SOURCE"));
  assert.equal(f.host.approvals.length, 0, "stale CAS is rejected before asking for approval");

  const input = { operationId: "55555555-5555-4555-8555-555555555555", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch };
  const receipt = await service.forget(input);
  const wrongActor = f.createService(makeHost("different-native-actor"));
  await assert.rejects(wrongActor.forget(input), isErasureError("RECEIPT_CONFLICT"));
  const changedArgs = { ...input, expectedEpoch: input.expectedEpoch + 1 };
  await assert.rejects(service.forget(changedArgs), isErasureError("RECEIPT_CONFLICT"));
  assert.deepEqual(await service.forget(input), receipt, "same operation/actor/arguments replay the immutable receipt");
  assert.equal(inspectEngine(f.workerOptions.database).tombstones.length, 1);

  const invalid = { ...input, untrustedActor: actorId };
  await assert.rejects(service.forget(invalid), isErasureError("INVALID_INPUT"));
});

test("restart inspects unknown effects without replay, then exact actor/request/authority recovers", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const preview = await f.createService().preview(scope);
  const input = { operationId: "66666666-6666-4666-8666-666666666666", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch };
  let calls = 0;
  const uncertainWorker = new Proxy(f.worker, { get(target, key) {
    if (key === "forgetScope") return async params => {
      calls++;
      await target.forgetScope(params);
      throw new Error("Injected lost response after durable engine commit.");
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(f.createService(f.host, uncertainWorker).forget(input), isErasureError("RECOVERY_REQUIRED"));
  assert.equal(calls, 1);
  await f.restart();
  const recovered = f.createService();
  const pending = await recovered.inspectPending();
  assert.deepEqual(pending.map(item => ({ status: item.status, engineState: item.engineState })),
    [{ status: "pending", engineState: "applied" }]);
  assert.equal(calls, 1, "startup inspection did not resubmit the forget");
  const receipt = await recovered.forget(input);
  assert.equal(receipt.removedStatements, 2);
  assert.deepEqual((await recovered.inspectPending()).map(item => item.status), ["committed"]);
  assert.equal(inspectEngine(f.workerOptions.database).tombstones.length, 1);
});

test("restart does not automatically reapply an unsubmitted pending forget", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const preview = await f.createService().preview(scope);
  const input = { operationId: "99999999-9999-4999-8999-999999999999", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch };
  let submissions = 0;
  const rejectedWorker = new Proxy(f.worker, { get(target, key) {
    if (key === "forgetScope") return async () => {
      submissions++;
      throw new Error("Injected failure before native engine submission.");
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await assert.rejects(f.createService(f.host, rejectedWorker).forget(input), isErasureError("RECOVERY_REQUIRED"));
  await f.restart();
  const recovered = f.createService();
  assert.deepEqual((await recovered.inspectPending()).map(item => item.engineState), ["not-applied"]);
  assert.equal(submissions, 1);
  assert.equal(inspectEngine(f.workerOptions.database).tombstones.length, 0);
  const receipt = await recovered.forget(input);
  assert.equal(receipt.removedStatements, 2);
  assert.equal(inspectEngine(f.workerOptions.database).tombstones.length, 1);
});

test("SQL hooks atomically commit the global receipt and recheck live replay policy", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  let allowed = true;
  const hooks = globalReceiptHooks({ allowed: () => allowed });
  const host = { ...f.host, sql: hooks };
  const service = f.createService(host);
  const preview = await service.preview(scope);
  const input = {
    operationId: "abababab-abab-4bab-8bab-abababababab", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  };
  const receipt = await service.forget(input);
  assert.equal(hooks.calls.write, 1);
  assert(hooks.calls.lease >= 3);
  assert(hooks.calls.admission >= 3);
  assert.equal(hooks.calls.replay, 0);

  const db = f.storage.connectNative();
  try {
    const inspection = validateLegacyMemoryErasureLedger(db, receipt.workspaceId, hooks);
    assert.equal(inspection.state, "ready");
    assert.equal(inspection.epoch, 1);
    assert.deepEqual(inspection.operations.map(({ status, globalReceipt }) => ({ status, globalReceipt })),
      [{ status: "committed", globalReceipt: "present" }]);
  } finally { db.close(); }

  allowed = false;
  await assert.rejects(service.forget(input), isErasureError("AUTHORITY_REQUIRED"));
  assert.equal(hooks.calls.replay, 1);
  allowed = true;
  assert.deepEqual(await service.forget(input), receipt);
  assert.equal(hooks.calls.replay, 2);
});

test("committed replay denies absent SQL policy and native authority revocation", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const preview = await f.createService().preview(scope);
  const input = {
    operationId: "13571357-1357-4357-8357-135713571357", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  };
  const receipt = await f.createService().forget(input);
  const noSql = { ...f.host };
  delete noSql.sql;
  await assert.rejects(f.createService(noSql).forget(input), isErasureError("AUTHORITY_REQUIRED"));
  const revoked = { ...f.host, assertEffectAuthority: request => request.phase !== "replay" };
  await assert.rejects(f.createService(revoked).forget(input), isErasureError("AUTHORITY_REQUIRED"));
  assert.deepEqual(await f.createService().forget(input), receipt);
});

test("effect authority denies revoked actor before worker submission and reports unknown after effect", async t => {
  for (const phase of ["before-effect", "after-effect"]) await t.test(phase, async st => {
    const f = await fixture(st, phase);
    await seed(f.worker);
    const preview = await f.createService().preview(scope);
    const phases = [];
    const host = { ...f.host, assertEffectAuthority(request) {
      phases.push(request.phase);
      assert.equal(request.actorId, actorId);
      assert.equal(request.expectedEpoch, preview.expectedEpoch);
      assert.equal(request.database, f.workerOptions.database);
      assert(request.databaseInode && request.directoryInode && request.ancestors.length);
      return request.phase !== phase;
    } };
    const input = {
      operationId: "24682468-2468-4468-8468-246824682468", scope,
      expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
    };
    await assert.rejects(f.createService(host).forget(input),
      isErasureError(phase === "before-effect" ? "AUTHORITY_REQUIRED" : "RECOVERY_REQUIRED"));
    assert.equal(inspectEngine(f.workerOptions.database).tombstones.length, phase === "after-effect" ? 1 : 0);
    assert.deepEqual(phases, phase === "before-effect" ? ["before-effect"] : ["before-effect", "after-effect"]);
    const db = f.storage.connectNative();
    try {
      assert.equal(validateLegacyMemoryErasureLedger(db, await f.storage.workspaceId()).operations[0].status, "pending");
    } finally { db.close(); }
  });
});

test("engine database replacement after approval is rejected before worker submission", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const preview = await f.createService().preview(scope);
  const host = { ...f.host, async authorizeForget(request) {
    await copyFile(f.workerOptions.database, join(f.runtimeDirectory, "replacement.sqlite"));
    await rename(f.workerOptions.database, join(f.runtimeDirectory, "original.sqlite"));
    await rename(join(f.runtimeDirectory, "replacement.sqlite"), f.workerOptions.database);
    return { actorId, decisionId, requestSha256: hash(JSON.stringify(request)) };
  } };
  await assert.rejects(f.createService(host).forget({
    operationId: "35793579-3579-4579-8579-357935793579", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  }), isErasureError("ENGINE_MISMATCH"));
});

test("engine database replacement after worker effect leaves recovery unknown", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const preview = await f.createService().preview(scope);
  const replacement = join(f.runtimeDirectory, "replacement.sqlite");
  await copyFile(f.workerOptions.database, replacement);
  const host = { ...f.host, assertEffectAuthority(request) {
    if (request.phase === "after-effect") {
      renameSync(f.workerOptions.database, join(f.runtimeDirectory, "original.sqlite"));
      renameSync(replacement, f.workerOptions.database);
    }
    return true;
  } };
  await assert.rejects(f.createService(host).forget({
    operationId: "57915791-5791-4791-8791-579157915791", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  }), isErasureError("RECOVERY_REQUIRED"));
  const db = f.storage.connectNative();
  try {
    assert.equal(validateLegacyMemoryErasureLedger(db, await f.storage.workspaceId()).operations[0].status, "pending");
  } finally { db.close(); }
});

test("offline ledger inspection reports pending without guessing engine outcome", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const preview = await f.createService().preview(scope);
  const host = { ...f.host, assertEffectAuthority: () => false };
  await assert.rejects(f.createService(host).forget({
    operationId: "46804680-4680-4680-8680-468046804680", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  }), isErasureError("AUTHORITY_REQUIRED"));
  await f.worker.close();
  const db = f.storage.connectNative();
  try {
    const inspection = validateLegacyMemoryErasureLedger(db, await f.storage.workspaceId());
    assert.equal(inspection.operations[0].status, "pending");
    assert.equal("engineState" in inspection.operations[0], false);
    await assert.rejects(f.createService().inspectPending(), isErasureError("ENGINE_MISMATCH"));
  } finally { db.close(); }
});

test("global receipt callback failure rolls back local commit; callbacks must be synchronous", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const preview = await f.createService().preview(scope);
  const failingHooks = globalReceiptHooks({ failWrite: true });
  const service = f.createService({ ...f.host, sql: failingHooks });
  const input = {
    operationId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  };
  await assert.rejects(service.forget(input), /Injected global receipt failure/);
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM receipts WHERE operation_id=?")
      .get(input.operationId).count, 0);
    const inspection = validateLegacyMemoryErasureLedger(db, await f.storage.workspaceId(), failingHooks);
    assert.deepEqual(inspection.operations.map(item => item.status), ["pending"]);
  } finally { db.close(); }

  const asyncFixture = await fixture(t, "async-hook");
  await seed(asyncFixture.worker);
  const otherPreview = await asyncFixture.createService().preview(scope);
  const asyncHooks = {
    assertSqlLease: async () => {},
  };
  await assert.rejects(asyncFixture.createService({ ...asyncFixture.host, sql: asyncHooks }).forget({
    operationId: "dededede-dede-4ede-8ded-dededededede",
    scope,
    expectedSourcePin: otherPreview.sourcePin,
    expectedEpoch: otherPreview.expectedEpoch,
  }), isErasureError("TRANSACTION_BOUNDARY"));
});

test("read-only ledger validator does not initialize or mutate the ledger", async t => {
  const f = await fixture(t);
  const workspaceId = await f.storage.workspaceId();
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23);
    const before = db.prepare("SELECT total_changes() AS count").get().count;
    const tablesBefore = db.prepare(`SELECT count(*) AS count FROM sqlite_master
      WHERE type='table' AND name GLOB 'legacy_memory_erasure_*'`).get().count;
    assert.equal(tablesBefore, 3, "new workspaces preinstall the erasure ledger DDL");
    assert.deepEqual(validateLegacyMemoryErasureLedger(db, workspaceId), {
      schema: "pkm.native-memory-erasure-ledger-inspection/v1",
      state: "uninitialized",
      workspaceId,
      epoch: null,
      operations: [],
    });
    assert.equal(db.prepare("SELECT total_changes() AS count").get().count, before);
    assert.equal(db.prepare(`SELECT count(*) AS count FROM sqlite_master
      WHERE type='table' AND name GLOB 'legacy_memory_erasure_*'`).get().count, tablesBefore);
  } finally { db.close(); }
});

test("erasure accepts current workspace schema 22 and previous schema-21/schema-20/schema-19 fixtures", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const database = f.storage.connectNative();
  try {
    database.exec(`DROP TABLE IF EXISTS legacy_memory_erasure_operations;
      DROP TABLE IF EXISTS legacy_memory_erasure_state;
      DROP TABLE IF EXISTS legacy_memory_erasure_schema; PRAGMA user_version=19;`);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 19);
    assert.equal(database.prepare(`SELECT count(*) AS count FROM sqlite_master
      WHERE type='table' AND name GLOB 'legacy_memory_erasure_*'`).get().count, 0,
    "schema-19 fixture has no preinstalled erasure tables");
    assert.equal(validateLegacyMemoryErasureLedger(database, await f.storage.workspaceId()).state, "uninitialized");
    assert.equal((await f.createService().preview(scope)).workspaceId, await f.storage.workspaceId());
    database.exec("PRAGMA user_version=20");
    assert.equal((await f.createService().preview(scope)).workspaceId, await f.storage.workspaceId());
    database.exec("PRAGMA user_version=21");
    assert.equal((await f.createService().preview(scope)).workspaceId, await f.storage.workspaceId());
    database.exec("PRAGMA user_version=22");
    assert.equal((await f.createService().preview(scope)).workspaceId, await f.storage.workspaceId());
    database.exec("PRAGMA user_version=23");
    assert.equal((await f.createService().preview(scope)).workspaceId, await f.storage.workspaceId());
    database.exec("PRAGMA user_version=24");
    await assert.rejects(f.createService().preview(scope), isErasureError("SCHEMA_MISMATCH"));
  } finally { database.close(); }
});

test("valid pristine schema20 preinstalled ledger initializes both singletons atomically", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const db = f.storage.connectNative();
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23);
    const workspaceId = await f.storage.workspaceId();
    const before = db.prepare("SELECT total_changes() AS count").get().count;
    assert.equal(validateLegacyMemoryErasureLedger(db, workspaceId).state, "uninitialized");
    assert.equal(db.prepare("SELECT total_changes() AS count").get().count, before);
    const service = f.createService();
    const preview = await service.preview(scope);
    assert.equal(preview.expectedEpoch, 0);
    assert.deepEqual({ ...db.prepare("SELECT singleton,version FROM legacy_memory_erasure_schema").get() },
      { singleton: 1, version: 1 });
    assert.deepEqual({ ...db.prepare("SELECT singleton,workspace_id,epoch FROM legacy_memory_erasure_state").get() },
      { singleton: 1, workspace_id: workspaceId, epoch: 0 });
    assert.equal(validateLegacyMemoryErasureLedger(db, workspaceId).state, "ready");
    const receipt = await service.forget({
      operationId: "12345678-1234-4234-8234-123456789abc", scope,
      expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
    });
    assert.equal(receipt.erasureEpoch, 1);
    assert.equal(receipt.removedStatements, 2);
    assert.equal(validateLegacyMemoryErasureLedger(db, workspaceId).epoch, 1);
  } finally { db.close(); }
});

test("tampered DDL, attached triggers or indexes, and missing schema20 DDL fail closed", async t => {
  const variants = [
    { name: "constraint", ddl: LEGACY_MEMORY_ERASURE_DDL.replace("CHECK(epoch>=0)", "CHECK(epoch>=-1)") },
    { name: "trigger", ddl: `${LEGACY_MEMORY_ERASURE_DDL}
      CREATE TRIGGER fixture_trigger AFTER INSERT ON legacy_memory_erasure_schema BEGIN SELECT 1; END;` },
    { name: "index", ddl: `${LEGACY_MEMORY_ERASURE_DDL}
      CREATE INDEX fixture_index ON legacy_memory_erasure_operations(status);` },
    { name: "missing", ddl: "" },
  ];
  for (const variant of variants) await t.test(variant.name, async st => {
    const f = await fixture(st, variant.name);
    const db = f.storage.connectNative();
    try {
      db.exec(`DROP TABLE IF EXISTS legacy_memory_erasure_operations;
        DROP TABLE IF EXISTS legacy_memory_erasure_state;
        DROP TABLE IF EXISTS legacy_memory_erasure_schema;
        ${variant.ddl} PRAGMA user_version=20;`);
      const workspaceId = await f.storage.workspaceId();
      assert.throws(() => validateLegacyMemoryErasureLedger(db, workspaceId), isErasureError("STATE_CORRUPT"));
      await assert.rejects(f.createService().preview(scope), isErasureError("STATE_CORRUPT"));
      assert.equal(db.prepare(`SELECT count(*) AS count FROM sqlite_master
        WHERE type='table' AND name='legacy_memory_erasure_schema'`).get().count,
      variant.name === "missing" ? 0 : 1);
    } finally { db.close(); }
  });
});

test("nonempty or partial preinstalled ledger never initializes or repairs itself", async t => {
  for (const variant of ["schema-row-only", "state-row-only", "operation-row-only", "missing-table", "missing-schema"]) {
    await t.test(variant, async st => {
      const f = await fixture(st, variant);
      const db = f.storage.connectNative();
      try {
        db.exec(`${LEGACY_MEMORY_ERASURE_DDL} PRAGMA user_version=20;`);
        const workspaceId = await f.storage.workspaceId();
        if (variant === "schema-row-only") db.exec("INSERT INTO legacy_memory_erasure_schema VALUES(1,1)");
        if (variant === "state-row-only") db.prepare("INSERT INTO legacy_memory_erasure_state VALUES(1,?,0)").run(workspaceId);
        if (variant === "operation-row-only") db.exec(`INSERT INTO legacy_memory_erasure_operations
          VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','actor','${workspaceId}',
            '${"a".repeat(64)}','${"b".repeat(64)}','${"c".repeat(64)}','${"d".repeat(64)}',
            'decision',0,0,0,0,0,'${"e".repeat(64)}','pending',NULL,0,0)`);
        if (variant === "missing-table") db.exec("DROP TABLE legacy_memory_erasure_operations");
        if (variant === "missing-schema") db.exec("DROP TABLE legacy_memory_erasure_schema");
        const before = db.prepare(`SELECT type,name,sql FROM sqlite_master
          WHERE name GLOB 'legacy_memory_erasure_*' ORDER BY name`).all().map(row => ({ ...row }));
        const rowsBefore = ["legacy_memory_erasure_schema", "legacy_memory_erasure_state",
          "legacy_memory_erasure_operations"].filter(name => before.some(row => row.name === name))
          .map(name => db.prepare(`SELECT * FROM ${name}`).all().map(row => ({ ...row })));
        assert.throws(() => validateLegacyMemoryErasureLedger(db, workspaceId), isErasureError("STATE_CORRUPT"));
        await assert.rejects(f.createService().preview(scope), isErasureError("STATE_CORRUPT"));
        assert.deepEqual(db.prepare(`SELECT type,name,sql FROM sqlite_master
          WHERE name GLOB 'legacy_memory_erasure_*' ORDER BY name`).all().map(row => ({ ...row })), before);
        assert.deepEqual(["legacy_memory_erasure_schema", "legacy_memory_erasure_state",
          "legacy_memory_erasure_operations"].filter(name => before.some(row => row.name === name))
          .map(name => db.prepare(`SELECT * FROM ${name}`).all().map(row => ({ ...row }))), rowsBefore);
      } finally { db.close(); }
    });
  }
});

test("transaction rollback leaves pristine schema20 empty if second singleton insertion fails", async t => {
  const f = await fixture(t);
  const db = f.storage.connectNative();
  try {
    db.exec(`${LEGACY_MEMORY_ERASURE_DDL} PRAGMA user_version=20;`);
    const storage = new Proxy(f.storage, { get(target, key) {
      if (key === "connectNative") return () => {
        const connection = target.connectNative();
        return new Proxy(connection, { get(inner, property) {
          if (property === "prepare") return sql => {
            if (sql.startsWith("INSERT INTO legacy_memory_erasure_state")) {
              return { run() { throw new Error("Injected singleton failure"); } };
            }
            return inner.prepare(sql);
          };
          const value = Reflect.get(inner, property, inner);
          return typeof value === "function" ? value.bind(inner) : value;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const service = new LegacyMemoryErasureService(storage, {
      worker: f.worker, runtimeDirectory: f.runtimeDirectory,
      database: f.workerOptions.database, identity: f.workerOptions.identity,
    }, f.host);
    await assert.rejects(service.preview(scope), /Injected singleton failure/);
    assert.equal(db.prepare("SELECT count(*) AS count FROM legacy_memory_erasure_schema").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM legacy_memory_erasure_state").get().count, 0);
    assert.equal(validateLegacyMemoryErasureLedger(db, await f.storage.workspaceId()).state, "uninitialized");
    assert.equal((await f.createService().preview(scope)).expectedEpoch, 0);
  } finally { db.close(); }
});

test("a memory source mutation after preview fails source-pin CAS", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const service = f.createService();
  const preview = await service.preview(scope);
  const db = new DatabaseSync(f.workerOptions.database);
  try {
    db.prepare("UPDATE statements SET body=? WHERE id=?")
      .run("Synthetic tampered statement.", "fixture-target-statement");
  } finally { db.close(); }
  await assert.rejects(service.forget({
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    scope, expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  }), isErasureError("STALE_SOURCE"));
  assert.equal(f.host.approvals.length, 0);
  assert.equal(inspectEngine(f.workerOptions.database).tombstones.length, 0);
});

test("local ledger rollback is not trusted for restore admission", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const preview = await f.createService().preview(scope);
  await f.createService().forget({
    operationId: "77777777-7777-4777-8777-777777777777", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  });
  const workspaceId = await f.storage.workspaceId();
  const backup = { workspaceId, manifestSha256: "b".repeat(64), memoryErasureEpoch: 0 };
  await assert.rejects(assertLegacyMemoryRestoreAdmitted(backup), isErasureError("BACKUP_AUTHORITY_REQUIRED"));
  const authority = { readTrustedEpoch: async () => ({
    authorityId: "trusted-fixture-authority", workspaceId, epoch: 1,
  }) };
  await assert.rejects(assertLegacyMemoryRestoreAdmitted(backup, authority), isErasureError("BACKUP_EPOCH_MISMATCH"));
  assert(legacyMemoryBackupEpochMatches(1, 1));
  assert.equal(legacyMemoryBackupEpochMatches(0, 1), false);
  assert.equal(legacyMemoryBackupEpochMatches(null, 1), false);
  assert.deepEqual(await assertLegacyMemoryRestoreAdmitted({ ...backup, memoryErasureEpoch: 1 }, authority), {
    workspaceId, manifestSha256: "b".repeat(64), memoryErasureEpoch: 1,
  });
  await assert.rejects(assertLegacyMemoryRestoreAdmitted({
    ...backup, workspaceId: "99999999-9999-4999-8999-999999999999", memoryErasureEpoch: 1,
  }, authority), isErasureError("BACKUP_EPOCH_MISMATCH"));
});

test("native entrypoint requires a strong owner/quiescence seam and rejects ledger tampering", async t => {
  const f = await fixture(t);
  await seed(f.worker);
  const preview = await f.createService().preview(scope);
  const noQuiescence = makeHost();
  delete noQuiescence.acquireMemoryQuiescence;
  assert.throws(() => f.createService(noQuiescence), isErasureError("AUTHORITY_REQUIRED"));
  await assert.rejects(f.createService().forget({
    operationId: "88888888-8888-4888-8888-888888888888", scope,
    expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch,
  }).then(async result => {
    const db = f.storage.connectNative();
    try { db.prepare("UPDATE legacy_memory_erasure_operations SET source_pin=? WHERE operation_id=?")
      .run("0".repeat(64), result.operationId); } finally { db.close(); }
    return f.createService().inspectPending();
  }), isErasureError("STATE_CORRUPT"));
});
