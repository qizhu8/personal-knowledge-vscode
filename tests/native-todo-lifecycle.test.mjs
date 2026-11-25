import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { createOriginalMcpColdComponentFixture, bootstrapOriginalMcpColdComponent } from "../dist/original-mcp-cold-component.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import { originalMcpNativeRequestProtocol, originalMcpNativeRequestMethods,
  parseOriginalMcpNativeRequest, originalMcpNativeResult } from "../dist/original-mcp-native-request.js";
import { originalMcpTodoGenesisMethod, parseOriginalMcpTodoGenesisPayload } from "../dist/original-mcp-todo-genesis-contracts.js";
import { getOriginalMcpTodoGenesisSourceScope, originalMcpTodoGenesisSourceControlForStorage } from "../dist/original-mcp-todo-genesis-native.js";
import { readOriginalMcpDomain } from "../dist/original-mcp-domain-state.js";
import { pinnedOriginalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function value(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}
async function until(check) {
  const stop = Date.now() + 5000;
  while (Date.now() < stop) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Owned Todo lifecycle Socket evidence timed out.");
}
async function fixture(t) {
  assert(process.env.PKM_TEST_WORKSPACE, "Use the genuine private framework, not a bypass.");
  assert(process.env.PKM_TEST_PYTHON);
  assert(originalMcpNativeRequestMethods.includes(originalMcpTodoGenesisMethod), "Parent must normal-emit method26 first.");
  process.umask(0o077);
  const directory = join(homedir(), ".local/state/pkm-v5-recovery", `tl-${randomBytes(4).toString("hex")}`);
  const branded = await createOriginalMcpColdComponentFixture(directory);
  const identity = await lstat(directory, { bigint: true });
  let component, socket;
  t.after(async () => {
    await component?.close(); socket?.destroy();
    const current = await lstat(directory, { bigint: true });
    assert.equal(current.ino, identity.ino); assert.equal(current.dev, identity.dev); assert.equal(current.uid, identity.uid);
    await rm(directory, { recursive: true });
  });
  const writer = pinnedOriginalKnowledgeWriterFixture({ directory, python: process.env.PKM_TEST_PYTHON,
    legacyVsix: process.env.PKM_LEGACY_VSIX });
  writer.run(branded.root, `
    store.noteUpsert({slug:"Entry",title:"Entry",content:"PUBLIC_TODO_LIFECYCLE",tags:[],type:"general"});
    store.noteUpsert({slug:"Private/Control",title:"Control",category:"Private",
      content:"PRIVATE_TODO_LIFECYCLE_CONTROL",tags:[],type:"general"});
    return store.noteGet("Entry");
  `);
  for (const path of ["skills", "papers", ".pkm/state/actions", "chatrooms", "mcp-server"])
    await mkdir(join(branded.root, path), { recursive: true, mode: 0o700 });
  await writeFile(join(branded.root, "skills/Base.md"), "---\ntitle: Base\n---\nPublic lifecycle Skill.", { mode: 0o600 });
  await writeFile(join(branded.root, ".pkm/content-privacy.json"), '{"schema":1,"private":{"notes":["Private"]}}', { mode: 0o600 });
  const endpoint = join(directory, "ipc"); await mkdir(endpoint, { mode: 0o700 });
  const keys = generateKeyPairSync("ed25519"), profileSha256 = hash("cold-todo-lifecycle-source-only");
  const publicIdentity = originalMcpNativeIdentity(keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  component = await bootstrapOriginalMcpColdComponent(branded, { operatorId: "todo-lifecycle-source-only", profileSha256,
    limits: { maxEntries: 30000, maxDepth: 32, maxBytes: 1073741824, maxFileBytes: 536870912 },
    attachment: { directory: endpoint, identity: publicIdentity, identitySha256: publicIdentity.sha256,
      payloadBuildId: hash("lifecycle-source-payload"), hostEntrySha256: hash("lifecycle-source-host") } });
  assert.equal(typeof component.activateTodoGenesisSource, "function", "Run after Parent's coherent normal emission.");
  const completing = component.complete();
  const descriptor = JSON.parse(await readFile(component.attachmentDescriptorPath));
  socket = connect(descriptor.socketPath);
  const frames = [], held = [], cancels = [], controls = { denyPhase: undefined, holdPhase: undefined, ttlMs: 60000 };
  let input = "", session, attachedResolve;
  const attached = new Promise(resolve => { attachedResolve = resolve; });
  const send = frame => socket.write(JSON.stringify(frame) + "\n");
  const affirm = request => {
    const payload = parseOriginalMcpTodoGenesisPayload(request.payload, session);
    send(originalMcpNativeResult(request, { decision: "approve", actorId: "mcp:external", decisionId: randomUUID(),
      operationId: payload.request.operationId, epoch: payload.request.nativeEpoch,
      requestSha256: payload.requestSha256, expiresAtMs: Date.now() + controls.ttlMs }));
  };
  socket.on("error", () => {});
  socket.on("data", bytes => {
    input += bytes.toString("utf8");
    for (let end; (end = input.indexOf("\n")) >= 0;) {
      const frame = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, publicIdentity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") {
        session = { brokerId: frame.brokerId, activationId: frame.activationId, identitySha256: frame.identitySha256,
          epoch: frame.activationId, binding: descriptor.binding };
        send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session,
          methods: ["admission.approve", "public.approve", "tool.approve", "tool.review", "credential.present",
            originalMcpTodoGenesisMethod], maxPacketBytes: 65536 }); attachedResolve();
      } else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-cancel") cancels.push(frame);
      else if (frame.type === "native-request") {
        const request = parseOriginalMcpNativeRequest(frame, session); frames.push(request);
        if (request.method === originalMcpTodoGenesisMethod) {
          const payload = parseOriginalMcpTodoGenesisPayload(request.payload, session);
          if (controls.holdPhase === payload.request.phase) held.push(request);
          else if (controls.denyPhase === payload.request.phase) send(originalMcpNativeResult(request, null));
          else affirm(request);
        } else send(originalMcpNativeResult(request, request.method === "credential.present" ? { present: false } : { decision: "approve" }));
      }
    }
  });
  await attached;
  const host = await completing, full = await component.owner.ensureFull(), lease = { ...component.owner.workspaceLease() };
  assert.equal(full.storage, component.storage); assert.equal(full.runtime.services.modelProvider, undefined);
  assert.equal(host.nativeChat, undefined);
  const call = (tool, args, signal) => component.invoke(tool, args, signal);
  const ok = async (tool, args) => value(await call(tool, args));
  async function image() {
    const files = [];
    async function walk(path) {
      let stat;
      try { stat = await lstat(join(component.root, path)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!stat) { files.push({ path, absent: true }); return; }
      assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) {
        files.push({ path, directory: true });
        for (const child of (await readdir(join(component.root, path))).sort()) await walk(`${path}/${child}`);
      } else files.push({ path, sha256: hash(await readFile(join(component.root, path))) });
    }
    for (const path of ["notes", "skills", "papers", ".pkm-next-todo", ".pkm/content-privacy.json"]) await walk(path);
    const db = component.storage.connectNative();
    try {
      return { files, sources: db.prepare("SELECT * FROM original_todo_genesis_sources ORDER BY board_slug").all(),
        receipts: db.prepare("SELECT * FROM receipts ORDER BY rowid").all(),
        pending: db.prepare("SELECT * FROM original_todo_genesis_pending").all(),
        intents: db.prepare("SELECT * FROM migration_runtime_intents ORDER BY operation_id").all() };
    } finally { db.close(); }
  }
  const refused = async (tool, args) => {
    const before = await image(); let failure;
    try { failure = (await call(tool, args)).isError === true; } catch { failure = true; }
    assert(failure); assert.deepEqual(await image(), before);
  };
  return { component, host, full, lease, frames, held, cancels, controls, affirm, call, ok, image, refused };
}

test("genuine cold facade revokes and renews only its exact genesis source, refusing durable/copy/expired authority while preserving IDs and canonical history", { timeout: 150000 }, async t => {
  const f = await fixture(t), c = f.component;
  const created = await f.ok("todo_board_create", { title: "Lifecycle" }), board = { board_slug: created.slug };
  const old = getOriginalMcpTodoGenesisSourceScope(c.storage, f.host, created.slug);
  const oldControl = originalMcpTodoGenesisSourceControlForStorage(c.storage, old);
  assert.equal(Atomics.load(new Int32Array(oldControl.revocation), 0), 0, "Create settlement leaves the independent source SAB live.");
  const empty = await f.ok("get_board", { ...board, worker_token: null }), task = { ...board, id: "lifecycle-task" };
  const added = await f.ok("add_workitem", { ...board, expected_digest: empty.digest, item: {
    id: task.id, title: "Exact source task", goal: "Retain current canonical identity", scope: "Branded disposable Source test",
    acceptance: ["Revocation and cancellation are effective"], plannedStart: "2026-11-22", plannedEnd: "2026-11-23",
  } });
  const edit = { ...task, expected_digest: added.digest, patch: { title: "Before revocation" }, reason: "Source lifecycle" };
  const edited = await f.ok("update_workitem", edit), stable = await f.image();
  assert.throws(() => c.revokeTodoGenesisSource("WrongRoot/Lifecycle"), { code: "NATIVE_AUTHORITY_REQUIRED" });
  assert.throws(() => c.revokeTodoGenesisSource({ boardSlug: created.slug, approved: true }), { code: "NATIVE_AUTHORITY_REQUIRED" });
  await assert.rejects(c.activateTodoGenesisSource(created.slug, { approved: true }), { code: "COMPONENT_NATIVE_TODO_SOURCE_INPUT_INVALID" });
  c.revokeTodoGenesisSource(created.slug);
  assert.equal(Atomics.load(new Int32Array(oldControl.revocation), 0), 1); assert.deepEqual(await f.image(), stable);
  await f.refused("get_workitem", task);
  await f.refused("update_workitem", { ...edit, expected_digest: edited.digest });
  f.controls.denyPhase = "activate-source";
  await assert.rejects(c.activateTodoGenesisSource(created.slug), { code: "TODO_GENESIS_DENIED" });
  assert.deepEqual(await f.image(), stable); await f.refused("get_board", board);
  f.controls.denyPhase = undefined;
  const renewed = await c.activateTodoGenesisSource(created.slug);
  assert.notEqual(renewed, old); assert.deepEqual(await f.image(), stable);
  await assert.rejects(c.storage.adoptOriginalMcpTodoGenesisSource(old), { code: "NATIVE_AUTHORITY_REQUIRED" });
  await assert.rejects(c.storage.adoptOriginalMcpTodoGenesisSource(structuredClone(renewed)), { code: "NATIVE_AUTHORITY_REQUIRED" });
  assert.deepEqual(await f.ok("get_workitem", task), edited);
  assert.deepEqual((await f.ok("list_workitem_history", { ...task, expected_digest: edited.digest })).items.map(row => row.action), ["create", "edit"]);
  const renewedControl = originalMcpTodoGenesisSourceControlForStorage(c.storage, renewed);
  assert.equal(renewedControl.provenance.request.phase, "activate-source");
  assert.equal(renewedControl.provenance.request.operationId, oldControl.provenance.request.operationId);
  assert.equal(renewedControl.provenance.request.selection.sourceId, oldControl.provenance.request.selection.sourceId);
  assert.notEqual(renewedControl.provenance.decision.decisionId, oldControl.provenance.decision.decisionId);
  await f.refused("get_board", { board_slug: "OtherBoard" });
  await assert.rejects(c.activateTodoGenesisSource("OtherBoard"), { code: "NOT_AVAILABLE" });
  const beforeTokens = f.frames.length;
  await f.refused("get_board", { ...board, worker_token: "" });
  assert.equal(f.frames.length, beforeTokens, "Supplied empty credentials refuse before PUBLIC transport.");
  assert.equal(readOriginalMcpDomain(c.root, "todo"), undefined);
  f.controls.ttlMs = 200;
  const short = await c.activateTodoGenesisSource(created.slug);
  await new Promise(resolve => setTimeout(resolve, 250));
  await assert.rejects(c.storage.adoptOriginalMcpTodoGenesisSource(short), { code: "NATIVE_AUTHORITY_REQUIRED" });
  await f.refused("get_board", board);
  f.controls.ttlMs = 60000;
  await c.activateTodoGenesisSource(created.slug);
  const final = await f.ok("update_workitem", { ...edit, expected_digest: edited.digest, patch: { title: "After fresh phase-specific review" } });
  assert.equal(final.item.id, task.id); assert.notEqual(final.digest, edited.digest);
  assert.deepEqual(c.owner.workspaceLease(), f.lease); assert.equal((await c.owner.ensureFull()).runtime.core, f.full.runtime.core);
  t.diagnostic("Genuine cold factory + signed Socket SOURCE only; no actual installed/browser qualification or runtime grant lengthening.");
});

test("actual signed cold transport settles create and activation cancellation before a late positive reply, and closed facade cannot grant authority", { timeout: 150000 }, async t => {
  const f = await fixture(t), c = f.component, args = { title: "LateChoice" };
  async function cancel(phase, invoke) {
    const before = await f.image(), controller = new AbortController(), count = f.held.length;
    f.controls.holdPhase = phase;
    const pending = invoke(controller.signal).then(value => ({ value }), error => ({ error }));
    await until(() => f.held.length > count);
    const request = f.held[count]; controller.abort();
    const settled = await pending; assert.equal(settled.error?.code, "NATIVE_REQUEST_CANCELLED");
    await until(() => f.cancels.some(frame => frame.requestId === request.requestId));
    assert.deepEqual(await f.image(), before);
    f.affirm(request);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(await f.image(), before); f.controls.holdPhase = undefined;
    return request;
  }
  const cancelledCreate = await cancel("create", signal => f.call("todo_board_create", args, signal));
  assert.equal(getOriginalMcpTodoGenesisSourceScope(c.storage, f.host, args.title), undefined);
  const created = await f.ok("todo_board_create", args), board = { board_slug: created.slug };
  assert.notEqual((await f.image()).sources[0].operation_id, cancelledCreate.payload.request.operationId);
  const old = getOriginalMcpTodoGenesisSourceScope(c.storage, f.host, created.slug);
  c.revokeTodoGenesisSource(created.slug);
  await cancel("activate-source", signal => c.activateTodoGenesisSource(created.slug, { signal }));
  await f.refused("get_board", board);
  await assert.rejects(c.storage.adoptOriginalMcpTodoGenesisSource(old), { code: "NATIVE_AUTHORITY_REQUIRED" });
  await c.activateTodoGenesisSource(created.slug);
  assert.equal((await f.ok("get_board", board)).digest, created.digest);
  c.revokeTodoGenesisSource(created.slug);
  f.controls.holdPhase = "activate-source";
  const count = f.held.length, held = c.activateTodoGenesisSource(created.slug).then(value => ({ value }), error => ({ error }));
  await until(() => f.held.length > count);
  await c.close();
  assert.equal((await held).error?.code, "NATIVE_REQUEST_CANCELLED");
  assert.throws(() => c.revokeTodoGenesisSource(created.slug), { code: "COMPONENT_NATIVE_TODO_SOURCE_UNAVAILABLE" });
  await assert.rejects(c.activateTodoGenesisSource(created.slug), { code: "COMPONENT_NATIVE_TODO_SOURCE_UNAVAILABLE" });
  assert.throws(() => c.owner.workspaceLease());
  t.diagnostic("Real Source native-cancel frame and settled code precede late signed reply; this is not rendered installed evidence.");
});

test("cold facade source activation refuses a canonical snapshot changed by a genuine approved planning edit while method26 is held", { timeout: 150000 }, async t => {
  const f = await fixture(t), c = f.component;
  const created = await f.ok("todo_board_create", { title: "ReviewedSnapshot" }), board = { board_slug: created.slug };
  const added = await f.ok("add_workitem", { ...board, expected_digest: created.digest, item: {
    id: "snapshot-task", title: "Original reviewed task", goal: "Pin the real canonical snapshot", scope: "Owned Source test",
    acceptance: ["Changed current snapshot refuses activation"], plannedStart: "2026-11-22", plannedEnd: "2026-11-23",
  } });
  const old = getOriginalMcpTodoGenesisSourceScope(c.storage, f.host, created.slug);
  f.controls.holdPhase = "activate-source";
  const pending = c.activateTodoGenesisSource(created.slug).then(value => ({ value }), error => ({ error }));
  await until(() => f.held.length === 1);
  const task = { ...board, id: added.item.id };
  const edited = await f.ok("update_workitem", { ...task, expected_digest: added.digest,
    patch: { title: "Changed during actual native review" }, reason: "Genuine independent planning write" });
  const afterEdit = await f.image();
  f.affirm(f.held[0]);
  assert.equal((await pending).error?.code, "CONFLICT");
  assert.deepEqual(await f.image(), afterEdit, "Stale review creates no receipt, files or replacement authority.");
  assert.equal(getOriginalMcpTodoGenesisSourceScope(c.storage, f.host, created.slug), old);
  assert.deepEqual(await f.ok("get_workitem", task), edited);
  f.controls.holdPhase = undefined;
  const fresh = await c.activateTodoGenesisSource(created.slug);
  assert.notEqual(fresh, old); assert.deepEqual(await f.ok("get_workitem", task), edited);
  t.diagnostic("Current-file source snapshot rechecked through actual Source PUBLIC write + held method26, not injected bytes.");
});
