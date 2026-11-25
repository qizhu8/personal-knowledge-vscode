import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestMatches, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import {
  assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession,
} from "./original-mcp-native-attachment.js";
import {
  originalMcpNativeRequestMethods, originalMcpNativeRequestSession, requestOriginalMcpNative,
} from "./original-mcp-native-request.js";
import {
  originalRecoveryDigest as digest, originalRecoveryPhase1Methods,
  originalRecoverySourcePayloadSchema, originalRecoveryRepairPayloadSchema,
  originalRecoverySourceResultSchema, originalRecoveryRepairResultSchema,
  parseOriginalRecoveryPhase1Payload, validateOriginalRecoveryEvidence,
  type OriginalRecoverySourcePayload, type OriginalRecoveryRepairPayload,
} from "./original-knowledge-recovery-contracts.js";
import { planOriginalKnowledgeRecovery, type OriginalRecoveryCapture } from "./original-knowledge-recovery-planner.js";
import {
  assertOriginalRecoveryPhase1Observation, assertOriginalRecoveryPhase1Successor,
  assertOriginalRecoveryPhase1Stage, planOriginalRecoveryPhase1Repair, type OriginalRecoveryPhase1RepairPlan,
} from "./original-knowledge-recovery-guard.js";
import { readOriginalRecoveryCustodyProof, type OriginalRecoveryCustodyProof } from "./original-knowledge-recovery-assembly.js";
import type { OriginalRecoveryWorkerAdmission } from "./original-knowledge-recovery-state.js";

export interface OriginalRecoveryPhase1Port { readonly kind: "pkm.original-recovery-phase1-port/v1" }
export interface OriginalRecoverySourceGrant { readonly kind: "pkm.original-recovery-source-grant/v1" }
export interface OriginalRecoverySourceCapture { readonly kind: "pkm.original-recovery-source-capture/v1" }
export interface OriginalRecoveryRepairGrant { readonly kind: "pkm.original-recovery-repair-grant/v1" }
export interface OriginalRecoveryRepairAttempt { readonly kind: "pkm.original-recovery-repair-attempt/v1" }
interface State {
  storage: Storage; host: OriginalMcpNativeHost; session: AuthenticatedOriginalMcpNativeSession;
  lifetime: AbortController; current(): void;
}
interface Source {
  state: State; payload: OriginalRecoverySourcePayload;
  result: NonNullable<ReturnType<typeof originalRecoverySourceResultSchema.parse>>;
  signal: AbortSignal; captured: boolean; current(): void;
}
interface Capture { source: Source; bytes: OriginalRecoveryCapture }
interface Repair {
  source: Source; payload: OriginalRecoveryRepairPayload;
  plan: OriginalRecoveryPhase1RepairPlan; used: boolean;
  stage?: ReturnType<typeof assertOriginalRecoveryPhase1Stage>;
  decision: NonNullable<ReturnType<typeof originalRecoveryRepairResultSchema.parse>>; current(): void;
}
const ports = new WeakMap<object, State>(), sources = new WeakMap<object, Source>();
const captures = new WeakMap<object, Capture>(), repairs = new WeakMap<object, Repair>(), attempts = new WeakMap<object, Repair>();
const selected = new WeakMap<Storage, { host: OriginalMcpNativeHost; port: OriginalRecoveryPhase1Port }>();
export interface OriginalRecoveryWorkerCapsule { readonly kind: "pkm.original-recovery-worker-capsule/v1" }
const workerCapsules = new WeakMap<object, { storage: Storage; data: OriginalRecoveryWorkerAdmission; current(): void; sent: boolean; release(): void }>();
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function stateFor(value: OriginalRecoveryPhase1Port): State {
  const state = ports.get(value);
  if (!state) fail("RECOVERY_GENUINE_NATIVE_PORT_REQUIRED");
  state.current(); return state;
}

/** No embedding approval callback or JSON grant factory; only the actual signed owner. */
export function createOriginalRecoveryPhase1Port(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession): OriginalRecoveryPhase1Port {
  const prior = selected.get(storage);
  if (prior) {
    if (prior.host !== host || stateFor(prior.port).session !== session) fail("RECOVERY_SIGNED_BINDING_MISMATCH");
    return prior.port;
  }
  const lifetime = new AbortController();
  const state: State = { storage, host, session, lifetime, current() {
    assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
    const journal = assertOriginalMcpPrivacy(storage.workspaceRoot()), binding = session.binding;
    if (!journal || lifetime.signal.aborted || host.signal.aborted || session.signal.aborted
      || binding.root !== storage.workspaceRoot() || binding.root !== host.receipt.root
      || binding.workspaceId !== journal.workspaceId || binding.workspaceId !== host.receipt.workspaceId
      || binding.planSha256 !== journal.plan.planSha256 || binding.planSha256 !== host.receipt.planSha256
      || binding.profileSha256 !== journal.plan.profileSha256 || binding.profileSha256 !== host.receipt.profileSha256
      || binding.catalogSha256 !== host.receipt.sourceCatalogSha256 || session.activationId !== host.receipt.epoch
      || host.receipt.authorityId !== `native-rpc:${session.brokerId}` || !host.receipt.domains.includes("mcp-public"))
      fail("RECOVERY_SIGNED_BINDING_MISMATCH");
  } };
  state.current();
  const port = Object.freeze({ kind: "pkm.original-recovery-phase1-port/v1" as const });
  const abort = () => lifetime.abort();
  host.signal.addEventListener("abort", abort, { once: true }); session.signal.addEventListener("abort", abort, { once: true });
  storage.retainNativeCleanup({ release: async () => {
    abort(); host.signal.removeEventListener("abort", abort); session.signal.removeEventListener("abort", abort);
    if (selected.get(storage)?.port === port) selected.delete(storage);
  } });
  ports.set(port, state); selected.set(storage, { host, port }); return port;
}
export function getOriginalRecoveryPhase1Port(storage: Storage, host: OriginalMcpNativeHost) {
  const entry = selected.get(storage);
  if (!entry) return undefined;
  if (entry.host !== host) fail("RECOVERY_SIGNED_BINDING_MISMATCH");
  stateFor(entry.port); return entry.port;
}
async function request(state: State, methodName: string, payload: unknown, signal: AbortSignal) {
  state.current();
  const method = originalMcpNativeRequestMethods.find(value => String(value) === methodName);
  if (!method) fail("MISSING_NATIVE_METHOD");
  if (signal.aborted) fail("RECOVERY_NATIVE_CANCELLED");
  const result = await requestOriginalMcpNative(state.session, method, payload, { signal, timeoutMs: 120000 });
  state.current();
  if (signal.aborted) fail("RECOVERY_NATIVE_CANCELLED");
  return result;
}
function assertDecision(decision: NonNullable<ReturnType<typeof originalRecoveryRepairResultSchema.parse>>,
  state: State, operationId: string, requestSha256: string) {
  if (decision.operationId !== operationId || decision.requestSha256 !== requestSha256
    || decision.epoch !== state.host.receipt.epoch || decision.actorId !== "mcp:external")
    fail("RECOVERY_NATIVE_DECISION_MISMATCH");
  if (decision.expiresAtMs <= Date.now() || decision.expiresAtMs > Date.now() + 120000) fail("RECOVERY_NATIVE_EXPIRED");
}
function assertPayloadOwner(state: State, payload: OriginalRecoverySourcePayload | OriginalRecoveryRepairPayload) {
  const { receiptSha256, ...binding } = state.host.receipt, publicRequest = payload.request.publicRequest;
  if (digest(payload.binding) !== digest(binding) || payload.request.nativeHostReceiptSha256 !== receiptSha256
    || !originalMcpPublicRequestMatches(state.storage, state.host, {
      operation: `mcp.tool.${publicRequest.tool}`, version: 1, tool: publicRequest.tool,
      readOnly: publicRequest.tool === "knowledge_recovery_preview",
      arguments: publicRequest.arguments, argumentsDigest: publicRequest.argumentsDigest,
    })) fail("RECOVERY_PUBLIC_REQUEST_MISMATCH");
}
export async function approveOriginalRecoverySource(port: OriginalRecoveryPhase1Port,
  input: OriginalRecoverySourcePayload, signal?: AbortSignal): Promise<OriginalRecoverySourceGrant> {
  const state = stateFor(port), payload = originalRecoverySourcePayloadSchema.parse(structuredClone(input));
  assertPayloadOwner(state, payload);
  parseOriginalRecoveryPhase1Payload(originalRecoveryPhase1Methods.source, payload, originalMcpNativeRequestSession(state.session));
  const combined = AbortSignal.any([state.lifetime.signal, state.host.signal, state.session.signal, ...(signal ? [signal] : [])]);
  const result = originalRecoverySourceResultSchema.parse(await request(state, originalRecoveryPhase1Methods.source, payload, combined));
  if (!result) fail("RECOVERY_NATIVE_SOURCE_DENIED");
  assertDecision(result.decision, state, payload.request.operationId, payload.requestSha256);
  const evidence = validateOriginalRecoveryEvidence(result.evidence);
  if (evidence.directory !== payload.request.publicRequest.arguments.evidence_directory
    || evidence.knowledgeRoot !== state.storage.workspaceRoot() || result.evidenceSha256 !== digest(evidence))
    fail("RECOVERY_EVIDENCE_BINDING_MISMATCH");
  if (payload.request.publicRequest.tool === "knowledge_recovery_apply"
    && payload.request.publicRequest.arguments.approved_plan_sha256 !== evidence.planSha256) fail("RECOVERY_PLAN_HASH_MISMATCH");
  const source: Source = { state, payload, result: structuredClone(result), signal: combined, captured: false, current() {
    state.current(); assertPayloadOwner(state, payload);
    if (combined.aborted) fail("RECOVERY_NATIVE_CANCELLED");
    if (result.decision.expiresAtMs <= Date.now()) fail("RECOVERY_NATIVE_EXPIRED");
  } };
  const grant = Object.freeze({ kind: "pkm.original-recovery-source-grant/v1" as const });
  sources.set(grant, source); return grant;
}
function sourceFor(port: OriginalRecoveryPhase1Port, grant: OriginalRecoverySourceGrant) {
  const state = stateFor(port), source = sources.get(grant);
  if (!source || source.state !== state) fail("RECOVERY_GENUINE_SOURCE_GRANT_REQUIRED");
  source.current(); return source;
}
export function assertOriginalRecoverySourceGrant(port: OriginalRecoveryPhase1Port, grant: OriginalRecoverySourceGrant) {
  sourceFor(port, grant);
}
export function originalRecoveryApprovedEvidence(port: OriginalRecoveryPhase1Port, grant: OriginalRecoverySourceGrant) {
  return structuredClone(sourceFor(port, grant).result.evidence);
}

/** Trusted source assembler supplies exact pinned bytes; this pure seal never reads arbitrary paths. */
export function sealOriginalRecoverySourceCapture(port: OriginalRecoveryPhase1Port, grant: OriginalRecoverySourceGrant,
  observedEvidence: unknown, capturedBytes: OriginalRecoveryCapture): OriginalRecoverySourceCapture {
  const source = sourceFor(port, grant);
  if (source.captured || digest(validateOriginalRecoveryEvidence(observedEvidence)) !== digest(source.result.evidence))
    fail("RECOVERY_EVIDENCE_BINDING_MISMATCH");
  const evidence = source.result.evidence, preview = planOriginalKnowledgeRecovery(capturedBytes);
  const plan = JSON.parse(Buffer.from(capturedBytes.planBytes).toString("utf8")) as { files: unknown[] };
  const row = evidence.files[0]!, blob = capturedBytes.blobs.get(row.sha256);
  if (preview.knowledge_root !== evidence.knowledgeRoot || preview.plan_sha256 !== evidence.planSha256
    || capturedBytes.planBytes.byteLength !== evidence.planIdentity.size || plan.files.length !== 1
    || digest(plan.files[0]) !== digest({ path: row.path, sha256: row.sha256, mode: row.mode })
    || !blob || blob.byteLength !== row.identity.size || capturedBytes.blobs.size !== 1
    || capturedBytes.destinations.size !== 1) fail("RECOVERY_EVIDENCE_BINDING_MISMATCH");
  const bytes: OriginalRecoveryCapture = {
    knowledgeRoot: capturedBytes.knowledgeRoot, planBytes: Buffer.from(capturedBytes.planBytes),
    expectedPlanSha256: capturedBytes.expectedPlanSha256,
    blobs: new Map([[row.sha256, Buffer.from(blob)]]),
    destinations: new Map([...capturedBytes.destinations].map(([path, value]) =>
      [path, value.kind === "regular" ? { kind: "regular", bytes: Buffer.from(value.bytes) } : { ...value }])),
  };
  planOriginalKnowledgeRecovery(bytes);
  source.captured = true;
  const capture = Object.freeze({ kind: "pkm.original-recovery-source-capture/v1" as const });
  captures.set(capture, { source, bytes }); return capture;
}
function captureFor(port: OriginalRecoveryPhase1Port, capture: OriginalRecoverySourceCapture) {
  const state = stateFor(port), entry = captures.get(capture);
  if (!entry || entry.source.state !== state) fail("RECOVERY_GENUINE_SOURCE_CAPTURE_REQUIRED");
  entry.source.current(); return entry;
}
export function previewOriginalRecoverySourceCapture(port: OriginalRecoveryPhase1Port, capture: OriginalRecoverySourceCapture) {
  const entry = captureFor(port, capture);
  if (entry.source.payload.request.publicRequest.tool !== "knowledge_recovery_preview") fail("RECOVERY_PUBLIC_REQUEST_MISMATCH");
  return planOriginalKnowledgeRecovery(entry.bytes);
}
export async function approveOriginalRecoveryRepair(port: OriginalRecoveryPhase1Port, capture: OriginalRecoverySourceCapture,
  planValue: OriginalRecoveryPhase1RepairPlan, input: OriginalRecoveryRepairPayload): Promise<OriginalRecoveryRepairGrant> {
  const entry = captureFor(port, capture), source = entry.source, state = source.state;
  const plan = structuredClone(planValue), payload = originalRecoveryRepairPayloadSchema.parse(structuredClone(input));
  assertPayloadOwner(state, payload);
  parseOriginalRecoveryPhase1Payload(originalRecoveryPhase1Methods.repair, payload, originalMcpNativeRequestSession(state.session));
  assertOriginalRecoveryPhase1Observation(plan, plan.observation);
  const rebuilt = planOriginalRecoveryPhase1Repair({
    operationId: plan.operationId, evidence: plan.evidence, owner: plan.owner,
    observation: plan.observation, capture: entry.bytes, auditName: plan.auditName,
  });
  if (rebuilt.repairPlanSha256 !== plan.repairPlanSha256) fail("RECOVERY_REPAIR_BINDING_MISMATCH");
  const requestValue = payload.request;
  if (source.payload.request.publicRequest.tool !== "knowledge_recovery_apply"
    || digest(source.payload.request.publicRequest) !== digest(requestValue.publicRequest)
    || source.payload.request.operationId !== requestValue.operationId || requestValue.operationId !== plan.operationId
    || requestValue.repairPlanSha256 !== plan.repairPlanSha256 || digest(requestValue.evidence) !== digest(source.result.evidence)
    || digest(requestValue.evidence) !== digest(plan.evidence) || digest(requestValue.owner) !== digest(plan.owner)
    || digest(requestValue.rootIdentity) !== digest(plan.observation.rootIdentity)
    || digest(requestValue.parentIdentity) !== digest(plan.observation.parentIdentity)
    || requestValue.ownerId !== plan.observation.ownerId || requestValue.fence !== plan.observation.fence
    || requestValue.auditName !== plan.auditName || plan.observation.root !== state.storage.workspaceRoot()
    || plan.observation.workspaceId !== state.host.receipt.workspaceId || plan.observation.epoch !== state.host.receipt.epoch
    || plan.observation.nativeHostReceiptSha256 !== state.host.receipt.receiptSha256)
    fail("RECOVERY_REPAIR_BINDING_MISMATCH");
  const decision = originalRecoveryRepairResultSchema.parse(await request(state, originalRecoveryPhase1Methods.repair, payload, source.signal));
  if (!decision) fail("RECOVERY_NATIVE_REPAIR_DENIED");
  assertDecision(decision, state, requestValue.operationId, payload.requestSha256);
  const repair: Repair = { source, payload, plan, decision, used: false, current() {
    source.current();
    if (decision.expiresAtMs <= Date.now()) fail("RECOVERY_NATIVE_EXPIRED");
  } };
  const grant = Object.freeze({ kind: "pkm.original-recovery-repair-grant/v1" as const });
  repairs.set(grant, repair); return grant;
}
export function beginOriginalRecoveryRepairAttempt(port: OriginalRecoveryPhase1Port, grant: OriginalRecoveryRepairGrant,
  observed: unknown): OriginalRecoveryRepairAttempt {
  const state = stateFor(port), repair = repairs.get(grant);
  if (!repair || repair.source.state !== state || repair.used) fail("RECOVERY_GENUINE_REPAIR_GRANT_REQUIRED");
  repair.current(); assertOriginalRecoveryPhase1Observation(repair.plan, observed);
  repair.used = true;
  const attempt = Object.freeze({ kind: "pkm.original-recovery-repair-attempt/v1" as const });
  attempts.set(attempt, repair); return attempt;
}
export function assertOriginalRecoveryRepairAttempt(attempt: OriginalRecoveryRepairAttempt, observed: unknown,
  repairPlanSha256: string) {
  const repair = attempts.get(attempt);
  if (!repair || repair.plan.repairPlanSha256 !== repairPlanSha256) fail("RECOVERY_GENUINE_REPAIR_GRANT_REQUIRED");
  repair.current(); assertOriginalRecoveryPhase1Observation(repair.plan, observed);
}
export function assertOriginalRecoveryRepairSuccessor(attempt: OriginalRecoveryRepairAttempt, observed: unknown,
  repairPlanSha256: string) {
  const repair = attempts.get(attempt);
  if (!repair || repair.plan.repairPlanSha256 !== repairPlanSha256) fail("RECOVERY_GENUINE_REPAIR_GRANT_REQUIRED");
  if (!repair.stage) fail("RECOVERY_OWNER_REPAIR_STAGE_REQUIRED");
  repair.current(); return assertOriginalRecoveryPhase1Successor(repair.plan, observed, repair.stage);
}
export function bindOriginalRecoveryRepairStage(attempt: OriginalRecoveryRepairAttempt, observed: unknown) {
  const repair = attempts.get(attempt);
  if (!repair || repair.stage) fail("RECOVERY_GENUINE_REPAIR_GRANT_REQUIRED");
  repair.current(); repair.stage = structuredClone(assertOriginalRecoveryPhase1Stage(repair.plan, observed));
}
export function createOriginalRecoveryWorkerCapsule(port: OriginalRecoveryPhase1Port, grant: OriginalRecoveryRepairGrant,
  proof: OriginalRecoveryCustodyProof): OriginalRecoveryWorkerCapsule {
  const state = stateFor(port), repair = repairs.get(grant);
  if (!repair || repair.source.state !== state || repair.used) fail("RECOVERY_GENUINE_REPAIR_GRANT_REQUIRED");
  repair.current();
  const custody = readOriginalRecoveryCustodyProof(state.storage, proof);
  const lease = state.storage.workspaceLease();
  if (lease.ownerId !== repair.plan.observation.ownerId || lease.fence !== repair.plan.observation.fence)
    fail("RECOVERY_SIGNED_BINDING_MISMATCH");
  repair.used = true;
  const control = new SharedArrayBuffer(8), revoke = () => Atomics.store(new Int32Array(control), 0, 1);
  const current = () => { repair.current(); custody.current(); };
  const check = () => { try { current(); } catch { revoke(); } };
  repair.source.signal.addEventListener("abort", revoke, { once: true });
  const timer = setInterval(check, 25); timer.unref();
  const release = () => { revoke(); clearInterval(timer); repair.source.signal.removeEventListener("abort", revoke); };
  state.storage.retainNativeCleanup({ release });
  const data: OriginalRecoveryWorkerAdmission = {
    plan: structuredClone(repair.plan), custodyRow: custody.row, control, actor: { id: "mcp:external", canWrite: true },
    provenance: {
      session: originalMcpNativeRequestSession(state.session),
      sourcePayload: structuredClone(repair.source.payload), sourceResult: structuredClone(repair.source.result),
      repairPayload: structuredClone(repair.payload), repairDecision: structuredClone(repair.decision),
    },
  };
  const capsule = Object.freeze({ kind: "pkm.original-recovery-worker-capsule/v1" as const });
  workerCapsules.set(capsule, { storage: state.storage, data, current, sent: false, release }); return capsule;
}
export function readOriginalRecoveryWorkerCapsule(storage: Storage, capsule: OriginalRecoveryWorkerCapsule) {
  const entry = workerCapsules.get(capsule);
  if (!entry || entry.storage !== storage || entry.sent) fail("RECOVERY_GENUINE_REPAIR_GRANT_REQUIRED");
  entry.current(); entry.sent = true; return entry.data;
}
export function releaseOriginalRecoveryWorkerCapsule(storage: Storage, capsule: OriginalRecoveryWorkerCapsule) {
  const entry = workerCapsules.get(capsule);
  if (!entry || entry.storage !== storage) fail("RECOVERY_GENUINE_REPAIR_GRANT_REQUIRED");
  entry.release();
}
