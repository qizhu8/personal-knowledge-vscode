import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { nativeRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initialize, Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { CollaborationStateStore } from "../dist/collaboration-state.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { inspectPortalLifecycleRecovery } from "../dist/portal-lifecycle.js";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../dist/workspace-backup.js";

const uuid = () => randomUUID();
const human = { id: "human-manager", canWrite: true };
const worker = { id: "agent-worker", canWrite: true };
const observer = { id: "agent-observer", canWrite: true };
const ownerToken = Object.freeze({}), workerToken = Object.freeze({}), observerToken = Object.freeze({});
const identities = new WeakMap([
  [ownerToken, { actorId: human.id, kind: "human" }],
  [workerToken, { actorId: worker.id, kind: "agent" }],
  [observerToken, { actorId: observer.id, kind: "agent" }],
]);
const invoke = (operation, arguments_) => ({ operation: `portal.lifecycle.${operation}`, version: 1, arguments: arguments_ });

async function fixture(t) {
  const root = resolve(`.batch10-native-portal-${uuid()}`);
  await initialize(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  let storage, runtime, db, permit = true;
  const owner = actor => permit && actor.kind === "human" && actor.actorId === human.id;
  const config = {
    channel: {
      actorForPublic(actor) {
        if (![human.id, worker.id, observer.id].includes(actor.id)) return undefined;
        return { actorId: actor.id, kind: actor.id === human.id ? "human" : "agent" };
      },
      resolveNativeActor: token => identities.get(token),
      authorizeHuman: owner,
      authorizeDirected: (actor, recipient) => actor.actorId === human.id && [worker.id, observer.id].includes(recipient.actorId)
        || [worker.id, observer.id].includes(actor.actorId) && recipient.actorId === human.id,
    },
    portal: {
      authorizeHuman: owner,
      authorizeRoom: (actor, roomId) => owner(actor) && roomId === "room-original",
      resolveChannelOwnerToken: () => ownerToken,
    },
  };
  const f = {
    root, config,
    get runtime() { return runtime; }, get db() { return db; }, get storage() { return storage; },
    deny() { permit = false; }, allow() { permit = true; },
    async open() {
      storage = await Storage.open(root);
      try { runtime = await createNativeRuntime({ storage, ...config }); db = storage.connectNative(); }
      catch (error) { await storage.close(); storage = undefined; throw error; }
    },
    async close() {
      db?.close(); db = undefined;
      await runtime?.close(); runtime = undefined;
      await storage?.close(); storage = undefined;
    },
  };
  t.after(() => f.close());
  await f.open();
  const collaboration = new CollaborationStateStore(db, { authorizeHuman: owner });
  collaboration.create({ actorId: human.id, kind: "human" }, { operationId: uuid(), roomId: "room-original", name: "Synthetic room", alias: "Manager" });
  runtime.services.channel.nativeCreate(ownerToken, { operationId: uuid(), channelId: "channel-original", expectedRevision: 0,
    participantId: "manager", expiresAt: Date.now() + 600_000 });
  f.pair = await runtime.services.portal.openExisting(ownerToken, { operationId: uuid(), channelId: "channel-original", roomId: "room-original" });
  f.revision = () => Number(f.db.prepare("SELECT revision FROM portal_lifecycle_pairs WHERE session_id=?").get(f.pair.sessionId).revision);
  return f;
}

async function originalRequest(f, operation, extra = {}) {
  const source = await readFile(new URL("../domain/portal-lifecycle-original-api-chat-control.py", import.meta.url), "utf8");
  const python = `
import ast,json,sys
tree=ast.parse(json.load(sys.stdin)['source'])
fn=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='portal_control')
fn.decorator_list=[]
env={'root':None,'_host_id':lambda *args:None,'_submit':lambda root,host,op,args,command:{'operation':op,'arguments':args,'commandId':command},'json':json}
exec(compile(ast.Module(body=[fn],type_ignores=[]),'<original-portal-oracle>','exec'),env)
print(json.dumps(env['portal_control'](**json.loads(sys.argv[1]))))
`;
  const args = { host_id: "synthetic-host", operation, command_id: uuid(), context_id: f.pair.sessionId, ...extra };
  const result = spawnSync("python3", ["-c", python, JSON.stringify(args)], { input: JSON.stringify({ source }), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function transports(f) {
  const bearer = "batch10-native-portal-synthetic-token-000000000000";
  const http = await startHttp(f.runtime.core, bearer, human, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startMcp(f.runtime.core, worker, serverTransport);
  const client = new Client({ name: "batch10-portal", version: "1" });
  await client.connect(clientTransport);
  return {
    async http(operation, args) {
      const response = await fetch(`${http.url}/v1/${operation === "route" ? "capability_call" : "capability_read"}`, {
        method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(invoke(operation, args)),
      });
      return response.json();
    },
    async mcp(operation, args) {
      return (await client.callTool({ name: operation === "route" ? "capability_call" : "capability_read", arguments: invoke(operation, args) })).structuredContent;
    },
    async close() { await client.close(); await mcp.close(); await new Promise(resolve => http.server.close(resolve)); },
  };
}
async function requestAdmission(f, token = workerToken) {
  return f.runtime.services.portal.requestAdmission(ownerToken, token, { operationId: uuid(), sessionId: f.pair.sessionId,
    expectedRevision: f.revision(), expiresAt: Date.now() + 60_000 });
}
async function admit(f, request, token = workerToken) {
  const input = { operationId: uuid(), sessionId: f.pair.sessionId, invitationId: request.invitationId,
    expectedRevision: f.revision(), expiresAt: Date.now() + 30_000, memberExpiresAt: Date.now() + 500_000 };
  const approved = await f.runtime.services.portal.approveAdmission(ownerToken, token, input);
  await assert.rejects(f.runtime.services.portal.approveAdmission(ownerToken, token, input), error => error.code === "INVITATION_SECRET_NOT_REPLAYED");
  const admitted = await f.runtime.services.portal.admit(token, { operationId: uuid(), sessionId: f.pair.sessionId,
    invitationId: request.invitationId, expectedRevision: f.revision(), token: approved.token });
  return { approved, admitted, participantId: f.db.prepare("SELECT participant_id FROM portal_lifecycle_admissions WHERE invitation_id=?").get(request.invitationId).participant_id };
}

test("original Portal request -> trusted native admission -> two actor HTTP/MCP route, transfer, leave/revoke and scoped cancel", async t => {
  const f = await fixture(t), io = await transports(f);
  try {
    const status = await originalRequest(f, "status");
    const publicStatus = await io.http("status", { sessionId: status.arguments.contextId });
    assert.equal(publicStatus.error, undefined);
    const pending = await requestAdmission(f);
    f.deny();
    await assert.rejects(f.runtime.services.portal.approveAdmission(ownerToken, workerToken, {
      operationId: uuid(), sessionId: f.pair.sessionId, invitationId: pending.invitationId,
      expectedRevision: f.revision(), expiresAt: Date.now() + 30_000, memberExpiresAt: Date.now() + 500_000,
    }), error => error.code === "HUMAN_AUTHORITY_REQUIRED");
    f.allow();
    assert.ok((await io.mcp("read", { sessionId: f.pair.sessionId })).error);
    const enrolled = await admit(f, pending);
    const request = await originalRequest(f, "send", { prompt: "synthetic original directed message", request_id: uuid() });
    const route = { operationId: request.arguments.requestId, sessionId: request.arguments.contextId,
      expectedRevision: f.revision(), recipientId: enrolled.participantId, text: request.arguments.prompt };
    const sent = await io.http("route", route);
    assert.equal(sent.error, undefined, JSON.stringify(sent.error));
    const replay = await io.http("route", route);
    assert.deepEqual(replay.result, sent.result);
    const mailbox = await io.mcp("read", { sessionId: f.pair.sessionId });
    assert.equal(mailbox.error, undefined, JSON.stringify(mailbox.error));
    assert.ok(JSON.stringify(mailbox.result).includes(request.arguments.prompt));
    const reply = await io.mcp("route", { operationId: uuid(), sessionId: f.pair.sessionId,
      expectedRevision: f.revision(), recipientId: "manager", text: "synthetic peer reply" });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    const cancelled = await requestAdmission(f, observerToken);
    await assert.rejects(f.runtime.services.portal.cancelAdmission(ownerToken, { operationId: uuid(), sessionId: uuid(),
      invitationId: cancelled.invitationId, expectedRevision: f.revision() }), error => error.code === "NOT_FOUND");
    await f.runtime.services.portal.cancelAdmission(ownerToken, { operationId: uuid(), sessionId: f.pair.sessionId,
      invitationId: cancelled.invitationId, expectedRevision: f.revision() });
    const oldRevision = f.revision();
    const transfer = await f.runtime.services.portal.transfer(ownerToken, observerToken, {
      revoke: { operationId: uuid(), sessionId: f.pair.sessionId, invitationId: pending.invitationId, expectedRevision: oldRevision },
      invitation: { operationId: uuid(), sessionId: f.pair.sessionId, expectedRevision: oldRevision + 2, expiresAt: Date.now() + 60_000 },
    });
    assert.equal(transfer.admission.state, "awaiting-approval");
    assert.ok((await io.mcp("read", { sessionId: f.pair.sessionId })).error);
    const next = await admit(f, transfer.admission, observerToken);
    await f.runtime.services.portal.leave(observerToken, { operationId: uuid(), sessionId: f.pair.sessionId,
      invitationId: transfer.admission.invitationId, expectedRevision: f.revision() });
    const final = await requestAdmission(f);
    await admit(f, final);
    await f.runtime.services.portal.revoke(ownerToken, { operationId: uuid(), sessionId: f.pair.sessionId,
      invitationId: final.invitationId, expectedRevision: f.revision() });
    assert.ok(next.approved.token);
    const durable = ["receipts", "portal_lifecycle_receipts", "portal_lifecycle_admissions", "channel_runtime_receipts", "channel_runtime_rooms"]
      .flatMap(table => f.db.prepare(`SELECT * FROM ${table}`).all()).map(row => JSON.stringify(row)).join("\n");
    assert.equal(durable.includes(enrolled.approved.token), false);
    assert.equal(durable.includes(next.approved.token), false);
    assert.ok(f.db.prepare("SELECT 1 FROM receipts WHERE operation_id=? AND operation='portal.lifecycle'").get(route.operationId));
    const conflict = await f.runtime.core.dispatch("capability_call", { operation: "knowledge.document.create", version: 1,
      arguments: { operationId: route.operationId, path: "conflict.md", title: "conflict", content: "never" } }, human);
    assert.ok(conflict.error);
    assert.equal(inspectPortalLifecycleRecovery(f.db).length, 0);
  } finally { await io.close(); }
  await f.close(); await f.open();
  const reopened = await f.runtime.core.dispatch("capability_read", invoke("status", { sessionId: f.pair.sessionId }), human);
  assert.equal(reopened.error, undefined);
  assert.ok((await f.runtime.core.dispatch("capability_read", invoke("read", { sessionId: f.pair.sessionId }), worker)).error);
});

test("unknown Portal receipt fences restart before effects and preserves exact pending inventory", async t => {
  const f = await fixture(t), operationId = uuid();
  f.db.prepare("INSERT INTO portal_lifecycle_receipts VALUES(?,?,?,?,?,?,NULL)")
    .run(operationId, human.id, f.pair.sessionId, "a".repeat(64), "unknown", f.revision());
  const before = inspectPortalLifecycleRecovery(f.db);
  await f.close();
  await assert.rejects(f.open(), error => error.code === "PORTAL_OUTCOME_UNKNOWN");
  const db = new DatabaseSync(join(f.root, "core.sqlite"), { readOnly: true });
  try { assert.deepEqual(inspectPortalLifecycleRecovery(db), before); } finally { db.close(); }
});

test("explicit previous schema12/13 workspaces atomically acquire schema22 snapshot receipt and Portal tables", async t => {
  for (const version of [12, 13]) {
    const root = resolve(`.batch10-prior-schema-${version}-${uuid()}`);
    await initialize(root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const storage = await Storage.open(root);
    await storage.close();
    const db = new DatabaseSync(join(root, "core.sqlite"));
    try {
      for (const name of ["portal_lifecycle_receipts", "portal_lifecycle_meetings", "portal_lifecycle_admissions",
        "portal_lifecycle_pairs", "portal_lifecycle_schema", "legacy_state_import_receipt", "legacy_command_extension_intent",
        "legacy_note_workitems_receipt", "legacy_note_workitems_intent", "legacy_note_workitems_admission", "legacy_note_workitems_native_binding"]) db.exec(`DROP TABLE ${name}`);
      if (version === 12) for (const name of ["legacy_project_receipt", "legacy_recipe_control", "legacy_project_control"]) db.exec(`DROP TABLE ${name}`);
      db.exec(`PRAGMA user_version=${version}`);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, version);
    } finally { db.close(); }
    const upgraded = await Storage.open(root);
    const check = upgraded.connectNative();
    try {
      assert.equal(check.prepare("PRAGMA user_version").get().user_version, 23);
      assert.equal(check.prepare("SELECT version FROM portal_lifecycle_schema").get().version, 1);
      assert.equal(check.prepare("SELECT count(*) AS n FROM legacy_state_import_receipt").get().n, 0);
      assert.equal(check.prepare("SELECT count(*) AS n FROM legacy_command_extension_intent").get().n, 0);
    } finally { check.close(); await upgraded.close(); }
  }
});

test("explicit schema12/13 backups restore without reinterpretation then migrate to coherent schema23", async t => {
  for (const version of [12, 13]) {
    const root = resolve(`.batch10-old-backup-${version}-${uuid()}`);
    await initialize(root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const storage = await Storage.open(root);
    const parent = resolve(`.batch10-backup-parent-${version}-${uuid()}`);
    await mkdir(parent);
    t.after(() => rm(parent, { recursive: true, force: true }));
    const backup = join(parent, "backup"), restored = join(parent, "restored");
    let held = false;
    try {
      await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => {
        held = true; return { assertHeld: () => assert.equal(held, true), release: () => { held = false; } };
      } });
    } finally { await storage.close(); }
    const snapshot = new DatabaseSync(join(backup, "core.sqlite"));
    try {
      for (const name of ["portal_lifecycle_receipts", "portal_lifecycle_meetings", "portal_lifecycle_admissions",
        "portal_lifecycle_pairs", "portal_lifecycle_schema", "legacy_state_import_receipt", "legacy_command_extension_intent",
        "legacy_note_workitems_receipt", "legacy_note_workitems_intent", "legacy_note_workitems_admission", "legacy_note_workitems_native_binding"]) snapshot.exec(`DROP TABLE ${name}`);
      if (version === 12) for (const name of ["legacy_project_receipt", "legacy_recipe_control", "legacy_project_control"]) snapshot.exec(`DROP TABLE ${name}`);
      snapshot.exec(`PRAGMA user_version=${version}`);
    } finally { snapshot.close(); }
    const manifestPath = join(backup, ".pkm-workspace-backup.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const bytes = await readFile(join(backup, "core.sqlite"));
    const file = manifest.files.find(item => item.path === "core.sqlite");
    manifest.totalBytes += bytes.length - file.size;
    file.size = bytes.length;
    file.sha256 = createHash("sha256").update(bytes).digest("hex");
    manifest.databaseUserVersion = version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority });
    const before = new DatabaseSync(join(restored, "core.sqlite"), { readOnly: true });
    try { assert.equal(before.prepare("PRAGMA user_version").get().user_version, version); } finally { before.close(); }
    const upgraded = await Storage.open(restored);
    const check = upgraded.connectNative();
    try {
      assert.equal(check.prepare("PRAGMA user_version").get().user_version, 23);
      assert.equal(check.prepare("SELECT version FROM portal_lifecycle_schema").get().version, 1);
      assert.equal(check.prepare("SELECT count(*) AS n FROM legacy_command_extension_intent").get().n, 0);
    } finally { check.close(); await upgraded.close(); }
  }
});

test("current-schema backup missing the legacy state receipt table is rejected before publication", async t => {
  const root = resolve(`.batch10-missing-receipt-${uuid()}`);
  const parent = resolve(`.batch10-missing-receipt-backup-${uuid()}`);
  await initialize(root);
  await mkdir(parent);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const backup = join(parent, "backup"), restored = join(parent, "restored");
  const storage = await Storage.open(root);
  let held = false;
  try {
    await createWorkspaceBackup(storage, backup, { acquireQuiescence: async () => {
      held = true; return { assertHeld: () => assert.equal(held, true), release: () => { held = false; } };
    } });
  } finally { await storage.close(); }
  const snapshot = new DatabaseSync(join(backup, "core.sqlite"));
  try { snapshot.exec("DROP TABLE legacy_state_import_receipt"); } finally { snapshot.close(); }
  const manifestPath = join(backup, ".pkm-workspace-backup.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const bytes = await readFile(join(backup, "core.sqlite"));
  const file = manifest.files.find(item => item.path === "core.sqlite");
  manifest.totalBytes += bytes.length - file.size;
  file.size = bytes.length;
  file.sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(restoreWorkspaceBackup(backup, restored, { nativeRestoreAuthority }),
    error => error.code === "IMPORT_RECEIPT_INVALID");
  await assert.rejects(access(restored), { code: "ENOENT" });
});

test("startup rejects a current-schema workspace missing the receipt table without recreating it", async t => {
  const root = resolve(`.batch10-startup-missing-receipt-${uuid()}`);
  await initialize(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = await Storage.open(root);
  await storage.close();
  const database = new DatabaseSync(join(root, "core.sqlite"));
  try { database.exec("DROP TABLE legacy_state_import_receipt"); } finally { database.close(); }
  await assert.rejects(Storage.open(root), /Original state import receipt table is missing/);
  const inspect = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try {
    assert.equal(inspect.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_state_import_receipt'").get(), undefined);
  } finally { inspect.close(); }
});
