import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { captureOriginalMcpCustody, openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { legacyKnowledgeWrite } from "../dist/legacy-knowledge-write.js";
import { startOriginalMcpNativeAttachmentServer } from "../dist/original-mcp-native-attachment.js";
import { originalMcpNativeIdentity, originalMcpNativeAttestationMessage } from "../dist/original-mcp-native-identity.js";
import {
  originalMcpNativeRequestMethods, originalMcpNativeRequestProtocol, originalMcpNativeRequestSession,
  originalMcpNativeResult, createOriginalMcpNativeRequestPolicy, waitForOriginalMcpNativeSupport,
} from "../dist/original-mcp-native-request.js";
import { createOriginalMcpNativeHost, withOriginalMcpPublicRequest, originalMcpRequestDigest } from "../dist/original-mcp-native-host.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";
import {
  createNativePrivateResourcePublicationPort, withNativePrivateResourcePublicationContext,
  approvePendingPrivateResourcePublications, withPrivateResourcePublicationRecovery,
} from "../dist/private-resource-publication-native.js";
import { parsePrivateResourcePublicationPayload, privateResourcePublicationMethod } from "../dist/private-resource-publication-contracts.js";
import { privateResourcePublicationDigest } from "../dist/private-resource-publication-contracts.js";
import { privatePublicationRequirements, assertPrivatePublicationSourcePins } from "../dist/private-resource-publication-planning.js";
import { scanMarkdown } from "../dist/markdown.js";
import { knowledgeMutationScanRevision } from "../dist/knowledge-mutations.js";
import { originalKnowledgeWriterFixture } from "./original-knowledge-writer-fixture.mjs";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";

assert(process.env.PKM_TEST_WORKSPACE, "Use the real private Linux framework.");
const hash = value => createHash("sha256").update(value).digest("hex"), actor = { id: "mcp:external", canWrite: true };
const privateA = Buffer.from("SYNTHETIC_PRIVATE_RESOURCE_A"), privateB = Buffer.from("SYNTHETIC_PRIVATE_RESOURCE_B");
const request = { tool: "update_note", arguments: { slug: "Old/Before", title: "After", category: "New" } };
const present = originalMcpNativeRequestMethods.some(method => String(method) === privateResourcePublicationMethod);
const seed = `
  const body="Public owner\\n![A](../Private/_assets/A.bin?q=1#view)\\n![B](../Private/_assets/B.bin)\\n";
  store.noteUpsert({slug:"Old/Before",title:"Before",category:"Old",type:"general",content:body});
  for(const [name,value] of [["A.bin","SYNTHETIC_PRIVATE_RESOURCE_A"],["B.bin","SYNTHETIC_PRIVATE_RESOURCE_B"]]){
    const bytes=Buffer.from(value),source="Private/_assets/"+name;
    assets.importMarkdownAssetBundle(root,[{type:"notes",path:source,data:bytes.toString("base64"),
      digest:"sha256:"+require("node:crypto").createHash("sha256").update(bytes).digest("hex")}],
      [{area:"notes",path:"Old/Before.md",content:body}]);
  }
  store.noteUpsert({slug:"Private/Referrer",title:"Referrer",category:"Private",type:"general",
    content:"SYNTHETIC_PRIVATE_REFERRER\\n![A](_assets/A.bin)\\n"});
  privacy.setTopLevelPrivacy("notes","Private",true);
  return store.noteGet("Old/Before");
`;
function journal(root) {
  const db = new DatabaseSync(join(root, "core.sqlite"), { readOnly: true });
  try { return { intents: db.prepare("SELECT * FROM migration_runtime_intents").all(),
    receipts: db.prepare("SELECT * FROM receipts WHERE operation='knowledge.note.update'").all() }; } finally { db.close(); }
}
async function fixture(t) {
  const directory = resolve("tests", `.private-publication-${randomUUID()}`), root = join(directory, "root");
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const area of ["notes", "skills", "papers"]) await mkdir(join(root, area), { mode: 0o700 });
  let opened, host, server, socket, endpoint;
  t.after(async () => {
    try { socket?.destroy(); await server?.close(); await host?.close(); await opened?.owner.close(); }
    finally { if (endpoint) await rm(endpoint, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); }
  });
  const original = originalKnowledgeWriterFixture(directory), row = original.run(root, seed);
  const oracle = join(directory, "oracle"); await cp(root, oracle, { recursive: true });
  const profileSha256 = hash("private-resource-fixture-profile");
  const plan = await captureOriginalMcpCustody({ root, backup: join(directory, "custody"), operatorId: "private-publication-fixture",
    profileSha256, limits: { maxEntries: 1000, maxDepth: 32, maxBytes: 16_777_216, maxFileBytes: 1_048_576 } });
  opened = await openOriginalMcpRoot(plan); const full = await opened.owner.ensureFull();
  const keys = generateKeyPairSync("ed25519"), identity = originalMcpNativeIdentity(
    createPublicKey(keys.privateKey).export({ format: "der", type: "spki" }).toString("base64"), profileSha256);
  endpoint = resolve("tests", `.p-${randomBytes(4).toString("hex")}`); await mkdir(endpoint, { mode: 0o700 });
  const binding = { root, workspaceId: opened.workspaceId, planSha256: plan.planSha256, profileSha256,
    catalogSha256: originalPublicMcpContracts().provenance.metadataSha256, payloadBuildId: hash("synthetic-payload"), hostEntrySha256: hash("synthetic-host") };
  server = await startOriginalMcpNativeAttachmentServer({ directory: endpoint, identity, identitySha256: identity.sha256,
    binding, maxPacketBytes: 65536, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 });
  socket = connect(join(endpoint, "n")); socket.on("error", () => socket.destroy());
  let buffer = "", attachedResolve;
  const attached = new Promise(resolve => { attachedResolve = resolve; }), frames = [], controls = { mode: "approve", count: 0, cancel: undefined };
  const send = frame => socket.write(JSON.stringify(frame) + "\n");
  socket.on("data", chunk => {
    buffer += chunk.toString("utf8"); let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (frame.type === "challenge") {
        const { body, message } = originalMcpNativeAttestationMessage(frame.challenge, identity.sha256, randomUUID());
        send({ type: "attestation", attestation: { ...body, signature: sign(null, message, keys.privateKey).toString("base64") } });
      } else if (frame.type === "attached") attachedResolve();
      else if (frame.type === "ping") send({ type: "pong", nonce: frame.nonce });
      else if (frame.type === "native-request") {
        frames.push(frame);
        if (frame.method !== privateResourcePublicationMethod) { send(originalMcpNativeResult(frame, { decision: "approve" })); continue; }
        controls.count++;
        if (controls.mode === "cancel") { controls.cancel.abort(); continue; }
        if (controls.mode === "deny" || controls.mode === "partial-deny" && controls.count % 2 === 0) {
          send(originalMcpNativeResult(frame, null)); continue;
        }
        send(originalMcpNativeResult(frame, { decision: "approve", actorId: "mcp:external", decisionId: randomUUID(),
          requestSha256: controls.mode === "wrong" ? "0".repeat(64) : frame.payload.requestSha256,
          operationId: frame.payload.request.subject.operationId, epoch: frame.session.epoch,
          expiresAtMs: controls.mode === "expired" ? Date.now() - 1 : Date.now() + 60000 }));
      }
    }
  });
  await attached; const session = await server.waitForSession({ timeoutMs: 1000 });
  send({ type: "native-supports", protocol: originalMcpNativeRequestProtocol, session: originalMcpNativeRequestSession(session),
    methods: [...originalMcpNativeRequestMethods], maxPacketBytes: 65536 });
  await waitForOriginalMcpNativeSupport(session, { timeoutMs: 1000 });
  host = await createOriginalMcpNativeHost(opened.storage, createOriginalMcpNativeRequestPolicy(session));
  const port = createNativePrivateResourcePublicationPort(opened.storage, host, session);
  const invoke = signal => withOriginalMcpPublicRequest(opened.storage, host, {
    operation: "mcp.tool.update_note", version: 1, tool: request.tool, readOnly: false,
    arguments: request.arguments, argumentsDigest: originalMcpRequestDigest(request.arguments),
  }, () => withNativePrivateResourcePublicationContext(port, () => legacyKnowledgeWrite(full.runtime.core, opened.storage, actor, request), signal), signal);
  const pin = extra => {
    const records = scanMarkdown(root), source = records.find(record => record.record.path === "Old/Before.md").record;
    return { operation: "knowledge.note.update", actorId: actor.id, args: { operationId: randomUUID(), id: source.id,
      expectedRevision: source.revision, expectedSha256: source.sha256, expectedScanRevision: knowledgeMutationScanRevision(records),
      title: "After", category: "New", moveTo: "New/After.md", preserveIdentity: true, ...extra } };
  };
  return { root, oracle, original, row, opened, full, host, port, session, controls, frames, invoke, pin };
}
test("default-deny and copied producer/recovery DTOs cannot inherit public approval or publish private bytes", { timeout: 120000 }, async t => {
  const f = await fixture(t), before = await readFile(join(f.root, "notes/Old/Before.md"));
  await assert.rejects(withNativePrivateResourcePublicationContext(structuredClone(f.port), async () => true),
    { code: "NATIVE_AUTHORITY_REQUIRED" });
  await assert.rejects(withPrivateResourcePublicationRecovery(f.opened.storage, { kind: "pkm.private-resource-publication-recovery/v1" }, async () => true),
    { code: "NATIVE_AUTHORITY_REQUIRED" });
  if (!present) await assert.rejects(f.invoke(), { code: "MISSING_NATIVE_METHOD" });
  else { f.controls.mode = "deny"; await assert.rejects(f.invoke(), { code: "PRIVATE_RESOURCE_PUBLICATION_DENIED" }); }
  assert.deepEqual(await readFile(join(f.root, "notes/Old/Before.md")), before);
  assert.deepEqual(journal(f.root), { intents: [], receipts: [] });
  assert.deepEqual(await readFile(join(f.root, "notes/Private/_assets/A.bin")), privateA);
});
test("pinned original writer copies private legacy bytes and retains shared source/referrer; v5 private retention is an explicit stronger policy", {
  timeout: 120000,
}, async t => {
  const f = await fixture(t), before = await readFile(join(f.oracle, "notes/Private/Referrer.md"));
  const result = f.original.run(f.oracle, `
    const before=store.noteGet("Old/Before");
    store.noteUpsert({...before,title:"After",category:"New",content:before.content,
      tags:typeof before.tags==="string"?JSON.parse(before.tags):before.tags});
    return store.noteGet("New/After");
  `);
  assert.equal(result.slug, "New/After");
  assert.deepEqual(await readFile(join(f.oracle, `notes/New/After.assets/${hash(privateA).slice(0, 16)}.bin`)), privateA);
  assert.deepEqual(await readFile(join(f.oracle, "notes/Private/_assets/A.bin")), privateA);
  assert.deepEqual(await readFile(join(f.oracle, "notes/Private/Referrer.md")), before);
  await assert.rejects(readFile(join(f.oracle, "notes/Private/_assets/B.bin")), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(f.root, "notes/Private/_assets/B.bin")), privateB);
});
test("checked stored references produce metadata-only bound review subjects, reject new private paths, and CAS failures suppress source details", {
  timeout: 120000,
}, async t => {
  const f = await fixture(t), subjects = await privatePublicationRequirements(f.opened.storage, request, f.pin(), true, f.host);
  assert.equal(subjects.length, 2);
  const { receiptSha256, ...binding } = f.host.receipt;
  const resourceRequest = { schema: "pkm.private-resource-publication/v1", phase: "publish", subject: subjects[0],
    nativeHostReceiptSha256: receiptSha256, nativeEpoch: f.host.receipt.epoch };
  const payload = { binding, defaultDecision: "deny", request: resourceRequest, requestSha256: privateResourcePublicationDigest(resourceRequest) };
  assert.deepEqual(parsePrivateResourcePublicationPayload(payload, originalMcpNativeRequestSession(f.session)), payload);
  assert(!JSON.stringify(payload).includes(privateA.toString()));
  for (const mutate of [
    value => { value.defaultDecision = "approve"; },
    value => { value.request.subject.resource.targetPath = "Other.assets/not-reviewed.bin"; },
    value => { value.request.subject.operation = "knowledge.research.update"; },
  ]) {
    const variant = structuredClone(payload); mutate(variant);
    assert.throws(() => parsePrivateResourcePublicationPayload(variant, originalMcpNativeRequestSession(f.session)));
  }
  await assert.rejects(privatePublicationRequirements(f.opened.storage, request, f.pin({
    content: "![not stored](../Private/_assets/NEVER_REVIEWED.bin)",
  }), true, f.host), { code: "UNSUPPORTED_OPERATION" });
  await writeFile(join(f.root, "notes/Private/_assets/A.bin"), Buffer.from("SYNTHETIC_SOURCE_DRIFT"));
  await assert.rejects(assertPrivatePublicationSourcePins(f.opened.storage, subjects), { code: "CONFLICT" });
  await rm(join(f.root, "notes/Private/_assets/B.bin"));
  await assert.rejects(assertPrivatePublicationSourcePins(f.opened.storage, [subjects[1]]),
    error => error.code === "INVALID_DOCUMENT" && !error.message.includes("Private/") && !error.message.includes(f.root));
  assert.deepEqual(journal(f.root), { intents: [], receipts: [] });
});
test("signed same-owner per-resource approval publishes exact private copies but retains all private sources/provenance without plaintext descriptors", {
  timeout: 120000, skip: !present && "Parent shared knowledge.asset.publish registration is required; no synthetic success fallback.",
}, async t => {
  const f = await fixture(t), privateBefore = await readFile(join(f.root, "notes/Private/_assets/A.bin"));
  const result = JSON.parse((await f.invoke()).text); assert.deepEqual(result, { ok: true, slug: "New/After" });
  assert.equal(f.frames.filter(frame => frame.method === privateResourcePublicationMethod).length, 2);
  const serialized = JSON.stringify(f.frames);
  assert(!serialized.includes(privateA.toString()) && !serialized.includes(privateB.toString()));
  assert.deepEqual(await readFile(join(f.root, `notes/New/After.assets/${hash(privateA).slice(0, 16)}.bin`)), privateA);
  assert.deepEqual(await readFile(join(f.root, `notes/New/After.assets/${hash(privateB).slice(0, 16)}.bin`)), privateB);
  assert.deepEqual(await readFile(join(f.root, "notes/Private/_assets/A.bin")), privateBefore);
  assert.equal(journal(f.root).receipts.length, 1); assert.equal(journal(f.root).intents.length, 0);
});
test("partial deny, cancellation, expired and wrong decisions refuse before any mutation intent/publication", {
  timeout: 120000, skip: !present && "Parent method registration missing; this approval-path evidence is not claimed.",
}, async t => {
  const f = await fixture(t), before = await readFile(join(f.root, "notes/Old/Before.md"));
  for (const mode of ["partial-deny", "expired", "wrong", "cancel"]) {
    f.controls.mode = mode; f.controls.count = 0;
    const cancel = new AbortController(); f.controls.cancel = cancel;
    await assert.rejects(f.invoke(cancel.signal), error => ["PRIVATE_RESOURCE_PUBLICATION_DENIED", "PRIVATE_RESOURCE_PUBLICATION_EXPIRED",
      "PRIVATE_RESOURCE_PUBLICATION_DECISION_MISMATCH", "NATIVE_REQUEST_CANCELLED"].includes(error.code));
    assert.deepEqual(journal(f.root), { intents: [], receipts: [] });
    assert.deepEqual(await readFile(join(f.root, "notes/Old/Before.md")), before);
  }
});
test("incomplete private publication recovery requires a new current decision and preserves exact historical replay without renewing authority", {
  timeout: 120000, skip: !present && "Current native resource approval registration is a prerequisite for this recovery test.",
}, async t => {
  const f = await fixture(t), execute = childProcess.execFileSync;
  let injected = false;
  childProcess.execFileSync = function(file, args, options) {
    const result = execute.call(this, file, args, options);
    if (!injected && Array.isArray(args) && args[0] === "-c" && String(args[1]).includes("renameat2")
      && String(args[3]).endsWith(`${hash(privateA).slice(0, 16)}.bin`)) { injected = true; throw new Error("Private copy interruption"); }
    return result;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.invoke()); } finally { childProcess.execFileSync = execute; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  const pending = journal(f.root).intents[0], recorded = JSON.parse(pending.request_json);
  assert.equal(journal(f.root).receipts.length, 0);
  const unreviewed = await f.full.runtime.core.dispatch("capability_call", { operation: recorded.operation, version: 1, arguments: recorded.args }, actor);
  assert.equal(unreviewed.error.code, "NATIVE_AUTHORITY_REQUIRED");
  const recovery = await approvePendingPrivateResourcePublications(f.port);
  const resumed = await withPrivateResourcePublicationRecovery(f.opened.storage, recovery, () =>
    f.full.runtime.core.dispatch("capability_call", { operation: recorded.operation, version: 1, arguments: recorded.args }, actor));
  assert.equal(resumed.error, undefined, JSON.stringify(resumed)); assert.equal(journal(f.root).receipts.length, 1);
  const reviewed = f.frames.filter(frame => frame.method === privateResourcePublicationMethod && frame.payload.request.phase === "recover");
  assert.equal(reviewed.length, 1); assert(reviewed[0].payload.request.subject.resource.sourcePath.endsWith("B.bin"));
  const historical = await f.full.runtime.core.dispatch("capability_call", { operation: recorded.operation, version: 1, arguments: recorded.args }, actor);
  assert.equal(historical.error, undefined); assert.equal(historical.result.operationId, pending.operation_id);
  assert.equal(f.frames.filter(frame => frame.method === privateResourcePublicationMethod && frame.payload.request.phase === "recover").length, 1);
});
test("strict resource payload rejects changed target/source operation bindings rather than a caller grant flag", {
  timeout: 120000, skip: !present && "Requires the real signed resource frame producer for grounded payload variants.",
}, async t => {
  const f = await fixture(t); f.controls.mode = "deny"; await assert.rejects(f.invoke());
  const frame = f.frames.find(frame => frame.method === privateResourcePublicationMethod);
  for (const mutate of [
    payload => { payload.defaultDecision = "approve"; },
    payload => { payload.request.subject.resource.targetPath = "Other.assets/not-approved.bin"; },
    payload => { payload.request.subject.operationId = randomUUID(); },
  ]) {
    const payload = structuredClone(frame.payload); mutate(payload);
    assert.throws(() => parsePrivateResourcePublicationPayload(payload, frame.session));
  }
});
