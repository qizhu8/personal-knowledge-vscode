import { AsyncLocalStorage } from "node:async_hooks";
import { CoreError } from "./contracts.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestActive, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestSession, requestOriginalMcpNative } from "./original-mcp-native-request.js";
import {
  parsePrivateResourcePublicationPayload, privateResourcePublicationDigest as digest, privateResourcePublicationMethod,
  privateResourcePublicationResultSchema, validatePrivateResourcePublicationSubject,
  type PrivateResourcePublicationSubject, type PrivateResourcePublicationProvenance,
} from "./private-resource-publication-contracts.js";

export interface NativePrivateResourcePublicationPort { readonly kind: "pkm.native-private-resource-publication-port/v1" }
export interface PrivateResourcePublicationRecovery { readonly kind: "pkm.private-resource-publication-recovery/v1" }
export interface PrivateResourcePublicationAttempt { readonly kind: "pkm.private-resource-publication-attempt/v1" }
export interface PrivatePublicationMutation {
  operation: string; actorId: string; args: Record<string, unknown>;
}
type OriginalRequest = { tool: string; arguments: Record<string, unknown> };
interface PortState {
  storage: Storage; host: OriginalMcpNativeHost; session: AuthenticatedOriginalMcpNativeSession; lifetime: AbortController;
  current(): void;
}
interface Grant {
  provenance: PrivateResourcePublicationProvenance; port: PortState; revoked: boolean; used: boolean; signal: AbortSignal;
  current(): void;
}
interface OperationScope {
  operationId: string; actorId: string; operation: string; canonicalArgumentsDigest: string;
  grants: Map<string, Grant>; subjects: Map<string, PrivateResourcePublicationSubject>;
}
interface Scope { port: PortState; operations: Map<string, OperationScope>; signal: AbortSignal; deadlineMs: number }
const ports = new WeakMap<object, PortState>(), recoveries = new WeakMap<object, Scope>();
const selectedPorts = new WeakMap<Storage, { host: OriginalMcpNativeHost; port: NativePrivateResourcePublicationPort }>();
const attempts = new WeakMap<object, { grant: Grant; current(): void }>();
const contexts = new AsyncLocalStorage<{ port: PortState; signal: AbortSignal }>(), effects = new AsyncLocalStorage<Scope>();
function fail(code: string, message = code): never { throw new CoreError(code, message); }
function portState(value: NativePrivateResourcePublicationPort): PortState {
  const state = ports.get(value);
  if (!state) fail("NATIVE_AUTHORITY_REQUIRED", "A genuine current native private-resource producer is required.");
  state.current(); return state;
}
export function getNativePrivateResourcePublicationPort(storage: Storage,
  host: OriginalMcpNativeHost): NativePrivateResourcePublicationPort | undefined {
  const selected = selectedPorts.get(storage);
  if (!selected) return undefined;
  if (selected.host !== host) fail("NATIVE_AUTHORITY_REQUIRED", "The private publication port belongs to a different native host.");
  portState(selected.port);
  return selected.port;
}

/** Actual same Storage/root/signed session only; no approval callback, Model policy or JSON decision factory. */
export function createNativePrivateResourcePublicationPort(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession): NativePrivateResourcePublicationPort {
  const selected = selectedPorts.get(storage);
  if (selected?.host === host) {
    const state = portState(selected.port);
    if (state.session !== session) fail("NATIVE_AUTHORITY_REQUIRED");
    return selected.port;
  }
  const lifetime = new AbortController();
  const state: PortState = { storage, host, session, lifetime, current() {
    assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
    const root = storage.workspaceRoot(), journal = assertOriginalMcpPrivacy(root), binding = session.binding;
    if (lifetime.signal.aborted || host.signal.aborted || session.signal.aborted || !journal
      || binding.root !== root || binding.workspaceId !== journal.workspaceId || binding.planSha256 !== journal.plan.planSha256
      || binding.profileSha256 !== journal.plan.profileSha256 || binding.root !== host.receipt.root
      || binding.workspaceId !== host.receipt.workspaceId || binding.catalogSha256 !== host.receipt.sourceCatalogSha256
      || session.activationId !== host.receipt.epoch || host.receipt.authorityId !== `native-rpc:${session.brokerId}`
      || !host.receipt.domains.includes("mcp-public"))
      fail("NATIVE_AUTHORITY_REQUIRED", "Private resource publication requires the exact live signed owner/profile/epoch.");
  } };
  state.current();
  const dispose = () => lifetime.abort();
  host.signal.addEventListener("abort", dispose, { once: true }); session.signal.addEventListener("abort", dispose, { once: true });
  storage.retainNativeCleanup({ release: async () => {
    dispose(); host.signal.removeEventListener("abort", dispose); session.signal.removeEventListener("abort", dispose);
    if (selectedPorts.get(storage)?.port === port) selectedPorts.delete(storage);
  } });
  const port = Object.freeze({ kind: "pkm.native-private-resource-publication-port/v1" as const });
  ports.set(port, state); selectedPorts.set(storage, { host, port }); return port;
}
export async function withNativePrivateResourcePublicationContext<T>(port: NativePrivateResourcePublicationPort,
  work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const state = portState(port), combined = AbortSignal.any([state.lifetime.signal, state.host.signal, state.session.signal,
    ...(signal ? [signal] : [])]);
  if (combined.aborted) fail("NATIVE_REQUEST_CANCELLED");
  return contexts.run({ port: state, signal: combined }, work);
}
async function approve(state: PortState, subjectValue: PrivateResourcePublicationSubject, phase: "publish" | "recover",
  signal: AbortSignal): Promise<Grant> {
  state.current(); const subject = validatePrivateResourcePublicationSubject(subjectValue);
  const { receiptSha256: _receipt, ...binding } = state.host.receipt;
  const request = { schema: "pkm.private-resource-publication/v1" as const, phase, subject,
    nativeHostReceiptSha256: state.host.receipt.receiptSha256, nativeEpoch: state.host.receipt.epoch };
  const payload = parsePrivateResourcePublicationPayload({ binding, defaultDecision: "deny", request, requestSha256: digest(request) },
    originalMcpNativeRequestSession(state.session));
  const method = originalMcpNativeRequestMethods.find(value => String(value) === privateResourcePublicationMethod);
  if (!method) fail("MISSING_NATIVE_METHOD", "Separate native resource publication review is unavailable; default denial remains active.");
  const decision = privateResourcePublicationResultSchema.parse(await requestOriginalMcpNative(state.session, method, payload,
    { signal, timeoutMs: 120000 }));
  state.current();
  if (!decision) fail("PRIVATE_RESOURCE_PUBLICATION_DENIED", "Native review denied publication; private sources remain unchanged.");
  if (signal.aborted) fail("NATIVE_REQUEST_CANCELLED");
  if (decision.requestSha256 !== payload.requestSha256 || decision.operationId !== subject.operationId
    || decision.epoch !== state.host.receipt.epoch || decision.actorId !== subject.actorId)
    fail("PRIVATE_RESOURCE_PUBLICATION_DECISION_MISMATCH");
  if (decision.expiresAtMs <= Date.now() || decision.expiresAtMs > Date.now() + 120000)
    fail("PRIVATE_RESOURCE_PUBLICATION_EXPIRED");
  const grant: Grant = { port: state, signal, revoked: false, used: false,
    provenance: Object.freeze({ subject: structuredClone(subject), decision: Object.freeze(decision),
      nativeHostReceiptSha256: request.nativeHostReceiptSha256, phase }), current() {
    state.current();
    if (signal.aborted || grant.revoked || decision.expiresAtMs <= Date.now()) fail("PRIVATE_RESOURCE_PUBLICATION_EXPIRED");
  } };
  return grant;
}
function scopeOperation(root: string, operationId: string, actorId: string): { scope: Scope; operation: OperationScope } {
  const scope = effects.getStore(), operation = scope?.operations.get(operationId);
  if (!scope || !operation || scope.port.storage.workspaceRoot() !== root || operation.actorId !== actorId
    || scope.signal.aborted || scope.deadlineMs <= Date.now())
    fail("NATIVE_AUTHORITY_REQUIRED", "This operation has no current native per-resource publication scope.");
  scope.port.current(); return { scope, operation };
}
export function privatePublicationOperationActive(root: string, operationId: string, actorId: string): boolean {
  const scope = effects.getStore(), operation = scope?.operations.get(operationId);
  if (!scope || !operation || scope.port.storage.workspaceRoot() !== root || operation.actorId !== actorId
    || scope.signal.aborted || scope.deadlineMs <= Date.now()) return false;
  scope.port.current(); return true;
}
export function assertPrivatePublicationCanonicalRequest(root: string, request: PrivatePublicationMutation) {
  const scope = effects.getStore(), operation = scope?.operations.get(String(request.args.operationId));
  if (operation && (scope!.port.storage.workspaceRoot() !== root || operation.actorId !== request.actorId
    || operation.operation !== request.operation || operation.canonicalArgumentsDigest !== digest(request.args)))
    fail("PRIVATE_RESOURCE_PUBLICATION_SUBJECT_MISMATCH");
}
export function privatePublicationProvenanceForPlan(root: string, operationId: string, actorId: string,
  owner: PrivateResourcePublicationSubject["owner"], resource: PrivateResourcePublicationSubject["resource"]): PrivateResourcePublicationProvenance {
  const { operation } = scopeOperation(root, operationId, actorId);
  const subject = [...operation.subjects.values()].find(value => digest(value.owner) === digest(owner) && digest(value.resource) === digest(resource));
  const grant = subject && operation.grants.get(digest(subject));
  if (!subject || !grant || grant.used) fail("NATIVE_AUTHORITY_REQUIRED", "The exact private source/target lacks a fresh one-use resource decision.");
  grant.current(); return structuredClone(grant.provenance);
}
export function assertPrivateOperationPublicationScope(root: string, operationId: string, actorId: string,
  incomplete: readonly PrivateResourcePublicationProvenance[]) {
  const { operation } = scopeOperation(root, operationId, actorId);
  for (const provenance of incomplete) {
    const grant = operation.grants.get(digest(provenance.subject));
    if (!grant || grant.used || grant.port.storage.workspaceRoot() !== root) fail("NATIVE_AUTHORITY_REQUIRED");
    grant.current();
  }
}
export function beginPrivateResourcePublication(root: string, operationId: string, actorId: string,
  provenance: PrivateResourcePublicationProvenance): PrivateResourcePublicationAttempt {
  const { scope, operation } = scopeOperation(root, operationId, actorId), grant = operation.grants.get(digest(provenance.subject));
  if (!grant || grant.used) fail("NATIVE_AUTHORITY_REQUIRED", "A private resource decision cannot be replayed or reused.");
  grant.current(); grant.used = true;
  const attempt = Object.freeze({ kind: "pkm.private-resource-publication-attempt/v1" as const });
  attempts.set(attempt, { grant, current() {
    grant.current(); scope.port.current();
    if (scope.signal.aborted || scope.deadlineMs <= Date.now()) fail("NATIVE_REQUEST_CANCELLED");
  } });
  return attempt;
}
export function assertPrivateResourcePublicationAttempt(value: PrivateResourcePublicationAttempt, subject?: PrivateResourcePublicationSubject) {
  const attempt = attempts.get(value);
  if (!attempt) fail("NATIVE_AUTHORITY_REQUIRED", "Publication attempts are not caller-supplied grants.");
  attempt.current();
  if (subject && digest(subject) !== digest(attempt.grant.provenance.subject)) fail("PRIVATE_RESOURCE_PUBLICATION_SUBJECT_MISMATCH");
}

/** Owned adapter hook: every approval and final source CAS precedes Core dispatch/intent persistence. */
export async function withApprovedPrivateResourcesForMutation<T>(storage: Storage, original: OriginalRequest,
  canonical: PrivatePublicationMutation, work: () => Promise<T>): Promise<T> {
  const planning = await import("./private-resource-publication-planning.js");
  const requirement = await planning.privatePublicationRequirements(storage, original, canonical, false);
  if (!requirement.length) return work();
  const context = contexts.getStore();
  if (!context || context.port.storage !== storage || !originalMcpPublicRequestActive(storage, original.tool, original.arguments))
    fail("NATIVE_AUTHORITY_REQUIRED", "Private bytes remain denied until separate current native resource review.");
  const subjects = await planning.privatePublicationRequirements(storage, original, canonical, true, context.port.host);
  if (!subjects.length) fail("CONFLICT", "Private resource requirements changed before native review.");
  const operation: OperationScope = { operationId: String(canonical.args.operationId), actorId: canonical.actorId,
    operation: canonical.operation, canonicalArgumentsDigest: subjects[0]!.canonicalArgumentsDigest,
    grants: new Map(), subjects: new Map(subjects.map(value => [digest(value), value])) };
  try {
    for (const subject of subjects) operation.grants.set(digest(subject), await approve(context.port, subject, "publish", context.signal));
    for (const grant of operation.grants.values()) grant.current();
    await planning.assertPrivatePublicationSourcePins(storage, subjects);
    return await effects.run({ port: context.port, signal: context.signal, operations: new Map([[operation.operationId, operation]]),
      deadlineMs: Math.min(...[...operation.grants.values()].map(grant => grant.provenance.decision.expiresAtMs)) }, work);
  } finally { for (const grant of operation.grants.values()) grant.revoked = true; }
}

/** Parent prepareNative calls this before any pending private publication can be replayed. */
export async function approvePendingPrivateResourcePublications(port: NativePrivateResourcePublicationPort,
  signal?: AbortSignal): Promise<PrivateResourcePublicationRecovery | undefined> {
  const state = portState(port), planning = await import("./private-resource-publication-planning.js");
  const pending = await planning.readPendingPrivatePublicationRequirements(state.storage);
  if (!pending.length) return undefined;
  const combined = AbortSignal.any([state.lifetime.signal, state.host.signal, state.session.signal, ...(signal ? [signal] : [])]);
  const scope: Scope = { port: state, signal: combined, operations: new Map(), deadlineMs: Date.now() + 120000 };
  const recovery = Object.freeze({ kind: "pkm.private-resource-publication-recovery/v1" as const });
  try {
    for (const item of pending) {
      const operation: OperationScope = { operationId: item.operationId, actorId: item.actorId,
        operation: item.request.operation, canonicalArgumentsDigest: item.canonicalArgumentsDigest,
        subjects: new Map(item.subjects.map(value => [digest(value), value])), grants: new Map() };
      scope.operations.set(item.operationId, operation);
      for (const subject of item.incomplete) operation.grants.set(digest(subject), await approve(state, subject, "recover", combined));
    }
    for (const operation of scope.operations.values()) for (const grant of operation.grants.values()) grant.current();
    const grants = [...scope.operations.values()].flatMap(operation => [...operation.grants.values()]);
    scope.deadlineMs = grants.length ? Math.min(...grants.map(grant => grant.provenance.decision.expiresAtMs)) : Date.now() + 120000;
    recoveries.set(recovery, scope);
    await planning.refreshPrivatePublicationRecoveryProvenance(state.storage, pending, recovery);
    return recovery;
  } catch (error) {
    for (const operation of scope.operations.values()) for (const grant of operation.grants.values()) grant.revoked = true;
    recoveries.delete(recovery);
    throw error;
  }
}
export async function withPrivateResourcePublicationRecovery<T>(storage: Storage, recovery: PrivateResourcePublicationRecovery,
  work: () => Promise<T>): Promise<T> {
  const scope = recoveries.get(recovery);
  if (!scope || scope.port.storage !== storage || scope.signal.aborted || scope.deadlineMs <= Date.now())
    fail("NATIVE_AUTHORITY_REQUIRED", "Recovery requires its genuine reviewed resource scope.");
  scope.port.current(); recoveries.delete(recovery);
  try { return await effects.run(scope, work); }
  finally { for (const operation of scope.operations.values()) for (const grant of operation.grants.values()) grant.revoked = true; }
}
export function privatePublicationRecoveryProvenances(storage: Storage, recovery: PrivateResourcePublicationRecovery): PrivateResourcePublicationProvenance[] {
  const scope = recoveries.get(recovery);
  if (!scope || scope.port.storage !== storage || scope.signal.aborted || scope.deadlineMs <= Date.now()) fail("NATIVE_AUTHORITY_REQUIRED");
  scope.port.current();
  return [...scope.operations.values()].flatMap(operation => [...operation.grants.values()].map(grant => {
    grant.current(); return structuredClone(grant.provenance);
  }));
}
