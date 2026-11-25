import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { initialize, Storage } from "../dist/storage.js";
import { admitLegacyRetrievalModel, verifyLegacyRetrievalModels } from "../dist/legacy-retrieval-model.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

async function fixture(t) {
  const root = resolve(`.retrieval-model-owner-${randomUUID()}`), workspace = join(root, "workspace");
  await mkdir(root); await initialize(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace };
}
async function admissionFixture(t) {
  const root = resolve(`.retrieval-model-budget-${randomUUID()}`), workspace = join(root, "workspace");
  let storage;
  t.after(async () => { try { await storage?.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  await mkdir(root); await initialize(workspace);
  const f = { root, workspace };
  const artifacts = {
    "config.json": "{}",
    "modules.json": JSON.stringify([{ idx: 0, name: "0", path: "", type: "sentence_transformers.models.Transformer" }]),
    "model.safetensors": "Synthetic admission-only bytes; never execute as a model.",
  };
  const digest = value => createHash("sha256").update(value).digest("hex");
  const manifest = { schema: "pkm.retrieval-solution/v1", name: "Bounded admission fixture",
    architecture: "dense-section", parameters: {}, license: "Synthetic fixture",
    validation: { validation_query_count: 0 },
    files: Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, {
      sha256: digest(value), bytes: Buffer.byteLength(value),
    }])) };
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(", ")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}: ${canonical(value[key])}`).join(", ")}}`
      : JSON.stringify(value);
  const packageId = digest(canonical(manifest)), source = join(f.root, packageId), raw = JSON.stringify(manifest);
  await mkdir(join(source, "model"), { recursive: true });
  await writeFile(join(source, "manifest.json"), raw);
  for (const [name, bytes] of Object.entries(artifacts)) await writeFile(join(source, "model", name), bytes);
  const bytes = Buffer.byteLength(raw) + Object.values(artifacts).reduce((total, value) => total + Buffer.byteLength(value), 0);
  storage = await Storage.open(f.workspace);
  return { ...f, source, packageId, bytes, storage, admit: (limits, extra = {}) => admitLegacyRetrievalModel(storage,
    { id: "mcp:external", canWrite: true }, { sourceRoot: source, packageId,
      authorityId: "test-budget-owner", authorize: () => true, limits, ...extra }) };
}
function freeSpace(t, bytes) {
  const disk = { bytes };
  const mocked = t.mock.method(fs, "statfsSync", () => ({ bavail: BigInt(disk.bytes), bsize: 1n }));
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return disk;
}
async function assertNoAdmission(f) {
  const database = f.storage.connectNative();
  try {
    assert.equal(verifyLegacyRetrievalModels(database, f.workspace).packages.length, 0);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_retrieval_model_selections'").get(), undefined);
  } finally { database.close(); }
  await assert.rejects(readdir(join(f.workspace, "packages/retrieval-models")), { code: "ENOENT" });
}

test("model admission validates limits and refuses verified package bytes above budget without stages or receipts", async t => {
  const f = await admissionFixture(t);
  for (const limits of [null, { maxTotalBytes: 0 }, { maxTotalBytes: 1.5 },
    { maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 }, { minFreeBytes: -1 }, { minFreeBytes: Infinity }, { unknown: 1 }])
    await assert.rejects(f.admit(limits), error => error.code === "INVALID_ARGUMENT");
  await assert.rejects(f.admit({ maxTotalBytes: f.bytes - 1, minFreeBytes: 0 }),
    error => error.code === "LIMIT" && /admission budget/.test(error.message));
  await assertNoAdmission(f);
});

test("model admission reserves explicit free-space headroom before creating stages or receipts", async t => {
  const f = await admissionFixture(t);
  freeSpace(t, f.bytes + 15);
  await assert.rejects(f.admit({ maxTotalBytes: f.bytes, minFreeBytes: 16 }),
    error => error.code === "LIMIT" && /free-space headroom/.test(error.message));
  await assertNoAdmission(f);
});

test("model admission copies a tiny verified package at its exact byte and headroom limits", async t => {
  const f = await admissionFixture(t);
  const disk = freeSpace(t, f.bytes + 16);
  const admitted = await f.admit({ maxTotalBytes: f.bytes, minFreeBytes: 16 });
  assert.equal(admitted.packageId, f.packageId);
  assert.deepEqual(await readdir(join(f.workspace, "packages/retrieval-models")), [f.packageId]);
  assert.equal(await readFile(join(admitted.root, "model/model.safetensors"), "utf8"),
    await readFile(join(f.source, "model/model.safetensors"), "utf8"));
  const database = f.storage.connectNative();
  try { assert.equal(verifyLegacyRetrievalModels(database, f.workspace).packages.length, 1); }
  finally { database.close(); }
  disk.bytes = 0;
  assert.equal((await f.admit({ maxTotalBytes: f.bytes, minFreeBytes: 16 })).packageId, f.packageId,
    "Selecting an already admitted package must not require another staged copy.");
});

test("model admission bounds a source that grows during copying and removes only its uncommitted stage", async t => {
  const f = await admissionFixture(t), source = join(f.source, "model/config.json");
  const originalOpen = fs.openSync, originalRead = fs.readSync;
  let opens = 0, input, changed = false;
  const open = t.mock.method(fs, "openSync", (...args) => {
    const fd = originalOpen(...args);
    if (args[0] === source && ++opens === 3) input = fd;
    return fd;
  });
  const read = t.mock.method(fs, "readSync", (...args) => {
    if (args[0] === input && !changed) {
      changed = true;
      fs.appendFileSync(source, "unexpected growth");
    }
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.admit({ maxTotalBytes: f.bytes, minFreeBytes: 0 }),
      error => error.code === "CONFLICT" && /grew during copying/.test(error.message));
  } finally { open.mock.restore(); read.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(changed, true);
  const database = f.storage.connectNative();
  try {
    assert.equal(verifyLegacyRetrievalModels(database, f.workspace).packages.length, 0);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_retrieval_model_selections'").get(), undefined);
  }
  finally { database.close(); }
  assert.deepEqual(await readdir(join(f.workspace, "packages/retrieval-models")), []);
});
for (const attack of ["unknown-package", "unknown-stage", "root-symlink"]) {
  test(`reserved retrieval-model owner rejects ${attack} at native startup`, async t => {
    const f = await fixture(t);
    await mkdir(join(f.workspace, "packages"));
    if (attack === "root-symlink") await symlink(join(f.workspace, "notes"), join(f.workspace, "packages/retrieval-models"));
    else {
      const path = join(f.workspace, "packages/retrieval-models", attack === "unknown-stage" ? `.stage-${randomUUID()}` : "a".repeat(64));
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "manifest.json"), "{}");
    }
    await assert.rejects(Storage.open(f.workspace));
  });
}

test("backup rejects unreceipted reserved model artifacts added after native startup", async t => {
  const f = await fixture(t);
  const storage = await Storage.open(f.workspace), native = await createNativeRuntime({ storage });
  try {
    const area = join(f.workspace, "packages/retrieval-models", "a".repeat(64));
    await mkdir(area, { recursive: true });
    await writeFile(join(area, "manifest.json"), "{}");
    const target = join(f.root, "must-not-publish");
    await assert.rejects(createWorkspaceBackup(storage, target, { acquireQuiescence: native.acquireWorkspaceQuiescence }));
    await assert.rejects(readdir(target), { code: "ENOENT" });
  } finally { await native.close(); await storage.close(); }
});

test("ordinary existing package files remain byte-preserved without acquiring model authority", async t => {
  const f = await fixture(t), raw = "Ordinary native package; never a model admission.\n";
  await mkdir(join(f.workspace, "packages/example"), { recursive: true });
  await writeFile(join(f.workspace, "packages/example/README.md"), raw);
  const storage = await Storage.open(f.workspace), native = await createNativeRuntime({ storage });
  const backup = join(f.root, "backup"), relocated = join(f.root, "relocated");
  try {
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence });
  } finally { await native.close(); await storage.close(); }
  await restoreWorkspaceBackup(backup, relocated, { nativeRestoreAuthority });
  const restored = await Storage.open(relocated), restoredNative = await createNativeRuntime({ storage: restored });
  try { assert.equal(await readFile(join(relocated, "packages/example/README.md"), "utf8"), raw); }
  finally { await restoredNative.close(); await restored.close(); }
});

test("restore rejects an internally hash-consistent manifest that adds an unreceipted reserved model package", async t => {
  const f = await fixture(t);
  const storage = await Storage.open(f.workspace), native = await createNativeRuntime({ storage });
  const backup = join(f.root, "forged-backup"), target = join(f.root, "must-not-restore");
  try {
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence });
  } finally { await native.close(); await storage.close(); }
  const packagePath = `packages/retrieval-models/${"a".repeat(64)}`;
  await mkdir(join(backup, packagePath), { recursive: true });
  const raw = "{}";
  await writeFile(join(backup, packagePath, "manifest.json"), raw);
  const manifestPath = join(backup, ".pkm-workspace-backup.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.directories.push("packages", "packages/retrieval-models", packagePath);
  manifest.directories.sort();
  manifest.files.push({ path: `${packagePath}/manifest.json`, size: Buffer.byteLength(raw),
    sha256: createHash("sha256").update(raw).digest("hex") });
  manifest.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  manifest.totalBytes += Buffer.byteLength(raw);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restoreWorkspaceBackup(backup, target, { nativeRestoreAuthority }), /Unreceipted native model artifact/);
  await assert.rejects(readdir(target), { code: "ENOENT" });
});
