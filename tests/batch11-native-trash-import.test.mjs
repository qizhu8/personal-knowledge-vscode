import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import test from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNativeLegacyTrashAccess, publishLegacyTrashWorkspaceImport } from "../dist/host-composition-legacy-trash.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { planLegacyTrashImport } from "../dist/legacy-trash-import.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { importLegacyWorkspace, planLegacyImport, recoverLegacyImportOutcome } from "../dist/legacy-import.js";
import { Storage } from "../dist/storage.js";
import { fixture as originalProjectSource, hashes as sourceHashes } from "./batch09-original-control-fixtures.mjs";
import { readLegacyProjectControl } from "../dist/legacy-control-import.js";

const actor = { id: "batch11-trash-owner", canWrite: true };
const originalId = "1717243800000-a1b2c3d4e5";
const deletedAt = "2024-06-01T10:50:00.000Z";
const assetBytes = Buffer.from([0, 0xff, 0x31, 0x0a, 0x80]);
const pythonExecutable = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const sourceBytes = Buffer.from("---\nschema: pkm.knowledge/v1\ndocumentId: original-note\nrevision: 1\ndeleted: false\naliases: []\n---\n# Original note\n\nOpaque imported payload.\n");
const deletionBytes = Buffer.from(JSON.stringify({
  schema: 1, records: [
    { path: "notes/original.md", deletedAt },
    { path: "notes/original.assets/image.bin", deletedAt },
  ],
}));
const nativeScope = { excludedRootNames: [".pkm", ".pkm-next-workspace"], excludedStateNames: [] };
const hash = value => createHash("sha256").update(value).digest("hex");
const require = createRequire(import.meta.url), originalModules = new Map();
function original(path) {
  if (originalModules.has(path)) return originalModules.get(path).exports;
  const mod = { exports: {} }; originalModules.set(path, mod);
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: path })(
    name => {
      if (!name.startsWith(".")) return require(name);
      const next = resolve(dirname(path), name);
      return original(existsSync(`${next}.ts`) ? `${next}.ts` : join(next, "index.ts"));
    }, mod, mod.exports, path, dirname(path));
  return mod.exports;
}
const originalRepo = resolve(import.meta.dirname, "../legacy");

function transaction(database, work) {
  database.exec("BEGIN IMMEDIATE");
  try { const result = work(); database.exec("COMMIT"); return result; }
  catch (error) { database.exec("ROLLBACK"); throw error; }
}

async function makeSource(root) {
  const bucket = join(root, "notes", ".trash", originalId);
  await Promise.all([
    mkdir(join(root, "skills"), { recursive: true }),
    mkdir(join(root, "papers"), { recursive: true }),
    mkdir(join(root, ".pkm", "state"), { recursive: true }),
    mkdir(bucket, { recursive: true }),
  ]);
  const metadata = { id: originalId, kind: "item", name: "Original note", originalPath: "original.md", deletedAt,
    assetsPath: "original.assets" };
  await mkdir(join(bucket, "assets"), { recursive: true });
  await writeFile(join(bucket, "metadata.json"), JSON.stringify(metadata));
  await writeFile(join(bucket, "payload"), sourceBytes);
  await writeFile(join(bucket, "assets", "image.bin"), assetBytes);
  await writeFile(join(root, ".pkm", "state", "knowledge-deletions.json"), deletionBytes);
}

test("permanent adopted Trash delete/empty enforce HTTP/MCP policy and survive native startup and shared backup", { timeout: 60_000 }, async t => {
  const parent = resolve("tests", `.trash-purge-transport-${randomUUID()}`);
  const source = join(parent, "source"), destination = join(parent, "workspace"), stage = join(parent, "stage");
  await mkdir(parent, { recursive: true });
  let storage, runtime, http, mcp, client;
  const stop = async () => {
    await client?.close(); client = undefined;
    await mcp?.close(); mcp = undefined;
    if (http) await new Promise(resolve => http.server.close(resolve));
    http = undefined;
    await runtime?.close(); runtime = undefined;
    await storage?.close(); storage = undefined;
  };
  t.after(async () => { await stop(); await rm(parent, { recursive: true, force: true }); });
  await makeSource(source);
  const secondId = "1717243800001-b1b2c3d4e5";
  await cp(join(source, "notes/.trash", originalId), join(source, "notes/.trash", secondId), { recursive: true });
  const secondMetadata = JSON.parse(await readFile(join(source, "notes/.trash", secondId, "metadata.json"), "utf8"));
  await writeFile(join(source, "notes/.trash", secondId, "metadata.json"), JSON.stringify({
    ...secondMetadata, id: secondId, originalPath: "second.md", assetsPath: "second.assets",
  }));
  await writeFile(join(source, "notes/.trash", secondId, "payload"),
    sourceBytes.toString("utf8").replace("documentId: original-note", "documentId: second-note"));
  const history = JSON.parse(deletionBytes.toString("utf8"));
  history.records.push({ path: "notes/second.md", deletedAt }, { path: "notes/second.assets/image.bin", deletedAt });
  await writeFile(join(source, ".pkm/state/knowledge-deletions.json"), JSON.stringify(history));
  const plan = await planLegacyTrashImport(source), workspaceId = randomUUID();
  const authority = { source, destination, stage, workspaceId, actorId: actor.id,
    planSha256: plan.planSha256, layoutVersion: "pkm.trash-lifecycle/v1" };
  await publishLegacyTrashWorkspaceImport(plan, authority, nativeScope);
  let allowed = true;
  const authorize = (id, operation) => id === actor.id
    && (!["knowledge.trash.delete", "knowledge.trash.empty"].includes(operation) || allowed);
  const policy = { trustedImportPlanSha256: plan.planSha256, snapshotScope: nativeScope, authorize };
  storage = await Storage.open(destination);
  runtime = await createNativeRuntime({ storage, legacyTrash: { ...policy, import: { plan, authority } } });
  http = await startHttp(runtime.core, "synthetic-trash-purge-token-000000000000", actor, 0);
  const callHttp = async (operation, args) => {
    const response = await fetch(`${http.url}/v1/capability_call`, {
      method: "POST",
      headers: { authorization: "Bearer synthetic-trash-purge-token-000000000000", "content-type": "application/json" },
      body: JSON.stringify({ operation, version: 1, arguments: args }),
    });
    return { status: response.status, body: await response.json() };
  };
  const args = { operationId: randomUUID(), area: "notes", originalId };
  const readonly = await runtime.core.dispatch("capability_call", {
    operation: "knowledge.trash.delete.original", version: 1, arguments: args,
  }, { ...actor, canWrite: false });
  assert.equal(readonly.error.code, "ACCESS_DENIED");
  allowed = false;
  const denied = await callHttp("knowledge.trash.delete.original", args);
  assert.notEqual(denied.status, 200);
  allowed = true;
  const [deleted, concurrentReplay] = await Promise.all([
    callHttp("knowledge.trash.delete.original", args),
    callHttp("knowledge.trash.delete.original", args),
  ]);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(concurrentReplay.status, 200, JSON.stringify(concurrentReplay.body));
  assert.deepEqual(concurrentReplay.body.result, deleted.body.result);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = await startMcp(runtime.core, actor, serverTransport);
  client = new Client({ name: "trash-purge-test", version: "1" });
  await client.connect(clientTransport);
  const emptyArgs = { operationId: randomUUID(), area: "notes" };
  const empty = await client.callTool({ name: "capability_call", arguments: {
    operation: "knowledge.trash.empty.original", version: 1, arguments: emptyArgs,
  } });
  assert.notEqual(empty.isError, true, JSON.stringify(empty));
  const invoke = async (method, operation, args) => {
    const response = await runtime.core.dispatch(method, { operation, version: 1, arguments: args }, actor);
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result;
  };
  assert.deepEqual((await invoke("capability_read", "knowledge.trash.list", {})).items, []);
  await stop();
  storage = await Storage.open(destination);
  runtime = await createNativeRuntime({ storage, legacyTrash: policy });
  assert.deepEqual((await invoke("capability_read", "knowledge.trash.list", {})).items, []);
  const replay = await invoke("capability_call", "knowledge.trash.delete.original", args);
  assert.equal(replay.count, 1);
  assert.equal((await invoke("capability_call", "knowledge.trash.empty.original", emptyArgs)).count, 1);
  const hostFactory = async (root, id, database, external) => {
    const ownedStorage = root === storage?.workspaceRoot() ? storage : await Storage.open(root);
    const db = database ?? ownedStorage.connectNative();
    const composed = createNativeLegacyTrashAccess({
      database: db, storage: ownedStorage, root, workspaceId: id,
      policy: { ...policy, trustedImportPlanSha256: external.trustedImportPlanSha256, snapshotScope: external.snapshotScope },
      transaction: work => transaction(db, work), reconcileIndex() {}, assertOperationAvailable() {},
    });
    return { ...composed.host, close: async () => {
      if (!database) db.close();
      if (ownedStorage !== storage) await ownedStorage.close();
    } };
  };
  const backupPath = join(parent, "backup"), restoredRoot = join(parent, "restored");
  const backupPolicy = { ...policy, actorId: actor.id, hostFactory };
  await runtime.close(); runtime = undefined;
  await createWorkspaceBackup(storage, backupPath, {
    acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
  }, { legacyTrash: backupPolicy });
  const expectedManifestSha256 = hash(await readFile(join(backupPath, ".pkm-workspace-backup.json")));
  await stop();
  await restoreWorkspaceBackup(backupPath, restoredRoot, {
    nativeRestoreAuthority, legacyTrash: { ...backupPolicy, expectedManifestSha256 },
  });
  storage = await Storage.open(restoredRoot);
  runtime = await createNativeRuntime({ storage, legacyTrash: policy });
  assert.deepEqual((await invoke("capability_read", "knowledge.trash.list", {})).items, []);
  assert.equal((await invoke("capability_call", "knowledge.trash.delete.original", args)).count, 1);
});

test("native startup recovers a partial Windows-style sharing failure only with the exact actor and current grant", { timeout: 60_000 }, async t => {
  const parent = resolve("tests", `.trash-purge-recovery-${randomUUID()}`);
  const source = join(parent, "source"), destination = join(parent, "workspace"), stage = join(parent, "stage");
  await mkdir(parent, { recursive: true });
  let storage, runtime;
  t.after(async () => {
    await runtime?.close();
    await storage?.close();
    await rm(parent, { recursive: true, force: true });
  });
  await makeSource(source);
  const plan = await planLegacyTrashImport(source), workspaceId = randomUUID();
  const authority = { source, destination, stage, workspaceId, actorId: actor.id,
    planSha256: plan.planSha256, layoutVersion: "pkm.trash-lifecycle/v1" };
  await publishLegacyTrashWorkspaceImport(plan, authority, nativeScope);
  let allowed = true;
  const policy = { trustedImportPlanSha256: plan.planSha256, snapshotScope: nativeScope,
    authorize: id => allowed && id === actor.id };
  storage = await Storage.open(destination);
  runtime = await createNativeRuntime({ storage, legacyTrash: { ...policy, import: { plan, authority } } });
  const args = { operationId: randomUUID(), area: "notes", originalId };
  const bucket = join(destination, "notes/.trash", plan.entries[0].runtimeId);
  const originalRm = fs.promises.rm;
  let attempts = 0;
  fs.promises.rm = async (target, options) => {
    if (target !== bucket) return originalRm(target, options);
    if (++attempts === 1) await originalRm(join(bucket, "assets/image.bin"));
    throw Object.assign(new Error("synthetic Windows sharing violation"), { code: "EPERM" });
  };
  syncBuiltinESMExports();
  try {
    const failed = await runtime.core.dispatch("capability_call", {
      operation: "knowledge.trash.delete.original", version: 1, arguments: args,
    }, actor);
    assert.equal(failed.error.code, "TRASH_DELETE_FAILED");
    assert.equal(failed.error.effect, "unknown");
    assert.match(failed.error.message, /EPERM.*remains pending/);
    assert.equal(attempts, 8);
  } finally { fs.promises.rm = originalRm; syncBuiltinESMExports(); }
  await runtime.close(); runtime = undefined;
  await storage.close();
  await assert.rejects(Storage.open(destination), error => error.code === "RECOVERY_CONFLICT");
  storage = await Storage.open(destination, { deferRecovery: true });
  await assert.rejects(createNativeRuntime({ storage, legacyTrash: policy }), /exact externally authorized actor/);
  allowed = false;
  await assert.rejects(createNativeRuntime({ storage, legacyTrash: { ...policy, recoveryActorId: actor.id } }),
    error => error.code === "ACCESS_DENIED");
  allowed = true;
  runtime = await createNativeRuntime({ storage, legacyTrash: { ...policy, recoveryActorId: actor.id } });
  const listing = await runtime.core.dispatch("capability_read", {
    operation: "knowledge.trash.list", version: 1, arguments: {},
  }, actor);
  assert.equal(listing.error, undefined);
  assert.deepEqual(listing.result.items, []);
  const replay = await runtime.core.dispatch("capability_call", {
    operation: "knowledge.trash.delete.original", version: 1, arguments: args,
  }, actor);
  assert.equal(replay.error, undefined);
  assert.equal(replay.result.count, 1);
});

test("nested original Trash with missing parents restores through HTTP, replays through MCP and survives restart", async t => {
  const parent = resolve("tests", `.trash-parent-transport-${randomUUID()}`);
  const source = join(parent, "source"), destination = join(parent, "workspace"), stage = join(parent, "stage");
  await makeSource(source);
  const bucket = join(source, "notes/.trash", originalId);
  const metadata = JSON.parse(await readFile(join(bucket, "metadata.json"), "utf8"));
  metadata.originalPath = "Missing/Deep/original.md";
  metadata.assetsPath = "Missing/Deep/original.assets";
  await writeFile(join(bucket, "metadata.json"), JSON.stringify(metadata));
  const history = JSON.parse(deletionBytes);
  for (const record of history.records) record.path = record.path.replace("notes/", "notes/Missing/Deep/");
  await writeFile(join(source, ".pkm/state/knowledge-deletions.json"), JSON.stringify(history));
  const plan = await planLegacyTrashImport(source), workspaceId = randomUUID();
  const authority = { source, destination, stage, workspaceId, actorId: actor.id,
    planSha256: plan.planSha256, layoutVersion: "pkm.trash-lifecycle/v1" };
  await publishLegacyTrashWorkspaceImport(plan, authority, nativeScope);
  const policy = { trustedImportPlanSha256: plan.planSha256, snapshotScope: nativeScope,
    authorize: (id, operation) => id === actor.id && ["knowledge.trash.adopt", "knowledge.trash.list", "knowledge.trash.restore"].includes(operation) };
  let storage, runtime, http, mcp, client;
  const close = async () => {
    await client?.close(); client = undefined;
    await mcp?.close(); mcp = undefined;
    if (http) await new Promise(resolve => http.server.close(resolve));
    http = undefined;
    await runtime?.close(); runtime = undefined;
    await storage?.close(); storage = undefined;
  };
  t.after(async () => { await close(); await rm(parent, { recursive: true, force: true }); });
  storage = await Storage.open(destination);
  runtime = await createNativeRuntime({ storage, legacyTrash: { ...policy, import: { plan, authority } } });
  assert.equal(existsSync(join(destination, "notes/Missing")), false);
  http = await startHttp(runtime.core, "synthetic-trash-parent-test-token-00000000", actor, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = await startMcp(runtime.core, actor, serverTransport);
  client = new Client({ name: "trash-parent-test", version: "1" });
  await client.connect(clientTransport);
  const args = { operationId: randomUUID(), area: "notes", originalId };
  const request = { operation: "knowledge.trash.restore.original", version: 1, arguments: args };
  const response = await fetch(`${http.url}/v1/capability_call`, {
    method: "POST", headers: { authorization: "Bearer synthetic-trash-parent-test-token-00000000", "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.error, undefined);
  assert.equal(result.result.path, "Missing/Deep/original.md");
  assert.deepEqual(await readFile(join(destination, "notes/Missing/Deep/original.md")), sourceBytes);
  assert.deepEqual(await readFile(join(destination, "notes/Missing/Deep/original.assets/image.bin")), assetBytes);
  const replay = await client.callTool({ name: "capability_call", arguments: request });
  assert.notEqual(replay.isError, true);
  assert.deepEqual(replay.structuredContent.result, result.result);
  await close();
  storage = await Storage.open(destination);
  runtime = await createNativeRuntime({ storage, legacyTrash: policy });
  const restarted = await runtime.core.dispatch("capability_call", request, actor);
  assert.equal(restarted.error, undefined);
  assert.deepEqual(restarted.result, result.result);
});

test("original trash import restores through Core HTTP/MCP, retains history, and rebinds backup lineage", { timeout: 60_000 }, async t => {
  const parent = resolve("tests", `.batch11-trash-${randomUUID()}`);
  const source = join(parent, "original-source"), destination = join(parent, "native-workspace");
  const stage = join(parent, "native-workspace.stage"), backupPath = join(parent, "backup");
  const restored = join(parent, "restored-workspace");
  await mkdir(parent, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  await makeSource(source);
  const plan = await planLegacyTrashImport(source);
  const workspaceId = randomUUID();
  const authority = { source, destination, stage, workspaceId, actorId: actor.id,
    planSha256: plan.planSha256, layoutVersion: "pkm.trash-lifecycle/v1" };
  const occupied = join(parent, "occupied-workspace"), occupiedStage = join(parent, "occupied-workspace.stage");
  await mkdir(occupied);
  await writeFile(join(occupied, "sentinel"), "never replace");
  await assert.rejects(publishLegacyTrashWorkspaceImport(plan, { ...authority,
    destination: occupied, stage: occupiedStage,
  }, nativeScope), error => error.code === "COLLISION");
  assert.equal(await readFile(join(occupied, "sentinel"), "utf8"), "never replace");
  await assert.rejects(readFile(join(occupiedStage, ".legacy-trash-import.json")), { code: "ENOENT" });
  await publishLegacyTrashWorkspaceImport(plan, authority, nativeScope);

  let storage = await Storage.open(destination), runtime, http, mcp, client;
  const authorize = (actorId, operation) => actorId === actor.id
    && ["knowledge.trash.list", "knowledge.trash.get", "knowledge.trash.restore", "knowledge.trash.backup", "knowledge.trash.adopt"].includes(operation);
  const policy = { trustedImportPlanSha256: plan.planSha256, snapshotScope: nativeScope, authorize };
  const hostFactory = async (root, id, database, external) => {
    const ownedStorage = root === storage.workspaceRoot() ? storage : await Storage.open(root);
    const db = database ?? ownedStorage.connectNative();
    const composed = createNativeLegacyTrashAccess({
      database: db, storage: ownedStorage, root, workspaceId: id,
      policy: { trustedImportPlanSha256: external.trustedImportPlanSha256, snapshotScope: external.snapshotScope, authorize },
      transaction: work => transaction(db, work), reconcileIndex() {},
      assertOperationAvailable() {},
    });
    return { ...composed.host, close: async () => {
      if (!database) db.close();
      if (ownedStorage !== storage) await ownedStorage.close();
    } };
  };
  const backupPolicy = { ...policy, actorId: actor.id, hostFactory };
  const openRuntime = async withImport => createNativeRuntime({ storage, legacyTrash: {
    ...policy, ...(withImport ? { import: { plan, authority } } : {}),
  } });
  const stopTransports = async () => {
    await client?.close(); client = undefined;
    await mcp?.close(); mcp = undefined;
    if (http) await new Promise(resolve => http.server.close(resolve));
    http = undefined;
  };
  const closeRuntime = async () => {
    await stopTransports();
    await runtime?.close(); runtime = undefined;
    await storage?.close();
  };
  t.after(closeRuntime);

  runtime = await openRuntime(true);
  const bearer = "batch11-synthetic-trash-token-000000000000";
  http = await startHttp(runtime.core, bearer, actor, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = await startMcp(runtime.core, actor, serverTransport);
  client = new Client({ name: "batch11-trash-import", version: "1" });
  await client.connect(clientTransport);
  const invokeHttp = async (method, operation, args) => {
    const response = await fetch(`${http.url}/v1/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ operation, version: 1, arguments: args }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const invokeMcp = async (method, operation, args) => {
    const response = await client.callTool({ name: method, arguments: { operation, version: 1, arguments: args } });
    assert.notEqual(response.isError, true);
    return response.structuredContent.result;
  };

  const listed = await invokeHttp("capability_read", "knowledge.trash.list", {});
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, originalId);
  const original = await invokeHttp("capability_read", "knowledge.trash.get", { area: "notes", originalId });
  assert.equal(original.entry.deletedAt, deletedAt);
  assert.equal(original.metadataBytes, Buffer.from(JSON.stringify({
    id: originalId, kind: "item", name: "Original note", originalPath: "original.md", deletedAt, assetsPath: "original.assets",
  })).toString("base64"));
  assert.deepEqual(original.deletionHistory.originalBytes, deletionBytes.toString("base64"));
  assert.ok(original.files.some(file => file.bytes === sourceBytes.toString("base64")));
  assert.ok(original.files.some(file => file.bytes === assetBytes.toString("base64")));

  const operationId = randomUUID();
  const restoredResult = await invokeMcp("capability_call", "knowledge.trash.restore.original", {
    operationId, area: "notes", originalId,
  });
  assert.equal(restoredResult.action, "restore");
  assert.deepEqual(await readFile(join(destination, "notes", "original.md")), sourceBytes);
  assert.deepEqual(await readFile(join(destination, "notes", "original.assets", "image.bin")), assetBytes);
  assert.equal((await invokeHttp("capability_read", "knowledge.trash.list", {})).items.length, 0);
  const historyDb = storage.connectNative();
  try {
    const history = historyDb.prepare("SELECT original_bytes,original_sha256,current_json,current_sha256 FROM legacy_trash_import_history WHERE workspace_id=?")
      .get(workspaceId);
    assert.equal(Buffer.from(history.original_bytes).toString("base64"), deletionBytes.toString("base64"));
    assert.equal(hash(Buffer.from(history.original_bytes)), history.original_sha256);
    assert.equal(hash(history.current_json), history.current_sha256);
  } finally { historyDb.close(); }

  await createWorkspaceBackup(storage, backupPath, {
    acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
  }, { legacyTrash: backupPolicy });
  const manifest = JSON.parse(await readFile(join(backupPath, ".pkm-workspace-backup.json"), "utf8"));
  const backupOptions = { nativeRestoreAuthority, legacyTrash: { ...backupPolicy, expectedManifestSha256: hash(await readFile(join(backupPath, ".pkm-workspace-backup.json"))) } };
  assert.equal(manifest.databaseUserVersion, 23);
  assert.equal(manifest.files.some(file => file.path === ".legacy-trash-import.json"), false);
  await closeRuntime();
  await restoreWorkspaceBackup(backupPath, restored, backupOptions);

  storage = await Storage.open(restored);
  runtime = await openRuntime(false);
  http = await startHttp(runtime.core, bearer, actor, 0);
  assert.equal((await invokeHttp("capability_read", "knowledge.trash.list", {})).items.length, 0);
  const restoredDb = storage.connectNative();
  try {
    const history = restoredDb.prepare("SELECT original_bytes,original_sha256,current_json,current_sha256 FROM legacy_trash_import_history WHERE workspace_id=?")
      .get(workspaceId);
    assert.equal(Buffer.from(history.original_bytes).toString("base64"), deletionBytes.toString("base64"));
    assert.equal(hash(Buffer.from(history.original_bytes)), history.original_sha256);
    assert.equal(hash(history.current_json), history.current_sha256);
    const adoption = restoredDb.prepare("SELECT root_path,receipt_json,digest FROM legacy_trash_import_receipt WHERE workspace_id=?").get(workspaceId);
    assert.equal(adoption.root_path, restored);
    assert.equal(JSON.parse(adoption.receipt_json).lineage.at(-1), backupOptions.legacyTrash.expectedManifestSha256);
  } finally { restoredDb.close(); }
  assert.deepEqual(await readFile(join(restored, "notes", "original.md")), sourceBytes);
  assert.deepEqual(await readFile(join(restored, "notes", "original.assets", "image.bin")), assetBytes);
  const secondBackup = await createWorkspaceBackup(storage, join(parent, "backup-after-rebind"), {
    acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
  }, { legacyTrash: backupPolicy });
  const secondManifest = JSON.parse(await readFile(join(parent, "backup-after-rebind", ".pkm-workspace-backup.json"), "utf8"));
  assert.equal(secondBackup.workspaceId, workspaceId);
  assert.equal(secondManifest.files.some(file => file.path === ".legacy-trash-import.json"), false);
});

test("one shared legacy stage publishes Project/Thread and original trash once, then restores through Core and backup lineage", { timeout: 90_000 }, async t => {
  const f = await originalProjectSource(t);
  const liveBytes = Buffer.from("---\nschema: pkm.knowledge/v1\ndocumentId: active-note\nrevision: 2\ndeleted: false\naliases: []\n---\n# Active note\n");
  const originalMarkdown = Buffer.from("---\ntitle: One\ndocumentId: original-trash-one\nknowledgeId: knowledge_000000000000000000000001\nrevision: 7\ndeleted: false\nsourceId: imported-original-source-01\naliases: []\n---\n# Original one\n\n![paired](One.assets/bytes.bin?q=1#view)\n");
  const originalAsset = Buffer.from([255, 0, 128, 13, 10, 9, 0]);
  await Promise.all([
    f.file("notes/active.md", liveBytes),
    f.file("notes/Outside.md", Buffer.from("---\nschema: pkm.knowledge/v1\ndocumentId: original-outside\nrevision: 1\ndeleted: false\naliases: []\n---\n# Outside reference owner\n")),
    f.file("skills/Keep.md", Buffer.from("---\nschema: pkm.knowledge/v1\ndocumentId: active-skill\nrevision: 1\ndeleted: false\naliases: []\n---\n# Skill\n")),
    f.file("papers/Keep.md", Buffer.from("---\nschema: pkm.knowledge/v1\ndocumentId: active-paper\nrevision: 1\ndeleted: false\naliases: []\n---\n# Paper\n")),
    f.file("notes/Team/One.md", originalMarkdown),
    f.file("notes/Team/One.assets/bytes.bin", originalAsset),
    f.file("prompts/Ads/Review/v1/base.jinja2", "BASE {{ Language }}\n"),
    f.file("prompts/Ads/Review/v1/prompt.jinja2", "{% extends 'base.jinja2' %}\n"),
    f.file("scripts/Tools/check.py", "print('retained library')\n"),
    f.file("scripts/Tools/.check.py.pkm.json", JSON.stringify({
      schema: "pkm.script/v1", knowledgeId: "script_1234567890abcdef12345678", aliases: ["pkm://scripts/Original/check.py"],
    })),
  ]);
  const { setStorePath, knowledgeMoveToTrash, knowledgeTrashRestore } =
    original(join(originalRepo, "src/knowledge/filestore.ts"));
  const { recordKnowledgeResourceMutation, readKnowledgeSyncDeletions } =
    original(join(originalRepo, "src/knowledge/knowledge-deletion-journal.ts"));
  setStorePath(f.source);
  recordKnowledgeResourceMutation(f.source, ["notes/PermanentlyGone.md"], [], () => true);
  const originalEntry = knowledgeMoveToTrash("notes", "Team/One.md", "item", "Opaque original display name");
  assert.ok(originalEntry);
  const originalId = originalEntry.id;
  const trashMetadataBytes = await readFile(join(f.source, "notes/.trash", originalId, "metadata.json"));
  const originalDeletionBytes = await readFile(join(f.source, ".pkm/state/knowledge-deletions.json"));
  const originalPayloadBytes = await readFile(join(f.source, "notes/.trash", originalId, "payload"));
  const originalAssetBytes = await readFile(join(f.source, "notes/.trash", originalId, "assets/bytes.bin"));
  assert.equal(trashMetadataBytes.toString("utf8"), `${JSON.stringify(originalEntry, null, 2)}\n`);
  assert.deepEqual(originalPayloadBytes, originalMarkdown);
  assert.deepEqual(originalAssetBytes, originalAsset);
  const oracleRoot = join(f.parent, "original-trash-oracle");
  await cp(f.source, oracleRoot, { recursive: true });
  const sourceBefore = await sourceHashes(f.source);
  const sourceScope = { excludedRootNames: ["project", "recipes", "prompts", "scripts"], excludedStateNames: ["project-store.json", "recipe-store.json"] };
  const selectedNativeScope = { excludedRootNames: [".pkm", ".pkm-next-workspace", "project", "recipes", "prompts", "scripts"], excludedStateNames: [] };
  await writeFile(join(f.source, ".pkm/state/knowledge-deletions.tmp"), "pending");
  await assert.rejects(planLegacyTrashImport(f.source, sourceScope), error => error.code === "PENDING_OR_UNKNOWN_JOURNAL");
  await rm(join(f.source, ".pkm/state/knowledge-deletions.tmp"));
  const trashPlan = await planLegacyTrashImport(f.source, sourceScope);
  const plan = await planLegacyImport(f.source, {}, { trashPlan });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  assert.deepEqual(plan.preflight.excludedPaths, [
    ".pkm/state/knowledge-deletions.json", "notes/.trash", "papers/.trash", "skills/.trash",
  ]);
  assert.ok(plan.entries.some(entry => entry.source === "project/Default-Project." + f.projectId + "/project.json"));
  const occupied = join(f.parent, "occupied-target");
  await mkdir(occupied);
  await writeFile(join(occupied, "sentinel"), "keep");
  await assert.rejects(importLegacyWorkspace(plan, occupied, {
    pythonExecutable, trashImport: { actorId: actor.id, nativeScope: selectedNativeScope },
  }), error => error.code === "DESTINATION_EXISTS");
  assert.equal(await readFile(join(occupied, "sentinel"), "utf8"), "keep");
  await assert.rejects(importLegacyWorkspace(plan, join(f.parent, "missing-authority"), { pythonExecutable }),
    error => error.code === "AUTHORITY_REQUIRED");
  const imported = await importLegacyWorkspace(plan, f.target, {
    pythonExecutable, trashImport: { actorId: actor.id, nativeScope: selectedNativeScope },
  });
  assert.deepEqual(await sourceHashes(f.source), sourceBefore);
  assert.equal(imported.legacyTrash.planSha256, trashPlan.planSha256);
  assert.equal(imported.legacyTrash.sourceSha256, trashPlan.sourceSha256);
  assert.equal(imported.legacyTrash.markerSha256, hash(await readFile(join(f.target, ".legacy-trash-import.json"))));
  assert.deepEqual(JSON.parse(await readFile(join(f.target, ".legacy-trash-import.json"), "utf8")), {
    schema: "pkm.legacy-trash-stage/v1", authority: imported.legacyTrash.authority, plan: trashPlan,
  });
  const importRecovery = await recoverLegacyImportOutcome(f.target);
  assert.equal(importRecovery.status, "published", JSON.stringify(importRecovery));
  assert.equal(imported.legacyTrash.authority.workspaceId, importRecovery.receipt.legacyTrash.authority.workspaceId);
  await assert.rejects(readFile(imported.legacyTrash.authority.stage), { code: "ENOENT" });
  assert.equal((await readdir(f.parent))
    .some(name => name.startsWith(`.${f.target.split("/").at(-1)}.pkm-legacy-import-`)), false);
  assert.deepEqual(await readFile(join(f.target, "notes/active.md")), liveBytes);
  assert.equal(await readFile(join(f.target, "prompts/Ads/Review/v1/prompt.jinja2"), "utf8"), "{% extends 'base.jinja2' %}\n");
  assert.equal(await readFile(join(f.target, "scripts/Tools/check.py"), "utf8"), "print('retained library')\n");
  assert.deepEqual(await readFile(join(f.target, "notes/.trash", trashPlan.entries[0].runtimeId, "assets/bytes.bin")), originalAssetBytes);

  const workspaceId = imported.legacyTrash.authority.workspaceId;
  const authorize = (actorId, operation) => actorId === actor.id
    && ["knowledge.trash.list", "knowledge.trash.get", "knowledge.trash.restore", "knowledge.trash.backup",
      "knowledge.trash.adopt", "project.legacy.command"].includes(operation);
  const trashPolicy = { trustedImportPlanSha256: trashPlan.planSha256, snapshotScope: selectedNativeScope, authorize };
  const legacyCommands = {
    authorize: (candidate, id) => candidate.id === actor.id && candidate.canWrite && id === workspaceId,
    projectThreadMoveGuard: () => ({ linkedActiveRunIds: [], audienceChanges: false }),
  };
  let storage = await Storage.open(f.target), runtime, http, mcp, client;
  const closeTransports = async () => {
    await client?.close(); client = undefined;
    await mcp?.close(); mcp = undefined;
    if (http) await new Promise(resolve => http.server.close(resolve));
    http = undefined;
  };
  const closeRuntime = async () => {
    await closeTransports();
    await runtime?.close(); runtime = undefined;
  };
  const openRuntime = async withImport => createNativeRuntime({ storage, legacyCommands, legacyTrash: {
    ...trashPolicy, ...(withImport ? { import: { plan: trashPlan, authority: imported.legacyTrash.authority } } : {}),
  } });
  t.after(async () => { await closeRuntime(); await storage?.close(); });
  runtime = await openRuntime(true);
  const nativeMetadataPath = join(f.target, "notes/.trash", trashPlan.entries[0].runtimeId, "metadata.json");
  const exactNativeMetadata = await readFile(nativeMetadataPath);
  await closeRuntime();
  await rm(nativeMetadataPath);
  await assert.rejects(openRuntime(false), error => typeof error?.code === "string");
  const dispositionDb = storage.connectNative();
  try {
    assert.equal(dispositionDb.prepare("SELECT COUNT(*) AS n FROM migration_runtime_trash WHERE entry_id=?")
      .get(trashPlan.entries[0].runtimeId).n, 1);
    assert.equal(dispositionDb.prepare("SELECT COUNT(*) AS n FROM legacy_trash_import_restored WHERE workspace_id=?")
      .get(workspaceId).n, 0);
  } finally { dispositionDb.close(); }
  await writeFile(nativeMetadataPath, exactNativeMetadata);
  runtime = await openRuntime(false);
  http = await startHttp(runtime.core, "batch11-shared-import-token-000000000000", actor, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = await startMcp(runtime.core, actor, serverTransport);
  client = new Client({ name: "batch11-shared-import", version: "1" });
  await client.connect(clientTransport);
  const invokeHttp = async (method, operation, args) => {
    const response = await fetch(`${http.url}/v1/${method}`, {
      method: "POST", headers: { authorization: `Bearer batch11-shared-import-token-000000000000`, "content-type": "application/json" },
      body: JSON.stringify({ operation, version: 1, arguments: args }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const invokeMcp = async (method, operation, args) => {
    const response = await client.callTool({ name: method, arguments: { operation, version: 1, arguments: args } });
    assert.notEqual(response.isError, true);
    return response.structuredContent.result;
  };
  const listed = await invokeHttp("capability_read", "knowledge.trash.list", {});
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, originalId);
  const fetched = await invokeHttp("capability_read", "knowledge.trash.get", { area: "notes", originalId });
  const { area: fetchedArea, runtimeEntryId, ...fetchedOriginalEntry } = fetched.entry;
  assert.equal(fetchedArea, "notes");
  assert.equal(runtimeEntryId, trashPlan.entries[0].runtimeId);
  assert.deepEqual(fetchedOriginalEntry, originalEntry);
  assert.equal(fetched.metadataBytes, trashMetadataBytes.toString("base64"));
  assert.equal(fetched.deletionHistory.originalBytes, originalDeletionBytes.toString("base64"));
  assert.ok(fetched.files.some(file => file.bytes === originalPayloadBytes.toString("base64")));
  assert.ok(fetched.files.some(file => file.bytes === originalAssetBytes.toString("base64")));

  const nextCommand = (operation, expectedStoreVersion) => ({
    operationId: randomUUID(),
    command: { commandId: `batch11-${operation}-${randomUUID()}`, fingerprint: `opaque-${operation}`,
      operation, expectedStoreVersion },
  });
  const projectDb = storage.connectNative();
  const currentVersion = () => readLegacyProjectControl(projectDb, workspaceId).storeVersion;
  const projectCreate = nextCommand("project-create", currentVersion());
  const createdProject = await invokeHttp("capability_call", "project.legacy.command", {
    ...projectCreate, args: { name: "Batch 11 project" },
  });
  const threadCreate = nextCommand("thread-create", currentVersion());
  const createdThread = await invokeMcp("capability_call", "project.legacy.command", {
    ...threadCreate, args: { projectId: f.projectId, name: "Batch 11 thread" },
  });
  const rename = nextCommand("thread-rename", currentVersion());
  const renamed = await invokeHttp("capability_call", "project.legacy.command", {
    ...rename, args: { threadId: createdThread.entityId, name: "Renamed Batch 11 thread" },
  });
  const move = nextCommand("thread-move", currentVersion());
  const moved = await invokeMcp("capability_call", "project.legacy.command", {
    ...move, args: { threadId: createdThread.entityId, destinationProjectId: createdProject.entityId,
      linkedActiveRunIds: [], includedRunIds: [], audienceChanges: false, audienceChangeConfirmed: false },
  });
  projectDb.close();
  assert.equal(renamed.snapshot.threads.find(item => item.threadId === createdThread.entityId).name, "Renamed Batch 11 thread");
  assert.equal(moved.snapshot.threads.find(item => item.threadId === createdThread.entityId).projectId, createdProject.entityId);

  const restored = await invokeMcp("capability_call", "knowledge.trash.restore.original", {
    operationId: randomUUID(), area: "notes", originalId,
  });
  assert.equal(restored.action, "restore");
  const nativeMarkdown = await readFile(join(f.target, "notes/Team/One.md"));
  const nativeAsset = await readFile(join(f.target, "notes/Team/One.assets/bytes.bin"));
  assert.deepEqual(nativeMarkdown, originalPayloadBytes);
  assert.deepEqual(nativeAsset, originalAssetBytes);
  for (const originalField of ["documentId: original-trash-one", "knowledgeId: knowledge_000000000000000000000001",
    "revision: 7", "sourceId: imported-original-source-01", "One.assets/bytes.bin?q=1#view"]) {
    assert.ok(nativeMarkdown.includes(Buffer.from(originalField)), originalField);
  }
  setStorePath(oracleRoot);
  assert.equal(knowledgeTrashRestore("notes", originalId).ok, true);
  assert.deepEqual(nativeMarkdown, await readFile(join(oracleRoot, "notes/Team/One.md")));
  assert.deepEqual(nativeAsset, await readFile(join(oracleRoot, "notes/Team/One.assets/bytes.bin")));
  const oracleDeletionHistory = readKnowledgeSyncDeletions(oracleRoot);
  const historyDb = storage.connectNative();
  try {
    const history = historyDb.prepare("SELECT original_bytes,current_json FROM legacy_trash_import_history WHERE workspace_id=?")
      .get(workspaceId);
    assert.deepEqual(Buffer.from(history.original_bytes), originalDeletionBytes);
    assert.deepEqual(JSON.parse(history.current_json).records, oracleDeletionHistory);
    assert.equal(oracleDeletionHistory.length, 1);
    assert.equal(oracleDeletionHistory[0].path, "notes/PermanentlyGone.md");
  } finally { historyDb.close(); }
  assert.deepEqual(await sourceHashes(f.source), sourceBefore);
  await closeRuntime();
  const activeRestoredPath = join(f.target, "notes/Team/One.md");
  await writeFile(activeRestoredPath, Buffer.concat([nativeMarkdown, Buffer.from("tampered\n")]));
  await assert.rejects(openRuntime(false), error => error?.code === "RECOVERY_CONFLICT");
  await writeFile(activeRestoredPath, nativeMarkdown);
  runtime = await openRuntime(false);
  await closeRuntime();

  const backupPath = join(f.parent, "shared-backup");
  const hostFactory = async (root, id, database, external) => {
    const ownedStorage = storage && root === storage.workspaceRoot() ? storage : await Storage.open(root);
    const db = database ?? ownedStorage.connectNative();
    const composed = createNativeLegacyTrashAccess({
      database: db, storage: ownedStorage, root, workspaceId: id,
      policy: { trustedImportPlanSha256: external.trustedImportPlanSha256, snapshotScope: external.snapshotScope, authorize },
      transaction: work => transaction(db, work), reconcileIndex() {}, assertOperationAvailable() {},
    });
    return { ...composed.host, close: async () => {
      if (!database) db.close();
      if (ownedStorage !== storage) await ownedStorage.close();
    } };
  };
  const backupPolicy = { ...trashPolicy, actorId: actor.id, hostFactory };
  await createWorkspaceBackup(storage, backupPath, {
    acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
  }, { legacyTrash: backupPolicy });
  const manifestBytes = await readFile(join(backupPath, ".pkm-workspace-backup.json"));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.databaseUserVersion, 23);
  assert.equal(manifest.files.some(file => file.path === ".legacy-trash-import.json"), false);
  await storage.close();
  storage = undefined;
  await restoreWorkspaceBackup(backupPath, f.restored, { nativeRestoreAuthority, legacyTrash: {
    ...backupPolicy, expectedManifestSha256: hash(manifestBytes),
  } });
  storage = await Storage.open(f.restored);
  runtime = await openRuntime(false);
  const threadSnapshot = await runtime.core.dispatch("capability_read", {
    operation: "project.get", version: 1, arguments: { id: createdProject.entityId },
  }, actor);
  assert.equal(threadSnapshot.error, undefined);
  assert.ok(threadSnapshot.result.threads.some(item => item.threadId === createdThread.entityId
    && item.projectId === createdProject.entityId && item.name === "Renamed Batch 11 thread"));
  assert.deepEqual(await readFile(join(f.restored, "notes/Team/One.md")), originalPayloadBytes);
  assert.deepEqual(await readFile(join(f.restored, "notes/Team/One.assets/bytes.bin")), originalAssetBytes);
  assert.equal(await readFile(join(f.restored, "prompts/Ads/Review/v1/base.jinja2"), "utf8"), "BASE {{ Language }}\n");
  assert.equal(await readFile(join(f.restored, "scripts/Tools/check.py"), "utf8"), "print('retained library')\n");
  assert.equal(JSON.parse(await readFile(join(f.restored, "scripts/Tools/.check.py.pkm.json"), "utf8")).knowledgeId,
    "script_1234567890abcdef12345678");
  await closeRuntime();
});
