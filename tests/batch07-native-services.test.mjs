import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { initialize, Storage } from "../dist/storage.js";
import { startHttp } from "../dist/http.js";
import { startMcp } from "../dist/mcp.js";
import { startLegacyNoteMcp } from "../dist/legacy-note-mcp.js";
import { readActionCompiler } from "../dist/action-compiler.js";
import { originalDigest } from "../dist/domain/action-compiler-validation.js";
import { originalActionCompilerFixtures as original } from "./action-compiler-original-fixtures.mjs";
import { invocation, until } from "./batch07-cli-fixtures.mjs";
import { nativeWorkspace, syntheticManager } from "./batch06-manager-fixtures.mjs";
import { createSyntheticProvider } from "./chat-turn-native-fixtures.mjs";
import { chatTurnInput } from "./chat-turn-fixtures.mjs";
import { createHostServices } from "../dist/host-services.js";
import { CoreError } from "../dist/contracts.js";
import { nativeRestoreAuthority as fixtureRestoreAuthority } from "./host-composition-legacy-batch16-restore-fixture.mjs";

const actor = { id: "native:service-owner", canWrite: true };
const hash = value => createHash("sha256").update(value).digest("hex");
async function servicesFixture(t, code, options = {}) {
  const root = resolve(import.meta.dirname, `.batch07-services-${randomUUID()}`);
  await mkdir(root);
  const workspace = resolve(root, "workspace");
  await initialize(workspace);
  const storage = await Storage.open(workspace), workspaceId = await storage.workspaceId();
  const definition = structuredClone(original.example);
  definition.implementations[0].program = "fixture";
  definition.implementations[0].args = ["-e", code];
  const source = { kind: "inline", definition };
  const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } });
  assert.equal(compiled.status, "valid");
  const approvals = [];
  const restorePin = { request: undefined, calls: 0 };
  const nativeRestoreAuthority = {
    actorId: actor.id,
    authorize(request) {
      if (!restorePin.request || JSON.stringify(request) !== JSON.stringify(restorePin.request)) return null;
      restorePin.calls++;
      return fixtureRestoreAuthority.authorize(request);
    },
  };
  const authorize = binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
    && binding.executableDigest === compiled.definitionDigest && binding.actionId === definition.action_id;
  const runtime = await createNativeRuntime({ storage, hostServices: {
    action: { process: { commands: [{ id: "fixture", executable: process.execPath, cwd: workspace, directChildOnly: true,
      arguments: [{ literal: "-e" }, { literal: code }], outputContractDigest: originalDigest(definition.output_schema),
      authorizationDigest: hash("native synthetic action policy"),
      authorizeDefinition: authorize, authorizeData: binding => authorize(binding) && binding.inputs.value === "public",
      async approve(request) {
        assert.equal(request.actorId, actor.id);
        assert.equal(request.executableDigest, compiled.definitionDigest);
        assert.equal(request.actionId, definition.action_id);
        assert.deepEqual(request.arguments, ["-e", code]);
        approvals.push(request);
        await options.approve?.(request);
        return true;
      }, redactOutput: () => ({ value: "native-redacted-result" }),
    }], limits: { graceMs: 20, closeDrainMs: 200 } } },
    authorizeBackup: request => request.workspaceId === workspaceId && request.transport === "native-host",
    backupOptions: { nativeRestoreAuthority },
  } });
  const bearer = `synthetic-native-${randomUUID()}`;
  const { server, url } = await startHttp(runtime.core, bearer, actor);
  t.after(async () => {
    server.closeIdleConnections();
    const drained = new Promise(resolve => server.close(resolve));
    await runtime.close(); await storage.close(); await drained;
    await rm(root, { recursive: true, force: true });
  });
  const rpc = async (method, operation, args) => {
    const response = await fetch(`${url}/v1/${method}`, { method: "POST", headers: {
      authorization: `Bearer ${bearer}`, "content-type": "application/json",
    }, body: JSON.stringify(invocation(operation, args)) });
    return { status: response.status, body: await response.json() };
  };
  const create = () => ({ operationId: randomUUID(), runId: `run-${randomUUID()}`, source,
    expectedDefinitionDigest: compiled.definitionDigest, deadline: Date.now() + 20000, inputs: { value: "public" } });
  return { root, workspace, workspaceId, storage, runtime, approvals, rpc, create, source, compiled, restorePin };
}

  function journal(db) {
    db.prepare(`INSERT INTO pending_write(singleton,operation_id,fingerprint,actor_id,operation,
      document_id,before_sha256,after_markdown,result) VALUES(1,?,?,?,?,?,NULL,?,?)`)
      .run(randomUUID(), "0".repeat(64), actor.id, "knowledge.document.edit", "synthetic-pending",
        "Synthetic unknown journal", "{}");
  }

  test("host Action caller rollback leaves no run/receipt and queued unknown journal fences actual child until cleared", { timeout: 20000 }, async t => {
    const root = resolve(import.meta.dirname, `.batch07-helper-${randomUUID()}`);
    await initialize(root);
    const storage = await Storage.open(root), db = storage.connectNative(), workspaceId = await storage.workspaceId();
    const code = "console.log(JSON.stringify({value:'public'}))", definition = structuredClone(original.example);
    definition.implementations[0].program = "fixture"; definition.implementations[0].args = ["-e", code];
    const source = { kind: "inline", definition };
    const compiled = readActionCompiler({ operation: "action.definition.compile", args: { source } });
    const approvals = [];
    const helper = createHostServices({ database: db, storage, workspaceId, assertOwner: () => {
      assert.equal(JSON.parse(readFileSync(resolve(root, ".pkm-next-workspace"), "utf8")).id, workspaceId);
    }, beforeEffect: () => {
      if (db.prepare("SELECT count(*) n FROM pending_write").get().n) {
        throw new CoreError("BUSY", "Synthetic pending journal");
      }
    }, action: { process: { commands: [{ id: "fixture", executable: process.execPath, cwd: root, directChildOnly: true,
      arguments: [{ literal: "-e" }, { literal: code }], outputContractDigest: originalDigest(definition.output_schema),
      authorizationDigest: hash("direct native helper caller policy"),
      authorizeDefinition: binding => binding.actorId === actor.id && binding.workspaceId === workspaceId
        && binding.executableDigest === compiled.definitionDigest,
      authorizeData: binding => binding.inputs.value === "public",
      approve: async request => { approvals.push(request); return true; },
      redactOutput: () => ({ value: "public" }),
    }] } } });
    await helper.start();
    const args = { operationId: randomUUID(), runId: "caller-rollback", source,
      expectedDefinitionDigest: compiled.definitionDigest, deadline: Date.now() + 10000, inputs: { value: "public" } };
    t.after(async () => { await helper.close(); db.close(); await storage.close(); await rm(root, { recursive: true, force: true }); });
    try {
      db.exec("BEGIN IMMEDIATE");
      helper.mutateAction({ operation: "action.runtime.create", args, actorId: actor.id });
      db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(args.operationId, "0".repeat(64), "{}",
        actor.id, "action.runtime.create", new Date().toISOString());
      db.exec("ROLLBACK");
      assert.equal(db.prepare("SELECT count(*) n FROM action_runtime_runs WHERE run_id=?").get(args.runId).n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM receipts WHERE operation_id=?").get(args.operationId).n, 0);
      db.exec("BEGIN IMMEDIATE");
      helper.mutateAction({ operation: "action.runtime.create", args, actorId: actor.id });
      journal(db);
      db.exec("COMMIT");
      helper.wake();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(approvals.length, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
      db.exec("DELETE FROM pending_write");
      await until(() => helper.readAction({ operation: "action.runtime.get", args: { runId: args.runId }, actorId: actor.id }).state === "succeeded");
      assert.equal(approvals.length, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='SUCCEEDED'").get().n, 1);
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.exec("DELETE FROM pending_write"); }
  });

  test("unknown journal inserted while awaiting native Action approval yields zero actual child launches", { timeout: 20000 }, async t => {
    let f;
    f = await servicesFixture(t, "console.log(JSON.stringify({value:'public'}))", { approve() {
      const db = f.storage.connectNative();
      try { journal(db); } finally { db.close(); }
    } });
    const args = f.create();
    assert.equal((await f.rpc("capability_call", "action.runtime.create", args)).status, 200);
    await until(() => f.approvals.length === 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    const db = f.storage.connectNative();
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n, 0);
      db.exec("DELETE FROM pending_write");
    } finally { db.close(); }
  });
test("real native host Action dispatcher schedules an authenticated child postcommit, redacts actual output and backs up quiescent state", { timeout: 30000 }, async t => {
  const code = "let s='';for await(const c of process.stdin)s+=c;JSON.parse(s);console.log(JSON.stringify({value:['synthetic','private','result'].join('-')}))";
  const f = await servicesFixture(t, code), args = f.create();
  const created = await f.rpc("capability_call", "action.runtime.create", args);
  assert.equal(created.status, 200, JSON.stringify(created));
  const run = await until(() => f.rpc("capability_read", "action.runtime.get", { runId: args.runId }).then(value => value.body.result),
    value => value && ["succeeded", "failed", "unknown"].includes(value.state));
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.equal(f.approvals.length, 1);
  assert.deepEqual((await f.rpc("capability_call", "action.runtime.create", args)).body.result, created.body.result);
  assert.equal(f.approvals.length, 1, "global immutable receipt cannot replay child");
  const events = await f.rpc("capability_read", "action.runtime.events", { runId: args.runId, after: 0, limit: 100 });
  assert.ok(events.body.result.items.some(event => event.kind === "run-succeeded"));
  assert.equal(JSON.stringify([run, events]).includes("synthetic-private-result"), false);
  assert.equal(Object.hasOwn(run.nodes[0], "outputs"), false);
  for (const operation of ["action.runtime.tick", "action.runtime.result", "process.result"]) {
    const forged = await f.rpc("capability_call", operation, { runId: args.runId, state: "succeeded", outputs: { value: "forged" } });
    assert.ok(forged.status !== 200 || forged.body.error, operation);
  }
  const denied = await f.rpc("capability_call", "action.runtime.create", { ...args, runId: "denied", operationId: randomUUID(), inputs: { value: "unauthorized" } });
  assert.ok(denied.status !== 200 || denied.body.error);
  const database = f.storage.connectNative();
  try {
    const processRow = JSON.parse(database.prepare("SELECT record_json FROM runtime_process_jobs").get().record_json);
    assert.equal(processRow.state, "SUCCEEDED");
    assert.equal(processRow.stdout, "");
    assert.equal(processRow.stderr, "");
    const snapshot = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE run_id=?").get(args.runId).snapshot;
    assert.equal(snapshot.includes("synthetic-private-result"), false);
    assert.ok(snapshot.includes("native-redacted-result"));
  } finally { database.close(); }
  const backupPath = resolve(f.root, "backup"), destination = resolve(f.root, "restored");
  const result = await f.runtime.services.hostServices.backup(backupPath);
  assert.equal(result.workspaceId, f.workspaceId);
  await assert.rejects(f.runtime.services.hostServices.restore(backupPath, destination), { code: "AUTHORITY_REQUIRED" });
  const sourceStat = await lstat(backupPath, { bigint: true });
  f.restorePin.request = {
    schema: "pkm.native-restore-authority-request/v1", intent: "workspace-restore", actorId: actor.id,
    workspaceId: f.workspaceId, sourceRoot: backupPath, sourceDevice: String(sourceStat.dev),
    sourceInode: String(sourceStat.ino), manifestSha256: hash(await readFile(resolve(backupPath, ".pkm-workspace-backup.json"))),
    destination, backupErasureEpoch: null,
  };
  const restored = await f.runtime.services.hostServices.restore(backupPath, destination);
  assert.equal(restored.workspaceId, f.workspaceId);
  assert.equal(f.restorePin.calls, process.platform === "linux" ? 4 : 3,
    "Restore reauthorizes before staging, after validation, before publication and after Linux fence marker binding");
  assert.ok((await readFile(resolve(destination, "core.sqlite"))).length);
  const reopened = await Storage.open(destination);
  try { assert.equal(await reopened.workspaceId(), f.workspaceId); } finally { await reopened.close(); }
});

test("MCP direct native Action runtime creates and executes a pinned inline Action without GPT", { timeout: 30000 }, async t => {
  const code = "let s='';for await(const c of process.stdin)s+=c;const v=JSON.parse(s);console.log(JSON.stringify({value:v.value}))";
  const f = await servicesFixture(t, code);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startMcp(f.runtime.core, actor, serverTransport);
  const client = new Client({ name: "native-action-create-call", version: "1" });
  t.after(async () => { await client.close(); await server.close(); });
  await client.connect(clientTransport);

  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === "capability_call"));
  assert.ok(!tools.tools.some(tool => tool.name === "action_call" || tool.name === "action_register"),
    "legacy Action proposal/call APIs are not wired into this next-server MCP surface");
  const args = f.create();
  const created = await client.callTool({ name: "capability_call", arguments: invocation("action.runtime.create", args) });
  assert.notEqual(created.isError, true, JSON.stringify(created));
  assert.equal(created.structuredContent.result.runId, args.runId);
  assert.equal(created.structuredContent.result.state, "ready");

  const run = await until(async () => {
    const response = await client.callTool({ name: "capability_read", arguments: invocation(
      "action.runtime.get", { runId: args.runId },
    ) });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.result;
  }, value => ["succeeded", "failed", "unknown"].includes(value.state));
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.equal(f.approvals.length, 1, "the native per-invocation host approval runs; GPT review is not an execution gate");
  assert.equal(f.approvals[0].executableDigest, f.compiled.definitionDigest);
  assert.equal(f.approvals[0].actorId, actor.id);
  assert.deepEqual(run.nodes, [{ nodeId: "action", state: "succeeded" }]);
});

test("real active Action child blocks backup, public cancellation drains it without accepting forged success", { timeout: 30000 }, async t => {
  const f = await servicesFixture(t, "setInterval(()=>{},1000)"), args = f.create();
  assert.equal((await f.rpc("capability_call", "action.runtime.create", args)).status, 200);
  await until(() => {
    const db = f.storage.connectNative();
    try { return db.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='RUNNING'").get().n === 1; }
    finally { db.close(); }
  });

  await assert.rejects(f.runtime.services.hostServices.backup(resolve(f.root, "active-backup")));
  const current = (await f.rpc("capability_read", "action.runtime.get", { runId: args.runId })).body.result;
  const cancelled = await f.rpc("capability_call", "action.runtime.cancel", {
    operationId: randomUUID(), runId: args.runId, expectedVersion: current.version,
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
  const terminal = await until(() => f.rpc("capability_read", "action.runtime.get", { runId: args.runId }).then(value => value.body.result),
    value => value && value.state === "unknown");
  assert.equal(terminal.nodes[0].state, "unknown");
  const events = (await f.rpc("capability_read", "action.runtime.events", {
    runId: args.runId, after: 0, limit: 100,
  })).body.result.items;
  assert.ok(events.some(event => event.kind === "cancel-requested"));
  assert.equal(events.some(event => event.kind === "run-succeeded"), false);
  await until(() => {
    const db = f.storage.connectNative();
    try { return db.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='RUNNING'").get().n === 0; }
    finally { db.close(); }
  });
});

test("native snapshot refuses actually active Manager/Chat tasks and durable future intents", { timeout: 30000 }, async t => {
    const manager = syntheticManager("small", 1, { hold: true });
    const managed = await nativeWorkspace(t, { manager: manager.config, hostServices: { authorizeBackup: () => true } });
    managed.addCleanup(manager.release);
    assert.ok((await managed.call("manager.runtime.start", manager.start("active-backup"))).result);
    await until(() => manager.calls.active === 1);
    await assert.rejects(managed.runtime.services.hostServices.backup(`${managed.root}-manager-backup`),
      error => ["ACTIVE_RUNTIME", "BUSY"].includes(error.code));
    manager.release();
    await until(() => managed.call("manager.runtime.get", { runId: "active-backup" }).then(value => value.result?.state === "succeeded"));

    let opened = false, release;
    const gate = new Promise(resolve => { release = resolve; });
    const provider = createSyntheticProvider({ async onOpen(request) {
      opened = true;
      await Promise.race([gate, new Promise(resolve => request.signal.addEventListener("abort", resolve, { once: true }))]);
    } });
    const chatting = await nativeWorkspace(t, { ...provider, toolCatalog: [{ name: "create_document", operation: "knowledge.document.create" }],
      reviewer: async request => ({ actorId: request.actorId, decisionId: randomUUID(), decision: "reject" }),
      hostServices: { authorizeBackup: () => true } });
    chatting.addCleanup(release);
    const input = chatTurnInput({ deadlineMs: 15000, expectedSessionRevision: 1 });
    assert.ok((await chatting.call("chat.session.create", { id: input.sessionId, title: "Active Chat",
      operationId: randomUUID(), expectedRevision: 0 })).result);
    assert.ok((await chatting.call("chat.turn.start", input)).result);
    await until(() => opened);
    await assert.rejects(chatting.runtime.services.hostServices.backup(`${chatting.root}-chat-backup`),
      error => ["ACTIVE_RUNTIME", "BUSY"].includes(error.code));
    release();
    await until(() => chatting.call("chat.turn.get", { id: input.id }).then(value =>
      ["completed", "failed", "cancelled", "unknown"].includes(value.result?.status)));
    const db = managed.storage.connectNative();
    try {
      db.exec("CREATE TABLE pending_future_intents(value TEXT); INSERT INTO pending_future_intents VALUES('synthetic');");
      await assert.rejects(managed.runtime.services.hostServices.backup(`${managed.root}-intent-backup`),
        error => error.code === "PENDING_JOURNAL");
    } finally { db.close(); }
});

test("trusted-workspace proposal admission is exact, revocable and still requires input and effect consent", { timeout: 30000 }, async t => {
  const root = resolve(import.meta.dirname, `.batch07-action-trust-${randomUUID()}`);
  await initialize(root);
  const storage = await Storage.open(root), workspaceId = await storage.workspaceId();
  const trustedActor = { id: "mcp:external", canWrite: true };
  const code = "setTimeout(()=>console.log(JSON.stringify({value:'public'})),500)";
  const definition = structuredClone(original.example);
  definition.implementations[0].program = "fixture";
  definition.implementations[0].args = ["-e", code];
  const approvedIds = new Set([definition.action_id]);
  const approvals = [];
  let effectConsent = true;
  let approvalFault = false;
  let approvalWait;
  let trust = { workspaceId, actorId: trustedActor.id, trustedWorkspace: true, epoch: "trusted-1" };
  const automaticTrusted = {
    current: () => ({ ...trust }),
    revoke: () => { trust = { ...trust, trustedWorkspace: false, epoch: "trusted-2" }; },
  };
  const native = await createNativeRuntime({ storage, hostServices: {
    action: { automaticTrusted, process: { commands: [{
      id: "fixture", executable: process.execPath, cwd: root, directChildOnly: true,
      arguments: [{ literal: "-e" }, { literal: code }],
      outputContractDigest: originalDigest(definition.output_schema),
      authorizationDigest: hash("per-action trusted host policy"),
      authorizeDefinition: binding => {
        return binding.actorId === trustedActor.id && binding.workspaceId === workspaceId
        && approvedIds.has(binding.definition.action_id) && binding.implementation.program === "fixture"
        && JSON.stringify(binding.implementation.args) === JSON.stringify(["-e", code]);
      },
      authorizeData: binding => binding.inputs.value === "public",
      approve: async request => {
        approvals.push(request);
        if (approvalWait) await approvalWait;
        if (approvalFault) throw new Error("approval service unavailable");
        return effectConsent && request.actorId === trustedActor.id && approvedIds.has(request.actionId);
      },
      redactOutput: () => ({ value: "redacted-public" }),
    }] } },
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startLegacyNoteMcp(storage, serverTransport, {
    core: native.core, actor: trustedActor, actionHost: native.services.hostServices,
  });
  const client = new Client({ name: "automatic-action-trust-test", version: "1.0.0" });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await native.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });

  const submit = async actionDefinition => {
    const response = await client.callTool({ name: "legacy_action_write", arguments: {
      tool: "action_register", arguments: { definition: actionDefinition },
    } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return response.structuredContent.value;
  };
  const call = (proposal, key, inputs = { value: "public" }) => client.callTool({
    name: "action_call", arguments: {
      action_id: proposal.action_id,
      content_hash: proposal.content_hash, idempotency_key: key, inputs,
    },
  });
  const status = runId => native.services.hostServices.readAction({
    operation: "action.runtime.get", args: { runId }, actorId: trustedActor.id,
  });

  const first = await submit(definition);
  assert.equal(first.state, "automatically_admitted");
  assert.equal(first.registered, true);
  assert.equal(first.callable, true);
  const registered = await client.callTool({ name: "legacy_action_read", arguments: {
    tool: "action_get", arguments: { action_id: first.action_id },
  } });
  assert.notEqual(registered.isError, true, JSON.stringify(registered));
  assert.equal(registered.structuredContent.value.content_hash, first.content_hash);
  assert.equal(registered.structuredContent.value.availability.state, "ready");
  const registrationDb = storage.connectNative();
  try {
    const row = registrationDb.prepare("SELECT proposal_id,content_hash,trust_epoch FROM native_action_automatic_admissions WHERE action_id=?")
      .get(first.action_id);
    assert.equal(row.proposal_id, first.proposal_id);
    assert.equal(row.content_hash, first.content_hash);
    assert.equal(row.trust_epoch, trust.epoch);
  } finally { registrationDb.close(); }
  await assert.rejects(native.services.hostServices.admitActionProposal(
    { id: "mcp:forged", canWrite: true }, first.proposal_id, first.content_hash), /trusted native workspace/);
  const forgedTrust = await client.callTool({ name: "action_call", arguments: {
    action_id: first.action_id, proposal_id: first.proposal_id, content_hash: first.content_hash,
    idempotency_key: "forged-trust-attempt", inputs: { value: "public" }, trustedWorkspace: true,
  } });
  assert.equal(forgedTrust.isError, true);
  const [firstCall, concurrentCall] = await Promise.all([
    call(first, "create-call-v1"), call(first, "create-call-v1"),
  ]);
  assert.notEqual(firstCall.isError, true, JSON.stringify(firstCall));
  assert.notEqual(concurrentCall.isError, true, JSON.stringify(concurrentCall));
  assert.equal(firstCall.structuredContent.value.runId, concurrentCall.structuredContent.value.runId);
  const firstRun = firstCall.structuredContent.value;
  assert.equal(firstRun.state, "ready");
  const succeeded = await until(() => status(firstRun.runId), run => run.state === "succeeded");
  assert.equal(succeeded.nodes[0].state, "succeeded");
  assert.equal(approvals.length, 1);
  const repeated = await call(first, "create-call-v1");
  assert.equal(repeated.structuredContent.value.runId, firstRun.runId);
  assert.equal(approvals.length, 1);
  assert.equal((await call(first, "create-call-v1", { value: "changed" })).isError, true);

  assert.equal((await call(first, "invalid-sensitive-input", { value: "secret" })).isError, true);
  assert.equal(approvals.length, 1);

  const unapprovedAction = { ...structuredClone(definition), action_id: "example.sensitive.transfer" };
  const unapprovedProposal = await submit(unapprovedAction);
  assert.equal(unapprovedProposal.state, "pending_operator_approval");
  assert.equal(unapprovedProposal.registered, false);
  assert.equal(unapprovedProposal.callable, false);
  assert.equal((await call(unapprovedProposal, "host-policy-denied")).isError, true);
  assert.equal(approvals.length, 1);
  const unlistedProgram = structuredClone(definition);
  unlistedProgram.version = definition.version + 1;
  unlistedProgram.implementations[0].program = "not-allowlisted";
  const unlistedProposal = await submit(unlistedProgram);
  assert.equal(unlistedProposal.state, "pending_operator_approval");
  assert.equal(unlistedProposal.registered, false);
  assert.equal((await call(unlistedProposal, "unlisted-program")).isError, true);

  const revisionTwo = { ...structuredClone(definition), version: definition.version + 1 };
  const second = await submit(revisionTwo);
  assert.equal(second.state, "automatically_admitted");
  assert.equal((await call(first, "old-revision-after-update")).isError, true);
  const oldResubmission = await client.callTool({ name: "legacy_action_write", arguments: {
    tool: "action_register", arguments: { definition },
  } });
  assert.equal(oldResubmission.isError, true);

  effectConsent = false;
  const beforeDenialDb = storage.connectNative();
  const jobsBeforeDenial = Number(beforeDenialDb.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n);
  const callsBeforeDenial = Number(beforeDenialDb.prepare("SELECT count(*) n FROM native_action_automatic_calls").get().n);
  const runsBeforeDenial = Number(beforeDenialDb.prepare("SELECT count(*) n FROM action_runtime_runs").get().n);
  beforeDenialDb.close();
  const deniedEffect = await call(second, "effect-consent-denied");
  assert.equal(deniedEffect.isError, true);
  assert.match(JSON.stringify(deniedEffect), /ACTION_EFFECT_CONSENT_REQUIRED/);
  assert.equal(approvals.length, 2);
  const afterDenialDb = storage.connectNative();
  try {
    assert.equal(Number(afterDenialDb.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n), jobsBeforeDenial);
    assert.equal(Number(afterDenialDb.prepare("SELECT count(*) n FROM native_action_automatic_calls").get().n), callsBeforeDenial);
    assert.equal(Number(afterDenialDb.prepare("SELECT count(*) n FROM action_runtime_runs").get().n), runsBeforeDenial);
  } finally { afterDenialDb.close(); }
  approvalFault = true;
  const unavailable = await call(second, "effect-consent-unavailable");
  assert.equal(unavailable.isError, true);
  assert.match(JSON.stringify(unavailable), /approval service unavailable/);
  const afterUnavailableDb = storage.connectNative();
  try {
    assert.equal(Number(afterUnavailableDb.prepare("SELECT count(*) n FROM runtime_process_jobs").get().n), jobsBeforeDenial);
    assert.equal(Number(afterUnavailableDb.prepare("SELECT count(*) n FROM native_action_automatic_calls").get().n), callsBeforeDenial);
    assert.equal(Number(afterUnavailableDb.prepare("SELECT count(*) n FROM action_runtime_runs").get().n), runsBeforeDenial);
  } finally { afterUnavailableDb.close(); }
  approvalFault = false;
  effectConsent = true;
  const activeCall = await call(second, "trust-change-during-effect");
  assert.notEqual(activeCall.isError, true, JSON.stringify(activeCall));
  const activeRun = activeCall.structuredContent.value;
  const db = storage.connectNative();
  try {
    await until(() => db.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='RUNNING'").get().n);
    trust = { ...trust, trustedWorkspace: false, epoch: "trusted-revoked-externally" };
  }
  finally { db.close(); }
  const externallyRevoked = await until(() => status(activeRun.runId), run => ["unknown", "cancelled"].includes(run.state));
  assert.equal(externallyRevoked.state, "unknown");
  assert.equal(externallyRevoked.nodes[0].state, "unknown");
  const afterFence = storage.connectNative();
  try {
    await until(
      () => afterFence.prepare("SELECT count(*) n FROM runtime_process_jobs WHERE state='RUNNING'").get().n,
      runningJobs => runningJobs === 0,
    );
    const processJobStates = afterFence.prepare("SELECT state FROM runtime_process_jobs").all().map(row => row.state);
    assert.equal(processJobStates.length, 2);
    assert.ok(processJobStates.includes("SUCCEEDED"));
    // Revocation cannot undo a process that finished before the monitor's next poll.
    assert.ok(processJobStates.every(state => state === "SUCCEEDED" || state === "CANCELLED"));
  } finally { afterFence.close(); }

  await native.services.hostServices.revokeAutomaticActionTrust();
  assert.equal(native.services.hostServices.automaticActionTrustStatus().trustedWorkspace, false);
  assert.equal((await call(second, "after-trust-revocation")).isError, true);
  assert.equal((await client.callTool({ name: "legacy_action_read", arguments: {
    tool: "action_get", arguments: { action_id: second.action_id },
  } })).isError, true);
  const untrustedProposal = await submit({ ...structuredClone(definition), version: definition.version + 2 });
  assert.equal(untrustedProposal.state, "pending_operator_approval");
  assert.equal((await call(untrustedProposal, "untrusted-workspace")).isError, true);
  trust = { ...trust, trustedWorkspace: true, epoch: "trusted-3" };
  assert.equal((await call(second, "new-epoch-before-readmission")).isError, true);
  const readmitted = await submit(revisionTwo);
  assert.equal(readmitted.proposal_id, second.proposal_id);
  assert.equal(readmitted.registered, true);
  const readmittedCall = await call(readmitted, "new-epoch-after-readmission");
  assert.notEqual(readmittedCall.isError, true, JSON.stringify(readmittedCall));
  await until(() => status(readmittedCall.structuredContent.value.runId), run => run.state === "succeeded");
  const third = await submit({ ...structuredClone(definition), version: definition.version + 3 });
  assert.equal(third.state, "automatically_admitted");
  effectConsent = true;
  const thirdCall = await call(third, "new-trust-epoch");
  assert.notEqual(thirdCall.isError, true, JSON.stringify(thirdCall));
  await until(() => status(thirdCall.structuredContent.value.runId), run => run.state === "succeeded");
  let releaseApproval;
  approvalWait = new Promise(resolve => { releaseApproval = resolve; });
  const approvalCount = approvals.length;
  const waitingCall = call(third, "revoke-during-consent");
  await until(() => approvals.length, count => count > approvalCount);
  trust = { ...trust, trustedWorkspace: false, epoch: "trusted-4" };
  releaseApproval();
  const revokedDuringConsent = await waitingCall;
  assert.equal(revokedDuringConsent.isError, true);
  const finalDb = storage.connectNative();
  try {
    assert.equal(finalDb.prepare("SELECT count(*) n FROM native_action_automatic_calls WHERE idempotency_key=?")
      .get("revoke-during-consent").n, 0);
  } finally { finalDb.close(); }
});
