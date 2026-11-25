import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { hydrateOriginalMcpTodo, activateOriginalMcpDomain, enrollOriginalMcpTodoWorker } from "../dist/original-mcp-domains.js";
import { readOriginalMcpTodoAuthority } from "../dist/original-mcp-domain-state.js";
import { planOriginalMcpApiChatSource, admitOriginalMcpApiChatSource, activateOriginalMcpApiChatSource } from "../dist/original-mcp-api-chat-source.js";
import { originalNativeChatDigest, originalNativeChatInferenceDigest } from "../dist/original-mcp-api-chat-contracts.js";
import { createOriginalMcpNativeChatSessionFixture } from "./fixtures/original-mcp-native-chat-session.mjs";
import { authenticateBoardWorker } from "../dist/boards.js";
import { prepareOriginalMcpTodoChatAssignment, assertOriginalMcpPreparedTodoChatAssignment } from "../dist/original-mcp-todo-assignment.js";

const require = createRequire(import.meta.url), extension = resolve("legacy");
const originalFixture = require("../legacy/tests/next-trial-electron/api-chat-fixture.cjs");
const store = require("../legacy/dist/knowledge/filestore.js");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const actor = { id: "mcp:external", canWrite: true }, workerId = "external:copilot:assignment-worker";
const boardSlug = "Team/Board";
const policy = { async authorize() {
  return { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 300_000 };
} };
async function fixture(t) {
  const directory = resolve("tests", `.todo-assignment-${randomUUID()}`), root = join(directory, "root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  let descriptor, oldToken, opened, host, wire, backend, executions = 0, sessionRequests = 0, modelAuthorizations = 0, allow = true;
  t.after(async () => {
    try { await backend?.close(); await opened?.owner.close(); await wire?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const mask = process.umask(0o077);
  try {
    descriptor = originalFixture.create({ extension, root });
    store.setStorePath(root); store.todoBoardCreate(boardSlug, "Board", "Team");
    store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest, { action: "create", item: {
      id: "original-task", title: "Original task", goal: "Preserve actual original Chat identity", scope: "Native fixture",
      acceptance: ["No assignment effect before atomic worker admission"], state: "Planning", evidence: [],
    } }, { id: "user:local", role: "user" });
    store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest, { action: "create", item: {
      id: "historical-worker-task", title: "Historical worker task", goal: "Retain evidence, not execution authority",
      scope: "Native fixture", acceptance: ["Fresh enrollment only"], state: "Planning", evidence: [],
    } }, { id: "user:local", role: "user" });
    store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest,
      { action: "assign", id: "historical-worker-task", ownerId: workerId, reason: "Historical assignment" }, { id: "user:local", role: "user" });
    oldToken = store.todoBoardGrantWorker(boardSlug, store.noteWorkItemsRead(boardSlug).digest, workerId);
  } finally { process.umask(mask); }
  const sourceBoard = join(root, "notes/Team/Board.assets/pkm-todo-board.json"), originalBoard = await readFile(sourceBoard);
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "assignment-fixture",
    profileSha256: hash("separate-assignment-fixture-profile"),
    limits: { maxEntries: 10_000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 8_388_608 } });
  opened = await openOriginalMcpRoot(plan);
  const models = {
    async catalogue() { return { source: "vscode.lm", epoch: wire.activationId, models: [{
      id: "assignment-fixture-model", nativeModelId: "assignment-fixture-wire", label: "Socket fixture, not installed native UI",
      vendor: "fixture", family: "fixture", version: "fixture", maxInputTokens: 8192, maxOutputTokens: 128, imageInput: true,
    }] }; },
    async select(input) { return { selectionId: randomUUID(), modelId: input.modelId, epoch: wire.activationId, maxInputTokens: 8192 }; },
    async count(input) { return { selectionId: input.selectionId, requestSha256: input.requestSha256,
      inputTokens: 1, countingMethod: "vscode-countTokens-plus-tool-overhead" }; },
    async *stream() { throw new Error("Assignment fixture never calls a provider."); },
  };
  const execution = { async run(plan, callbacks) {
    executions++;
    const inferenceId = originalNativeChatDigest({ requestId: plan.requestId, sourcePlanSha256: plan.sourcePlanSha256, round: 0, receipts: [] });
    const body = { inferenceId, round: 0, planSha256: originalNativeChatDigest(plan), sourcePlanSha256: plan.sourcePlanSha256,
      selectionId: plan.selectionId, nativeRequest: { messages: [{ role: 1, content: [{ value: "Socket fixture only" }] }],
        options: { justification: "Fixture continuation, not installed native UI." } },
      inputTokens: 1, countingMethod: "vscode-countTokens-plus-overhead" };
    await callbacks.beforeInference({ ...body, requestSha256: originalNativeChatInferenceDigest(body) });
    await callbacks.text({ inferenceId, text: "Owned fixture continuation." });
    return { status: "complete", toolRoundLimit: null };
  } };
  // Real socket/signature/native-field protocol plus actual RootOwner/Core; not native VS Code UI authority.
  wire = await createOriginalMcpNativeChatSessionFixture(t, { binding: {
    root, workspaceId: opened.workspaceId, planSha256: plan.planSha256, profileSha256: plan.profileSha256,
    catalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
  }, models, execution, apiChat: {
    async resolve() { sessionRequests++; return {
      protocol: "pkm.original-api-chat-execution/v1", epoch: wire.activationId,
      modelId: "assignment-fixture-model", wireModelId: "assignment-fixture-wire", provider: "vscode", permissionMode: "protective",
      outputTokenCap: 128, budget: { maxInputTokens: 8192, maxTotalOutputTokens: 128, deadlineMs: 30_000 },
    }; },
    async authorize() { sessionRequests++; return allow; }, async present() { sessionRequests++; },
  } });
  host = await createOriginalMcpNativeHost(opened.storage, {
    profileSha256: plan.profileSha256, sourceCatalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
    authorityId: "real-socket-fixture-not-native-ui", epoch: wire.activationId, signal: wire.resource.signal,
    assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
    models: { configuration: { aiEndpoint: "https://not-called.invalid", aiModel: "not-used" }, registryAvailability: {},
      async credentialAvailable() { return false; }, async authorizeRequest(request) {
        assert.equal(request.provider, "vscode"); modelAuthorizations++; return true;
      },
      transport: { supports: () => false, async open() { throw new Error("No provider calls in assignment fixture."); } } },
  }, { nativeChat: wire.resource });
  await opened.owner.ensureFull();
  await hydrateOriginalMcpTodo(opened.storage, host, [boardSlug], policy);
  const stagingDirectory = join(directory, "chat-source"); await mkdir(stagingDirectory, { mode: 0o700 });
  const source = await planOriginalMcpApiChatSource(opened.storage, host, { stagingDirectory,
    limits: { maxChats: 10, maxMessagesPerChat: 100, maxMessages: 100 } });
  await admitOriginalMcpApiChatSource(opened.storage, host, source, policy);
  backend = createNativePublicOwnerBackend(opened.owner, { actor, originalMcpHost: host });
  const call = async (operation, args, who = actor) => {
    const { runtime } = await opened.owner.ensureFull();
    const response = await runtime.core.dispatch(["todo.workitem.assign", "todo.workitem.comment", "chat.session.create", "chat.session.archive", "chat.session.append"]
      .includes(operation) ? "capability_call" : "capability_read", { operation, version: 1, arguments: args }, who);
    if (response.error) throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  };
  const invoke = async (tool, arguments_) => (await backend.invoke("original_mcp_public", { tool, arguments: arguments_ })).structuredContent;
  const bind = async (expected = "succeeded") => {
    const submitted = await invoke("api_chat_send", { host_id: opened.workspaceId, chat_id: descriptor.inline,
      prompt: "Existing native protocol prepares the exact original binding; Todo preparation starts nothing.",
      command_id: randomUUID() });
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await invoke("api_chat_request_get", { host_id: opened.workspaceId, request_id: submitted.request_id });
      if (!["queued", "running"].includes(result.status)) {
        assert.equal(result.status, expected, JSON.stringify(result));
        if (expected === "succeeded") assert.equal(result.result.chatId, descriptor.inline);
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("Existing owned Chat continuation did not settle.");
  };
  const args = async () => ({ board_slug: boardSlug, id: "original-task", owner_id: `chat:${descriptor.inline}`,
    reason: "Exact current original Chat target", expected_digest: (await call("todo.board.get", { board_slug: boardSlug })).digest,
    operationId: randomUUID() });
  return { root, plan, opened, host, wire, descriptor, sourceBoard, originalBoard, oldToken, backend, call, bind, args,
    counts: () => ({ executions, sessionRequests, modelAuthorizations }), allow: value => { allow = value; } };
}

test("read-only Todo authority distinguishes a genuine current Board worker enrollment from retained old grants", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const manager = readOriginalMcpTodoAuthority(f.root, actor.id, boardSlug);
  assert.equal(manager.workerReceiptSha256, undefined);
  assert.throws(() => readOriginalMcpTodoAuthority(f.root, workerId, boardSlug), /fresh native grant/);
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, f.oldToken), /never inherited/);
  const fresh = await enrollOriginalMcpTodoWorker(f.opened.storage, f.host, { boardSlug, actorId: workerId }, {
    async authorize(request) { return { actorId: request.actorId, decisionId: "fresh-assignment-worker", expiresAtMs: Date.now() + 60_000 }; },
  });
  const worker = readOriginalMcpTodoAuthority(f.root, workerId, boardSlug);
  assert.equal(worker.workerReceiptSha256, fresh.receiptSha256);
  assert.equal(worker.workerDecisionId, "fresh-assignment-worker");
  assert.equal(worker.sessionDecisionId, manager.sessionDecisionId);
  assert.equal("tokenSha256" in worker, false);
  assert.equal(f.counts().executions, 0);
  await activateOriginalMcpDomain(f.opened.storage, f.host, "todo", policy);
  assert.equal(Atomics.load(new Int32Array(worker.revocation), 0), 1);
  assert.throws(() => readOriginalMcpTodoAuthority(f.root, workerId, boardSlug), /fresh native grant/);
  assert.deepEqual(await readFile(f.sourceBoard), f.originalBoard);
});

test("private Storage really publishes exact original assignment and validates live authority before receipt replay", { timeout: 120_000 }, async t => {
    const f = await fixture(t); await f.bind();
    const args = await f.args(), candidate = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args);
    await assert.rejects(f.call("todo.workitem.assign", args), /private original|private.*admission|native existence/i);
    await assert.rejects(f.opened.storage.requestOriginalMcpTodoChatAssignment({ ...candidate }), /actual prepared/);
    await assert.rejects(f.opened.storage.requestOriginalMcpTodoChatAssignment({ ...candidate,
      revocation: new SharedArrayBuffer(4), todoRevocation: new SharedArrayBuffer(4), chatSourceRevocation: new SharedArrayBuffer(4) }), /actual prepared/);
    const counts = f.counts(), assigned = await f.opened.storage.requestOriginalMcpTodoChatAssignment(candidate);
    assert.equal(assigned.item.ownerId, args.owner_id);
    assert.notEqual(assigned.digest, args.expected_digest);
    assert.equal((await f.call("todo.workitem.get", { board_slug: boardSlug, id: args.id })).item.ownerId, args.owner_id);
    assert.deepEqual(await f.opened.storage.requestOriginalMcpTodoChatAssignment(candidate), assigned);
    assert.deepEqual(f.counts(), counts, "assignment and receipt replay start no model or native Chat queue");
    await assert.rejects(f.call("todo.workitem.assign", args), /private.*admission|native existence/i);
    const db = f.opened.storage.connectNative();
    try {
      const row = db.prepare("SELECT * FROM original_mcp_todo_assignments WHERE operation_id=?").get(args.operationId);
      assert.equal(JSON.parse(row.guard_json).guard.ownerId, args.owner_id);
      assert.equal(row.after_sha256, assigned.digest);
      assert.equal(JSON.parse(row.result_json).item.ownerId, args.owner_id);
      assert.equal(db.prepare("SELECT count(*) AS n FROM pending_todo").get().n, 0);
    } finally { db.close(); }
    candidate.revoke();
    await assert.rejects(f.opened.storage.requestOriginalMcpTodoChatAssignment(candidate), /revok/i);
    assert.deepEqual(await readFile(f.sourceBoard), f.originalBoard);
  });

test("canonical original-source assignment uses the atomic worker gate and never falls back to native session existence", { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const { operationId: _operationId, ...input } = await f.args();
  const request = { action: "call", args: { operation: "todo.workitem.assign", version: 1, arguments: input } };
  await assert.rejects(f.backend.invoke("legacy_capability_call", request), /current.*binding|fresh native continuation/i);
  await f.bind();
  const before = f.counts(), response = await f.backend.invoke("legacy_capability_call", request);
  assert.equal(response.structuredContent.schema, "pkm.capability-result/v1");
  assert.equal(response.structuredContent.operation, "todo.workitem.assign");
  assert.equal(response.structuredContent.result.item.ownerId, input.owner_id);
  assert.deepEqual(f.counts(), before, "A canonical assignment does not queue Chat/model execution.");
  assert.equal((await f.call("todo.workitem.get", { board_slug: boardSlug, id: input.id })).item.ownerId, input.owner_id);
  await assert.rejects(activateOriginalMcpApiChatSource(f.opened.storage, f.host, { async authorize() { return null; } }));
  const { operationId: _nextOperationId, ...next } = await f.args();
  await assert.rejects(f.backend.invoke("legacy_capability_call", {
    action: "call", args: { operation: "todo.workitem.assign", version: 1, arguments: next },
  }), /fresh source-domain|fresh.*source|source.*revok/i);
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(await readFile(f.sourceBoard), f.originalBoard);
});

test("worker admission rejects revocation and canonical Chat revision changes after main validation", { timeout: 120_000 }, async t => {
    for (const kind of ["revocation", "revision"]) {
      const f = await fixture(t); await f.bind();
      const args = await f.args(), candidate = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args);
      const storage = f.opened.storage, post = storage.postOriginalTodoAssignment;
      t.mock.method(storage, "postOriginalTodoAssignment", async function(admission) {
        if (kind === "revocation") candidate.revoke();
        else await f.call("chat.session.append", { id: f.descriptor.inline, expectedRevision: candidate.guard.coreRevision,
          operationId: randomUUID(), message: { id: randomUUID(), role: "user", content: "Actual intervening Core mutation", status: "complete" } });
        return post.call(this, admission);
      });
      await assert.rejects(storage.requestOriginalMcpTodoChatAssignment(candidate), /revok|revision changed/i);
      const db = storage.connectNative();
      try {
        assert.equal(db.prepare("SELECT count(*) AS n FROM pending_todo").get().n, 0);
        assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(args.operationId).n, 0);
      } finally { db.close(); }
      assert.deepEqual(await readFile(join(f.root, ".pkm-next-todo/Team/Board/pkm-todo-board.json")), f.originalBoard);
      t.mock.restoreAll();
    }
  });

test("interrupted publication preserves exact guard and cannot recover or restart with revoked/retained admission", { timeout: 120_000 }, async t => {
    const f = await fixture(t); await f.bind();
    const args = await f.args(), candidate = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args);
    let db = f.opened.storage.connectNative();
    try { db.exec(`CREATE TRIGGER fixture_stop_original_receipt BEFORE INSERT ON receipts
      WHEN NEW.operation='todo.workitem.assign' BEGIN SELECT RAISE(ABORT,'fixture-original-receipt-interruption'); END;`); }
    finally { db.close(); }
    await assert.rejects(f.opened.storage.requestOriginalMcpTodoChatAssignment(candidate), /intent committed|interruption/i);
    db = f.opened.storage.connectNative();
    let pending, guard;
    try {
      pending = db.prepare("SELECT * FROM pending_todo").get();
      guard = db.prepare("SELECT * FROM original_mcp_todo_assignments WHERE operation_id=?").get(args.operationId);
      assert.equal(pending.operation_id, args.operationId);
      assert.equal(guard.after_sha256, hash(pending.after_json));
      assert.equal(guard.result_json, pending.result);
      db.exec("DROP TRIGGER fixture_stop_original_receipt");
    } finally { db.close(); }
    candidate.revoke();
    await assert.rejects(f.call("todo.board.get", { board_slug: boardSlug }), /admission|revok|authority/i);
    db = f.opened.storage.connectNative();
    try {
      assert.deepEqual(db.prepare("SELECT * FROM pending_todo").get(), pending);
      assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(args.operationId).n, 0);
    } finally { db.close(); }
    await f.backend.close(); await f.opened.owner.close(); await f.wire.close();
    await assert.rejects(openOriginalMcpRoot(f.plan), /admission|restart|native|guard/i);
    assert.deepEqual(await readFile(f.sourceBoard), f.originalBoard);
  });

test("Board digest and original source mutation revoke preparation without receipt replay or assignment publication", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.bind();
  const args = await f.args(), candidate = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args);
  await f.call("todo.workitem.comment", { board_slug: boardSlug, id: args.id, text: "Actual canonical Board change",
    expected_digest: args.expected_digest, operationId: randomUUID() });
  await assert.rejects(candidate.assertCurrent(), /digest changed/);
  const fresh = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, await f.args());
  const nativeBoard = join(f.root, ".pkm-next-todo/Team/Board/pkm-todo-board.json"), before = await readFile(nativeBoard);
  const metadata = join(f.root, ".pkm/state/api-chats", f.descriptor.namespace, `${f.descriptor.inline}.json`);
  await writeFile(metadata, Buffer.concat([await readFile(metadata), Buffer.from("\n")]), { mode: 0o600 });
  await assert.rejects(fresh.assertCurrent(), /changed|custody/i);
  await assert.rejects(fresh.assertCurrent(), /revok/i);
  assert.equal(Atomics.load(new Int32Array(fresh.revocation), 0), 1);
  assert.deepEqual(await readFile(nativeBoard), before);
  assert.deepEqual(await readFile(f.sourceBoard), f.originalBoard);
});

test("compatible live private admission resumes an interrupted pending assignment without a second effect", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.bind();
  const args = await f.args(), candidate = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args);
  let db = f.opened.storage.connectNative();
  try { db.exec(`CREATE TRIGGER fixture_stop_compatible_receipt BEFORE INSERT ON receipts
    WHEN NEW.operation='todo.workitem.assign' BEGIN SELECT RAISE(ABORT,'fixture-compatible-interruption'); END;`); }
  finally { db.close(); }
  await assert.rejects(f.opened.storage.requestOriginalMcpTodoChatAssignment(candidate), /intent committed|interruption/i);
  const nativeBoard = join(f.root, ".pkm-next-todo/Team/Board/pkm-todo-board.json"), published = await readFile(nativeBoard);
  db = f.opened.storage.connectNative();
  try { db.exec("DROP TRIGGER fixture_stop_compatible_receipt"); } finally { db.close(); }
  const counts = f.counts();
  const result = await f.opened.storage.requestOriginalMcpTodoChatAssignment(candidate);
  assert.equal(result.item.ownerId, args.owner_id);
  assert.deepEqual(await readFile(nativeBoard), published);
  assert.deepEqual(await f.opened.storage.requestOriginalMcpTodoChatAssignment(candidate), result);
  assert.deepEqual(f.counts(), counts);
  db = f.opened.storage.connectNative();
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM pending_todo").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(args.operationId).n, 1);
  } finally { db.close(); }
});

test("atomic worker checks original source bytes again after main admission", { timeout: 120_000 }, async t => {
  const f = await fixture(t); await f.bind();
  const args = await f.args(), candidate = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args);
  const storage = f.opened.storage, post = storage.postOriginalTodoAssignment;
  t.mock.method(storage, "postOriginalTodoAssignment", async function(admission) {
    const path = join(f.root, ".pkm/state/api-chats", f.descriptor.namespace, `${f.descriptor.inline}.json`);
    await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("\n")]), { mode: 0o600 });
    return post.call(this, admission);
  });
  await assert.rejects(storage.requestOriginalMcpTodoChatAssignment(candidate), /metadata changed|source changed/i);
  assert.deepEqual(await readFile(join(f.root, ".pkm-next-todo/Team/Board/pkm-todo-board.json")), f.originalBoard);
  const db = storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM receipts WHERE operation_id=?").get(args.operationId).n, 0); }
  finally { db.close(); }
});

test("real socket/Core fixture prepares only the exact freshly bound original UUID; native existence and copied objects are not authority", { timeout: 120_000 }, async t => {
  const f = await fixture(t), args = await f.args();
  await f.call("chat.session.create", { id: f.descriptor.segmented, title: "Core existence without original native binding",
    operationId: randomUUID(), expectedRevision: 0 });
  await assert.rejects(prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor,
    { ...args, owner_id: `chat:${f.descriptor.segmented}` }), /binding|continuation|native|source/i);
  await assert.rejects(prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args),
    /binding|continuation|native|source/i);
  const completed = await f.bind(), counts = f.counts();
  await assert.rejects(prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, { ...actor, canWrite: false }, args),
    /authenticated manager/);
  const session = await f.call("chat.session.get", { id: f.descriptor.inline });
  const candidate = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args);
  await assertOriginalMcpPreparedTodoChatAssignment(candidate, f.opened.owner, f.host);
  assert.equal(candidate.guard.ownerId, `chat:${f.descriptor.inline}`);
  assert.equal(candidate.guard.chatUrl, `pkm://chats/${f.descriptor.namespace}/${f.descriptor.inline}`);
  assert.equal(candidate.guard.coreSessionId, f.descriptor.inline);
  assert.equal(candidate.guard.coreRevision, session.revision);
  assert.equal(candidate.guard.nativeRequestId, completed.request_id);
  assert.equal(candidate.guard.nativeEpoch, f.wire.activationId);
  assert.equal(candidate.guard.boardDigest, args.expected_digest);
  assert.equal(candidate.arguments.operationId, args.operationId);
  await assert.rejects(assertOriginalMcpPreparedTodoChatAssignment({ ...candidate }, f.opened.owner, f.host), /genuine prepared/);
  assert.deepEqual(f.counts(), counts, "preparing/asserting assignment dispatches no inference, queue or native Chat request");
  assert.equal((await f.call("todo.board.get", { board_slug: boardSlug })).digest, args.expected_digest);
  assert.equal((await f.call("todo.workitem.get", { board_slug: boardSlug, id: args.id })).item.ownerId, undefined);
  await f.call("chat.session.archive", { id: f.descriptor.inline, expectedRevision: session.revision, operationId: randomUUID() });
  await assert.rejects(candidate.assertCurrent(), /revision|archiv|binding|native/i);
  assert.equal(Atomics.load(new Int32Array(candidate.revocation), 0), 1);
  const ordinary = randomUUID();
  await f.call("chat.session.create", { id: ordinary, title: "Ordinary same-actor native Chat", expectedRevision: 0, operationId: randomUUID() });
  const assigned = await f.call("todo.workitem.assign", { ...args, owner_id: `chat:${ordinary}`, operationId: randomUUID() });
  assert.equal(assigned.item.ownerId, `chat:${ordinary}`, "ordinary native assignment remains unchanged");
  assert.deepEqual(await readFile(f.sourceBoard), f.originalBoard);
});

test("native refusal, fresh worker scope, Todo readmission and signed-session revocation cannot revive an old prepared assignment", { timeout: 120_000 }, async t => {
  const f = await fixture(t), args = await f.args();
  f.allow(false); await f.bind("failed");
  await assert.rejects(prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args), /binding|continuation|native|source/i);
  assert.equal(f.counts().executions, 0);
  f.allow(true); await f.bind();
  const candidate = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args);
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, f.oldToken), /never inherited/);
  const fresh = await enrollOriginalMcpTodoWorker(f.opened.storage, f.host, { boardSlug, actorId: workerId }, {
    async authorize(request) { return { actorId: request.actorId, decisionId: randomUUID(), expiresAtMs: Date.now() + 60_000 }; },
  });
  const worker = authenticateBoardWorker(f.root, boardSlug, fresh.token);
  await assert.rejects(prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, { ...worker, canWrite: true }, args),
    /actor|owner|worker|authority/i);
  await activateOriginalMcpDomain(f.opened.storage, f.host, "todo", policy);
  await assert.rejects(candidate.assertCurrent(), /authority|revok|manager|worker/i);
  const replacement = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args);
  assert.notEqual(replacement.guard.sessionDecisionId, candidate.guard.sessionDecisionId);
  await assert.rejects(candidate.assertCurrent(), /revok/i);
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, fresh.token), /never inherited/);
  await assert.rejects(activateOriginalMcpApiChatSource(f.opened.storage, f.host,
    { async authorize() { return null; } }), /Fresh exact native/);
  assert.equal(Atomics.load(new Int32Array(replacement.chatSourceRevocation), 0), 1);
  assert.equal(f.host.signal.aborted, false, "logical source revocation is not transport revocation");
  await assert.rejects(replacement.assertCurrent(), /revok/i);
  await activateOriginalMcpApiChatSource(f.opened.storage, f.host, policy);
  const current = await prepareOriginalMcpTodoChatAssignment(f.opened.owner, f.host, actor, args);
  assert.notEqual(current.guard.chatSourceDecisionId, replacement.guard.chatSourceDecisionId);
  await assert.rejects(replacement.assertCurrent(), /revok/i);
  const counts = f.counts();
  await f.wire.close();
  await assert.rejects(current.assertCurrent(), /native|revok|authority|attachment/i);
  assert.deepEqual(f.counts(), counts);
  assert.equal((await readFile(join(f.root, ".pkm-next-todo/Team/Board/pkm-todo-board.json"))).equals(f.originalBoard), true);
  assert.deepEqual(await readFile(f.sourceBoard), f.originalBoard);
});
