import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestSession, requestOriginalMcpNative } from "./original-mcp-native-request.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import {
  originalNativeSourcePayloadSchemas, originalNativeSourceResultSchemas, parseOriginalNativeSourcePayload,
  assertOriginalNativeSourcePacketBudget, originalNativeSourceRequestDigest,
  type OriginalNativeSourceDomain, type OriginalNativeSourceMethod,
} from "./original-mcp-native-source-contracts.js";
import type { OriginalMcpDomainPolicy, OriginalApiChatSourcePolicy, OriginalMcpSourceApproval } from "./original-mcp-source-policy-contracts.js";
import type { OriginalMcpDomainApprovalRequest } from "./original-mcp-source-policy-contracts.js";

export interface OriginalMcpNativeTodoSourceScope { readonly kind: "pkm.original-native-todo-source-scope/v1" }
interface TodoSourceScope {
  storage: Storage; host: OriginalMcpNativeHost; request: OriginalMcpDomainApprovalRequest;
  approval: OriginalMcpSourceApproval; signal: AbortSignal; current(): void;
}
const todoSourceScopes = new WeakMap<object, TodoSourceScope>();
const currentTodoSources = new WeakMap<Storage, { host: OriginalMcpNativeHost; scope: OriginalMcpNativeTodoSourceScope }>();
export function getOriginalMcpNativeTodoSourceScope(storage: Storage, host: OriginalMcpNativeHost) {
  const entry = currentTodoSources.get(storage);
  if (!entry) return undefined;
  if (entry.host !== host) fail("NATIVE_SOURCE_POLICY_REQUIRED");
  readOriginalMcpNativeTodoSourceScope(entry.scope, storage, host);
  return entry.scope;
}
export function readOriginalMcpNativeTodoSourceScope(scope: OriginalMcpNativeTodoSourceScope,
  storage: Storage, host: OriginalMcpNativeHost) {
  const state = todoSourceScopes.get(scope);
  if (!state || state.storage !== storage || state.host !== host
    || currentTodoSources.get(storage)?.scope !== scope) fail("NATIVE_SOURCE_POLICY_REQUIRED");
  state.current();
  return { request: structuredClone(state.request), approval: structuredClone(state.approval), signal: state.signal };
}

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
interface Grant {
  approval: OriginalMcpSourceApproval;
  domain: OriginalNativeSourceDomain;
  requestSha256: string;
  signal: AbortSignal;
  current(): void;
}
const grants = new WeakMap<object, Grant>();
const policies = new WeakMap<object, {
  storage: Storage; host: OriginalMcpNativeHost; domain: OriginalNativeSourceDomain; current(): void;
}>();

/** Parsed copies retain genuine session revocation; fixture callbacks gain no native source brand. */
export function retainOriginalMcpNativeSourceApproval(observed: unknown, parsed: OriginalMcpSourceApproval,
  domain: OriginalNativeSourceDomain, request: unknown): void {
  const grant = observed && typeof observed === "object" ? grants.get(observed) : undefined;
  if (!grant) return;
  if (originalNativeSourceRequestDigest(parsed) !== originalNativeSourceRequestDigest(grant.approval))
    fail("NATIVE_SOURCE_DECISION_CHANGED");
  if (grant.domain !== domain || grant.requestSha256 !== originalNativeSourceRequestDigest(request))
    fail("NATIVE_SOURCE_DECISION_REQUEST_MISMATCH");
  grant.current(); grants.set(parsed, grant);
}
export function assertOriginalMcpNativeSourceApprovalCurrent(approval: OriginalMcpSourceApproval): void {
  const grant = grants.get(approval);
  if (!grant) return;
  grant.current();
  if (originalNativeSourceRequestDigest(approval) !== originalNativeSourceRequestDigest(grant.approval))
    fail("NATIVE_SOURCE_DECISION_CHANGED");
}
export function originalMcpNativeSourceApprovalSignal(approval: OriginalMcpSourceApproval): AbortSignal | undefined {
  return grants.get(approval)?.signal;
}
export function assertOriginalMcpNativeSourcePolicy(value: unknown, storage: Storage, host: OriginalMcpNativeHost,
  domain: OriginalNativeSourceDomain): void {
  const state = value && typeof value === "object" ? policies.get(value) : undefined;
  if (!state || state.storage !== storage || state.host !== host || state.domain !== domain)
    fail("NATIVE_SOURCE_POLICY_REQUIRED");
  state.current();
}

/** Exact same-owner signed transport only. No injectable source approval callbacks or inherited execution policy. */
export function createOriginalMcpNativeSourcePolicies(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession) {
  const lifetime = new AbortController(), decisions = new Map<OriginalNativeSourceDomain, AbortController>();
  const pending = new Map<OriginalNativeSourceDomain, AbortController>();
  function current() {
    assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
    const journal = assertOriginalMcpPrivacy(storage.workspaceRoot()), signed = session.binding;
    if (lifetime.signal.aborted || session.signal.aborted || host.signal.aborted) fail("NATIVE_SOURCE_SESSION_REVOKED");
    if (!journal || signed.root !== storage.workspaceRoot() || signed.workspaceId !== journal.workspaceId
      || signed.planSha256 !== journal.plan.planSha256 || signed.profileSha256 !== journal.plan.profileSha256
      || signed.root !== host.receipt.root || signed.workspaceId !== host.receipt.workspaceId
      || signed.planSha256 !== host.receipt.planSha256 || signed.profileSha256 !== host.receipt.profileSha256
      || signed.catalogSha256 !== host.receipt.sourceCatalogSha256 || session.activationId !== host.receipt.epoch
      || host.receipt.authorityId !== `native-rpc:${session.brokerId}` || !host.receipt.domains.includes("mcp-public"))
      fail("NATIVE_SOURCE_SIGNED_OWNER_BINDING_REQUIRED");
  }
  function revoke(domain: OriginalNativeSourceDomain) {
    decisions.get(domain)?.abort(); decisions.delete(domain);
    pending.get(domain)?.abort();
    if (domain === "todo" && currentTodoSources.get(storage)?.host === host) currentTodoSources.delete(storage);
  }
  function dispose() {
    lifetime.abort();
    for (const domain of ["todo", "memory", "chat"] as const) revoke(domain);
    host.signal.removeEventListener("abort", dispose); session.signal.removeEventListener("abort", dispose);
  }
  current();
  host.signal.addEventListener("abort", dispose, { once: true }); session.signal.addEventListener("abort", dispose, { once: true });
  async function authorize(domain: OriginalNativeSourceDomain, request: unknown) {
    current();
    if (pending.has(domain)) fail("NATIVE_SOURCE_BUSY");
    revoke(domain);
    const controller = new AbortController(); pending.set(domain, controller);
    const signal = AbortSignal.any([controller.signal, lifetime.signal, host.signal, session.signal]);
    try {
      const name = `${domain}.source.approve` as OriginalNativeSourceMethod;
      const { receiptSha256: _receipt, ...binding } = host.receipt;
      const signed = originalMcpNativeRequestSession(session);
      const payload = parseOriginalNativeSourcePayload(name,
        originalNativeSourcePayloadSchemas[name].parse({ binding, request: structuredClone(request), noExecution: true }), signed);
      assertOriginalNativeSourcePacketBudget(name, payload, signed);
      const method = originalMcpNativeRequestMethods.find(candidate => String(candidate) === name);
      if (!method) fail("MISSING_NATIVE_METHOD");
      const decision = originalNativeSourceResultSchemas[name].parse(
        await requestOriginalMcpNative(session, method, payload, { signal, timeoutMs: 120000 }));
      current();
      if (signal.aborted) fail("NATIVE_SOURCE_CANCELLED");
      if (!decision) return null;
      if (decision.expiresAtMs <= Date.now() || decision.expiresAtMs > Date.now() + 300000)
        fail("NATIVE_SOURCE_DECISION_EXPIRED");
      const approval = Object.freeze(decision), revocation = new AbortController();
      decisions.set(domain, revocation);
      const grant: Grant = { approval, domain, requestSha256: originalNativeSourceRequestDigest(payload.request),
        signal: revocation.signal, current() {
        current();
        if (revocation.signal.aborted || decisions.get(domain) !== revocation || approval.expiresAtMs <= Date.now())
          fail("NATIVE_SOURCE_DECISION_REVOKED");
      } };
      grants.set(approval, grant);
      if (name === "todo.source.approve") {
        const request = originalNativeSourcePayloadSchemas[name].parse(payload).request;
        const scope = Object.freeze({ kind: "pkm.original-native-todo-source-scope/v1" as const });
        todoSourceScopes.set(scope, { storage, host, request, approval, signal: grant.signal, current: grant.current });
        currentTodoSources.set(storage, { host, scope });
      }
      return approval;
    } catch (error) {
      revoke(domain);
      if (error && typeof error === "object" && "code" in error && error.code === "NATIVE_DENIED") return null;
      throw error;
    } finally { pending.delete(domain); }
  }
  const todo: OriginalMcpDomainPolicy = Object.freeze({ authorize: (request: Parameters<OriginalMcpDomainPolicy["authorize"]>[0]) =>
    authorize("todo", request) });
  const memory: OriginalMcpDomainPolicy = Object.freeze({ authorize: (request: Parameters<OriginalMcpDomainPolicy["authorize"]>[0]) =>
    authorize("memory", request) });
  const chat: OriginalApiChatSourcePolicy = Object.freeze({ authorize: (request: Parameters<OriginalApiChatSourcePolicy["authorize"]>[0]) =>
    authorize("chat", request) });
  for (const [domain, policy] of [["todo", todo], ["memory", memory], ["chat", chat]] as const)
    policies.set(policy, { storage, host, domain, current });
  storage.retainNativeCleanup({ release: async () => dispose() });
  return Object.freeze({ kind: "pkm.original-native-source-policies/v1" as const,
    todo, memory, chat, signal: lifetime.signal, assertCurrent: current, revoke, dispose });
}
