import { AsyncLocalStorage } from "node:async_hooks";
import { CoreError } from "./contracts.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestActive, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestSession, requestOriginalMcpNative } from "./original-mcp-native-request.js";
import {
  originalNativeTrashMethod, originalNativeTrashResultSchema, originalNativeTrashDigest as digest,
  parseOriginalNativeTrashPayload, validateOriginalNativeTrashSubject,
  type OriginalNativeTrashSubject, type OriginalNativeTrashProvenance,
} from "./original-native-trash-contracts.js";
import type { TrashLifecyclePlan } from "./trash-lifecycle.js";
import type { OriginalTrashTransition } from "./original-native-trash-custody.js";

export interface NativeOriginalTrashPort { readonly kind: "pkm.native-original-trash-port/v1" }
export interface OriginalTrashRecovery { readonly kind: "pkm.original-trash-recovery/v1" }
export interface OriginalTrashAttempt { readonly kind: "pkm.original-trash-attempt/v1" }
export interface OriginalTrashCanonicalRequest { operation: string; actorId: string; args: Record<string, unknown> }
export interface OriginalTrashPublicRequest { tool: string; arguments: Record<string, unknown> }
interface State {
  storage: Storage; host: OriginalMcpNativeHost; session: AuthenticatedOriginalMcpNativeSession;
  lifetime: AbortController; current(): void;
}
interface Grant {
  state: State; provenance: OriginalNativeTrashProvenance; signal: AbortSignal;
  used: boolean; revoked: boolean; current(): void;
}
interface Scope {
  grant: Grant; request: OriginalTrashCanonicalRequest; plan?: TrashLifecyclePlan;
  transition?: OriginalTrashTransition;
}
const ports = new WeakMap<object, State>();
const selected = new WeakMap<Storage, { host: OriginalMcpNativeHost; port: NativeOriginalTrashPort }>();
const recoveries = new WeakMap<object, Scope>();
const attempts = new WeakMap<object, Scope>();
const contexts = new AsyncLocalStorage<{ state: State; signal: AbortSignal; publicRequest?: OriginalTrashPublicRequest }>();
const effects = new AsyncLocalStorage<Scope>();
function fail(code: string, message = code): never { throw new CoreError(code, message); }
function stateFor(port: NativeOriginalTrashPort): State {
  const state = ports.get(port);
  if (!state) fail("NATIVE_AUTHORITY_REQUIRED", "Original Trash authority is not a JSON grant or a caller policy.");
  state.current(); return state;
}
export function assertNativeOriginalTrashPort(port: NativeOriginalTrashPort, storage: Storage) {
  if (stateFor(port).storage !== storage) fail("NATIVE_AUTHORITY_REQUIRED");
}
export function assertNativeOriginalTrashPortRoot(port: NativeOriginalTrashPort, root: string, workspaceId: string) {
  const state = stateFor(port);
  if (state.storage.workspaceRoot() !== root || state.host.receipt.workspaceId !== workspaceId) fail("NATIVE_AUTHORITY_REQUIRED");
}
export function getNativeOriginalTrashPort(storage: Storage, host: OriginalMcpNativeHost): NativeOriginalTrashPort | undefined {
  const value = selected.get(storage);
  if (!value) return undefined;
  if (value.host !== host) fail("NATIVE_AUTHORITY_REQUIRED", "The Trash producer belongs to another native host.");
  stateFor(value.port); return value.port;
}
export function createNativeOriginalTrashPort(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession): NativeOriginalTrashPort {
  const prior = selected.get(storage);
  if (prior) {
    if (prior.host !== host || stateFor(prior.port).session !== session) fail("NATIVE_AUTHORITY_REQUIRED");
    return prior.port;
  }
  const lifetime = new AbortController();
  const state: State = { storage, host, session, lifetime, current() {
    assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
    const root = storage.workspaceRoot(), journal = assertOriginalMcpPrivacy(root), binding = session.binding;
    if (!journal || lifetime.signal.aborted || host.signal.aborted || session.signal.aborted
      || binding.root !== root || binding.workspaceId !== journal.workspaceId || binding.planSha256 !== journal.plan.planSha256
      || binding.profileSha256 !== journal.plan.profileSha256 || host.receipt.root !== root
      || host.receipt.workspaceId !== binding.workspaceId || host.receipt.sourceCatalogSha256 !== binding.catalogSha256
      || host.receipt.epoch !== session.activationId || host.receipt.authorityId !== `native-rpc:${session.brokerId}`
      || !host.receipt.domains.includes("mcp-public")) fail("NATIVE_AUTHORITY_REQUIRED", "Original Trash requires its actual live owner/profile/session.");
  } };
  state.current();
  const port = Object.freeze({ kind: "pkm.native-original-trash-port/v1" as const }), abort = () => lifetime.abort();
  host.signal.addEventListener("abort", abort, { once: true }); session.signal.addEventListener("abort", abort, { once: true });
  storage.retainNativeCleanup({ release: async () => {
    abort(); host.signal.removeEventListener("abort", abort); session.signal.removeEventListener("abort", abort);
    if (selected.get(storage)?.port === port) selected.delete(storage);
  } });
  ports.set(port, state); selected.set(storage, { host, port }); return port;
}
export async function withNativeOriginalTrashContext<T>(port: NativeOriginalTrashPort, work: () => Promise<T>,
  signal?: AbortSignal, publicRequest?: OriginalTrashPublicRequest): Promise<T> {
  const state = stateFor(port), parent = contexts.getStore();
  const combined = AbortSignal.any([state.lifetime.signal, state.host.signal, state.session.signal,
    ...(signal ? [signal] : []), ...(parent?.state === state ? [parent.signal] : [])]);
  if (combined.aborted) fail("NATIVE_REQUEST_CANCELLED");
  return contexts.run({ state, signal: combined, publicRequest: publicRequest ?? (parent?.state === state ? parent.publicRequest : undefined) }, work);
}
async function approve(state: State, value: OriginalNativeTrashSubject, phase: "execute" | "recover", signal: AbortSignal): Promise<Grant> {
  state.current();
  const subject = validateOriginalNativeTrashSubject(value), { receiptSha256: _receipt, ...binding } = state.host.receipt;
  const request = { schema: "area" in subject ? (subject.area === "scripts" || subject.area === "prompts"
    ? "pkm.original-native-trash-request/v3" : "pkm.original-native-trash-request/v2") : "pkm.original-native-trash-request/v1", phase, subject,
    nativeHostReceiptSha256: state.host.receipt.receiptSha256, nativeEpoch: state.host.receipt.epoch };
  const payload = parseOriginalNativeTrashPayload({ binding, defaultDecision: "deny", request, requestSha256: digest(request) },
    originalMcpNativeRequestSession(state.session));
  const method = originalMcpNativeRequestMethods.find(value => String(value) === originalNativeTrashMethod);
  if (!method) fail("MISSING_NATIVE_METHOD", "Original Trash remains closed until its actual native per-target review exists.");
  let response: unknown;
  try { response = await requestOriginalMcpNative(state.session, method, payload, { signal, timeoutMs: 120000 }); }
  catch (error) {
    if (error instanceof Error && "code" in error
      && (error.code === "NATIVE_REQUEST_CANCELLED" || error.code === "MISSING_NATIVE_METHOD"))
      throw new CoreError(error.code, error.code === "NATIVE_REQUEST_CANCELLED"
        ? "The current native Trash review was cancelled; no new effect was approved."
        : "The current native producer does not support exact Trash review; no new effect was approved.",
      phase === "recover" ? "unknown" : "not-committed");
    throw error;
  }
  const decision = originalNativeTrashResultSchema.parse(response);
  state.current();
  if (!decision) fail("ORIGINAL_TRASH_DENIED", "Native Trash review denied the exact operation; no intent or effect is authorized.");
  if (signal.aborted) fail("NATIVE_REQUEST_CANCELLED");
  if (decision.actorId !== subject.actorId || decision.operationId !== subject.operationId
    || decision.requestSha256 !== payload.requestSha256 || decision.epoch !== state.host.receipt.epoch)
    fail("ORIGINAL_TRASH_DECISION_MISMATCH");
  if (decision.expiresAtMs <= Date.now() || decision.expiresAtMs > Date.now() + 120000) fail("ORIGINAL_TRASH_EXPIRED");
  const grant: Grant = { state, signal, used: false, revoked: false,
    provenance: structuredClone({ request: payload.request, decision }), current() {
      state.current();
      if (signal.aborted) throw new CoreError("NATIVE_REQUEST_CANCELLED", "The current native Trash operation was cancelled.",
        grant.used ? "unknown" : "not-committed");
      if (grant.revoked || decision.expiresAtMs <= Date.now())
        throw new CoreError("ORIGINAL_TRASH_EXPIRED", "Original Trash authority expired or was revoked.",
          grant.used ? "unknown" : "not-committed");
    } };
  return grant;
}
function scopeFor(root: string, request: OriginalTrashCanonicalRequest): Scope {
  const scope = effects.getStore();
  if (!scope || scope.grant.state.storage.workspaceRoot() !== root || digest(scope.request) !== digest(request)) {
    console.error("PKM original Trash approval scope mismatch:", {
      present: !!scope, sameRoot: scope ? scope.grant.state.storage.workspaceRoot() === root : false,
      requested: { operation: request.operation, actorId: request.actorId, argumentsDigest: digest(request.args) },
      approved: scope ? { operation: scope.request.operation, actorId: scope.request.actorId, argumentsDigest: digest(scope.request.args) } : null,
    });
    fail("NATIVE_AUTHORITY_REQUIRED", "Trash requires its exact approved operation, actor and canonical arguments.");
  }
  scope.grant.current(); return scope;
}
export function approvedOriginalTrashPlan(root: string, request: OriginalTrashCanonicalRequest): TrashLifecyclePlan {
  const scope = scopeFor(root, request);
  if (!scope.plan || scope.grant.used) fail("NATIVE_AUTHORITY_REQUIRED");
  return structuredClone(scope.plan);
}
export function beginOriginalTrashAttempt(root: string, request: OriginalTrashCanonicalRequest): OriginalTrashAttempt {
  const scope = scopeFor(root, request);
  if (scope.grant.used) fail("NATIVE_AUTHORITY_REQUIRED", "A Trash decision is one use, not historical authority.");
  scope.grant.used = true;
  const attempt = Object.freeze({ kind: "pkm.original-trash-attempt/v1" as const });
  attempts.set(attempt, scope); return attempt;
}
export function beginOriginalTrashAttemptForPlan(root: string, plan: TrashLifecyclePlan): OriginalTrashAttempt {
  const scope = effects.getStore();
  if (!scope?.plan || digest(scope.plan) !== digest(plan)) fail("NATIVE_AUTHORITY_REQUIRED", "The worker must use its exact reviewed Trash plan.");
  return beginOriginalTrashAttempt(root, scope.request);
}
export function assertOriginalTrashAttempt(attempt: OriginalTrashAttempt, transition: OriginalTrashTransition) {
  const scope = attempts.get(attempt);
  if (!scope || !scope.transition || digest(scope.transition) !== digest(transition)) fail("NATIVE_AUTHORITY_REQUIRED");
  scope.grant.current();
}
export function assertOriginalTrashCommit(root: string, transition: OriginalTrashTransition) {
  const scope = effects.getStore();
  if (!scope?.grant.used || scope.grant.state.storage.workspaceRoot() !== root
    || digest(scope.transition) !== digest(transition)) fail("NATIVE_AUTHORITY_REQUIRED");
  scope.grant.current();
}
export function assertOriginalTrashRecovery(storage: Storage, recovery: OriginalTrashRecovery, plan: TrashLifecyclePlan) {
  const scope = recoveries.get(recovery);
  if (!scope || scope.grant.state.storage !== storage || digest(scope.plan) !== digest(plan)) fail("NATIVE_AUTHORITY_REQUIRED");
  scope.grant.current();
}
export async function withApprovedOriginalTrashOperation<T>(storage: Storage, request: OriginalTrashCanonicalRequest,
  work: () => Promise<T>): Promise<T> {
  const context = contexts.getStore();
  if (!context || context.state.storage !== storage) fail("NATIVE_AUTHORITY_REQUIRED", "Trash is not authorized by ordinary public or folder approval.");
  context.state.current();
  if (context.publicRequest && !originalMcpPublicRequestActive(storage, context.publicRequest.tool, context.publicRequest.arguments))
    fail("NATIVE_AUTHORITY_REQUIRED");
  const planning = await import("./original-native-trash-planning.js");
  if (await planning.hasOriginalTrashReplay(storage, request)) return work();
  const prepared = await planning.prepareOriginalTrashOperation(storage, context.state.host, request, context.publicRequest);
  const grant = await approve(context.state, prepared.subject, "execute", context.signal);
  const transition = prepared.transition ? { ...prepared.transition, provenance: grant.provenance } : undefined;
  const plan = prepared.plan && transition ? { ...prepared.plan, originalTrash: transition } : undefined;
  const scope: Scope = { grant, request: structuredClone(request), transition, plan };
  try {
    await planning.assertOriginalTrashPreparation(storage, prepared);
    return await effects.run(scope, work);
  } finally { grant.revoked = true; }
}
export function originalTrashListResult(root: string, request: OriginalTrashCanonicalRequest) {
  const scope = scopeFor(root, request);
  if (scope.grant.provenance.request.subject.action !== "list" || scope.grant.used) fail("NATIVE_AUTHORITY_REQUIRED");
  scope.grant.used = true;
  return { items: scope.grant.provenance.request.subject.selection
    .map(item => ({ area: item.area, ...item.metadata, runtimeEntryId: item.entryId }))
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt)) };
}
export async function approvePendingOriginalTrash(port: NativeOriginalTrashPort, signal?: AbortSignal): Promise<OriginalTrashRecovery | undefined> {
  const state = stateFor(port), planning = await import("./original-native-trash-planning.js");
  const pending = await planning.readPendingOriginalTrash(state.storage);
  if (!pending) return undefined;
  const combined = AbortSignal.any([state.lifetime.signal, state.host.signal, state.session.signal, ...(signal ? [signal] : [])]);
  const grant = await approve(state, pending.transition.provenance.request.subject, "recover", combined);
  const transition = { ...pending.transition, provenance: grant.provenance };
  const scope: Scope = { grant, request: pending.request, transition, plan: { ...pending.plan, originalTrash: transition } };
  const recovery = Object.freeze({ kind: "pkm.original-trash-recovery/v1" as const });
  recoveries.set(recovery, scope);
  try {
    await planning.refreshOriginalTrashRecovery(state.storage, pending, scope.plan!, recovery);
    return recovery;
  } catch (error) { recoveries.delete(recovery); grant.revoked = true; throw error; }
}
export async function withOriginalTrashRecovery<T>(storage: Storage, recovery: OriginalTrashRecovery, work: () => Promise<T>): Promise<T> {
  const scope = recoveries.get(recovery);
  if (!scope || scope.grant.state.storage !== storage) fail("NATIVE_AUTHORITY_REQUIRED");
  scope.grant.current(); recoveries.delete(recovery);
  try { return await effects.run(scope, work); } finally { scope.grant.revoked = true; }
}
