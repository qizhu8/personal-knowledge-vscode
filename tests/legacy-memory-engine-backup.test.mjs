import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LegacyMemoryErasureOwnedWorker } from "../dist/legacy-memory-erasure-worker.js";
import { LegacyMemoryErasureService } from "../dist/legacy-memory-erasure.js";
import {
  createLegacyMemoryEngineBackup, restoreLegacyMemoryEngineBackup,
} from "../dist/legacy-memory-engine-backup.js";
import { initialize, Storage } from "../dist/storage.js";

const server = fileURLToPath(new URL("../", import.meta.url));
const python = process.env.COMPUTE_TEST_PYTHON || execFileSync("python3",
  ["-I", "-S", "-B", "-c", "import sys; print(sys.executable)"], {
    encoding: "utf8", cwd: server, env: { ...process.env,
      TMPDIR: join(server, "tests"), TMP: join(server, "tests"), TEMP: join(server, "tests") },
  }).trim();
const hash = value => createHash("sha256").update(value).digest("hex");
const actorId = "fixture-native-human";
const scope = "fixture/backup/actor/chat";
const isCode = code => error => error?.code === code;
const auth = (request, epoch) => ({ actorId: request.actorId, authorityId: "disposable-fixture",
  requestSha256: hash(JSON.stringify(request)), expiresAt: Date.now() + 60_000, trustedEpoch: epoch });
const renameAt2Program = [
  "import ctypes, os, sys",
  "if not sys.platform.startswith('linux'): sys.exit(77)",
  "libc = ctypes.CDLL(None, use_errno=True)",
  "try: renameat2 = libc.renameat2",
  "except AttributeError: sys.exit(78)",
  "renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]",
  "renameat2.restype = ctypes.c_int",
  "result = renameat2(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1)",
  "if result != 0: sys.exit(ctypes.get_errno() if 0 < ctypes.get_errno() < 256 else 1)",
].join("\n");
const publishNoReplace = parent => async (source, target) => {
  assert.equal(dirname(source), parent);
  assert.equal(dirname(target), parent);
  execFileSync(python, ["-I", "-S", "-B", "-c", renameAt2Program, source, target], {
    cwd: server, env: { ...process.env, TMPDIR: join(server, "tests"),
      TMP: join(server, "tests"), TEMP: join(server, "tests") },
  });
};

async function fixture(t) {
  const parent = join(server, "tests", `.legacy-memory-engine-backup-${randomUUID()}`);
  await mkdir(parent);
  const root = await initialize(join(parent, "workspace"));
  const runtimeDirectory = join(parent, "runtime");
  await mkdir(runtimeDirectory);
  const storage = await Storage.open(root);
  const options = { python, runtimeDirectory, database: join(runtimeDirectory, "memory.sqlite3"),
    identity: `engine-fixture-${randomUUID()}` };
  let owned = true;
  let epoch = 0;
  const ownership = binding => owned && binding.database === options.database && binding.identity === options.identity;
  const worker = await LegacyMemoryErasureOwnedWorker.open(options, {
    scope: "exclusive-native-disposable-fixture",
    assertFixtureOwnership: ownership,
    authorizeEffect: request => {
      if (request.phase === "before-effect") return epoch === request.expectedEpoch;
      if (request.phase === "after-effect") {
        if (epoch !== request.expectedEpoch) return false;
        epoch++;
        return true;
      }
      return epoch === request.expectedEpoch + 1;
    },
  });
  let workspaceHeld = false;
  const workspaceHost = {
    scope: "exclusive-native-disposable-fixture",
    actorId,
    acquireWorkspaceQuiescence: async () => {
      assert.equal(workspaceHeld, false);
      workspaceHeld = true;
      return { assertHeld: () => assert.equal(workspaceHeld, true), release: () => { workspaceHeld = false; } };
    },
    assertFixtureOwnership: binding => owned && binding.workspaceRoot === root
      && binding.engine.database === options.database && binding.destination.startsWith(parent),
    readTrustedEpoch: async ({ workspaceId }) => ({
      authorityId: "fixture-epoch", workspaceId, epoch,
    }),
    authorizeBackup: request => epoch === request.memoryErasureEpoch
      ? auth(request, epoch) : null,
    publishNoReplace: publishNoReplace(parent),
  };
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
    authorizeReceiptReplay: () => true,
  };
  const erasureHost = {
    actorId,
    acquireMemoryQuiescence: () => worker.acquireMemoryQuiescence(),
    assertEffectAuthority: request => worker.assertEffectAuthority(request),
    authorizeForget: request => ({ actorId, decisionId: "fixture-human-approval",
      requestSha256: hash(JSON.stringify(request)) }),
    sql,
  };
  t.after(async () => {
    await worker.close();
    await storage.close();
    await rm(parent, { recursive: true, force: true });
  });
  return { parent, root, storage, options, worker, workspaceHost, erasureHost,
    service: () => new LegacyMemoryErasureService(storage, worker.engineBinding(), erasureHost),
    get epoch() { return epoch; },
    setOwned: value => { owned = value; } };
}

test("engine snapshots use SQLite backup and restored workers preserve a committed forget", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.worker.dispatch("createPiece", "create", {
    piece: "fixture-piece", label: "Synthetic only", kind: "topic", scope,
  });
  await f.worker.dispatch("appendStatement", "append", {
    piece: "fixture-piece", statement_id: "fixture-statement", expected_revision: 0,
    body: "Synthetic fixture content.", status: "observation",
    sources: [{ id: "fixture-source", chat: scope, revision: "fixture-revision", locator: "message/fixture" }],
  });
  const oldBackup = join(f.parent, "before-forget");
  const before = await createLegacyMemoryEngineBackup(f.storage, f.worker, oldBackup, f.workspaceHost);
  assert.equal(before.memoryErasureEpoch, 0);

  const service = f.service();
  const preview = await service.preview(scope);
  const input = { operationId: randomUUID(), scope, expectedSourcePin: preview.sourcePin, expectedEpoch: 0 };
  const receipt = await service.forget(input);
  assert.equal(receipt.removedStatements, 1);
  assert.equal(f.epoch, 1);

  const deniedRuntime = join(f.parent, "denied-runtime");
  await mkdir(deniedRuntime);
  const restorePolicy = (runtimeDirectory, database) => ({
    scope: "exclusive-native-disposable-fixture",
    actorId,
    python,
    assertFixtureOwnership: binding => binding.workspaceId === receipt.workspaceId
      && binding.targetRuntimeDirectory === runtimeDirectory && binding.targetDatabase === database
      && binding.targetIdentity === f.options.identity,
    readTrustedEpoch: async ({ workspaceId }) => ({
      authorityId: "fixture-epoch", workspaceId, epoch: f.epoch,
    }),
    authorizeRestore: async request => auth(request, f.epoch) && ({
      ...auth(request, f.epoch), lineage: "erasure-protected",
    }),
    publishNoReplace: publishNoReplace(runtimeDirectory),
  });
  const deniedDatabase = join(deniedRuntime, "memory.sqlite3");
  await assert.rejects(restoreLegacyMemoryEngineBackup(oldBackup, deniedRuntime, deniedDatabase,
    restorePolicy(deniedRuntime, deniedDatabase)), isCode("BACKUP_EPOCH_MISMATCH"));
  assert.deepEqual(await readdir(deniedRuntime), []);

  const currentBackupPath = join(f.parent, "after-forget");
  const currentBackup = await createLegacyMemoryEngineBackup(f.storage, f.worker, currentBackupPath, f.workspaceHost);
  assert.equal(currentBackup.memoryErasureEpoch, 1);
  const restoredRuntime = join(f.parent, "restored-runtime");
  await mkdir(restoredRuntime);
  const restoredDatabase = join(restoredRuntime, "memory.sqlite3");
  const restored = await restoreLegacyMemoryEngineBackup(currentBackupPath, restoredRuntime, restoredDatabase,
    restorePolicy(restoredRuntime, restoredDatabase));
  assert.equal(restored.workspaceId, receipt.workspaceId);
  assert.equal(restored.memoryErasureEpoch, 1);
  const reopened = await LegacyMemoryErasureOwnedWorker.open({
    python, runtimeDirectory: restoredRuntime, database: restoredDatabase, identity: f.options.identity,
  }, {
    scope: "exclusive-native-disposable-fixture",
    assertFixtureOwnership: binding => binding.database === restoredDatabase && binding.identity === f.options.identity,
    authorizeEffect: () => false,
  });
  try {
    assert.deepEqual(await reopened.dispatch("usage", { scope }), { bytes: 0, pieces: 0 });
    const piece = await reopened.dispatch("readPiece", { piece_id: "fixture-piece" });
    assert.equal(piece.statements.length, 0, "pre-forget statements must not be restored");
  } finally { await reopened.close(); }
});

test("backup and restore fail closed on ownership revocation, tampered bytes, and occupied targets", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  await f.worker.dispatch("createPiece", "create", {
    piece: "fixture-piece", label: "Synthetic only", kind: "topic", scope,
  });
  const deniedPath = join(f.parent, "denied-backup");
  await assert.rejects(createLegacyMemoryEngineBackup(f.storage, f.worker, deniedPath, {
    ...f.workspaceHost, assertFixtureOwnership: () => false,
  }), isCode("AUTHORITY_REQUIRED"));
  assert.deepEqual(await readdir(f.parent).then(entries => entries.filter(name => name === "denied-backup")), []);

  const uncertainPath = join(f.parent, "uncertain-backup");
  await assert.rejects(createLegacyMemoryEngineBackup(f.storage, f.worker, uncertainPath, {
    ...f.workspaceHost, publishNoReplace: async () => {},
  }), isCode("RECOVERY_REQUIRED"));
  const unknownStage = (await readdir(f.parent)).find(name => name.startsWith(".pkm-legacy-memory-backup.") && name.endsWith(".stage"));
  assert(unknownStage, "uncertain native publication must leave a stage for explicit reconciliation");
  await rm(join(f.parent, unknownStage), { recursive: true, force: true });

  const backupPath = join(f.parent, "backup");
  await createLegacyMemoryEngineBackup(f.storage, f.worker, backupPath, f.workspaceHost);
  const artifact = join(backupPath, "memory.sqlite3");
  const original = await readFile(artifact);
  await writeFile(artifact, Buffer.from("tampered"));
  const runtimeDirectory = join(f.parent, "target-runtime");
  await mkdir(runtimeDirectory);
  const database = join(runtimeDirectory, "memory.sqlite3");
  const restorePolicy = {
    scope: "exclusive-native-disposable-fixture", actorId, python,
    assertFixtureOwnership: binding => binding.targetDatabase === database,
    readTrustedEpoch: async ({ workspaceId }) => ({ authorityId: "fixture-epoch", workspaceId, epoch: 0 }),
    authorizeRestore: async request => ({ ...auth(request, 0), lineage: "unrelated" }),
    publishNoReplace: publishNoReplace(runtimeDirectory),
  };
  await assert.rejects(restoreLegacyMemoryEngineBackup(backupPath, runtimeDirectory, database, restorePolicy), isCode("INVALID_ENGINE"));
  assert.deepEqual(await readdir(runtimeDirectory), []);
  await writeFile(artifact, original);
  await restoreLegacyMemoryEngineBackup(backupPath, runtimeDirectory, database, restorePolicy);
  await assert.rejects(restoreLegacyMemoryEngineBackup(backupPath, runtimeDirectory, database, restorePolicy), isCode("DESTINATION_EXISTS"));
  await assert.rejects(LegacyMemoryErasureOwnedWorker.open({
    ...f.options, database: join(f.options.runtimeDirectory, "absent.sqlite3"),
  }, {
    scope: "exclusive-native-disposable-fixture", assertFixtureOwnership: () => false,
    authorizeEffect: () => false,
  }), isCode("AUTHORITY_REQUIRED"));
});
