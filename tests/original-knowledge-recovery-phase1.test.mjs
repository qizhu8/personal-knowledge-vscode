import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import "./original-knowledge-recovery-source-loader.mjs";

assert.equal(process.env.PKM_TEST_ISOLATED_NETWORK, "1", "Use the actual private framework isolation.");
assert(process.env.PKM_LEGACY_VSIX, "Pinned Original22 remains mandatory; no skip-as-pass.");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha(await readFile(process.env.PKM_LEGACY_VSIX)), "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
const project = resolve(import.meta.dirname, "..");
const source = name => pathToFileURL(join(project, "src", name)).href;
const c = await import(source("original-knowledge-recovery-contracts.ts"));
const g = await import(source("original-knowledge-recovery-guard.ts"));
const n = await import(source("original-knowledge-recovery-native.ts"));
const rpc = await import(source("original-mcp-native-request.ts"));
function fixture() {
  const root = "/phase1-synthetic-no-filesystem/root", directory = "/phase1-synthetic-no-filesystem/evidence";
  const uuid = randomUUID(), hash = "a".repeat(64);
  const identity = { device: "1", inode: "2", uid: "1000", mode: 0o700, links: 2, size: 4096, mtime: "1", ctime: "1" };
  const bytes = Buffer.from("---\r\ndocumentId: native_doc_id\r\nknowledgeId: original_raw_id\r\nrevision: 7\r\n---\r\nUnchanged raw bytes.\r\n");
  const file = { path: "notes/Public/Owned.md", sha256: sha(bytes), mode: "100644" };
  const planBytes = Buffer.from(JSON.stringify({ schema: "pkm.knowledge-recovery/v1", knowledgeRoot: root, files: [file] }));
  const evidenceBody = {
    schema: "pkm.original-recovery-evidence/v1", directory, directoryIdentity: identity, knowledgeRoot: root,
    planSha256: sha(planBytes), planIdentity: { ...identity, mode: 0o600, links: 1, size: planBytes.length },
    files: [{ ...file, identity: { ...identity, mode: 0o600, links: 1, size: bytes.length } }],
  };
  const evidence = { ...evidenceBody, manifestSha256: c.originalRecoveryDigest(evidenceBody) };
  const owner = { area: "notes", id: "native_doc_id", knowledgeId: "original_raw_id", path: "Public/Owned.md",
    revision: 7, sha256: file.sha256, bytes: bytes.length, mode: file.mode,
    registrationReceiptSha256: hash, custodyPredecessorSha256: hash, indexRowSha256: hash,
    privacy: "public", deleted: false, documentKind: "note", assets: [], referrers: [] };
  const signed = { brokerId: randomUUID(), activationId: uuid, identitySha256: hash, epoch: uuid,
    binding: { root, workspaceId: randomUUID(), planSha256: hash, catalogSha256: hash,
      profileSha256: hash, payloadBuildId: hash, hostEntrySha256: hash } };
  const binding = { schema: "pkm.original-mcp-native-host-admission/v1", root, workspaceId: signed.binding.workspaceId,
    planSha256: hash, profileSha256: hash, sourceCatalogSha256: hash,
    authorityId: `native-rpc:${signed.brokerId}`, epoch: uuid, actorId: "mcp:external",
    domains: ["mcp-public"], configurationSha256: hash };
  const operationId = randomUUID(), arguments_ = { evidence_directory: directory, approved_plan_sha256: sha(planBytes) };
  const publicRequest = { tool: "knowledge_recovery_apply", version: 1, arguments: arguments_,
    argumentsDigest: c.originalRecoveryDigest(arguments_) };
  const observation = { root, workspaceId: signed.binding.workspaceId, nativeHostReceiptSha256: c.originalRecoveryDigest(binding),
    epoch: uuid, ownerId: randomUUID(), fence: 1, rootIdentity: identity, parentIdentity: identity, owner,
    destination: "missing", pendingOperationIds: [] };
  const capture = { knowledgeRoot: root, planBytes, expectedPlanSha256: sha(planBytes),
    blobs: new Map([[file.sha256, bytes]]), destinations: new Map([[file.path, { kind: "missing" }]]) };
  const plan = g.planOriginalRecoveryPhase1Repair({ operationId, evidence, owner, observation, capture,
    auditName: "result-20261122T222500123456.json" });
  const repairRequest = { schema: "pkm.original-recovery-repair-request/v1", operationId,
    nativeHostReceiptSha256: observation.nativeHostReceiptSha256, publicRequest, evidence, owner,
    rootIdentity: identity, parentIdentity: identity, ownerId: observation.ownerId, fence: 1,
    repairPlanSha256: plan.repairPlanSha256, auditName: plan.auditName };
  const payload = request => ({ binding, defaultDecision: "deny", request, requestSha256: c.originalRecoveryDigest(request) });
  return { root, directory, bytes, file, evidence, owner, signed, observation, capture, plan, publicRequest, repairRequest, payload };
}

test("strict phase1 RPC DTOs bind the signed request and cannot manufacture source/repair WeakMap authority", () => {
  const f = fixture();
  const sourceRequest = { schema: "pkm.original-recovery-source-request/v1", operationId: f.plan.operationId,
    nativeHostReceiptSha256: f.observation.nativeHostReceiptSha256, publicRequest: f.publicRequest };
  assert(c.parseOriginalRecoveryPhase1Payload(c.originalRecoveryPhase1Methods.source, f.payload(sourceRequest), f.signed));
  assert(c.parseOriginalRecoveryPhase1Payload(c.originalRecoveryPhase1Methods.repair, f.payload(f.repairRequest), f.signed));
  assert.throws(() => c.parseOriginalRecoveryPhase1Payload(c.originalRecoveryPhase1Methods.source, f.payload(sourceRequest),
    { ...f.signed, activationId: randomUUID() }), { code: "RECOVERY_SIGNED_BINDING_MISMATCH" });
  assert.throws(() => c.parseOriginalRecoveryPhase1Payload(c.originalRecoveryPhase1Methods.repair,
    { ...f.payload(f.repairRequest), requestSha256: "0".repeat(64) }, f.signed), { code: "RECOVERY_SIGNED_BINDING_MISMATCH" });
  assert.throws(() => c.parseOriginalRecoveryPhase1Payload(c.originalRecoveryPhase1Methods.repair,
    f.payload({ ...f.repairRequest, repairPlanSha256: "b".repeat(64) }), f.signed),
    { code: "RECOVERY_REPAIR_BINDING_MISMATCH" });
  assert.throws(() => c.parseOriginalRecoveryPhase1Payload(c.originalRecoveryPhase1Methods.repair,
    { ...f.payload(f.repairRequest), defaultDecision: "approve" }, f.signed));
  const port = { kind: "pkm.original-recovery-phase1-port/v1" };
  assert.throws(() => n.assertOriginalRecoverySourceGrant(port, { kind: "pkm.original-recovery-source-grant/v1" }),
    { code: "RECOVERY_GENUINE_NATIVE_PORT_REQUIRED" });
  assert.throws(() => n.beginOriginalRecoveryRepairAttempt(port, { kind: "pkm.original-recovery-repair-grant/v1" }, f.observation),
    { code: "RECOVERY_GENUINE_NATIVE_PORT_REQUIRED" });
  assert.throws(() => n.assertOriginalRecoveryRepairAttempt({ kind: "pkm.original-recovery-repair-attempt/v1" },
    f.observation, f.plan.repairPlanSha256), { code: "RECOVERY_GENUINE_REPAIR_GRANT_REQUIRED" });
  assert.throws(() => n.readOriginalRecoveryWorkerCapsule({}, JSON.parse(JSON.stringify({
    kind: "pkm.original-recovery-worker-capsule/v1",
  }))), { code: "RECOVERY_GENUINE_REPAIR_GRANT_REQUIRED" });
});

test("actual native-request schemas register both recovery methods without exposing plan/blob bytes or enlarging packets", () => {
  const f = fixture();
  for (const method of Object.values(c.originalRecoveryPhase1Methods)) assert(rpc.originalMcpNativeRequestMethods.includes(method));
  const request = { schema: "pkm.original-recovery-source-request/v1", operationId: f.plan.operationId,
    nativeHostReceiptSha256: f.observation.nativeHostReceiptSha256, publicRequest: f.publicRequest };
  const body = { protocol: rpc.originalMcpNativeRequestProtocol, requestId: randomUUID(), session: f.signed,
    method: c.originalRecoveryPhase1Methods.source, payload: f.payload(request) };
  const frame = { type: "native-request", ...body, requestDigest: c.originalRecoveryDigest(body) };
  const parsed = rpc.parseOriginalMcpNativeRequest(frame, f.signed);
  assert.equal(parsed.method, c.originalRecoveryPhase1Methods.source);
  assert.equal(rpc.originalMcpNativeResult(parsed, null).result, null);
  assert.throws(() => rpc.parseOriginalMcpNativeRequest({
    ...frame, payload: { ...frame.payload, blob: "x".repeat(65536) },
  }, f.signed), error => error.code === "NATIVE_REQUEST_INVALID" || error.code === "NATIVE_REQUEST_TOO_LARGE");
  assert.throws(() => c.originalRecoverySourceResultSchema.parse({
    decision: { decision: "approve", actorId: "mcp:external", decisionId: randomUUID(), operationId: f.plan.operationId,
      requestSha256: frame.payload.requestSha256, epoch: f.signed.epoch, expiresAtMs: Date.now() + 1000 },
    evidence: f.evidence, evidenceSha256: c.originalRecoveryDigest(f.evidence), planBytes: f.capture.planBytes.toString("base64"),
  }));
});

test("pure one-owner preflight preserves raw identity/hash/mode and denies occupied, private, shared, stale or mismatched lineage", () => {
  const f = fixture(), draft = updates => g.planOriginalRecoveryPhase1Repair({
    operationId: f.plan.operationId, evidence: f.evidence, owner: f.owner,
    observation: f.observation, capture: f.capture, auditName: f.plan.auditName, ...updates,
  });
  assert.equal(draft().owner.revision, 7);
  assert.deepEqual(f.capture.blobs.get(f.file.sha256), f.bytes);
  assert.throws(() => draft({ owner: { ...f.owner, privacy: "private" } }));
  assert.throws(() => draft({ owner: { ...f.owner, assets: ["Owned.assets/retained.bin"] } }));
  assert.throws(() => draft({ owner: { ...f.owner, referrers: ["notes/Public/Other.md"] } }));
  assert.throws(() => draft({ owner: { ...f.owner, registrationReceiptSha256: "b".repeat(64) } }),
    { code: "RECOVERY_OWNER_REPAIR_PRECONDITION_CHANGED" });
  assert.throws(() => draft({ owner: { ...f.owner, mode: "100755" } }), { code: "RECOVERY_OWNER_REPAIR_PRECONDITION_CHANGED" });
  assert.throws(() => draft({ observation: { ...f.observation, pendingOperationIds: [randomUUID()] } }));
  assert.throws(() => draft({ capture: { ...f.capture,
    destinations: new Map([[f.file.path, { kind: "regular", bytes: Buffer.from("Occupied user bytes.") }]]) } }),
    { code: "RECOVERY_OWNER_REPAIR_PRECONDITION_CHANGED" });
  assert.throws(() => g.assertOriginalRecoveryPhase1Observation(f.plan, { ...f.observation, fence: 2 }),
    { code: "RECOVERY_OWNER_REPAIR_PRECONDITION_CHANGED" });
});

test("successful-image guard admits only the same owner/index predecessor and exact physical/audit successor", () => {
  const f = fixture();
  const image = { operationId: f.plan.operationId, repairPlanSha256: f.plan.repairPlanSha256,
    root: f.root, workspaceId: f.observation.workspaceId, epoch: f.observation.epoch,
    ownerId: f.observation.ownerId, fence: f.observation.fence,
    rootIdentity: f.observation.rootIdentity, parentIdentity: { ...f.observation.parentIdentity, mtime: "2", ctime: "2" },
    owner: f.owner, path: f.file.path, sha256: f.file.sha256,
    physicalIdentity: { ...f.observation.parentIdentity, inode: "3", size: f.bytes.length, mode: 0o644, links: 1 },
    predecessorSha256: f.owner.custodyPredecessorSha256, beforeIndexRowSha256: f.owner.indexRowSha256,
    afterIndexRowSha256: f.owner.indexRowSha256, auditName: f.plan.auditName,
    auditPlanSha256: f.evidence.planSha256, auditedRestored: [f.file.path] };
  const stage = { operationId: f.plan.operationId, root: f.root, workspaceId: f.observation.workspaceId,
    epoch: f.observation.epoch, ownerId: f.observation.ownerId, fence: f.observation.fence,
    rootIdentity: f.observation.rootIdentity, parentIdentity: image.parentIdentity,
    stageName: `.pkm-write-${f.plan.operationId}`, targetPath: f.file.path, sha256: f.file.sha256,
    identity: image.physicalIdentity, pendingOperationIds: [f.plan.operationId] };
  assert(g.assertOriginalRecoveryPhase1Successor(f.plan, image, stage));
  for (const changed of [{ owner: { ...f.owner, revision: 8 } },
    { afterIndexRowSha256: "b".repeat(64) }, { sha256: "0".repeat(64) },
    { physicalIdentity: { ...image.physicalIdentity, mode: 0o755 } },
    { physicalIdentity: { ...image.physicalIdentity, links: 2 } }, { auditedRestored: ["notes/Public/Other.md"] },
    { rootIdentity: { ...image.rootIdentity, inode: "4" } },
    { physicalIdentity: { ...image.physicalIdentity, inode: "100" } }])
    assert.throws(() => g.assertOriginalRecoveryPhase1Successor(f.plan, { ...image, ...changed }, stage),
      { code: "RECOVERY_OWNER_REPAIR_SUCCESSOR_CHANGED" });
  assert.throws(() => g.assertOriginalRecoveryPhase1Stage(f.plan, { ...stage, pendingOperationIds: [randomUUID()] }),
    { code: "RECOVERY_OWNER_REPAIR_STAGE_CHANGED" });
  assert.throws(() => n.assertOriginalRecoveryRepairSuccessor(JSON.parse(JSON.stringify({
    kind: "pkm.original-recovery-repair-attempt/v1",
  })), image, f.plan.repairPlanSha256), { code: "RECOVERY_GENUINE_REPAIR_GRANT_REQUIRED" });
});
