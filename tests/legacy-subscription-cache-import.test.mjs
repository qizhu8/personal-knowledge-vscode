import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm, symlink, link, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { planLegacyStateImport, stageLegacyStateImport, verifyLegacyStateImport } from "../dist/legacy-state-import.js";
import { initialize, Storage } from "../dist/storage.js";
import { legacyRetrievalSubscriptions } from "../dist/legacy-retrieval-subscriptions.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { subscriptionReadSourceFiles } from "./subscription-reads-fixtures.mjs";
import { planLegacyImport, importLegacyWorkspace } from "../dist/legacy-import.js";
import { createNativeRuntime } from "../dist/native-runtime.js";

async function fixture(t) {
  const root = resolve(`.subscription-cache-import-${randomUUID()}`);
  const source = join(root, "original"), subscription = join(root, "subscription-source"), stage = join(root, "stage");
  await mkdir(source, { recursive: true }); await mkdir(subscription); await initialize(stage);
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (relative, value) => {
    const path = join(subscription, relative); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value));
  };
  for (const [name, value] of Object.entries(subscriptionReadSourceFiles)) await put(name, value);
  const cache = "cache/fixture-remote/fixture-share";
  await put(`${cache}/_subscription.json`, { subscriptionId: "fixture-sub", nodeId: "fixture-remote", shareId: "fixture-share", syncedAt: "2026-01-02" });
  await put(`${cache}/content/notes/Shared.md`, "Evidence in shared cache.\n");
  await put(`${cache}/content/notes/Shared.md.pkm-source.json`, { publisher: "Fixture publisher", revision: "source-7" });
  return { root, source, subscription, stage, cache, put };
}

test("exact admitted subscription bytes, provenance, all eight kinds, binary assets and empty directories survive restart and relocated backup", async t => {
  const f = await fixture(t);
  for (const kind of ["skills", "papers", "prompts", "scripts", "packages", "servers", "recipes"]) {
    await f.put(`${f.cache}/content/${kind}/Example.txt`, `Evidence ${kind}`);
  }
  await f.put(`${f.cache}/content/notes/Shared.assets/image.png`, Buffer.from([137, 80, 78, 71, 0, 255]));
  await mkdir(join(f.subscription, f.cache, "content/notes/empty"), { recursive: true });
  const plan = await planLegacyStateImport(f.source, f.subscription);
  await stageLegacyStateImport(plan, f.stage);
  await verifyLegacyStateImport(plan, f.stage);
  for (const entry of plan.entries) {
    assert.deepEqual(await readFile(entry.source), await readFile(join(f.stage, entry.destination)));
  }
  assert.deepEqual(await readdir(join(f.stage, "subscriptions", f.cache, "content/notes/empty")), []);
  const storage = await Storage.open(f.stage);
  const backup = join(f.root, "backup"), restored = join(f.root, "restored");
  try {
    const corpus = await legacyRetrievalSubscriptions(f.stage);
    assert(corpus.groups.some(group => group.items.some(item => item.path === "Shared.md")));
    assert(!corpus.groups.flatMap(group => group.items).some(item => item.path.includes(".assets")));
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) });
  } finally { await storage.close(); }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
  const reopened = await Storage.open(restored);
  try {
    assert.equal((await legacyRetrievalSubscriptions(restored)).groups.length, 7);
    assert.deepEqual(await readFile(join(restored, "subscriptions", f.cache, "content/notes/Shared.assets/image.png")), Buffer.from([137, 80, 78, 71, 0, 255]));
  } finally { await reopened.close(); }
});

for (const attack of ["foreign-cache", "foreign-provenance", "orphan-sidecar", "pending", "unknown-kind", "symlink", "hardlink", "collision", "removed-member", "pending-status"]) {
  test(`cache importer rejects ${attack} without writing original or stage`, async t => {
    const f = await fixture(t);
    if (attack === "foreign-cache") await f.put("cache/foreign/share/content/notes/Other.md", "foreign");
    if (attack === "foreign-provenance") await f.put(`${f.cache}/content/notes/Shared.md.pkm-source.json`, { nodeId: "foreign" });
    if (attack === "orphan-sidecar") await f.put(`${f.cache}/content/notes/Missing.md.pkm-source.json`, {});
    if (attack === "pending") await f.put("snapshot-pending/control.json", {});
    if (attack === "unknown-kind") await f.put(`${f.cache}/content/unknown/Other.md`, "unknown");
    if (attack === "symlink") await symlink("Shared.md", join(f.subscription, f.cache, "content/notes/Link.md"));
    if (attack === "hardlink") await link(join(f.subscription, f.cache, "content/notes/Shared.md"), join(f.subscription, f.cache, "content/notes/Link.md"));
    if (attack === "collision") await f.put(`${f.cache}/content/notes/shared.md`, "collision");
    if (attack === "removed-member" || attack === "pending-status") {
      const state = structuredClone(subscriptionReadSourceFiles["subscriptions.json"]);
      if (attack === "removed-member") state.subscriptions = [];
      else state.subscriptions[0].status = "pending";
      await f.put("subscriptions.json", state);
    }
    await assert.rejects(planLegacyStateImport(f.source, f.subscription));
    assert.deepEqual((await readdir(f.stage)).sort(), [".pkm-next-workspace", "notes"]);
  });

}

test("offline existing subscriber retains its original readable cache without network authority", async t => {
  const f = await fixture(t);
  const state = structuredClone(subscriptionReadSourceFiles["subscriptions.json"]);
  state.subscriptions[0].status = "offline";
  await f.put("subscriptions.json", state);
  const plan = await planLegacyStateImport(f.source, f.subscription);
  await stageLegacyStateImport(plan, f.stage);
  const corpus = await legacyRetrievalSubscriptions(f.stage);
  assert.equal(corpus.groups[0].items[0].path, "Shared.md");
});

test("cache source content and member inventory races invalidate planned publication", async t => {
  const f = await fixture(t);
  const plan = await planLegacyStateImport(f.source, f.subscription);
  await f.put(`${f.cache}/content/notes/Shared.md`, "changed after planning");
  await assert.rejects(stageLegacyStateImport(plan, f.stage), error => error.code === "SOURCE_CHANGED");
  const next = await planLegacyStateImport(f.source, f.subscription);
  await stageLegacyStateImport(next, f.stage);
  await f.put(`${f.cache}/content/notes/New.md`, "new inventory");
  await assert.rejects(verifyLegacyStateImport(next, f.stage), error => error.code === "SOURCE_CHANGED");
});

test("actual import copies more than 512 cache files, a >2MiB asset and >32MiB total through restart and relocated backup", { timeout: 180_000 }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.source, "notes"));
  const bytes = Buffer.alloc(64 * 1024, 171);
  for (let i = 0; i < 520; i++) await f.put(`${f.cache}/content/notes/Shared.assets/chunk-${i}.bin`, bytes);
  const large = Buffer.alloc(3 * 1024 * 1024 + 17, 205);
  const largePath = `${f.cache}/content/notes/Shared.assets/large.bin`;
  await f.put(largePath, large);
  const plan = await planLegacyImport(f.source, { maxTotalBytes: 1024 }, { subscriptionRoot: f.subscription });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const cacheEntries = plan.statePlan.entries.filter(entry => entry.destination.startsWith("subscriptions/cache/"));
  assert(cacheEntries.length > 512);
  assert(cacheEntries.reduce((sum, entry) => sum + entry.size, 0) > 32 * 1024 * 1024);
  assert(cacheEntries.find(entry => entry.destination.endsWith("/large.bin")).size > 2 * 1024 * 1024);
  const target = join(f.root, "actual-target");
  const pythonExecutable = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
  await importLegacyWorkspace(plan, target, { pythonExecutable });
  const digest = value => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(await readFile(join(target, "subscriptions", largePath))), digest(large));
  const first = await Storage.open(target);
  const firstNative = await createNativeRuntime({ storage: first });
  await firstNative.close(); await first.close();
  const restarted = await Storage.open(target);
  const native = await createNativeRuntime({ storage: restarted });
  const backup = join(f.root, "large-backup"), restored = join(f.root, "large-restored");
  try {
    await createWorkspaceBackup(restarted, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence });
  } finally { await native.close(); await restarted.close(); }
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
  const relocated = await Storage.open(restored);
  const relocatedNative = await createNativeRuntime({ storage: relocated });
  try {
    for (const entry of cacheEntries) {
      assert.equal(digest(await readFile(join(restored, entry.destination))), entry.sha256);
      assert.equal(digest(await readFile(entry.source)), entry.sha256);
    }
  } finally { await relocatedNative.close(); await relocated.close(); }
});

test("actual original cache paths deeper than 64 components import, restart, backup and relocate without an invented traversal ceiling", async t => {
  const f = await fixture(t);
  await mkdir(join(f.source, "notes"));
  const deepPath = `${f.cache}/content/notes/Shared.assets/${Array.from({ length: 68 }, () => "d").join("/")}/deep.bin`;
  await f.put(deepPath, Buffer.from([1, 2, 255]));
  const plan = await planLegacyImport(f.source, {}, { subscriptionRoot: f.subscription });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const target = join(f.root, "deep-target");
  const pythonExecutable = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
  await importLegacyWorkspace(plan, target, { pythonExecutable });
  const storage = await Storage.open(target);
  const native = await createNativeRuntime({ storage });
  const backup = join(f.root, "deep-backup"), restored = join(f.root, "deep-restored");
  try {
    assert.deepEqual(await readFile(join(target, "subscriptions", deepPath)), Buffer.from([1, 2, 255]));
    await assert.rejects(createWorkspaceBackup(storage, join(f.root, "explicit-depth-limited"),
      { acquireQuiescence: native.acquireWorkspaceQuiescence }, { limits: { maxDepth: 32 } }),
      error => error.code === "UNSAFE_PATH" || error.code === "QUOTA_EXCEEDED");
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: native.acquireWorkspaceQuiescence });
  } finally { await native.close(); await storage.close(); }
  await assert.rejects(restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority, limits: { maxDepth: 32 } }));
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
  const relocated = await Storage.open(restored);
  const relocatedNative = await createNativeRuntime({ storage: relocated });
  try {
    assert.deepEqual(await readFile(join(restored, "subscriptions", deepPath)), Buffer.from([1, 2, 255]));
    assert.deepEqual(await readFile(join(f.subscription, deepPath)), Buffer.from([1, 2, 255]));
  } finally { await relocatedNative.close(); await relocated.close(); }
});
