import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { Storage, initialize } from "../dist/storage.js";
import { acquireLinuxRootWriterFence, markLinuxRootNextOwned } from "../dist/linux-root-writer-fence.js";

const testsRoot = dirname(fileURLToPath(import.meta.url));
const child = join(testsRoot, "linux-root-writer-fence-child.mjs");
const pythonChild = join(testsRoot, "linux-root-writer-python-child.py");
const extensionLockModule = resolve(testsRoot, "../legacy/dist/runtime/linux-root-writer-fence.js");
const resourcesRoot = resolve(testsRoot, "../legacy/resources");
const legacyStore = createRequire(import.meta.url)("../legacy/dist/knowledge/filestore.js");
const legacyStorage = createRequire(import.meta.url)("../legacy/dist/knowledge/storage.js");
const privacy = createRequire(import.meta.url)("../legacy/dist/knowledge/content-privacy.js");
const groups = createRequire(import.meta.url)("../legacy/dist/knowledge/knowledge-groups.js");
const classification = createRequire(import.meta.url)("../legacy/dist/knowledge/asset-classification.js");
const { KnowledgeInventoryManager } = createRequire(import.meta.url)("../legacy/dist/knowledge/knowledge-inventory.js");
const { KnowledgeV1Migration } = createRequire(import.meta.url)("../legacy/dist/knowledge/knowledge-migration.js");
const legacyFence = createRequire(import.meta.url)("../legacy/dist/runtime/linux-root-writer-fence.js");
const lockDirectoryName = ".pkm-next-root-adoption-locks";
const rootHash = root => createHash("sha256").update(root).digest("hex").slice(0, 40);
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for fixture marker: ${file}`);
}

function start(mode, root, readyPath, timeout) {
  return spawn(process.execPath, [child, mode, root, readyPath,
    mode === "legacy" ? extensionLockModule : resolve(testsRoot, "../dist/storage.js"),
    String(timeout)], { stdio: "ignore" });
}

function startPython(root, readyPath, holdSeconds, lockTimeout) {
  return spawn(process.env.PYTHON || "python3", [pythonChild, root, readyPath, String(holdSeconds), String(lockTimeout)],
    { stdio: "ignore", env: { ...process.env, PYTHONPATH: resourcesRoot } });
}

async function waitForClose(processHandle) {
  while (processHandle.exitCode === null && processHandle.signalCode === null) await delay(10);
  return { code: processHandle.exitCode, signal: processHandle.signalCode };
}

async function cleanupRoot(root) {
  await rm(root, { recursive: true, force: true });
  const directory = join(dirname(root), lockDirectoryName);
  const prefix = rootHash(root);
  try {
    for (const name of await readdir(directory)) {
      if (name.startsWith(prefix + ".")) await rm(join(directory, name), { recursive: true, force: true });
    }
    await rmdir(directory);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  }
}

test("legacy MCP-style writers and Next acquisition serialize across real Linux processes", {
  skip: process.platform !== "linux", timeout: 15000,
}, async t => {
  const root = resolve(testsRoot, `.linux-root-fence-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => cleanupRoot(root));

  const activeFile = join(root, "legacy-active");
  const legacy = start("legacy", root, activeFile, 1000);
  assert.equal(await waitForFile(activeFile), "entered");
  await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
  assert.equal(await waitForClose(legacy).then(result => result.code), 0);

  const recovered = await acquireLinuxRootWriterFence(root, 1500);
  try { recovered.assertHeld(); }
  finally { await recovered.release(); }
});

test("a fence stops authorizing work as soon as release begins", {
  skip: process.platform !== "linux", timeout: 10000,
}, async t => {
  const root = resolve(testsRoot, `.linux-root-fence-release-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => cleanupRoot(root));
  const fence = await acquireLinuxRootWriterFence(root);
  fence.assertHeld();
  const release = fence.release();
  assert.throws(() => fence.assertHeld(), /fence was lost/i);
  await release;
  assert.throws(() => fence.assertHeld(), /fence was lost/i);
});

test("synchronous legacy fence release ends authorization and frees the lock", {
  skip: process.platform !== "linux", timeout: 10000,
}, async t => {
  const root = resolve(testsRoot, `.linux-root-fence-legacy-release-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => cleanupRoot(root));
  const held = legacyFence.acquireLinuxRootWriterFence(root, "shared");
  try {
    held.assertHeld();
    await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
  } finally { held.release(); }
  assert.throws(() => held.assertHeld(), /fence was lost/i);
  const next = await acquireLinuxRootWriterFence(root, 1500);
  await next.release();

  const ready = join(root, "legacy-active");
  const owner = start("legacy", root, ready, 30_000);
  try {
    assert.equal(await waitForFile(ready), "entered");
    await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
    owner.kill("SIGKILL");
    assert.equal((await waitForClose(owner)).signal, "SIGKILL");
    const recovered = await acquireLinuxRootWriterFence(root, 4000);
    await recovered.release();
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await waitForClose(owner);
  }
});

test("fenced no-replace moves preserve collisions and hold the kernel fence through parent death", {
  skip: process.platform !== "linux", timeout: 15000,
}, async t => {
  const root = resolve(testsRoot, `.linux-root-fence-rename-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => cleanupRoot(root));
  const source = join(root, "source"), destination = join(root, "destination");
  await mkdir(source);
  await writeFile(join(source, "asset"), "original");
  await mkdir(destination);
  const fence = await acquireLinuxRootWriterFence(root);
  try {
    assert.throws(() => fence.renameNoReplaceWithinRoot(source, destination), /Destination already exists/);
    assert.equal(await readFile(join(source, "asset"), "utf8"), "original");
    assert.throws(() => fence.renameNoReplaceWithinRoot(source, dirname(root)), /inside the fenced root/);
    await symlink(dirname(root), join(root, "link"));
    assert.throws(() => fence.renameNoReplaceWithinRoot(source, join(root, "link/escape")), /real directories/);
  } finally { await fence.release(); }
  await rmdir(destination);
  const ready = join(root, "helper-ready"), python = join(root, "delayed-python");
  await writeFile(python, `#!/bin/sh\nprintf ready > '${ready}'\nsleep 1.5\nexec python3 "$@"\n`);
  await chmod(python, 0o700);
  const script = `
    const { acquireLinuxRootWriterFence } = await import(process.argv[1]);
    const fence = await acquireLinuxRootWriterFence(process.argv[2]);
    fence.renameNoReplaceWithinRoot(process.argv[3], process.argv[4], process.argv[5]);
    await fence.release();
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", script,
    new URL("../dist/linux-root-writer-fence.js", import.meta.url).href, root, source, destination, python],
  { stdio: "ignore" });
  try {
    assert.equal(await waitForFile(ready), "ready");
    owner.kill("SIGKILL");
    assert.equal((await waitForClose(owner)).signal, "SIGKILL");
    await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
    const recovered = await acquireLinuxRootWriterFence(root, 4000);
    try { assert.equal(await readFile(join(destination, "asset"), "utf8"), "original"); }
    finally { await recovered.release(); }
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    await waitForClose(owner);
  }
});

test("legacy MCP Python flock interoperates with the Next exclusive fence", {
  skip: process.platform !== "linux" || spawnSync(process.env.PYTHON || "python3", ["--version"]).error !== undefined,
  timeout: 15000,
}, async t => {
  const root = resolve(testsRoot, `.linux-root-fence-python-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => cleanupRoot(root));

  const activeFile = join(root, "legacy-active");
  const legacy = startPython(root, activeFile, 0.6, 2);
  assert.equal(await waitForFile(activeFile), "entered");
  await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
  assert.equal((await waitForClose(legacy)).code, 0);

  const next = await acquireLinuxRootWriterFence(root, 1500);
  try { await markLinuxRootNextOwned(root, next); }
  finally { await next.release(); }
  const afterHandoffFile = join(root, "legacy-after-handoff");
  const afterHandoff = startPython(root, afterHandoffFile, 0, 0.15);
  assert.equal((await waitForClose(afterHandoff)).code, 23);
  assert.match(await readFile(afterHandoffFile, "utf8"), /handed to next-server/);
});

test("legacy folder creation respects the durable Next writer fence", {
  skip: process.platform !== "linux", timeout: 15000,
}, async t => {
  const root = resolve(testsRoot, `.linux-root-fence-folders-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => cleanupRoot(root));
  legacyStore.setStorePath(root);
  const areas = ["skills", "notes", "papers", "prompts", "scripts"];
  for (const area of areas) {
    assert.equal(legacyStore.folderCreate(area, "before/child"), true);
    assert.equal(await readFile(join(root, area, "before", "child", ".gitkeep"), "utf8"), "");
  }
  const fence = await acquireLinuxRootWriterFence(root);
  try { await markLinuxRootNextOwned(root, fence); }
  finally { await fence.release(); }
  for (const area of areas) {
    assert.equal(legacyStore.folderCreate(area, "after/child"), false);
    await assert.rejects(access(join(root, area, "after")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, area, "before", "child", ".gitkeep"), "utf8"), "");
  }
});

test("legacy package import and deletion respect Next ownership", {
  skip: process.platform !== "linux", timeout: 15000,
}, async t => {
  const root = resolve(testsRoot, `.linux-root-fence-package-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => cleanupRoot(root));
  legacyStorage.setStorePath(root);
  const item = name => [{ name, files: [{ path: "content.txt", content: "original" }] }];
  assert.equal(legacyStorage.packageImport(item("keep")), 1);
  assert.equal(legacyStorage.packageImport(item("delete")), 1);
  assert.equal(legacyStorage.packageDelete("delete"), true);
  const fence = await acquireLinuxRootWriterFence(root);
  try { await markLinuxRootNextOwned(root, fence); }
  finally { await fence.release(); }
  assert.throws(() => legacyStorage.packageImport(item("after")), /handed to next-server/i);
  assert.throws(() => legacyStorage.packageDelete("keep"), /handed to next-server/i);
  await assert.rejects(access(join(root, "packages", "after")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "packages", "keep", "content.txt"), "utf8"), "original");
});

test("legacy fallback assets, folder pins and permanent Skill Trash deletion respect Next ownership", {
  skip: process.platform !== "linux", timeout: 15000,
}, async t => {
  const root = resolve(testsRoot, `.linux-root-fence-extra-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => cleanupRoot(root));
  legacyStore.setStorePath(root);
  privacy.setPrivacyStoreRoot(root);
  groups.setKnowledgeGroupStoreRoot(root);
  assert.equal(legacyStore.noteSetFolderPinned("folder", true), true);
  privacy.setTopLevelPrivacy("notes", "folder", true);
  groups.knowledgeGroupCreate("notes", "Group", "#123456");
  const noteAsset = legacyStore.saveNoteAsset(Buffer.from("note").toString("base64"), "png");
  const paperAsset = legacyStore.savePaperFile(Buffer.from("paper").toString("base64"), "pdf");
  const trash = join(root, "skills", ".trash", "1-ab");
  await mkdir(trash, { recursive: true });
  await writeFile(join(trash, "metadata.json"), JSON.stringify({
    id: "1-ab", kind: "skill", name: "sample", originalPath: "sample.md", deletedAt: "2020",
  }));
  await writeFile(join(trash, "payload"), "original");
  const noteTrash = join(root, "notes", ".trash", "1-cd");
  await mkdir(noteTrash, { recursive: true });
  await writeFile(join(noteTrash, "metadata.json"), JSON.stringify({
    id: "1-cd", kind: "item", name: "note", originalPath: "note.md", deletedAt: "2020",
  }));
  await writeFile(join(noteTrash, "payload"), "original");
  const fence = await acquireLinuxRootWriterFence(root);
  try { await markLinuxRootNextOwned(root, fence); }
  finally { await fence.release(); }
  for (const action of [
    () => legacyStore.noteSetFolderPinned("folder", false),
    () => legacyStore.noteMoveFolder("folder", "other"),
    () => legacyStore.saveNoteAsset(Buffer.from("after").toString("base64"), "png"),
    () => legacyStore.savePaperFile(Buffer.from("after").toString("base64"), "pdf"),
    () => legacyStore.skillTrashDelete("1-ab"),
    () => legacyStore.skillTrashEmpty(),
    () => legacyStore.knowledgeTrashDelete("notes", "1-cd"),
    () => legacyStore.knowledgeTrashEmpty("notes"),
    () => legacyStore.migrateLegacyMyIdeasFolder(),
    () => privacy.setTopLevelPrivacy("notes", "folder", false),
    () => privacy.renameTopLevelPrivacy("notes", "folder", "renamed"),
    () => groups.knowledgeGroupCreate("notes", "Other", "#123456"),
    () => classification.applyAssetClassification(root, {}, []),
    () => classification.rollbackAssetClassification(root, "bad"),
  ]) assert.throws(action, /handed to next-server/i);
  assert.equal(await readFile(join(root, "notes", noteAsset), "utf8"), "note");
  assert.equal(await readFile(join(root, "papers", paperAsset), "utf8"), "paper");
  assert.equal(await readFile(join(trash, "payload"), "utf8"), "original");
  assert.equal(await readFile(join(noteTrash, "payload"), "utf8"), "original");
  assert.deepEqual(JSON.parse(await readFile(join(root, "notes", ".pk-meta.json"), "utf8")).pinnedFolders, ["folder"]);
  assert.deepEqual(privacy.privateTopLevels("notes"), ["folder"]);
  assert(groups.knowledgeGroupSnapshot("notes", []).groups.some(group => group.name === "Group"));
});

test("legacy inventory and migration writes retain the fence through their complete operations", {
  skip: process.platform !== "linux", timeout: 15000,
}, async t => {
  const root = resolve(testsRoot, `.linux-root-fence-inventory-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => cleanupRoot(root));
  const worker = join(root, "fixture-worker.cjs"), ready = join(root, "worker-ready");
  await writeFile(worker, `const { parentPort } = require("node:worker_threads");
    require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    parentPort.postMessage({event:"complete", entries:{}});`);
  const state = join(root, ".inventory");
  const inventory = new KnowledgeInventoryManager(root, state, worker);
  const migration = new KnowledgeV1Migration(root);
  const receipt = migration.preview();
  migration.backup(receipt.sourceDigest);
  const pending = inventory.refresh();
  assert.equal(await waitForFile(ready), "ready");
  await assert.rejects(acquireLinuxRootWriterFence(root, 150), /Timed out|acquire.*fence/i);
  await pending;
  const before = await readFile(join(state, "manifest.json"), "utf8");
  const fence = await acquireLinuxRootWriterFence(root);
  try { await markLinuxRootNextOwned(root, fence); }
  finally { await fence.release(); }
  await assert.rejects(inventory.refresh(), /handed to next-server/i);
  assert.throws(() => new KnowledgeInventoryManager(root, join(root, ".other"), worker), /handed to next-server/i);
  for (const operation of ["backup", "stage", "verify", "cutover", "rollback"]) {
    assert.throws(() => migration[operation](receipt.sourceDigest), /handed to next-server/i);
  }
  assert.equal(await readFile(join(state, "manifest.json"), "utf8"), before);
});

test("Storage holds the exclusive fence for its lifetime and crash releases the kernel lock", {
  skip: process.platform !== "linux", timeout: 20000,
}, async t => {
  const root = resolve(testsRoot, `.linux-root-fence-storage-${randomUUID()}`);
  await initialize(root);
  t.after(() => cleanupRoot(root));

  const storage = await Storage.open(root);
  const blockedFile = join(testsRoot, `.linux-root-fence-blocked-${randomUUID()}`);
  const blocked = start("legacy", root, blockedFile, 150);
  const blockedResult = await waitForClose(blocked);
  assert.equal(blockedResult.code, 23);
  assert.match(await readFile(blockedFile, "utf8"), /blocked:/);
  await rm(blockedFile, { force: true });

  await storage.close();
  const afterCloseFile = join(testsRoot, `.linux-root-fence-after-close-${randomUUID()}`);
  const afterClose = start("legacy", root, afterCloseFile, 200);
  assert.equal((await waitForClose(afterClose)).code, 23);
  assert.match(await readFile(afterCloseFile, "utf8"), /handed to next-server/);
  await rm(afterCloseFile, { force: true });

  const crashRoot = resolve(testsRoot, `.linux-root-fence-crash-${randomUUID()}`);
  await mkdir(crashRoot, { mode: 0o700 });
  const activeFile = join(crashRoot, "legacy-active");
  const crashed = start("legacy", crashRoot, activeFile, 10000);
  t.after(() => cleanupRoot(crashRoot));
  assert.equal(await waitForFile(activeFile), "entered");
  crashed.kill("SIGKILL");
  assert.equal((await waitForClose(crashed)).signal, "SIGKILL");

  const recovered = await acquireLinuxRootWriterFence(crashRoot, 3000);
  try { recovered.assertHeld(); }
  finally { await recovered.release(); }

  const resumedFile = join(crashRoot, "legacy-resumed");
  const resumed = start("legacy", crashRoot, resumedFile, 0);
  assert.equal((await waitForClose(resumed)).code, 0);
  assert.equal(await readFile(resumedFile, "utf8"), "entered");

  const storageCrashRoot = resolve(testsRoot, `.linux-root-fence-storage-crash-${randomUUID()}`);
  await initialize(storageCrashRoot);
  t.after(() => cleanupRoot(storageCrashRoot));
  const crashedOwnerFile = join(storageCrashRoot, "storage-owner");
  const crashedOwner = start("next", storageCrashRoot, crashedOwnerFile, 10000);
  assert.equal(await waitForFile(crashedOwnerFile), "entered");
  crashedOwner.kill("SIGKILL");
  assert.equal((await waitForClose(crashedOwner)).signal, "SIGKILL");
  await rm(crashedOwnerFile, { force: true });

  const recoveredOwnerFile = join(storageCrashRoot, "storage-recovered");
  const recoveredOwner = start("next", storageCrashRoot, recoveredOwnerFile, 50);
  assert.equal(await waitForFile(recoveredOwnerFile), "entered");
  assert.equal((await waitForClose(recoveredOwner)).code, 0);
});
