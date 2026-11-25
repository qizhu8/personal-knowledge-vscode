import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { test } from "node:test";
import { createOriginalMcpColdComponentFixture, bootstrapOriginalMcpColdComponent } from "../dist/original-mcp-cold-component.js";
import { acquireOriginalMcpRootFence, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestProtocol, originalMcpNativeRequestMethods, parseOriginalMcpNativeRequest,
  originalMcpNativeResult, waitForOriginalMcpNativeSupport, createOriginalMcpNativeRequestPolicy } from "../dist/original-mcp-native-request.js";
import { originalMcpTodoGenesisMethod, parseOriginalMcpTodoGenesisPayload,
  originalMcpTodoGenesisRequestDigest as digest } from "../dist/original-mcp-todo-genesis-contracts.js";
import { createOriginalMcpTodoGenesisPort, approvePendingOriginalMcpTodoGenesis,
  recoverOriginalMcpTodoGenesisWithScope, getOriginalMcpTodoGenesisSourceScope } from "../dist/original-mcp-todo-genesis-native.js";
import { getOriginalMcpTodoGenesisPort } from "../dist/original-mcp-todo-genesis-native.js";
import { bindExperimentalTodoGenesisFault, reportExperimentalTodoGenesisFault } from "../dist/original-mcp-todo-genesis-fault.js";
import { readOriginalMcpTodoGenesisCustodyTransitions, readOriginalMcpTodoGenesisSources } from "../dist/original-mcp-todo-genesis.js";
import { readOriginalMcpDomain } from "../dist/original-mcp-domain-state.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import { nativePublicFullOptions } from "../dist/native-public-mcp-owner.js";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function picture(storage, root) {
  const db = storage.connectNative();
  try {
    const rows = db.prepare("SELECT creation_plan FROM original_todo_genesis_pending").all();
    const plan = rows.length ? JSON.parse(rows[0].creation_plan) : undefined;
    const paths = plan ? [plan.request.selection.notePath, plan.request.selection.backingPath, plan.request.selection.canonicalBoardPath]
      : ["notes/Recovery.md", "notes/Recovery.assets/pkm-todo-board.json", ".pkm-next-todo/Recovery/pkm-todo-board.json"];
    return { files: await Promise.all(paths.map(async path => {
      try { return { path, sha256: hash(await readFile(join(root, path))) }; }
      catch (error) { if (error.code !== "ENOENT") throw error; return { path, absent: true }; }
    })), pending: db.prepare("SELECT * FROM original_todo_genesis_pending").all(),
    compound: db.prepare("SELECT * FROM pending_todo").all(),
    sources: db.prepare("SELECT * FROM original_todo_genesis_sources ORDER BY board_slug").all(),
    receipts: db.prepare("SELECT * FROM receipts ORDER BY rowid").all(),
    documents: db.prepare("SELECT * FROM documents ORDER BY id").all() };
  } finally { db.close(); }
}
async function attach(target, identity, keys, controls, frames) {
  const descriptor = JSON.parse(await readFile(target.attachmentDescriptorPath));
  const socket = connect(descriptor.socketPath);
  let text = "", session;
  socket.on("error", () => {});
  socket.on("data", bytes => {
    text += bytes.toString("utf8");
    for (let end; (end = text.indexOf("\n")) >= 0;) {
      const frame = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
      const send = value => socket.write(JSON.stringify(value) + "\n");
      if (frame.type === "challenge") {
        const proof = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...proof.body, signature: sign(null, proof.message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") {
        session = { brokerId: frame.brokerId, activationId: frame.activationId, identitySha256: frame.identitySha256,
          epoch: frame.activationId, binding: descriptor.binding };
        send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session,
          methods: ["admission.approve", "public.approve", "tool.approve", "tool.review", originalMcpTodoGenesisMethod], maxPacketBytes: 65536 });
      } else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") {
        const request = parseOriginalMcpNativeRequest(frame, session); frames.push(request);
        if (request.method === originalMcpTodoGenesisMethod) {
          const payload = parseOriginalMcpTodoGenesisPayload(request.payload, session);
          send(originalMcpNativeResult(request, controls.deny ? null : {
            decision: "approve", actorId: "mcp:external", decisionId: randomUUID(),
            operationId: payload.request.operationId, epoch: payload.request.nativeEpoch,
            requestSha256: payload.requestSha256, expiresAtMs: Date.now() + controls.ttlMs,
          }));
        } else send(originalMcpNativeResult(request, { decision: "approve" }));
      }
    }
  });
  return socket;
}
async function fixture(t, callbackThrows = false) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use the genuine private test framework.");
  assert(process.env.PKM_TEST_PYTHON);
  process.umask(0o077);
  const directory = join(homedir(), ".local/state/pkm-v5-recovery", `tg-${randomBytes(4).toString("hex")}`);
  const branded = await createOriginalMcpColdComponentFixture(directory), pin = await lstat(directory);
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory, python: process.env.PKM_TEST_PYTHON, legacyVsix: process.env.PKM_LEGACY_VSIX });
  writer.run(branded.root, `
    store.noteUpsert({slug:"Entry",title:"Entry",content:"RECOVERY_CONTROL",tags:[],type:"general"});
    store.noteUpsert({slug:"Private/Control",title:"Control",category:"Private",
      content:"PRIVATE_TODO_RECOVERY_CONTROL",tags:[],type:"general"});
    return store.noteGet("Entry");
  `);
  for (const path of ["skills", "papers", ".pkm/state/actions", "chatrooms", "mcp-server"])
    await mkdir(join(branded.root, path), { recursive: true, mode: 0o700 });
  await writeFile(join(branded.root, "skills/Base.md"), "---\ntitle: Base\n---\nRecovery control.", { mode: 0o600 });
  await writeFile(join(branded.root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":["Private"]}}', { mode: 0o600 });
  t.diagnostic(JSON.stringify({ checkpoint: "controlled-original-pre-B0-layout",
    pkmNames: (await readdir(join(branded.root, ".pkm"))).sort(),
    stateNames: (await readdir(join(branded.root, ".pkm/state"))).sort() }));
  const keys = generateKeyPairSync("ed25519"), profileSha256 = hash("todo-pending-source-recovery");
  const identity = originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  const controls = { deny: false, ttlMs: 60000 }, frames = [], checkpoints = [], resources = [];
  const attachment = async () => {
    const endpoint = join(directory, `i-${resources.length}`); await mkdir(endpoint, { mode: 0o700 });
    return { directory: endpoint, identity, identitySha256: identity.sha256,
      payloadBuildId: hash("recovery-source-payload"), hostEntrySha256: hash("recovery-source-host") };
  };
  t.after(async () => {
    for (const close of resources.reverse()) await close();
    const current = await lstat(directory);
    assert.equal(current.dev, pin.dev); assert.equal(current.ino, pin.ino); assert.equal(current.uid, pin.uid);
    await rm(directory, { recursive: true });
  });
  const limits = { maxEntries: 30000, maxDepth: 32, maxBytes: 1073741824, maxFileBytes: 536870912 };
  const component = await bootstrapOriginalMcpColdComponent(branded, { operatorId: "todo-recovery-source", profileSha256,
    limits, attachment: await attachment(), experimentalTodoGenesisFaultInjector(checkpoint) {
      checkpoints.push(checkpoint);
      if (callbackThrows) throw new Error("EXACT_SOURCE_CALLBACK_FAILURE");
    } });
  resources.push(() => component.close());
  const completing = component.complete(), socket = await attach(component, identity, keys, controls, frames);
  resources.push(async () => socket.destroy());
  const host = await completing;
  async function reopen(onScope = async () => {}) {
    await component.close();
    const fence = await acquireOriginalMcpRootFence(branded.root);
    let server, newHost, port, scope;
    let opened;
    try { opened = await openOriginalMcpRoot(component.custody, { writerFence: fence, prepareNative: async storage => {
      const session = await server.waitForSession({ timeoutMs: 3000 });
      await waitForOriginalMcpNativeSupport(session, { timeoutMs: 3000 });
      newHost = await createOriginalMcpNativeHost(storage, createOriginalMcpNativeRequestPolicy(session));
      port = createOriginalMcpTodoGenesisPort(storage, newHost, session);
      scope = await approvePendingOriginalMcpTodoGenesis(port);
      await onScope({ storage, host: newHost, port, scope });
      return { ...await nativePublicFullOptions(storage, { actor: { id: "mcp:external", canWrite: true }, originalMcpHost: newHost }),
        ...(scope ? { originalTodoGenesisRecovery: scope } : {}) };
    } }); } catch (error) { await fence.release(); throw error; }
    const a = await attachment();
    server = await startOriginalMcpNativeAttachmentServer({ directory: a.directory, identity, identitySha256: identity.sha256,
      binding: { root: opened.root, workspaceId: opened.workspaceId, planSha256: component.custody.planSha256,
        profileSha256, catalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
        payloadBuildId: a.payloadBuildId, hostEntrySha256: a.hostEntrySha256 }, maxPacketBytes: 65536 });
    const target = { attachmentDescriptorPath: server.descriptorPath };
    const newSocket = await attach(target, identity, keys, controls, frames);
    const close = async () => { await server.close(); await newHost?.close(); await opened.owner.close(); newSocket.destroy(); };
    resources.push(close);
    return { ...opened, complete: () => opened.owner.ensureFull(), close, current: () => ({ host: newHost, port, scope }) };
  }
  return { branded, component, host, controls, frames, checkpoints, reopen };
}
test("genuine worker pending genesis survives fresh same-custody deny/expiry and completes once only with an opaque current method26 recover scope", { timeout: 150000 }, async t => {
  const f = await fixture(t), c = f.component, before = await picture(c.storage, c.root);
  const oldPort = getOriginalMcpTodoGenesisPort(c.storage, f.host);
  let failure;
  try { await c.invoke("todo_board_create", { title: "Recovery" }); } catch (error) { failure = error; }
  assert.equal(failure?.code, "TODO_GENESIS_EXPERIMENTAL_FAULT"); assert.equal(failure.effect, "unknown");
  assert.equal(failure.cause.code, "TODO_GENESIS_EXPERIMENTAL_FAULT");
  assert.equal(f.checkpoints.length, 1);
  const pending = await picture(c.storage, c.root), plan = JSON.parse(pending.pending[0].creation_plan);
  assert.equal(pending.pending.length, 1); assert.equal(pending.compound.length, 1);
  assert.equal(pending.compound[0].operation, "todo.board.create+signed-genesis");
  assert.equal(pending.compound[0].operation_id, plan.request.operationId);
  assert.deepEqual(pending.files.map(row => row.sha256 ?? "absent"),
    [plan.request.selection.descriptorSha256, plan.request.selection.backingSha256, "absent"]);
  assert.deepEqual(pending.documents, before.documents); assert.deepEqual(pending.receipts, before.receipts);
  assert.deepEqual(pending.sources, []); assert.equal(getOriginalMcpTodoGenesisSourceScope(c.storage, f.host, "Recovery"), undefined);
  assert.equal(f.checkpoints[0].operationId, plan.request.operationId); assert.equal(f.checkpoints[0].planSha256, plan.planSha256);
  const db = c.storage.connectNative();
  try { assert.equal(readOriginalMcpTodoGenesisCustodyTransitions(c.root, db)[0].status, "pending"); } finally { db.close(); }
  await assert.rejects(bindExperimentalTodoGenesisFault(structuredClone(f.branded), c.storage, f.host, {}, () => {}));
  assert.throws(() => reportExperimentalTodoGenesisFault(c.storage, structuredClone({ checkpoint: f.checkpoints[0], oneUse: new SharedArrayBuffer(4) }), failure),
    { code: "TODO_GENESIS_EXPERIMENTAL_CONTROL_REQUIRED" });
  await c.close();
  await assert.rejects(approvePendingOriginalMcpTodoGenesis(oldPort), { code: "STORAGE_UNAVAILABLE" });
  await assert.rejects(c.storage.request({ operation: "todo.board.create", actorId: "mcp:external",
    args: { board_slug: "Recovery", operationId: plan.request.operationId } }), { code: "STORAGE_UNAVAILABLE" });
  f.controls.deny = true;
  const denied = await f.reopen();
  await assert.rejects(denied.complete(), { code: "TODO_GENESIS_DENIED" });
  assert.deepEqual(await picture(denied.storage, denied.root), pending);
  await denied.close(); f.controls.deny = false;
  let expiredScope;
  f.controls.ttlMs = 100;
  const expired = await f.reopen(async ({ storage, scope }) => {
    expiredScope = scope;
    await new Promise(resolve => setTimeout(resolve, 150));
    const before = await picture(storage, c.root);
    await assert.rejects(recoverOriginalMcpTodoGenesisWithScope(storage, scope), { code: "NATIVE_AUTHORITY_REQUIRED" });
    assert.deepEqual(await picture(storage, c.root), before);
    throw Object.assign(new Error("Expected expiry probe completed"), { code: "SOURCE_EXPIRY_PROBED" });
  });
  await assert.rejects(expired.complete(), { code: "SOURCE_EXPIRY_PROBED" });
  assert.deepEqual(await picture(expired.storage, expired.root), pending);
  await expired.close(); f.controls.ttlMs = 60000;
  const recovered = await f.reopen(async ({ storage, scope }) => {
    const before = await picture(storage, c.root);
    for (const copied of [structuredClone(scope), { kind: scope.kind }, expiredScope])
      await assert.rejects(recoverOriginalMcpTodoGenesisWithScope(storage, copied), { code: "NATIVE_AUTHORITY_REQUIRED" });
    assert.deepEqual(await picture(storage, c.root), before);
  });
  await recovered.complete();
  const state = recovered.current(), after = await picture(recovered.storage, recovered.root);
  assert.equal(after.pending.length, 0); assert.equal(after.compound.length, 0);
  assert.equal(after.sources.length, 1); assert.equal(after.sources[0].operation_id, plan.request.operationId);
  assert.equal(after.receipts.filter(row => row.operation === "todo.board.create").length, 1);
  assert.equal(after.receipts[0].operation_id, plan.request.operationId);
  assert.equal(JSON.parse(after.sources[0].payload).creation.request.selection.sourceId, plan.request.selection.sourceId);
  assert.equal(JSON.parse(after.sources[0].payload).finalReview.request.phase, "recover");
  assert.notEqual(state.host.receipt.epoch, f.host.receipt.epoch);
  assert.equal(f.checkpoints.length, 1, "The creation interruption never faults recovery.");
  await assert.rejects(recoverOriginalMcpTodoGenesisWithScope(recovered.storage, state.scope), { code: "NATIVE_AUTHORITY_REQUIRED" });
  assert.deepEqual(await picture(recovered.storage, recovered.root), after);
  const active = getOriginalMcpTodoGenesisSourceScope(recovered.storage, state.host, "Recovery"); assert(active);
  const freshDb = recovered.storage.connectNative();
  try { assert.equal(readOriginalMcpTodoGenesisSources(recovered.root, freshDb).length, 1); } finally { freshDb.close(); }
  assert.equal(readOriginalMcpDomain(c.root, "todo"), undefined);
  const reviews = f.frames.filter(frame => frame.method === originalMcpTodoGenesisMethod);
  assert.deepEqual(reviews.map(frame => frame.payload.request.phase), ["create", "recover", "recover", "recover"]);
  assert.equal(new Set(reviews.map(frame => frame.payload.request.nativeEpoch)).size, 4);
  assert(reviews.every(frame => frame.payload.request.operationId === plan.request.operationId));
  t.diagnostic("SOURCE signed Socket/worker only; no installed/editor, B1 or full migration claim.");
});
test("worker-confirmed callback errors remain unknown and pending content mismatch refuses fresh recovery without publication or new review", { timeout: 150000 }, async t => {
  const f = await fixture(t, true), c = f.component;
  await assert.rejects(c.invoke("todo_board_create", { title: "Recovery" }), error =>
    error.code === "TODO_GENESIS_EXPERIMENTAL_CALLBACK_FAILED" && error.effect === "unknown"
      && error.cause.message === "EXACT_SOURCE_CALLBACK_FAILURE");
  assert.equal(f.checkpoints.length, 1);
  const pending = await picture(c.storage, c.root), plan = JSON.parse(pending.pending[0].creation_plan);
  await c.close();
  await writeFile(join(c.root, plan.request.selection.backingPath), "ALTERED_OWNED_PENDING_CONTENT", { mode: 0o600 });
  const frameCount = f.frames.filter(frame => frame.method === originalMcpTodoGenesisMethod).length;
  let opened;
  try { opened = await f.reopen(); await opened.complete(); assert.fail("Altered pending content must not admit recovery."); }
  catch (error) { assert.match(error.code ?? error.message, /RECOVERY_CONFLICT|CHANGED|CONFLICT|INVALID_WORKSPACE|INVALID_DOCUMENT/); }
  finally { await opened?.close(); }
  assert.equal(f.frames.filter(frame => frame.method === originalMcpTodoGenesisMethod).length, frameCount);
  assert.equal(hash(await readFile(join(c.root, plan.request.selection.backingPath))), hash("ALTERED_OWNED_PENDING_CONTENT"));
  assert.equal(readOriginalMcpDomain(c.root, "todo"), undefined);
});
