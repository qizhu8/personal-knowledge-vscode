import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  prepareInstalledNativeTodoWorkerFixture, verifyInstalledNativeTodoWorker,
  verifyInstalledNativeTodoWorkerRestored,
} from "./installed-native-todo-worker.mjs";

assert(process.env.PKM_TEST_WORKSPACE, "Run installed-worker helper tests in the existing isolated Linux framework.");
process.umask(0o077);
const installed = resolve("clients/vscode-host");
const recovery = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-component-recovery.js")).href);
const { readTodoBoard } = await import("../../dist/domain/todo-board.js");
const writerPath = resolve("legacy/dist/knowledge/filestore.js");
const hash = value => createHash("sha256").update(value).digest("hex");
const pinnedWriter = { path: writerPath, sha256: hash(await readFile(writerPath)) };
async function fixture(t) {
  const base = join(homedir(), ".local/state/pkm-v5-recovery");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const componentFixture = await recovery.createOriginalMcpColdComponentFixture(join(base, `w-${randomBytes(4).toString("hex")}`));
  t.after(() => rm(componentFixture.directory, { recursive: true, force: true }));
  return componentFixture;
}

test("installed worker preparation requires the exact cold fixture and pinned original writer before custody", async t => {
  const componentFixture = await fixture(t);
  await assert.rejects(prepareInstalledNativeTodoWorkerFixture({ installed, componentFixture }),
    { code: "INSTALLED_TODO_WORKER_PINNED_ORIGINAL_WRITER_REQUIRED" });
  await assert.rejects(prepareInstalledNativeTodoWorkerFixture({ installed, componentFixture,
    legacyWriter: { ...pinnedWriter, sha256: "0".repeat(64) } }), { code: "INSTALLED_TODO_WORKER_ORIGINAL_WRITER_CHANGED" });
  await assert.rejects(prepareInstalledNativeTodoWorkerFixture({ installed, componentFixture: { ...componentFixture },
    legacyWriter: pinnedWriter }), { code: "COMPONENT_FIXTURE_IDENTITY_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), []);
  await mkdir(join(componentFixture.directory, "b0"), { mode: 0o700 });
  await assert.rejects(prepareInstalledNativeTodoWorkerFixture({ installed, componentFixture, legacyWriter: pinnedWriter }),
    { code: "INSTALLED_TODO_WORKER_PRESEAL_PREPARATION_REQUIRED" });
  assert.deepEqual(await readdir(componentFixture.root), []);
});

test("installed worker preparation writes genuine original Board/history/old hash without exposing a token or successful native consent", async t => {
  const componentFixture = await fixture(t);
  const workerFixture = await prepareInstalledNativeTodoWorkerFixture({ installed, componentFixture, legacyWriter: pinnedWriter });
  const bytes = await readFile(join(componentFixture.root, workerFixture.boardPath)), board = readTodoBoard(bytes.toString("utf8"));
  const task = board.items.find(item => item.id === workerFixture.itemId);
  assert.equal(task.ownerId, workerFixture.workerActorId);
  assert.equal(task.state, "Planning");
  assert.match(task.title, /installed worker task/);
  assert(task.history.length >= 2, "the actual original writer must retain creation and historical assignment");
  assert.match(JSON.parse(bytes).workers[workerFixture.workerActorId], /^[a-f0-9]{64}$/);
  assert.equal(hash(bytes), workerFixture.boardSha256);
  assert.equal(hash(await readFile(join(componentFixture.root, workerFixture.notePath))), workerFixture.noteSha256);
  assert.equal(workerFixture.legacyWriterSha256, pinnedWriter.sha256);
  assert.equal(Object.keys(workerFixture).some(key => /token|approval|receipt|nativeGrant/i.test(key)), false);
  assert.equal(Object.isFrozen(workerFixture), true);
  await assert.rejects(prepareInstalledNativeTodoWorkerFixture({ installed, componentFixture, legacyWriter: pinnedWriter }),
    { code: "INSTALLED_TODO_WORKER_ALREADY_PREPARED" });
  await assert.rejects(verifyInstalledNativeTodoWorker({ installed, workerFixture,
    component: { fixture: componentFixture, root: componentFixture.root } }),
  { code: "INSTALLED_TODO_WORKER_COMPONENT_ADAPTER_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTodoWorker({ installed, workerFixture: { ...workerFixture },
    component: { fixture: componentFixture, root: componentFixture.root } }),
  { code: "INSTALLED_TODO_WORKER_ACTUAL_PREPARATION_REQUIRED" });
  await assert.rejects(verifyInstalledNativeTodoWorkerRestored(workerFixture, {
    restoredRoot: join(componentFixture.directory, "restored-b0"), archive: join(componentFixture.root, ".arbitrary-copy"),
  }), { code: "INSTALLED_TODO_WORKER_VERIFIED_EFFECT_REQUIRED" });
});

test("actual cold component is refused before UI when required retained-worker composition or bounded driver input is missing", async t => {
  const componentFixture = await fixture(t);
  const workerFixture = await prepareInstalledNativeTodoWorkerFixture({ installed, componentFixture, legacyWriter: pinnedWriter });
  await mkdir(join(componentFixture.root, ".pkm"), { recursive: true, mode: 0o700 });
  await writeFile(join(componentFixture.root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const cold = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-cold-component.js")).href);
  const identityApi = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-native-identity.js")).href);
  const keys = generateKeyPairSync("ed25519"), profileSha256 = hash("installed-worker-leaf-fixture-profile");
  const identity = identityApi.originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const directory = join(componentFixture.directory, "ipc"); await mkdir(directory, { mode: 0o700 });
  const component = await cold.bootstrapOriginalMcpColdComponent(componentFixture, {
    operatorId: "isolated-installed-worker-leaf-regression", profileSha256,
    limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 4_194_304, maxFileBytes: 2_097_152 },
    attachment: { directory, identity, identitySha256: identity.sha256,
      payloadBuildId: hash("worker-leaf-test-only-payload"), hostEntrySha256: hash("worker-leaf-test-only-host") },
  });
  try {
    assert.equal(component.fixture, componentFixture);
    assert.equal(component.root, workerFixture.root);
    await assert.rejects(verifyInstalledNativeTodoWorker({
      installed, workerFixture, component, port: 0, python: process.execPath,
    }), error => ["INSTALLED_TODO_WORKER_COMPONENT_ADAPTER_REQUIRED", "INSTALLED_TODO_WORKER_DRIVER_LIMITS_REQUIRED"].includes(error.code));
    const db = component.storage.connectNative();
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='original_mcp_domain_workers'").get().n, 0); }
    finally { db.close(); }
    assert.equal(hash(await readFile(join(component.root, workerFixture.boardPath))), workerFixture.boardSha256);
  } finally { await component.close(); }
});
