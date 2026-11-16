import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { LegacyMemoryErasureOwnedWorker } from "../dist/legacy-memory-erasure-worker.js";
import { createPairedMemoryWorkspaceBackup, restorePairedMemoryWorkspaceBackup,
  openPairedMemoryWorkspaceWorker } from "../dist/workspace-backup.js";
import { transports } from "./host-composition-legacy-shared-captures.mjs";
import { DatabaseSync } from "node:sqlite";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { acquireLinuxRootWriterFence } from "../dist/linux-root-writer-fence.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const actor = { id: "paired-native-fixture-human", canWrite: true, collaborationKind: "human" };
const python = execFileSync("python3", ["-I", "-S", "-B", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const noReplace = async (stage, destination) => {
  execFileSync(python, ["-I", "-S", "-B", "-c",
    "import ctypes,os,sys\nlib=ctypes.CDLL(None,use_errno=True)\nr=lib.renameat2(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1)\nsys.exit(0 if r==0 else ctypes.get_errno())",
    stage, destination], { env: { ...process.env, TMPDIR: dirname(stage), TMP: dirname(stage), TEMP: dirname(stage) } });
};
async function fixture(t) {
  const parent = fileURLToPath(new URL(`./.paired-memory-${randomUUID()}/`, import.meta.url));
  await mkdir(parent);
  const root = await initialize(join(parent, "workspace"));
  const runtimeDirectory = join(parent, "external-engine");
  await mkdir(runtimeDirectory);
  let epoch = 0, allowed = true;
  const approvals = new Set();
  const adopted = new Set();
  const snapshots = new Set();
  const engineSealAuthorityPath = join(parent, "native-engine-content-authority.json");
  const readEngineSeals = () => {
    try { return JSON.parse(readFileSync(engineSealAuthorityPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  };
  let held = false;
  const policy = {
    scope: "exclusive-native-disposable-fixture", actorId: actor.id, python,
    restoredEngineLayout: "native-controlled-inside-workspace",
    get ownedWorker() { return worker; },
    engineStateAuthority: {
      read: request => readEngineSeals()[request.destination] ?? null,
      commit(request, seal) {
        if (!allowed || request.epoch !== epoch || !adopted.has(request.destination)) return false;
        const seals = readEngineSeals();
        seals[request.destination] = structuredClone(seal);
        const stage = `${engineSealAuthorityPath}.${randomUUID()}`;
        const fd = openSync(stage, "wx", 0o600);
        try { writeFileSync(fd, JSON.stringify(seals)); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(stage, engineSealAuthorityPath);
        const directory = openSync(parent, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
        return true;
      },
    },
    assertOwnership: request => allowed && request.destination.startsWith(parent)
      && request.sourceRoot.startsWith(parent),
    authorize: request => {
      if (!allowed || request.epoch !== epoch || request.actorId !== actor.id) return null;
      const snapshotKey = JSON.stringify([request.operationId, request.sourceRoot, request.destination]);
      if (request.phase === "snapshot") snapshots.add(snapshotKey);
      if (request.phase === "snapshot" || request.phase === "publish" && snapshots.has(snapshotKey)) {
        if (request.manifestSha256) approvals.add(request.manifestSha256);
      } else if (!approvals.has(request.manifestSha256)) return null;
      if (request.phase === "publish") adopted.add(request.destination);
      if (request.phase === "open" && !adopted.has(request.destination)) return null;
      return { authorityId: "native-disposable-epoch", actorId: actor.id,
        requestSha256: hash(JSON.stringify(request)), expiresAt: Date.now() + 60_000, trustedEpoch: epoch };
    },
    acquireQuiescence: async () => {
      assert.equal(held, false); held = true;
      const actual = await runtime.acquireWorkspaceQuiescence();
      return { assertHeld() { assert(held); actual.assertHeld(); }, release() { held = false; actual.release(); } };
    },
    publishNoReplace: noReplace,
  };
  const workerPolicy = {
    scope: "exclusive-native-disposable-fixture",
    assertFixtureOwnership: binding => allowed && binding.database.startsWith(parent),
    authorizeEffect: request => {
      if (!allowed || request.actorId !== actor.id) return false;
      if (request.phase === "replay") return request.expectedEpoch < epoch;
      if (request.expectedEpoch !== epoch) return false;
      if (request.phase === "after-effect") epoch++;
      return true;
    },
  };
  let worker = await LegacyMemoryErasureOwnedWorker.open({
    python, runtimeDirectory, database: join(runtimeDirectory, "memory.sqlite3"), identity: "fixture-paired-engine",
  }, workerPolicy);
  let storage = await Storage.open(root, { deferRecovery: true });
  let runtime, io;
  const openRuntime = async (path, ownedWorker) => {
    worker = ownedWorker;
    storage = await Storage.open(path, { deferRecovery: true });
    runtime = await createNativeRuntime({ storage, batch16Memory: {
      scope: "exclusive-native-disposable-fixture", worker,
      authorizeActor: who => allowed && who.id === actor.id,
      authorizeForget: request => ({ actorId: actor.id, decisionId: "native-human-approved",
        requestSha256: hash(JSON.stringify(request)) }),
      assertSqlAuthority(_db, who) { assert(allowed && who.id === actor.id); },
    } });
    io = await transports(t, runtime.core, actor);
  };
  await storage.close();
  await openRuntime(root, worker);
  const closeRuntime = async () => { await io?.close(); await runtime?.close(); await storage?.close(); };
  t.after(async () => { allowed = true; await closeRuntime(); await worker.close(); await rm(parent, { recursive: true, force: true }); });
  return { parent, root, policy, workerPolicy, openRuntime, closeRuntime,
    get worker() { return worker; }, get storage() { return storage; }, get runtime() { return runtime; }, get io() { return io; },
    advanceEpoch() { epoch++; }, setAllowed(value) { allowed = value; }, approvals };
}
async function forget(f, scope) {
  await f.worker.dispatch("createPiece", randomUUID(), { piece: scope, label: "Synthetic fixture", kind: "topic", scope });
  await f.worker.dispatch("appendStatement", randomUUID(), { piece: scope, statement_id: `${scope}-s`,
    expected_revision: 0, body: "Synthetic fixture memory", sources: [{
      id: `${scope}-source`, chat: scope, revision: "fixture-rev", locator: "fixture/message",
    }] });
  const preview = await f.runtime.batch16Memory.preview(actor, scope);
  const input = { operationId: randomUUID(), scope, expectedSourcePin: preview.sourcePin, expectedEpoch: preview.expectedEpoch };
  const response = await f.io.http("memory.scope.forget.native", input);
  assert.equal(response.error, undefined);
  return { input, receipt: response.result };
}

test("paired actual HTTP/MCP forget, atomic workspace+engine restore, immutable receipt retry and next forget", async t => {
  const f = await fixture(t);
  const one = await forget(f, "fixture/one");
  const history = Buffer.from("Synthetic original transcript and Markdown history\n");
  await writeFile(join(f.root, "notes", "history.md"), history);
  await writeFile(join(f.root, "notes", ".pkm-memory-snapshot-original-history.md"), history);
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), {
    ...f.policy,
    async publishNoReplace(stage, destination) {
      assert.throws(() => f.worker.dispatch("createPiece", randomUUID(), {
        piece: "must-not-write", label: "Denied", kind: "topic", scope: "fixture/denied",
      }), { code: "BUSY" });
      const denied = await f.io.http("knowledge.document.create", {
        operationId: randomUUID(), id: "must-not-write", title: "Denied", content: "Denied",
      });
      assert(denied.error, "actual Core/HTTP workspace writes must be denied under the shared snapshot fence");
      await noReplace(stage, destination);
    },
  });
  const target = join(f.parent, "restored");
  let publications = 0;
  await restorePairedMemoryWorkspaceBackup(backup.backupPath, target, {
    ...f.policy, async publishNoReplace(stage, destination) {
      publications++;
      if (process.platform === "linux") {
        const marker = JSON.parse(await readFile(join(stage, ".pkm-next-writer-fenced.json"), "utf8"));
        const stat = await lstat(stage, { bigint: true });
        assert.equal(marker.root, destination);
        assert.equal(marker.device, String(stat.dev));
        assert.equal(marker.inode, String(stat.ino));
        await assert.rejects(acquireLinuxRootWriterFence(stage, 50), { code: "BUSY" });
      }
      await noReplace(stage, destination);
    },
  });
  assert.equal(publications, 1);
  assert.deepEqual(await readFile(join(target, "notes", "history.md")), history);
  const oldDb = f.storage.connectNative();
  let originalReceipt;
  try { originalReceipt = oldDb.prepare("SELECT * FROM receipts WHERE operation_id=?").get(one.input.operationId); }
  finally { oldDb.close(); }
  await f.closeRuntime(); await f.worker.close();
  const restoredWorker = await openPairedMemoryWorkspaceWorker(target, f.policy, f.workerPolicy);
  await f.openRuntime(target, restoredWorker);
  const retry = await f.io.mcp("memory.scope.forget.native", one.input);
  assert.equal(retry.error, undefined);
  assert.deepEqual(retry.result, one.receipt);
  assert.deepEqual(await f.worker.dispatch("usage", { scope: "fixture/one" }), { bytes: 0, pieces: 0 });
  const db = f.storage.connectNative();
  try { assert.deepEqual(db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(one.input.operationId), originalReceipt); }
  finally { db.close(); }
  const two = await forget(f, "fixture/two");
  assert.equal(two.receipt.erasureEpoch, 2);
  await f.closeRuntime(); await f.worker.close();
  const restarted = await openPairedMemoryWorkspaceWorker(target, f.policy, f.workerPolicy);
  await f.openRuntime(target, restarted);
  assert.deepEqual((await f.io.http("memory.scope.forget.native", two.input)).result, two.receipt);
  const second = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup-two"), f.policy);
  assert.equal(second.epoch, 2);
  const targetTwo = join(f.parent, "restored-two");
  await restorePairedMemoryWorkspaceBackup(second.backupPath, targetTwo, f.policy);
  await f.closeRuntime(); await f.worker.close();
  const restoredTwo = await openPairedMemoryWorkspaceWorker(targetTwo, f.policy, f.workerPolicy);
  await f.openRuntime(targetTwo, restoredTwo);
  assert.deepEqual((await f.io.mcp("memory.scope.forget.native", one.input)).result, one.receipt);
  assert.deepEqual((await f.io.http("memory.scope.forget.native", two.input)).result, two.receipt);
  assert.deepEqual(await f.worker.dispatch("usage", { scope: "fixture/one" }), { bytes: 0, pieces: 0 });
  assert.deepEqual(await f.worker.dispatch("usage", { scope: "fixture/two" }), { bytes: 0, pieces: 0 });
  assert.deepEqual(await readFile(join(targetTwo, "notes", "history.md")), history);
  assert.deepEqual(await readFile(join(targetTwo, "notes", ".pkm-memory-snapshot-original-history.md")), history);
});

test("paired snapshots validate live writer ownership and copied restored roots still fail admission", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await fixture(t);
  await forget(f, "fixture/root-owner");
  const markerName = ".pkm-next-writer-fenced.json";
  const sourceMarkerPath = join(f.root, markerName);
  const original = await readFile(sourceMarkerPath);
  await writeFile(sourceMarkerPath, JSON.stringify({ ...JSON.parse(original), inode: "0" }));
  await assert.rejects(createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "invalid-owner"), f.policy),
    { code: "RECOVERY_REQUIRED" });
  await writeFile(sourceMarkerPath, original);
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), f.policy);
  assert(!(await readdir(backup.backupPath)).includes(markerName));
  const target = join(f.parent, "restored");
  await restorePairedMemoryWorkspaceBackup(backup.backupPath, target, f.policy);
  const copy = join(f.parent, "arbitrary-copy");
  await cp(target, copy, { recursive: true, preserveTimestamps: true });
  await assert.rejects(Storage.open(copy, { deferRecovery: true }), { code: "RECOVERY_REQUIRED" });
  await assert.rejects(openPairedMemoryWorkspaceWorker(copy, f.policy, f.workerPolicy), { code: "ADOPTION_MISMATCH" });
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, target, f.policy), { code: "DESTINATION_EXISTS" });
});

test("paired restore never launders a copied owner marker in an authorized stage", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await fixture(t);
  await forget(f, "fixture/stage-owner-tamper");
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), f.policy);
  const destination = join(f.parent, "never-published");
  const sourceMarker = await readFile(join(f.root, ".pkm-next-writer-fenced.json"));
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, destination, {
    ...f.policy,
    authorize(request) {
      if (request.phase === "publish") {
        const stage = readdirSync(f.parent).find(name => name.startsWith(".pkm-paired.") && name.endsWith(".stage"));
        writeFileSync(join(f.parent, stage, ".pkm-next-writer-fenced.json"), sourceMarker, { mode: 0o600 });
      }
      return f.policy.authorize(request);
    },
    async publishNoReplace() { assert.fail("A foreign root owner must never reach publication"); },
  }), { code: "RECOVERY_REQUIRED" });
  assert(!(await readdir(f.parent)).some(name => name === "never-published" || name.startsWith(".pkm-paired.")));
  assert.deepEqual(await readFile(join(f.root, ".pkm-next-writer-fenced.json")), sourceMarker);
  assert.deepEqual(await f.worker.dispatch("usage", { scope: "fixture/stage-owner-tamper" }), { bytes: 0, pieces: 0 });
});

test("paired restore rechecks revoked authority after acquiring its publication fence", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await fixture(t);
  await forget(f, "fixture/publication-authority");
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), f.policy);
  let approvals = 0;
  const destination = join(f.parent, "revoked-restored");
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, destination, {
    ...f.policy,
    authorize(request) {
      if (request.phase === "publish" && ++approvals === 2) return null;
      return f.policy.authorize(request);
    },
    async publishNoReplace() { assert.fail("Revoked authority must never reach publication"); },
  }), { code: "AUTHORITY_REQUIRED" });
  assert(!(await readdir(f.parent)).some(name => name === "revoked-restored" || name.startsWith(".pkm-paired.")));
  assert.deepEqual(await f.worker.dispatch("usage", { scope: "fixture/publication-authority" }), { bytes: 0, pieces: 0 });
});

test("paired restore rechecks authority after target-marker binding before calling the native publisher", {
  skip: process.platform !== "linux",
}, async t => {
  const f = await fixture(t);
  await forget(f, "fixture/final-publication-authority");
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), f.policy);
  let approvals = 0, publications = 0;
  const destination = join(f.parent, "final-revoked-restored");
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, destination, {
    ...f.policy,
    authorize(request) {
      if (request.phase === "publish" && ++approvals === 3) {
        const stage = readdirSync(f.parent).find(name => name.startsWith(".pkm-paired.") && name.endsWith(".stage"));
        const marker = JSON.parse(readFileSync(join(f.parent, stage, ".pkm-next-writer-fenced.json"), "utf8"));
        assert.equal(marker.root, destination, "final authority must run after target-marker binding");
        return null;
      }
      return f.policy.authorize(request);
    },
    async publishNoReplace() { publications++; assert.fail("Final revoked authority must never publish"); },
  }), { code: "AUTHORITY_REQUIRED" });
  assert.equal(approvals, 3);
  assert.equal(publications, 0);
  assert(!(await readdir(f.parent)).some(name => name === "final-revoked-restored" || name.startsWith(".pkm-paired.")));
  assert.deepEqual(await f.worker.dispatch("usage", { scope: "fixture/final-publication-authority" }), { bytes: 0, pieces: 0 });
  const next = await forget(f, "fixture/after-final-revocation");
  assert.equal(next.receipt.erasureEpoch, 2);
});

test("paired publication failure retains pending native adoption and blocks restart rather than silently succeeding", async t => {
  const f = await fixture(t);
  await forget(f, "fixture/fault");
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), f.policy);
  const destination = join(f.parent, "unknown-restored");
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, destination, {
    ...f.policy, async publishNoReplace(stage, target) {
      await noReplace(stage, target);
      throw new Error("native fault after atomic paired rename");
    },
  }), { code: "RECOVERY_REQUIRED" });
  const publication = JSON.parse((await readFile(join(destination, ".pkm-native-memory-publication.json"))).toString());
  assert.equal(publication.state, "pending");
  await assert.rejects(openPairedMemoryWorkspaceWorker(destination, f.policy, f.workerPolicy), { code: "ADOPTION_MISMATCH" });
  await assert.rejects(Storage.open(destination, { deferRecovery: true }), { code: "RECOVERY_REQUIRED" });
  const denied = await f.io.mcp("knowledge.document.create", {
    operationId: randomUUID(), id: "unknown-blocked", title: "Denied", content: "Denied",
  });
  assert(denied.error, "unknown paired publication must keep the original native workspace admission fenced");
});

test("paired before-publish revocation has no target effects and expired/wrong-actor authorities deny", async t => {
  const f = await fixture(t);
  await forget(f, "fixture/revocation");
  await assert.rejects(createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "unsupported-layout"), {
    ...f.policy, restoredEngineLayout: "external-two-target",
  }), { code: "AUTHORITY_REQUIRED" });
  for (const [name, transform] of [
    ["expired", decision => ({ ...decision, expiresAt: 0 })],
    ["actor", decision => ({ ...decision, actorId: "wrong-actor" })],
  ]) {
    await assert.rejects(createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, name), {
      ...f.policy, authorize(request) { const decision = f.policy.authorize(request); return decision && transform(decision); },
    }), { code: "AUTHORITY_REQUIRED" });
  }
  await assert.rejects(createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "publish-revoked"), {
    ...f.policy, authorize(request) { return request.phase === "publish" ? null : f.policy.authorize(request); },
  }), { code: "AUTHORITY_REQUIRED" });
  assert(!(await readdir(f.parent)).some(name => name === "publish-revoked" || name === "expired" || name === "actor"
    || name.startsWith(".pkm-paired.")));
  assert.deepEqual(await f.worker.dispatch("usage", { scope: "fixture/revocation" }), { bytes: 0, pieces: 0 });
});

test("paired stale epoch, revoked authority, manifest tampering and occupied destinations deny before effects", async t => {
  const f = await fixture(t);
  await forget(f, "fixture/deny");
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), f.policy);
  const historyPath = join(backup.backupPath, ".pkm-next-workspace");
  await chmod(historyPath, 0o644);
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, join(f.parent, "unsafe-mode"), f.policy), { code: "UNSAFE_PATH" });
  await chmod(historyPath, 0o600);
  f.setAllowed(false);
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, join(f.parent, "revoked"), f.policy), { code: "AUTHORITY_REQUIRED" });
  f.setAllowed(true);
  const manifestPath = join(backup.backupPath, ".pkm-paired-memory-backup.json");
  const bytes = await readFile(manifestPath);
  const modified = JSON.parse(bytes); modified.epoch++;
  await writeFile(manifestPath, JSON.stringify(modified));
  const publicationPath = join(backup.backupPath, ".pkm-native-memory-publication.json");
  const publication = await readFile(publicationPath);
  await writeFile(publicationPath, JSON.stringify({ state: "committed", manifestSha256: hash(JSON.stringify(modified)) }));
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, join(f.parent, "tampered"), f.policy), { code: "LINEAGE_MISMATCH" });
  await writeFile(manifestPath, bytes);
  await writeFile(publicationPath, publication);
  await mkdir(join(f.parent, "occupied"));
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, join(f.parent, "occupied"), f.policy), { code: "DESTINATION_EXISTS" });
  f.advanceEpoch();
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, join(f.parent, "stale"), f.policy), { code: "AUTHORITY_REQUIRED" });
  assert(!(await readdir(f.parent)).some(name => name === "tampered" || name === "stale" || name === "revoked"));
});

test("paired restore fences the actual engine before publication and preserves unknown-before-effect staging", async t => {
  const f = await fixture(t);
  await forget(f, "fixture/restore-before-effect");
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), f.policy);
  const destination = join(f.parent, "never-published");
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, destination, {
    ...f.policy, async publishNoReplace() {
      assert.throws(() => f.worker.dispatch("createPiece", randomUUID(), {
        piece: "restore-denied", label: "Denied", kind: "topic", scope: "fixture/restore-denied",
      }), { code: "BUSY" });
      throw new Error("native publication outcome unavailable before rename");
    },
  }), { code: "RECOVERY_REQUIRED" });
  assert(!(await readdir(f.parent)).includes("never-published"));
  assert((await readdir(f.parent)).some(name => name.startsWith(".pkm-paired.") && name.endsWith(".stage")));
  assert.throws(() => f.worker.dispatch("usage", { scope: "fixture/restore-before-effect" }), { code: "BUSY" });
  await assert.rejects(restorePairedMemoryWorkspaceBackup(backup.backupPath, join(f.parent, "no-replay"), f.policy), { code: "RECOVERY_REQUIRED" });
});

test("paired backup unknown-after-rename fences both actual native writer dispatchers and denies restart", async t => {
  const f = await fixture(t);
  await forget(f, "fixture/backup-unknown");
  const destination = join(f.parent, "unknown-backup");
  await assert.rejects(createPairedMemoryWorkspaceBackup(f.storage, f.worker, destination, {
    ...f.policy, async publishNoReplace(stage, target) {
      await noReplace(stage, target);
      throw new Error("native backup fault after exact stage rename");
    },
  }), { code: "RECOVERY_REQUIRED" });
  assert.equal(JSON.parse(await readFile(join(destination, ".pkm-native-memory-publication.json"), "utf8")).state, "pending");
  assert.throws(() => f.worker.dispatch("usage", { scope: "fixture/backup-unknown" }), { code: "BUSY" });
  await assert.rejects(Storage.open(destination), { code: "RECOVERY_REQUIRED" });
  assert((await f.io.http("knowledge.document.create", {
    operationId: randomUUID(), id: "unknown-backup-denied", title: "Denied", content: "Denied",
  })).error);
});

test("paired successful publication still cannot resume writers after native epoch authority revocation", async t => {
  const f = await fixture(t);
  await forget(f, "fixture/resume-denied");
  const destination = join(f.parent, "resume-denied-backup");
  await assert.rejects(createPairedMemoryWorkspaceBackup(f.storage, f.worker, destination, {
    ...f.policy, authorize(request) {
      return request.phase === "resume" ? null : f.policy.authorize(request);
    },
  }), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => f.worker.dispatch("usage", { scope: "fixture/resume-denied" }), { code: "BUSY" });
  assert((await f.io.mcp("knowledge.document.create", {
    operationId: randomUUID(), id: "resume-denied", title: "Denied", content: "Denied",
  })).error);
});

test("restored native admission rejects changed immutable receipts, durable authority and current core identity", async t => {
  const f = await fixture(t);
  const forgotten = await forget(f, "fixture/live-pins");
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), f.policy);
  const destination = join(f.parent, "restored");
  await restorePairedMemoryWorkspaceBackup(backup.backupPath, destination, f.policy);
  await f.closeRuntime(); await f.worker.close();
  await f.openRuntime(destination, await openPairedMemoryWorkspaceWorker(destination, f.policy, f.workerPolicy));
  const db = f.storage.connectNative();
  try {
    const row = db.prepare("SELECT actor_id FROM receipts WHERE operation_id=?").get(forgotten.input.operationId);
    db.prepare("UPDATE receipts SET actor_id=? WHERE operation_id=?").run("tampered-fixture-actor", forgotten.input.operationId);
    assert.throws(() => f.worker.dispatch("usage", { scope: "fixture/live-pins" }), { code: "LINEAGE_MISMATCH" });
    db.prepare("UPDATE receipts SET actor_id=? WHERE operation_id=?").run(row.actor_id, forgotten.input.operationId);
  } finally { db.close(); }
  const publicationPath = join(destination, ".pkm-native-memory-publication.json");
  const publication = await readFile(publicationPath);
  await writeFile(publicationPath, JSON.stringify({ state: "pending", manifestSha256: backup.manifestSha256 }));
  assert.throws(() => f.worker.dispatch("usage", { scope: "fixture/live-pins" }), { code: "ADOPTION_MISMATCH" });
  await writeFile(publicationPath, publication);
  await chmod(join(destination, "core.sqlite"), 0o644);
  assert.throws(() => f.worker.dispatch("usage", { scope: "fixture/live-pins" }), { code: "ADOPTION_MISMATCH" });
  await chmod(join(destination, "core.sqlite"), 0o600);
  assert.deepEqual(await f.worker.dispatch("usage", { scope: "fixture/live-pins" }), { bytes: 0, pieces: 0 });
  f.setAllowed(false);
  assert.throws(() => f.worker.dispatch("usage", { scope: "fixture/live-pins" }), { code: "AUTHORITY_REQUIRED" });
  f.setAllowed(true);
  assert.throws(() => f.worker.dispatch("usage", { scope: "fixture/live-pins" }), { code: "BUSY" });
  await f.closeRuntime(); await f.worker.close();
  const corePath = join(destination, "core.sqlite");
  const originalCore = join(f.parent, "closed-original-core.sqlite");
  const coreBytes = await readFile(corePath);
  await rename(corePath, originalCore);
  await writeFile(corePath, coreBytes, { mode: 0o600 });
  await assert.rejects(openPairedMemoryWorkspaceWorker(destination, f.policy, f.workerPolicy), { code: "ADOPTION_MISMATCH" });
  await rename(originalCore, corePath);
});

test("restored engine same-inode payload tampering denies initial and previously sealed native worker open", async t => {
  const f = await fixture(t);
  await forget(f, "fixture/engine-content-pin");
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), f.policy);
  const mutate = async destination => {
    const database = join(destination, "packages", ".pkm-native-memory", "memory.sqlite3");
    const before = await lstat(database, { bigint: true });
    const db = new DatabaseSync(database);
    const original = db.prepare("SELECT label FROM pieces ORDER BY id LIMIT 1").get();
    const schema = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const tombstones = db.prepare("SELECT * FROM deleted_chats ORDER BY chat").all();
    const identity = db.prepare("SELECT * FROM metadata").all();
    db.exec("UPDATE pieces SET label='same-inode synthetic payload tampering'");
    assert.deepEqual(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all(), schema);
    assert.deepEqual(db.prepare("SELECT * FROM deleted_chats ORDER BY chat").all(), tombstones);
    assert.deepEqual(db.prepare("SELECT * FROM metadata").all(), identity);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    db.close();
    const after = await lstat(database, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.equal(after.mode, before.mode);
    await assert.rejects(openPairedMemoryWorkspaceWorker(destination, f.policy, f.workerPolicy), { code: "ENGINE_MISMATCH" });
    return original;
  };
  const first = join(f.parent, "initial-tampered");
  await restorePairedMemoryWorkspaceBackup(backup.backupPath, first, f.policy);
  await mutate(first);
  const second = join(f.parent, "sealed-tampered");
  await restorePairedMemoryWorkspaceBackup(backup.backupPath, second, f.policy);
  const headerOnly = join(f.parent, "header-tampered");
  await restorePairedMemoryWorkspaceBackup(backup.backupPath, headerOnly, f.policy);
  const headerDatabase = join(headerOnly, "packages", ".pkm-native-memory", "memory.sqlite3");
  const headerBefore = await lstat(headerDatabase, { bigint: true });
  const headerDb = new DatabaseSync(headerDatabase);
  headerDb.exec("PRAGMA application_id=123456");
  headerDb.close();
  assert.equal((await lstat(headerDatabase, { bigint: true })).ino, headerBefore.ino);
  await assert.rejects(openPairedMemoryWorkspaceWorker(headerOnly, f.policy, f.workerPolicy), { code: "ENGINE_MISMATCH" });
  await f.closeRuntime(); await f.worker.close();
  await f.openRuntime(second, await openPairedMemoryWorkspaceWorker(second, f.policy, f.workerPolicy));
  await f.worker.dispatch("createPiece", randomUUID(), {
    piece: "legitimate-after-restore", label: "Legitimate native fixture write", kind: "topic", scope: "fixture/new-write",
  });
  await f.closeRuntime(); await f.worker.close();
  await f.openRuntime(second, await openPairedMemoryWorkspaceWorker(second, f.policy, f.workerPolicy));
  assert.equal((await f.worker.dispatch("readPiece", { piece_id: "legitimate-after-restore" })).piece.label, "Legitimate native fixture write");
  await f.closeRuntime(); await f.worker.close();
  await mutate(second);
});

test("actual postrestore effect whose native content anchor is denied fences and never gains startup approval", async t => {
  const f = await fixture(t);
  await forget(f, "fixture/native-seal-denial");
  const backup = await createPairedMemoryWorkspaceBackup(f.storage, f.worker, join(f.parent, "backup"), f.policy);
  const destination = join(f.parent, "restored");
  await restorePairedMemoryWorkspaceBackup(backup.backupPath, destination, f.policy);
  await f.closeRuntime(); await f.worker.close();
  const deniedPolicy = { ...f.policy, engineStateAuthority: {
    read: f.policy.engineStateAuthority.read,
    commit: () => false,
  } };
  await f.openRuntime(destination, await openPairedMemoryWorkspaceWorker(destination, deniedPolicy, f.workerPolicy));
  await assert.rejects(f.worker.dispatch("createPiece", randomUUID(), {
    piece: "applied-without-native-seal", label: "Unknown native anchor", kind: "topic", scope: "fixture/native-seal-unknown-new",
  }), { code: "RECOVERY_REQUIRED" });
  assert.throws(() => f.worker.dispatch("usage", { scope: "fixture/native-seal-denial" }), { code: "BUSY" });
  await f.closeRuntime(); await f.worker.close();
  await assert.rejects(openPairedMemoryWorkspaceWorker(destination, f.policy, f.workerPolicy),
    error => error.code === "ENGINE_MISMATCH" || error.code === "INVALID_ENGINE");
});
