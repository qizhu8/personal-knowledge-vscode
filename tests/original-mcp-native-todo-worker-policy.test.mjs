import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  originalMcpNativeResult, createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport } from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createOriginalMcpNativeSourcePolicies } from "../dist/original-mcp-native-source-policy.js";
import { createOriginalMcpNativeTodoWorkerPolicy, assertOriginalMcpNativeTodoWorkerPolicy,
  enrollOriginalMcpNativeTodoWorker } from "../dist/original-mcp-native-todo-worker-policy.js";
import { originalNativeTodoWorkerDigest } from "../dist/original-mcp-native-todo-worker-contracts.js";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { hydrateOriginalMcpTodo } from "../dist/original-mcp-domains.js";
import { readOriginalMcpTodoAuthority } from "../dist/original-mcp-domain-state.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { authenticateBoardWorker } from "../dist/boards.js";

assert(process.env.PKM_TEST_WORKSPACE, "Run signed worker tests in the existing isolated Linux framework.");
const require = createRequire(import.meta.url), store = require("../legacy/dist/knowledge/filestore.js");
const hash = value => createHash("sha256").update(value).digest("hex");
const workerId = "external:copilot:signed-worker", boardSlug = "Team/Board";
const actor = { id: "mcp:external", canWrite: true }, integrated = originalMcpNativeRequestMethods.includes("todo.worker.enroll");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const directory = resolve("tests", `.signed-todo-worker-${randomUUID()}`), root = join(directory, "root");
  let opened, host, policy, source, server, socket, endpoint, backend;
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(async () => {
    policy?.dispose(); source?.dispose(); socket?.destroy(); await server?.close();
    await backend?.close(); await host?.close(); await opened?.owner.close();
    if (endpoint) await rm(endpoint, { recursive: true });
    await rm(directory, { recursive: true, force: true });
  });
  let oldToken;
  const mask = process.umask(0o077);
  try {
    store.setStorePath(root); store.todoBoardCreate(boardSlug, "Board", "Team");
    store.todoBoardCreate("Other/Board", "Board", "Other");
    store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest, { action: "create", item: {
      id: "signed-task", title: "Signed worker task", goal: "Use fresh exact authority", scope: "Actual Core",
      acceptance: ["Canonical worker write; revocation blocks cached authority"], state: "Planning", evidence: [],
    } }, { id: "user:local", role: "user" });
    store.noteWorkItemCommand(boardSlug, store.noteWorkItemsRead(boardSlug).digest,
      { action: "assign", id: "signed-task", ownerId: workerId, reason: "Historical assignment only" }, { id: "user:local", role: "user" });
    oldToken = store.todoBoardGrantWorker(boardSlug, store.noteWorkItemsRead(boardSlug).digest, workerId);
  } finally { process.umask(mask); }
  await mkdir(join(root, ".pkm"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".pkm/content-privacy.json"), '{"schema":1,"private":{}}', { mode: 0o600 });
  const sourceBoard = join(root, "notes/Team/Board.assets/pkm-todo-board.json"), originalBoard = await readFile(sourceBoard);
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "signed-worker-fixture",
    profileSha256: hash("separate-signed-worker-profile"), limits: {
      maxEntries: 1000, maxDepth: 32, maxBytes: 4_194_304, maxFileBytes: 2_097_152,
    } });
  opened = await openOriginalMcpRoot(plan);
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
    createPublicKey(keys.privateKey).export({ format: "der", type: "spki" }).toString("base64"), plan.profileSha256);
  endpoint = join(homedir(), ".local/state/pkm-v5-recovery", `w-${randomBytes(4).toString("hex")}`);
  await mkdir(endpoint, { mode: 0o700 });
  server = await startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity, identitySha256: identity.sha256,
    binding: { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256,
      catalogSha256: originalPublicMcpContracts().provenance.metadataSha256, profileSha256: plan.profileSha256,
      payloadBuildId: hash("worker-fixture-payload"), hostEntrySha256: hash("worker-fixture-host") },
    maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 2000 });
  socket = connect(join(endpoint, "n"));
  let input = "", ready;
  const attached = new Promise(resolve => { ready = resolve; }), frames = [], held = [];
  const controls = { allow: true, pending: false, wrongActor: false, workerTtl: 60000 };
  const send = frame => socket.write(JSON.stringify(frame) + "\n");
  const reply = frame => {
    if (frame.method === "admission.approve" || frame.method === "public.approve")
      return send(originalMcpNativeResult(frame, { decision: "approve" }));
    if (frame.method === "todo.source.approve")
      return send(originalMcpNativeResult(frame, { actorId: "mcp:external", decisionId: randomUUID(), expiresAtMs: Date.now() + 180_000 }));
    if (frame.method === "todo.worker.enroll") {
      const payload = frame.payload;
      return send(originalMcpNativeResult(frame, controls.allow ? {
        schema: "pkm.original-mcp-native-todo-worker-decision/v1",
        actorId: controls.wrongActor ? "external:claude:foreign" : payload.request.actorId,
        decisionId: randomUUID(), expiresAtMs: Math.min(Date.now() + controls.workerTtl, payload.sessionExpiresAtMs),
        requestSha256: originalNativeTodoWorkerDigest(payload), epoch: payload.epoch, sessionDecisionId: payload.sessionDecisionId,
      } : null));
    }
    throw new Error(`Unexpected fixture request ${frame.method}; no model or inference is allowed.`);
  };
  // Real socket/signature protocol plus actual RootOwner/Core; the signer and UI responses are fixtures, not installed-native qualification.
  socket.on("error", () => {});
  socket.on("data", chunk => {
    input += chunk.toString("utf8");
    for (let boundary; (boundary = input.indexOf("\n")) >= 0;) {
      const frame = JSON.parse(input.slice(0, boundary)); input = input.slice(boundary + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") ready();
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") {
        frames.push(frame);
        if (frame.method === "todo.worker.enroll" && controls.pending) held.push(frame); else reply(frame);
      }
    }
  });
  await attached;
  const session = await server.waitForSession({ timeoutMs: 2000 });
  send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: originalMcpNativeRequestSession(session),
    methods: [...originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
  await waitForOriginalMcpNativeSupport(session, { timeoutMs: 2000 });
  host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(session));
  source = createOriginalMcpNativeSourcePolicies(opened.storage, host, session);
  policy = createOriginalMcpNativeTodoWorkerPolicy(opened.storage, host, session);
  await hydrateOriginalMcpTodo(opened.storage, host, [boardSlug, "Other/Board"], source.todo);
  await opened.owner.ensureFull();
  backend = createNativePublicOwnerBackend(opened.owner, { actor, originalMcpHost: host });
  const enroll = () => enrollOriginalMcpNativeTodoWorker(opened.storage, host, session, { boardSlug, actorId: workerId });
  const invoke = async (operation, args, token) => (await backend.invoke(operation.endsWith(".get")
    ? "legacy_capability_read" : "legacy_capability_call", { action: operation.endsWith(".get") ? "read" : "call",
    ...(token ? { workerToken: token } : {}), args: { operation, version: 1, arguments: args } })).structuredContent.result;
  return { directory, root, plan, opened, host, session, source, policy, frames, held, controls, reply, oldToken,
    originalBoard, sourceBoard, enroll, invoke };
}

test("signed native enrollment policy is branded/same-owner and refuses missing transport without issuing fresh access", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  assertOriginalMcpNativeTodoWorkerPolicy(f.policy, f.opened.storage, f.host, f.session);
  assert.throws(() => assertOriginalMcpNativeTodoWorkerPolicy({ ...f.policy }, f.opened.storage, f.host, f.session),
    { code: "NATIVE_TODO_WORKER_POLICY_REQUIRED" });
  assert.throws(() => createOriginalMcpNativeTodoWorkerPolicy(f.opened.storage, f.host, { ...f.session }),
    /UNAUTHENTICATED/);
  await assert.rejects(enrollOriginalMcpNativeTodoWorker(f.opened.storage, f.host, f.session,
    { boardSlug, actorId: workerId, token: f.oldToken }));
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, f.oldToken), /never inherited/);
  if (!integrated) {
    await assert.rejects(f.enroll(), { code: "MISSING_NATIVE_METHOD" });
    const db = f.opened.storage.connectNative();
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM original_mcp_domain_workers").get().n, 0); } finally { db.close(); }
    assert.equal(f.frames.filter(frame => frame.method === "todo.worker.enroll").length, 0);
    t.diagnostic("Parent must register todo.worker.enroll payload/result/parser and native attachment producer. No positive enrollment is claimed.");
    return;
  }
  f.controls.allow = false;
  await assert.rejects(f.enroll(), /typed native worker decision/);
  f.controls.allow = true; f.controls.wrongActor = true;
  await assert.rejects(f.enroll(), /DECISION_MISMATCH/);
  f.controls.wrongActor = false;
  const db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM original_mcp_domain_workers").get().n, 0); } finally { db.close(); }
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, f.oldToken), /never inherited/);
});

test("actual signed fresh worker performs canonical Core writes; logical revocation fences cached tokens/principals, not historical rows", {
  timeout: 120000, skip: integrated ? false : "Parent todo.worker.enroll transport merge is required for genuine signed positive tests",
}, async t => {
  const f = await fixture(t), enrolled = await f.enroll();
  assert.notEqual(enrolled.token, f.oldToken);
  const request = f.frames.find(frame => frame.method === "todo.worker.enroll").payload;
  assert.equal(request.request.actorId, workerId); assert.equal(request.request.boardSlug, boardSlug);
  assert.equal(request.custodyPlanSha256, f.plan.planSha256);
  assert.equal(request.profileSha256, f.plan.profileSha256); assert.equal(request.epoch, f.session.activationId);
  assert.equal(request.request.tokenSha256, hash(enrolled.token));
  assert(!JSON.stringify(request).includes(enrolled.token));
  const cached = authenticateBoardWorker(f.root, boardSlug, enrolled.token);
  const authority = readOriginalMcpTodoAuthority(f.root, workerId, boardSlug);
  assert.equal(authority.workerReceiptSha256, enrolled.receiptSha256);
  const board = await f.invoke("todo.board.get", { board_slug: boardSlug }, enrolled.token);
  const commented = await f.invoke("todo.workitem.comment", { board_slug: boardSlug, id: "signed-task",
    text: "Actual signed native worker Core write", expected_digest: board.digest }, enrolled.token);
  assert.equal(commented.item.comments.at(-1).actorId, workerId);
  await assert.rejects(f.invoke("todo.board.get", { board_slug: "Other/Board" }, enrolled.token), /invalid|grant|Board|never inherited/i);
  const { runtime } = await f.opened.owner.ensureFull(), workerChat = randomUUID();
  const createRequest = { operation: "chat.session.create", version: 1,
    arguments: { id: workerChat, title: "Worker-owned ordinary native Chat", expectedRevision: 0, operationId: randomUUID() } },
    deniedCreate = await runtime.core.dispatch("capability_call", createRequest, { ...cached, canWrite: true });
  assert.equal(deniedCreate.error?.code, "ACCESS_DENIED", "a Board token does not grant Chat creation");
  // Independent same-actor native-principal fixture creates an ordinary session, not a permission from the Board token.
  const created = await runtime.core.dispatch("capability_call", createRequest, { id: workerId, canWrite: true });
  assert.equal(created.error, undefined);
  const assigned = await f.invoke("todo.workitem.assign", { board_slug: boardSlug, id: "signed-task",
    owner_id: `chat:${workerChat}`, reason: "Existing same-actor native permission", expected_digest: commented.digest }, enrolled.token);
  assert.equal(assigned.item.ownerId, `chat:${workerChat}`);
  f.policy.revoke();
  assert.equal(Atomics.load(new Int32Array(authority.revocation), 0), 1);
  f.session.assertCurrent();
  await assert.rejects(f.invoke("todo.board.get", { board_slug: boardSlug }, enrolled.token), /native|rebind|authority/i);
  const denied = await runtime.core.dispatch("capability_call", { operation: "todo.workitem.comment", version: 1, arguments: {
    board_slug: boardSlug, id: "signed-task", expected_digest: assigned.digest, operationId: randomUUID(), text: "Must not publish",
  } }, { ...cached, canWrite: true });
  assert(denied.error);
  await hydrateOriginalMcpTodo(f.opened.storage, f.host, [boardSlug, "Other/Board"], f.source.todo);
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, enrolled.token), /never inherited/);
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, f.oldToken), /never inherited/);
  assert.deepEqual(await readFile(f.sourceBoard), f.originalBoard);
});

test("Todo source revocation and cancelled/late signed decisions never publish worker enrollment", {
  timeout: 120000, skip: integrated ? false : "Parent todo.worker.enroll transport merge is required for genuine signed late-decision tests",
}, async t => {
  const f = await fixture(t);
  f.controls.pending = true;
  const pending = f.enroll(), rejected = assert.rejects(pending, /CANCEL|REVOK|source|Todo|native/i);
  for (let count = 0; count < 200 && !f.held.length; count++) await delay(5);
  assert.equal(f.held.length, 1);
  f.source.revoke("todo");
  await rejected;
  f.controls.pending = false; f.reply(f.held.shift());
  await delay(20);
  let db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM original_mcp_domain_workers").get().n, 0); } finally { db.close(); }
  await hydrateOriginalMcpTodo(f.opened.storage, f.host, [boardSlug, "Other/Board"], f.source.todo);
  const fresh = await f.enroll(), cached = authenticateBoardWorker(f.root, boardSlug, fresh.token);
  await f.session.close();
  db = f.opened.storage.connectNative();
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM original_mcp_domain_workers").get().n, 1); } finally { db.close(); }
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, fresh.token), /native|rebind|authority/i);
  const { runtime } = await f.opened.owner.ensureFull();
  const response = await runtime.core.dispatch("capability_read", { operation: "todo.board.get", version: 1,
    arguments: { board_slug: boardSlug } }, { ...cached, canWrite: true });
  assert(response.error);
  await f.opened.owner.close();
  const restarted = await openOriginalMcpRoot(f.plan);
  try {
    const { runtime } = await restarted.owner.ensureFull();
    const denied = await runtime.core.dispatch("capability_read", { operation: "todo.board.get", version: 1,
      arguments: { board_slug: boardSlug } }, { ...cached, canWrite: true });
    assert(denied.error, "restart does not activate durable worker enrollment rows or retained source consent");
  } finally { await restarted.owner.close(); }
});

test("finite native worker expiry fences actual worker Core access without extending source consent", {
  timeout: 120000, skip: integrated ? false : "Parent todo.worker.enroll transport merge is required for genuine signed expiry tests",
}, async t => {
  const f = await fixture(t); f.controls.workerTtl = 1000;
  const fresh = await f.enroll(), cached = authenticateBoardWorker(f.root, boardSlug, fresh.token);
  await f.invoke("todo.board.get", { board_slug: boardSlug }, fresh.token);
  await delay(Math.max(0, fresh.expiresAtMs - Date.now() + 20));
  assert.throws(() => authenticateBoardWorker(f.root, boardSlug, fresh.token));
  const { runtime } = await f.opened.owner.ensureFull();
  const denied = await runtime.core.dispatch("capability_read", { operation: "todo.board.get", version: 1,
    arguments: { board_slug: boardSlug } }, { ...cached, canWrite: true });
  assert(denied.error);
  assert.equal((await f.invoke("todo.board.get", { board_slug: boardSlug })).board_slug, boardSlug);
});
