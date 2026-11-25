import { AsyncLocalStorage } from "node:async_hooks";
import { CoreError } from "./contracts.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import { assertOriginalMcpNativeHost, originalMcpPublicRequestActive, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestSession, requestOriginalMcpNative } from "./original-mcp-native-request.js";
import {
  originalMcpTodoGenesisMethod, originalMcpTodoGenesisResultSchema, originalMcpTodoGenesisRequestDigest as digest,
  parseOriginalMcpTodoGenesisPayload, validateOriginalMcpTodoGenesisPlan,
  originalMcpTodoGenesisArgumentsSchema,
  type OriginalMcpTodoGenesisPlan, type OriginalMcpTodoGenesisProvenance,
} from "./original-mcp-todo-genesis-contracts.js";
import { readOriginalMcpTodoGenesisSources, assertOriginalMcpTodoGenesisSourceActivationCurrent } from "./original-mcp-todo-genesis.js";
import type { OriginalMcpTodoGenesisSourceControl } from "./original-mcp-todo-genesis-source.js";

export interface OriginalMcpTodoGenesisPort { readonly kind: "pkm.original-mcp-todo-genesis-port/v1" }
export interface OriginalMcpTodoGenesisAttempt { readonly kind: "pkm.original-mcp-todo-genesis-attempt/v1" }
export interface OriginalMcpTodoGenesisSourceScope { readonly kind: "pkm.original-mcp-todo-genesis-source-scope/v1" }
export interface OriginalMcpTodoGenesisRecoveryScope { readonly kind: "pkm.original-mcp-todo-genesis-recovery-scope/v1" }
interface State {
  storage: Storage; host: OriginalMcpNativeHost; session: AuthenticatedOriginalMcpNativeSession;
  lifetime: AbortController; current(): void;
}
interface Scope {
  state: State; plan: OriginalMcpTodoGenesisPlan; provenance: OriginalMcpTodoGenesisProvenance;
  signal: AbortSignal; used: boolean; revoked: boolean; current(): void;
  revocation: SharedArrayBuffer;
}
const ports = new WeakMap<object, State>();
const selected = new WeakMap<Storage, { host: OriginalMcpNativeHost; port: OriginalMcpTodoGenesisPort }>();
const attempts = new WeakMap<object, Scope>();
interface SourceGrant {
  state: State; plan: OriginalMcpTodoGenesisPlan; control: OriginalMcpTodoGenesisSourceControl;
  scope: OriginalMcpTodoGenesisSourceScope; current(): void;
}
const sourceGrants = new WeakMap<Storage, Map<string, SourceGrant>>();
const sourceCapsules = new WeakMap<object, SourceGrant>();
const contexts = new AsyncLocalStorage<{ state: State; publicArguments: Readonly<Record<string, unknown>>; signal: AbortSignal }>();
const approvals = new AsyncLocalStorage<Scope>();
const recoveryScopes = new WeakMap<object, { scope: Scope; release(): void; consumed: boolean }>();
function fail(code: string, message = code): never { throw new CoreError(code, message); }
function stateFor(port: OriginalMcpTodoGenesisPort): State {
  const state = ports.get(port);
  if (!state) fail("NATIVE_AUTHORITY_REQUIRED", "Todo genesis requires a genuine signed producer, not a JSON approval.");
  state.current(); return state;
}
export function createOriginalMcpTodoGenesisPort(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession): OriginalMcpTodoGenesisPort {
  const prior = selected.get(storage);
  if (prior) {
    if (prior.host !== host || stateFor(prior.port).session !== session) fail("NATIVE_AUTHORITY_REQUIRED");
    return prior.port;
  }
  const lifetime = new AbortController();
  const state: State = { storage, host, session, lifetime, current() {
    assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
    const root = storage.workspaceRoot(), custody = assertOriginalMcpPrivacy(root), binding = session.binding;
    if (!custody || lifetime.signal.aborted || host.signal.aborted || session.signal.aborted
      || binding.root !== root || binding.workspaceId !== custody.workspaceId
      || binding.planSha256 !== custody.plan.planSha256 || binding.profileSha256 !== custody.plan.profileSha256
      || host.receipt.root !== root || host.receipt.workspaceId !== binding.workspaceId
      || host.receipt.planSha256 !== binding.planSha256 || host.receipt.profileSha256 !== binding.profileSha256
      || host.receipt.sourceCatalogSha256 !== binding.catalogSha256 || host.receipt.epoch !== session.activationId
      || host.receipt.authorityId !== `native-rpc:${session.brokerId}` || !host.receipt.domains.includes("mcp-public"))
      fail("NATIVE_AUTHORITY_REQUIRED", "Todo genesis requires its exact current signed Root/profile/epoch.");
  } };
  state.current();
  const port = Object.freeze({ kind: "pkm.original-mcp-todo-genesis-port/v1" as const });
  const abort = () => lifetime.abort();
  host.signal.addEventListener("abort", abort, { once: true }); session.signal.addEventListener("abort", abort, { once: true });
  storage.retainNativeCleanup({ release: async () => {
    abort(); host.signal.removeEventListener("abort", abort); session.signal.removeEventListener("abort", abort);
    if (selected.get(storage)?.port === port) selected.delete(storage);
  } });
  ports.set(port, state); selected.set(storage, { host, port }); return port;
}
export function getOriginalMcpTodoGenesisPort(storage: Storage, host: OriginalMcpNativeHost): OriginalMcpTodoGenesisPort | undefined {
  const entry = selected.get(storage);
  if (!entry) return undefined;
  if (entry.host !== host) fail("NATIVE_AUTHORITY_REQUIRED");
  stateFor(entry.port); return entry.port;
}
export function assertOriginalMcpTodoGenesisPort(port: OriginalMcpTodoGenesisPort, storage: Storage, host: OriginalMcpNativeHost) {
  const state = stateFor(port);
  if (state.storage !== storage || state.host !== host) fail("NATIVE_AUTHORITY_REQUIRED");
}
export async function withOriginalMcpTodoGenesisContext<T>(port: OriginalMcpTodoGenesisPort,
  publicArguments: Readonly<Record<string, unknown>>, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const state = stateFor(port);
  if (!originalMcpPublicRequestActive(state.storage, "todo_board_create", publicArguments))
    fail("NATIVE_AUTHORITY_REQUIRED", "Exact PUBLIC approval is independent of Todo genesis consent.");
  const combined = AbortSignal.any([state.lifetime.signal, state.host.signal, state.session.signal, ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  return contexts.run({ state, publicArguments: structuredClone(publicArguments), signal: combined }, work);
}
export async function withApprovedOriginalMcpTodoGenesis<T>(storage: Storage, value: OriginalMcpTodoGenesisPlan,
  work: () => Promise<T>): Promise<T> {
  const context = contexts.getStore(), plan = validateOriginalMcpTodoGenesisPlan(value);
  if (!context || context.state.storage !== storage || plan.request.phase !== "create"
    || !originalMcpPublicRequestActive(storage, "todo_board_create", context.publicArguments)
    || digest(originalMcpTodoGenesisArgumentsSchema.parse(context.publicArguments)) !== digest(plan.request.arguments))
    fail("NATIVE_AUTHORITY_REQUIRED", "Ordinary PUBLIC approval grants no genesis authority.");
  return reviewGenesis(context, plan, work);
}
export async function withOriginalMcpTodoGenesisRecovery<T>(port: OriginalMcpTodoGenesisPort,
  value: OriginalMcpTodoGenesisPlan, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const state = stateFor(port), plan = validateOriginalMcpTodoGenesisPlan(value);
  if (plan.request.phase !== "recover") fail("ACCESS_DENIED", "Use the exact genesis recovery review.");
  return reviewGenesis({ state, signal: AbortSignal.any([state.lifetime.signal, state.host.signal,
    state.session.signal, ...(signal ? [signal] : [])]) }, plan, work);
}
export async function withOriginalMcpTodoGenesisSourceActivation<T>(port: OriginalMcpTodoGenesisPort,
  value: OriginalMcpTodoGenesisPlan, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const state = stateFor(port), plan = validateOriginalMcpTodoGenesisPlan(value);
  if (plan.request.phase !== "activate-source") fail("ACCESS_DENIED", "Use the exact existing genesis-source review.");
  return reviewGenesis({ state, signal: AbortSignal.any([state.lifetime.signal, state.host.signal,
    state.session.signal, ...(signal ? [signal] : [])]) }, plan, work);
}
async function reviewGenesis<T>(context: { state: State; signal: AbortSignal },
  plan: OriginalMcpTodoGenesisPlan, work: () => Promise<T>): Promise<T> {
  const grant = await grantGenesis(context, plan);
  try { return await approvals.run(grant.scope, work); } finally { grant.release(); }
}
async function grantGenesis(context: { state: State; signal: AbortSignal }, plan: OriginalMcpTodoGenesisPlan) {
  context.state.current();
  const { receiptSha256: _receipt, ...binding } = context.state.host.receipt;
  const payload = parseOriginalMcpTodoGenesisPayload({
    binding, defaultDecision: "deny", request: plan.request, requestSha256: digest(plan.request),
  }, originalMcpNativeRequestSession(context.state.session));
  const method = originalMcpNativeRequestMethods.find(candidate => String(candidate) === originalMcpTodoGenesisMethod);
  if (!method) fail("MISSING_NATIVE_METHOD", "Exact native Todo genesis review is not registered; nothing was published.");
  const response = await requestOriginalMcpNative(context.state.session, method, payload,
    { signal: context.signal, timeoutMs: 120000 });
  context.signal.throwIfAborted();
  const decision = originalMcpTodoGenesisResultSchema.parse(response);
  context.state.current();
  if (!decision) fail("TODO_GENESIS_DENIED", "Exact native Todo genesis/source review was denied.");
  if (decision.actorId !== plan.request.actorId || decision.operationId !== plan.request.operationId
    || decision.epoch !== plan.request.nativeEpoch || decision.requestSha256 !== payload.requestSha256)
    fail("TODO_GENESIS_DECISION_MISMATCH");
  if (decision.expiresAtMs <= Date.now() || decision.expiresAtMs > Date.now() + 120000) fail("TODO_GENESIS_EXPIRED");
  const scope: Scope = {
    state: context.state, plan: structuredClone(plan), provenance: structuredClone({ request: plan.request, decision }),
    signal: context.signal, used: false, revoked: false, current() {
      context.state.current();
      if (context.signal.aborted || scope.revoked || decision.expiresAtMs <= Date.now())
        throw new CoreError("NATIVE_AUTHORITY_REQUIRED", "Todo genesis review expired or was revoked.",
          scope.used || plan.request.phase === "recover" ? "unknown" : "not-committed");
    },
    revocation: new SharedArrayBuffer(4),
  };
  const revoke = () => Atomics.store(new Int32Array(scope.revocation), 0, 1);
  context.signal.addEventListener("abort", revoke, { once: true });
  const timer = setTimeout(revoke, Math.max(0, decision.expiresAtMs - Date.now()));
  return { scope, release() {
    scope.revoked = true; revoke(); clearTimeout(timer); context.signal.removeEventListener("abort", revoke);
  } };
}
export async function approvePendingOriginalMcpTodoGenesis(port: OriginalMcpTodoGenesisPort,
  signal?: AbortSignal): Promise<OriginalMcpTodoGenesisRecoveryScope | undefined> {
  const state = stateFor(port);
  const { preparePendingOriginalMcpTodoGenesis } = await import("./original-mcp-todo-genesis.js");
  const plan = await preparePendingOriginalMcpTodoGenesis(state.storage, state.host);
  if (!plan) return undefined;
  const grant = await grantGenesis({ state, signal: AbortSignal.any([state.lifetime.signal, state.host.signal,
    state.session.signal, ...(signal ? [signal] : [])]) }, plan);
  const recovery = Object.freeze({ kind: "pkm.original-mcp-todo-genesis-recovery-scope/v1" as const });
  recoveryScopes.set(recovery, { ...grant, consumed: false });
  state.storage.retainNativeCleanup({ release: async () => grant.release() });
  return recovery;
}
export async function recoverOriginalMcpTodoGenesisWithScope(storage: Storage, recovery: OriginalMcpTodoGenesisRecoveryScope) {
  const grant = recoveryScopes.get(recovery);
  if (!grant || grant.scope.state.storage !== storage || grant.consumed)
    fail("NATIVE_AUTHORITY_REQUIRED", "Recovery needs the actual one-use current native review, not a copied receipt.");
  grant.scope.current(); grant.consumed = true;
  try {
    return await approvals.run(grant.scope, async () => {
      const result = await storage.recoverOriginalMcpTodoGenesis(grant.scope.plan);
      await activateOriginalMcpTodoGenesisSource(storage, grant.scope.plan);
      return result;
    });
  } finally { grant.release(); }
}
export function beginOriginalMcpTodoGenesisAttempt(storage: Storage, plan: OriginalMcpTodoGenesisPlan): OriginalMcpTodoGenesisAttempt {
  const scope = approvals.getStore();
  if (!scope || scope.state.storage !== storage || scope.used || digest(scope.plan) !== digest(plan))
    fail("NATIVE_AUTHORITY_REQUIRED", "A Todo genesis decision is exact and one-use.");
  scope.current(); scope.used = true;
  const attempt = Object.freeze({ kind: "pkm.original-mcp-todo-genesis-attempt/v1" as const });
  attempts.set(attempt, scope); return attempt;
}
export function originalMcpTodoGenesisAttemptProvenance(attempt: OriginalMcpTodoGenesisAttempt,
  storage: Storage, plan: OriginalMcpTodoGenesisPlan): OriginalMcpTodoGenesisProvenance {
  const scope = attempts.get(attempt);
  if (!scope || scope.state.storage !== storage || digest(scope.plan) !== digest(plan))
    fail("NATIVE_AUTHORITY_REQUIRED", "A copied Todo genesis receipt cannot authorize publication.");
  scope.current(); return structuredClone(scope.provenance);
}
export function originalMcpTodoGenesisStorageAdmission(storage: Storage, request: {
  operation: string; actorId: string; args: Record<string, unknown>; boardWorker?: unknown;
}): import("./original-mcp-todo-genesis.js").OriginalMcpTodoGenesisAdmission | undefined {
  if (request.operation !== "todo.board.create") return undefined;
  const scope = approvals.getStore();
  if (!scope) return undefined;
  if (scope.state.storage !== storage || request.actorId !== "mcp:external" || request.boardWorker
    || request.args.board_slug !== scope.plan.request.selection.boardSlug
    || request.args.operationId !== scope.plan.request.operationId || Object.keys(request.args).length !== 2)
    fail("ACCESS_DENIED", "Todo genesis canonical request differs from its approved original request.");
  const attempt = beginOriginalMcpTodoGenesisAttempt(storage, scope.plan);
  return { plan: structuredClone(scope.plan),
    provenance: originalMcpTodoGenesisAttemptProvenance(attempt, storage, scope.plan), revocation: scope.revocation };
}
export async function activateOriginalMcpTodoGenesisSource(storage: Storage, plan: OriginalMcpTodoGenesisPlan) {
  const scope = approvals.getStore();
  if (!scope || scope.state.storage !== storage || digest(scope.plan) !== digest(plan))
    fail("NATIVE_AUTHORITY_REQUIRED", "New Todo source activation requires the actual consumed genesis review.");
  if (!scope.used && plan.request.phase === "activate-source") beginOriginalMcpTodoGenesisAttempt(storage, plan);
  if (!scope.used) fail("NATIVE_AUTHORITY_REQUIRED");
  scope.current();
  if (plan.request.phase === "activate-source")
    assertOriginalMcpTodoGenesisSourceActivationCurrent(storage.workspaceRoot(), plan);
  const db = storage.connectNative();
  try {
    if (!readOriginalMcpTodoGenesisSources(storage.workspaceRoot(), db).some(file =>
      file.operationId === plan.request.operationId && file.sourceId === plan.request.selection.sourceId))
      fail("RECOVERY_REQUIRED", "New Todo source activation requires its complete canonical publication receipt.");
    let entries = sourceGrants.get(storage);
    if (!entries) { entries = new Map(); sourceGrants.set(storage, entries); }
    const capsule = Object.freeze({ kind: "pkm.original-mcp-todo-genesis-source-scope/v1" as const });
    const control = { provenance: structuredClone(scope.provenance), revocation: new SharedArrayBuffer(4) };
    const revoke = () => Atomics.store(new Int32Array(control.revocation), 0, 1);
    const entry: SourceGrant = { state: scope.state, plan: structuredClone(plan), control, scope: capsule, current() {
      scope.state.current();
      if (control.provenance.decision.expiresAtMs <= Date.now() || Atomics.load(new Int32Array(control.revocation), 0) !== 0)
        fail("NATIVE_AUTHORITY_REQUIRED", "This exact genesis source review expired or was revoked.");
    } };
    const prior = entries.get(plan.request.selection.boardSlug);
    if (prior) Atomics.store(new Int32Array(prior.control.revocation), 0, 1);
    sourceCapsules.set(capsule, entry); entries.set(plan.request.selection.boardSlug, entry);
    scope.state.lifetime.signal.addEventListener("abort", revoke, { once: true });
    const timer = setTimeout(revoke, Math.max(0, control.provenance.decision.expiresAtMs - Date.now())); timer.unref();
    storage.retainNativeCleanup({ release: async () => {
      revoke(); clearTimeout(timer); scope.state.lifetime.signal.removeEventListener("abort", revoke);
    } });
    const cancelAdoption = () => revoke();
    scope.signal.addEventListener("abort", cancelAdoption, { once: true });
    try {
      scope.current();
      await storage.adoptOriginalMcpTodoGenesisSource(capsule);
      scope.current();
      if (plan.request.phase === "activate-source")
        assertOriginalMcpTodoGenesisSourceActivationCurrent(storage.workspaceRoot(), plan);
    } catch (error) {
      revoke();
      if (entries.get(plan.request.selection.boardSlug) === entry) entries.delete(plan.request.selection.boardSlug);
      throw error;
    } finally { scope.signal.removeEventListener("abort", cancelAdoption); }
  } finally { db.close(); }
}
export function readOriginalMcpTodoGenesisSource(storage: Storage, host: OriginalMcpNativeHost, slug: string) {
  const entry = sourceGrants.get(storage)?.get(slug);
  if (!entry) return undefined;
  entry.current();
  if (entry.state.host !== host)
    fail("NATIVE_AUTHORITY_REQUIRED", "New Todo source requires fresh review in the current signed epoch.");
  const db = storage.connectNative();
  try {
    const source = readOriginalMcpTodoGenesisSources(storage.workspaceRoot(), db).find(file => file.key === slug);
    if (!source || source.sourceId !== entry.plan.request.selection.sourceId
      || source.operationId !== entry.plan.request.operationId) fail("RECOVERY_REQUIRED");
    return source;
  } finally { db.close(); }
}
export function originalMcpTodoGenesisSourceControlForStorage(storage: Storage, capsule: OriginalMcpTodoGenesisSourceScope) {
  const entry = sourceCapsules.get(capsule);
  if (!entry || entry.state.storage !== storage) fail("NATIVE_AUTHORITY_REQUIRED", "A copied source capsule cannot mint authority.");
  entry.current();
  return { provenance: structuredClone(entry.control.provenance), revocation: entry.control.revocation };
}
export function revokeOriginalMcpTodoGenesisSource(storage: Storage, host: OriginalMcpNativeHost, slug: string) {
  const entry = sourceGrants.get(storage)?.get(slug);
  if (!entry || entry.state.host !== host) fail("NATIVE_AUTHORITY_REQUIRED");
  entry.state.current(); Atomics.store(new Int32Array(entry.control.revocation), 0, 1);
}
export function getOriginalMcpTodoGenesisSourceScope(storage: Storage, host: OriginalMcpNativeHost, slug: string) {
  const entry = sourceGrants.get(storage)?.get(slug);
  if (!entry) return undefined;
  entry.current();
  if (entry.state.host !== host) fail("NATIVE_AUTHORITY_REQUIRED");
  return entry.scope;
}
