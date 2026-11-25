import { createHash } from "node:crypto";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestSession, requestOriginalMcpNative } from "./original-mcp-native-request.js";
import { assertOriginalMcpPrivacy, originalMcpPrivateBytes } from "./original-mcp-root-custody.js";
import { assertOriginalMcpDomainSession, enrollOriginalMcpTodoWorker, type OriginalMcpTodoWorkerPolicy } from "./original-mcp-domains.js";
import { originalMcpDomainFile, originalMcpTodoSession, readOriginalMcpDomain } from "./original-mcp-domain-state.js";
import {
  originalNativeTodoWorkerDigest, originalTodoWorkerRequestSchema, originalNativeTodoWorkerInputSchema, parseOriginalNativeTodoWorkerPayload,
  parseOriginalNativeTodoWorkerDecision,
} from "./original-mcp-native-todo-worker-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
type PolicyResource = {
  readonly kind: "pkm.original-mcp-native-todo-worker-policy/v1"; readonly policy: OriginalMcpTodoWorkerPolicy;
  readonly signal: AbortSignal; assertCurrent(): void; revoke(): void; dispose(): void;
};
const resources = new WeakMap<object, { storage: Storage; host: OriginalMcpNativeHost; session: AuthenticatedOriginalMcpNativeSession }>();
const active = new WeakMap<Storage, PolicyResource>();

export function assertOriginalMcpNativeTodoWorkerPolicy(value: unknown, storage: Storage,
  host: OriginalMcpNativeHost, session: AuthenticatedOriginalMcpNativeSession): void {
  const state = value && typeof value === "object" ? resources.get(value) : undefined;
  if (!state || state.storage !== storage || state.host !== host || state.session !== session)
    fail("NATIVE_TODO_WORKER_POLICY_REQUIRED");
  (value as PolicyResource).assertCurrent();
}

/** Actual signed transport + independently active Todo source. No injectable authorization, token or success callback. */
export function createOriginalMcpNativeTodoWorkerPolicy(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession): PolicyResource {
  assertStorage(storage); assertOriginalMcpNativeHost(host, storage); assertAuthenticatedOriginalMcpNativeSession(session);
  const existing = active.get(storage);
  if (existing) {
    const state = resources.get(existing);
    if (state?.host === host && state.session === session) { existing.assertCurrent(); return existing; }
    existing.dispose();
  }
  const lifetime = new AbortController();
  let pending: AbortController | undefined;
  const admitted = new Map<string, { expiresAtMs: number; revocation: SharedArrayBuffer }>();
  const invalidateGrants = () => {
    for (const grant of admitted.values()) Atomics.store(new Int32Array(grant.revocation), 0, 1);
    admitted.clear();
  };
  function current() {
    assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
    const journal = assertOriginalMcpPrivacy(storage.workspaceRoot()), signed = session.binding;
    if (lifetime.signal.aborted || host.signal.aborted || session.signal.aborted) fail("NATIVE_TODO_WORKER_REVOKED");
    if (!journal || signed.root !== storage.workspaceRoot() || signed.workspaceId !== journal.workspaceId
      || signed.planSha256 !== journal.plan.planSha256 || signed.profileSha256 !== journal.plan.profileSha256
      || signed.catalogSha256 !== host.receipt.sourceCatalogSha256 || host.receipt.root !== signed.root
      || host.receipt.workspaceId !== signed.workspaceId || host.receipt.planSha256 !== signed.planSha256
      || host.receipt.profileSha256 !== signed.profileSha256 || host.receipt.epoch !== session.activationId
      || host.receipt.authorityId !== `native-rpc:${session.brokerId}` || !host.receipt.domains.includes("mcp-public"))
      fail("NATIVE_TODO_WORKER_SIGNED_OWNER_REQUIRED");
  }
  function revoke() {
    pending?.abort();
    // Existing Core authority has one Todo-session revocation channel, not per-worker revocation.
    invalidateGrants();
  }
  function dispose() {
    lifetime.abort(); revoke();
    host.signal.removeEventListener("abort", dispose); session.signal.removeEventListener("abort", dispose);
    if (active.get(storage) === resource) active.delete(storage);
  }
  current();
  host.signal.addEventListener("abort", dispose, { once: true });
  session.signal.addEventListener("abort", dispose, { once: true });
  const policy: OriginalMcpTodoWorkerPolicy = Object.freeze({
    async authorize(input: Parameters<OriginalMcpTodoWorkerPolicy["authorize"]>[0]) {
      current();
      if (pending) fail("NATIVE_TODO_WORKER_BUSY");
      assertOriginalMcpDomainSession(storage, host, "todo");
      const request = originalTodoWorkerRequestSchema.parse(structuredClone(input));
      const root = storage.workspaceRoot(), state = readOriginalMcpDomain(root, "todo")!, todo = originalMcpTodoSession(root);
      const journal = assertOriginalMcpPrivacy(root)!;
      const key = `${request.boardSlug}\0${request.actorId}`;
      for (const [id, grant] of admitted) if (grant.expiresAtMs <= Date.now() || Atomics.load(new Int32Array(grant.revocation), 0) !== 0)
        admitted.delete(id);
      const old = admitted.get(key);
      if (old && Atomics.load(new Int32Array(old.revocation), 0) === 0) {
        revoke(); fail("NATIVE_TODO_WORKER_REVIEW_REQUIRES_FRESH_TODO_SESSION");
      }
      if (admitted.size >= 128 && !old) fail("NATIVE_TODO_WORKER_LIMIT");
      const checkSource = () => {
        current(); assertOriginalMcpDomainSession(storage, host, "todo");
        const now = originalMcpTodoSession(root);
        if (now.revocation !== todo.revocation || now.decisionId !== todo.decisionId
          || now.intentSha256 !== request.intentSha256 || now.nativeHostReceiptSha256 !== request.nativeHostReceiptSha256
          || request.root !== root || request.workspaceId !== journal.workspaceId
          || !state.intent.files.some(item => item.key === request.boardSlug)
          || createHash("sha256").update(originalMcpPrivateBytes(originalMcpDomainFile(root, "todo", request.boardSlug), 2_097_152))
            .digest("hex") !== request.boardDigest)
          fail("NATIVE_TODO_WORKER_SOURCE_CHANGED");
      };
      checkSource();
      const controller = new AbortController(); pending = controller;
      const signal = AbortSignal.any([controller.signal, lifetime.signal, session.signal, host.signal]);
      const interval = setInterval(() => {
        try { checkSource(); } catch { controller.abort(); }
      }, 50);
      interval.unref();
      try {
        const { receiptSha256: _receipt, ...binding } = host.receipt;
        const payload = parseOriginalNativeTodoWorkerPayload("todo.worker.enroll", {
          binding, request, custodyPlanSha256: journal.plan.planSha256, profileSha256: journal.plan.profileSha256,
          epoch: host.receipt.epoch, sourceSha256: state.intent.sourceSha256,
          sessionDecisionId: todo.decisionId, sessionExpiresAtMs: todo.expiresAtMs,
          noExecution: true, noLegacyTokenInheritance: true,
        }, originalMcpNativeRequestSession(session));
        const method = originalMcpNativeRequestMethods.find(item => String(item) === "todo.worker.enroll");
        if (!method) fail("MISSING_NATIVE_METHOD");
        const decision = parseOriginalNativeTodoWorkerDecision(await requestOriginalMcpNative(session, method, payload,
          { signal, timeoutMs: 120000 }), payload);
        checkSource();
        if (signal.aborted) fail("NATIVE_TODO_WORKER_CANCELLED");
        if (!decision) return null;
        if (decision.requestSha256 !== originalNativeTodoWorkerDigest(payload)) fail("NATIVE_TODO_WORKER_DECISION_CHANGED");
        admitted.set(key, { expiresAtMs: decision.expiresAtMs, revocation: todo.revocation });
        return Object.freeze({ actorId: decision.actorId, decisionId: decision.decisionId, expiresAtMs: decision.expiresAtMs });
      } finally { clearInterval(interval); if (pending === controller) pending = undefined; }
    },
  });
  const resource: PolicyResource = Object.freeze({
    kind: "pkm.original-mcp-native-todo-worker-policy/v1" as const, policy, signal: lifetime.signal,
    assertCurrent: current, revoke, dispose,
  });
  resources.set(resource, { storage, host, session }); active.set(storage, resource);
  storage.retainNativeCleanup({ release: async () => dispose() });
  return resource;
}

/** Production composition entrypoint; the lower-level enrollment policy remains a trusted-embedding protocol. */
export async function enrollOriginalMcpNativeTodoWorker(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession, input: { boardSlug: string; actorId: string }) {
  input = originalNativeTodoWorkerInputSchema.parse(structuredClone(input));
  const resource = createOriginalMcpNativeTodoWorkerPolicy(storage, host, session);
  assertOriginalMcpNativeTodoWorkerPolicy(resource, storage, host, session);
  const enrolled = await enrollOriginalMcpTodoWorker(storage, host, input, resource.policy);
  try { resource.assertCurrent(); assertOriginalMcpDomainSession(storage, host, "todo"); return enrolled; }
  catch (error) { resource.revoke(); throw error; }
}
