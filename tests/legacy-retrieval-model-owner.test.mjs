import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

async function fixture(t) {
  const root = resolve(`.retrieval-model-owner-${randomUUID()}`), workspace = join(root, "workspace");
  await mkdir(root); await initialize(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace };
}
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
