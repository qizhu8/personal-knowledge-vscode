import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { importLegacyWorkspace, planLegacyImport, recoverLegacyImportOutcome } from "../dist/legacy-import.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { Storage } from "../dist/storage.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";
import { readLegacyStateReceipt } from "../dist/host-composition-legacy-state.js";
import { snapshotFixture } from "./agent-snapshot-reads-fixtures.mjs";
import { originalProjection } from "./agent-snapshot-reads-original.mjs";

const actor = { id: "local:synthetic-owner", canWrite: false };
const invoke = args => ({ operation: "agent.snapshot.read", version: 1, arguments: args });
async function fixture(t) {
  const root = resolve(`.batch10-snapshot-${randomUUID()}`);
  const source = join(root, "source"), target = join(root, "target");
  await mkdir(source, { recursive: true });
  await mkdir(join(source, "notes"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  t.after(() => key.fill(0));
  const originalPath = new URL("../legacy/src/agent-sessions/agent-snapshots.ts", import.meta.url);
  const originalKey = 'createHash("sha256").update("uone", "utf8").digest()';
  const sourceCode = await readFile(originalPath, "utf8");
  assert.equal(sourceCode.split(originalKey).length, 2);
  const code = ts.transpileModule(sourceCode.replace(originalKey, `Buffer.from("${key.toString("hex")}", "hex")`),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} }, require = createRequire(import.meta.url);
  runInThisContext(`(function(require,module,exports){${code}\n})`)(
    name => name === "../chat/chat-history-storage" ? {} : require(name), mod, mod.exports);
  const session = snapshotFixture().payload.session;
  session.sessionId = "agent_session_original";
  session.summary = "synthetic encrypted history must never be a persistent plaintext projection";
  const sessionPath = join(source, ".pkm/state/agent-sessions", `${session.sessionId}.json`);
  await mkdir(dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, JSON.stringify(session));
  const { snapshot } = mod.exports.createAgentSnapshot(source, session.sessionId);
  const payload = mod.exports.readAgentSnapshotContents(source, snapshot.snapshotId);
  await rm(sessionPath);
  const path = `.pkm/state/agent-snapshots/${snapshot.snapshotId}.json`;
  const bytes = await readFile(join(source, path));
  let epoch = "synthetic-epoch-1", granted = true, authorized = true, decodeHook;
  let keyCalls = 0;
  const authority = {
    epoch: async () => granted ? epoch : undefined,
    key: async (_algorithm, requested) => {
      keyCalls++;
      await decodeHook?.();
      return granted && requested === epoch ? Buffer.from(key) : undefined;
    },
  };
  return { root, source, target, key, snapshot: JSON.parse(bytes), payload, bytes, path, authority,
    get keyCalls() { return keyCalls; },
    epoch(value) { epoch = value; }, grant(value) { granted = value; },
    authorize(value) { authorized = value; }, decodeHook(value) { decodeHook = value; },
    policy(receipt) { return { receiptSha256: receipt.receiptSha256, authority,
      authorize: async candidate => authorized && candidate.id === actor.id }; },
  };
}

async function importFixture(f) {
  const plan = await planLegacyImport(f.source, {}, { snapshotAuthority: f.authority });
  assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  const python = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
  const receipt = await importLegacyWorkspace(plan, f.target, { pythonExecutable: python, snapshotAuthority: f.authority });
  return { plan, receipt };
}
async function open(f, receipt, root = f.target, policy = f.policy(receipt)) {
  const storage = await Storage.open(root);
  let native;
  try { native = await createNativeRuntime({ storage, ...(policy ? { legacySnapshots: policy } : {}) }); }
  catch (error) { await storage.close(); throw error; }
  return { storage, native, async close() { await native.close(); await storage.close(); } };
}
function oracle(snapshot, payload, messages) {
  const python = spawnSync("python3", ["-c", `${originalProjection}\nimport json,sys\nv=json.load(sys.stdin)\nprint(json.dumps(_snapshot_read_projection(v['snapshot'],v['payload'],v['messages'])))`],
    { input: JSON.stringify({ snapshot, payload, messages }), encoding: "utf8" });
  assert.equal(python.status, 0, python.stderr);
  return JSON.parse(python.stdout);
}
function projection(result) {
  const copy = structuredClone(result);
  delete copy.snapshotRevision; delete copy.adapters; delete copy.snapshot.name;
  return copy;
}

test("legacy state receipt table is optional only before schema 14", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const version of [12, 13]) {
      database.exec(`PRAGMA user_version=${version}`);
      assert.equal(readLegacyStateReceipt(database, "fixture-workspace"), undefined);
    }
    for (const version of [14, 23]) {
      database.exec(`PRAGMA user_version=${version}`);
      assert.throws(() => readLegacyStateReceipt(database, "fixture-workspace"),
        error => error.code === "IMPORT_RECEIPT_INVALID");
    }
  } finally { database.close(); }
});
async function assertOpaque(root, f) {
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else {
        const bytes = await readFile(full);
        assert.equal(bytes.includes(f.key), false, full);
        assert.equal(bytes.includes(f.key.toString("hex")), false, full);
        assert.equal(bytes.includes(f.key.toString("base64")), false, full);
        assert.equal(bytes.includes(f.payload.session.summary), false, full);
      }
    }
  }
  await visit(root);
}

test("original codec -> atomic native import -> HTTP/MCP exact independent projection -> backup restore/restart", async t => {
  const f = await fixture(t);
  const { plan, receipt } = await importFixture(f);
  assert.equal(receipt.importPlanSha256, plan.planSha256);
  assert.deepEqual(receipt.statePlan, plan.statePlan);
  assert.equal((await recoverLegacyImportOutcome(f.target)).status, "published");
  const outcomePath = join(f.root, ".target.pkm-legacy-import.outcome.json");
  const originalOutcome = await readFile(outcomePath);
  const omitted = JSON.parse(originalOutcome);
  delete omitted.receipt.statePlan; delete omitted.receipt.importPlanSha256;
  const { receiptSha256, ...body } = omitted.receipt;
  omitted.receipt.receiptSha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await writeFile(outcomePath, JSON.stringify(omitted));
  assert.equal((await recoverLegacyImportOutcome(f.target)).status, "unknown");
  await writeFile(outcomePath, originalOutcome);
  void receiptSha256;
  const snapshotPath = join(f.target, "agent-snapshot-reads", f.path);
  assert.deepEqual(await readFile(snapshotPath), f.bytes);
  const opened = await open(f, receipt);
  const bearer = "synthetic-batch10-snapshot-http-token-000000000000";
  const http = await startHttp(opened.native.core, bearer, actor, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startMcp(opened.native.core, actor, serverTransport);
  const client = new Client({ name: "batch10-original-oracle", version: "1" });
  await client.connect(clientTransport);
  const args = { magic_code: f.snapshot.magicCode, recent_messages: 1 };
  let backup;
  try {
    const response = await fetch(`${http.url}/v1/capability_read`, { method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(invoke(args)) });
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.deepEqual(projection(body.result), oracle(f.snapshot, f.payload, 1));
    const mcpResult = await client.callTool({ name: "capability_read", arguments: invoke(args) });
    assert.equal(mcpResult.isError, false);
    assert.deepEqual(mcpResult.structuredContent.result, body.result);
    for (const operation of ["agent.snapshot.list", "agent.snapshot.get"]) {
      const read = await opened.native.core.dispatch("capability_read", { operation, version: 1,
        arguments: operation.endsWith("get") ? { snapshotId: f.snapshot.snapshotId } : {} }, actor);
      assert.equal(read.error, undefined);
    }
    f.epoch("synthetic-epoch-2");
    assert.equal((await client.callTool({ name: "capability_read", arguments: invoke(args) })).structuredContent.error.code, "KEY_AUTHORITY_REQUIRED");
    f.epoch("synthetic-epoch-1"); f.grant(false);
    assert.equal((await opened.native.core.dispatch("capability_read", invoke(args), actor)).error.code, "KEY_AUTHORITY_REQUIRED");
    f.grant(true); f.authorize(false);
    const keyCalls = f.keyCalls;
    assert.equal((await opened.native.core.dispatch("capability_read", invoke(args), actor)).error.code, "ACCESS_DENIED");
    assert.equal(f.keyCalls, keyCalls);
    f.authorize(true);
    f.decodeHook(async () => f.authorize(false));
    assert.equal((await opened.native.core.dispatch("capability_read", invoke(args), actor)).error.code, "ACCESS_DENIED");
    f.decodeHook(undefined); f.authorize(true);
    f.decodeHook(async () => f.epoch("revoked-during-decode"));
    assert.equal((await opened.native.core.dispatch("capability_read", invoke(args), actor)).error.code, "KEY_AUTHORITY_REQUIRED");
    f.decodeHook(undefined); f.epoch("synthetic-epoch-1");
    const changed = JSON.parse(f.bytes); changed.payload.ciphertext = changed.payload.ciphertext.slice(1) + "A";
    await writeFile(snapshotPath, JSON.stringify(changed));
    assert.ok((await opened.native.core.dispatch("capability_read", invoke(args), actor)).error);
    assert.equal((await recoverLegacyImportOutcome(f.target)).status, "unknown");
    await assert.rejects(createWorkspaceBackup(opened.storage, join(f.root, "corrupt-backup"), {
      acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
    }));
    await writeFile(snapshotPath, f.bytes);
    backup = join(f.root, "backup");
    let held = false;
    await createWorkspaceBackup(opened.storage, backup, { acquireQuiescence: async () => {
      held = true;
      return { assertHeld: () => assert.equal(held, true), release: () => { held = false; } };
    } });
    const db = opened.storage.connectNative();
    try {
      assert.equal(Number(db.prepare("PRAGMA user_version").get().user_version), 23);
      assert.throws(() => db.prepare("UPDATE legacy_state_import_receipt SET binding_sha256=?").run("0".repeat(64)), /Immutable/);
    } finally { db.close(); }
  } finally {
    await client.close(); await mcp.close();
    await new Promise(resolve => http.server.close(resolve));
    await opened.close();
  }
  await assertOpaque(f.target, f); await assertOpaque(backup, f);
  const restored = join(f.root, "restored");
  await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
  await rm(f.source, { recursive: true });
  for (const root of [f.target, restored, restored]) {
    const reopened = await open(f, receipt, root);
    try {
      const result = await reopened.native.core.dispatch("capability_read", invoke(args), actor);
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      assert.deepEqual(projection(result.result), oracle(f.snapshot, f.payload, 1));
      assert.deepEqual(await readFile(join(root, "agent-snapshot-reads", f.path)), f.bytes);
      const db = reopened.storage.connectNative();
      try { assert.equal(db.prepare("SELECT count(*) AS n FROM receipts").get().n, 0); } finally { db.close(); }
    } finally { await reopened.close(); }
  }
  await assertOpaque(restored, f);
});

test("Magic Code alone, mismatched native receipt, unknown inventory and stale import policy fail closed", async t => {
  const f = await fixture(t);
  assert.equal((await planLegacyImport(f.source)).ready, false);
  const { receipt } = await importFixture(f);
  const args = { magic_code: f.snapshot.magicCode };
  const unconfigured = await open(f, receipt, f.target, null);
  try { assert.equal((await unconfigured.native.core.dispatch("capability_read", invoke(args), actor)).error.code, "ADAPTER_UNAVAILABLE"); }
  finally { await unconfigured.close(); }
  const wrong = await open(f, receipt, f.target, { ...f.policy(receipt), receiptSha256: "0".repeat(64) });
  try { assert.equal((await wrong.native.core.dispatch("capability_read", invoke(args), actor)).error.code, "IMPORT_RECEIPT_INVALID"); }
  finally { await wrong.close(); }
  const plan = await planLegacyImport(f.source, {}, { snapshotAuthority: f.authority });
  f.epoch("stale");
  const python = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
  await assert.rejects(importLegacyWorkspace(plan, join(f.root, "stale-target"), { pythonExecutable: python, snapshotAuthority: f.authority }), error => error.code === "SOURCE_CHANGED");
  f.epoch("synthetic-epoch-1");
  await writeFile(join(f.source, ".pkm/state/agent-snapshots/pending.json"), "{}");
  assert.equal((await planLegacyImport(f.source, {}, { snapshotAuthority: f.authority })).ready, false);
});
