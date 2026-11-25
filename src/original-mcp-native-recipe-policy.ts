import { assertRootOwner, type RootOwner } from "./root-owner.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestSession, requestOriginalMcpNative } from "./original-mcp-native-request.js";
import { assertOriginalMcpPrivacy } from "./original-mcp-root-custody.js";
import type { Storage } from "./storage.js";
import {
  originalNativeRecipeDigest, originalNativeRecipeResultSchemas, parseOriginalNativeRecipePayload,
  assertOriginalNativeRecipePacketBudget,
} from "./original-mcp-native-recipe-contracts.js";
import type {
  OriginalRecipeSourceApproval, OriginalRecipeSourceApprovalRequest, OriginalRecipeSourcePolicy,
} from "./original-mcp-recipe-source-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
interface Grant {
  approval: OriginalRecipeSourceApproval; requestSha256: string; signal: AbortSignal; current(): void;
}
const grants = new WeakMap<object, Grant>();
const policies = new WeakMap<object, {
  owner: RootOwner; host: OriginalMcpNativeHost; session: AuthenticatedOriginalMcpNativeSession; current(): void;
}>();
const ownerPolicies = new WeakMap<Storage, { owner: RootOwner; host: OriginalMcpNativeHost; policy: OriginalRecipeSourcePolicy }>();
export function originalMcpNativeRecipeSourcePolicySession(policy: OriginalRecipeSourcePolicy,
  owner: RootOwner, host: OriginalMcpNativeHost) {
  assertOriginalMcpNativeRecipeSourcePolicy(policy, owner, host);
  return policies.get(policy)!.session;
}
export async function originalMcpNativeRecipeSourcePolicyForOwner(owner: RootOwner, host: OriginalMcpNativeHost) {
  assertRootOwner(owner);
  const { storage } = await owner.ensureFull();
  const retained = ownerPolicies.get(storage);
  if (retained?.owner === owner && retained.host === host) {
    assertOriginalMcpNativeRecipeSourcePolicy(retained.policy, owner, host);
    return retained.policy;
  }
  if (!host.nativeChat?.session) fail("NATIVE_RECIPE_SOURCE_SESSION_REQUIRED");
  return (await createOriginalMcpNativeRecipeSourcePolicy(owner, host, host.nativeChat.session)).policy;
}
export function assertOriginalMcpNativeRecipeSourcePolicy(value: unknown, owner: RootOwner,
  host: OriginalMcpNativeHost): void {
  const state = value && typeof value === "object" ? policies.get(value) : undefined;
  if (!state || state.owner !== owner || state.host !== host) fail("NATIVE_RECIPE_SOURCE_POLICY_REQUIRED");
  state.current();
}
/** Parsed copies retain real session/source revocation; callback fixtures never acquire this brand. */
export function retainOriginalMcpNativeRecipeSourceApproval(observed: unknown, parsed: OriginalRecipeSourceApproval,
  request: OriginalRecipeSourceApprovalRequest): void {
  const grant = observed && typeof observed === "object" ? grants.get(observed) : undefined;
  if (!grant) return;
  if (originalNativeRecipeDigest(parsed) !== originalNativeRecipeDigest(grant.approval)
    || grant.requestSha256 !== originalNativeRecipeDigest(request)) fail("NATIVE_RECIPE_SOURCE_DECISION_CHANGED");
  grant.current(); grants.set(parsed, grant);
}
export function assertOriginalMcpNativeRecipeSourceApprovalCurrent(approval: OriginalRecipeSourceApproval): void {
  const grant = grants.get(approval);
  if (!grant) return;
  grant.current();
  if (originalNativeRecipeDigest(approval) !== originalNativeRecipeDigest(grant.approval))
    fail("NATIVE_RECIPE_SOURCE_DECISION_CHANGED");
}
export function originalMcpNativeRecipeSourceApprovalSignal(approval: OriginalRecipeSourceApproval): AbortSignal | undefined {
  return grants.get(approval)?.signal;
}

/** Actual RootOwner + signed socket only; no injectable approval, model, transport or other-domain grants. */
export async function createOriginalMcpNativeRecipeSourcePolicy(owner: RootOwner, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession) {
  assertRootOwner(owner);
  const { storage } = await owner.ensureFull();
  const lifetime = new AbortController();
  let pending: AbortController | undefined;
  const decisions = new Map<string, { controller: AbortController; expiry: ReturnType<typeof setTimeout> }>();
  function decisionLane(request: Readonly<OriginalRecipeSourceApprovalRequest>) {
    return request.schema === "pkm.original-native-recipe-library-source/v1" ? request.purpose
      : request.schema === "pkm.original-recipe-library-source/v1" ? "execute" : request.schema;
  }
  function current() {
    assertRootOwner(owner); owner.assertWorkspaceLease(); storage.assertWorkspaceLease();
    assertOriginalMcpNativeHost(host, storage); assertAuthenticatedOriginalMcpNativeSession(session);
    if (lifetime.signal.aborted || host.signal.aborted || session.signal.aborted) fail("NATIVE_RECIPE_SOURCE_SESSION_REVOKED");
    const journal = assertOriginalMcpPrivacy(owner.workspaceRoot()), signed = session.binding, receipt = host.receipt;
    if (!journal || owner.workspaceRoot() !== storage.workspaceRoot() || signed.root !== owner.workspaceRoot()
      || signed.workspaceId !== journal.workspaceId || signed.planSha256 !== journal.plan.planSha256
      || signed.profileSha256 !== journal.plan.profileSha256 || signed.root !== receipt.root
      || signed.workspaceId !== receipt.workspaceId || signed.planSha256 !== receipt.planSha256
      || signed.profileSha256 !== receipt.profileSha256 || signed.catalogSha256 !== receipt.sourceCatalogSha256
      || session.activationId !== receipt.epoch || receipt.authorityId !== `native-rpc:${session.brokerId}`
      || !receipt.domains.includes("mcp-public")) fail("NATIVE_RECIPE_SOURCE_SIGNED_OWNER_REQUIRED");
  }
  function payload(request: Readonly<OriginalRecipeSourceApprovalRequest>) {
    current();
    const { receiptSha256: _receipt, ...binding } = host.receipt;
    return parseOriginalNativeRecipePayload("recipe.source.approve",
      { binding, request: structuredClone(request), noExecution: true }, originalMcpNativeRequestSession(session));
  }
  function revokeLane(lane: string) {
    const previous = decisions.get(lane);
    if (previous) { clearTimeout(previous.expiry); previous.controller.abort(); decisions.delete(lane); }
  }
  function revoke() {
    for (const lane of decisions.keys()) revokeLane(lane);
    pending?.abort();
  }
  function dispose() {
    lifetime.abort(); revoke();
    host.signal.removeEventListener("abort", dispose); session.signal.removeEventListener("abort", dispose);
  }
  current();
  host.signal.addEventListener("abort", dispose, { once: true }); session.signal.addEventListener("abort", dispose, { once: true });
  const policy: OriginalRecipeSourcePolicy = Object.freeze({
    signal: lifetime.signal,
    assertCurrent(request: Readonly<OriginalRecipeSourceApprovalRequest>) { payload(request); },
    async authorize(request: Readonly<OriginalRecipeSourceApprovalRequest>, requestSignal: AbortSignal) {
      current();
      if (pending) fail("NATIVE_RECIPE_SOURCE_BUSY");
      const lane = decisionLane(request);
      revokeLane(lane);
      const controller = new AbortController(); pending = controller;
      const signal = AbortSignal.any([controller.signal, lifetime.signal, host.signal, session.signal, requestSignal]);
      try {
        signal.throwIfAborted();
        const parsed = payload(request), signed = originalMcpNativeRequestSession(session);
        assertOriginalNativeRecipePacketBudget("recipe.source.approve", parsed, signed);
        // Parent owns the shared lane. Until the exact 14th method is integrated, there is no fallback.
        const method = originalMcpNativeRequestMethods.find(candidate => String(candidate) === "recipe.source.approve");
        if (!method) fail("MISSING_NATIVE_METHOD");
        const result = originalNativeRecipeResultSchemas["recipe.source.approve"].parse(
          await requestOriginalMcpNative(session, method, parsed, { signal, timeoutMs: 120000 }));
        current(); signal.throwIfAborted();
        if (!result) return null;
        const requestSha256 = originalNativeRecipeDigest(parsed.request);
        if (result.requestSha256 !== requestSha256 || result.expiresAtMs <= Date.now()
          || result.expiresAtMs > Date.now() + 300000) fail("NATIVE_RECIPE_SOURCE_DECISION_INVALID");
        const approval = Object.freeze(result), revocation = new AbortController();
        const grant: Grant = { approval, requestSha256, signal: revocation.signal, current() {
          current();
          if (revocation.signal.aborted || decisions.get(lane)?.controller !== revocation || approval.expiresAtMs <= Date.now())
            fail("NATIVE_RECIPE_SOURCE_DECISION_REVOKED");
        } };
        grants.set(approval, grant);
        const expiry = setTimeout(() => {
          if (decisions.get(lane)?.controller === revocation) revokeLane(lane);
        }, approval.expiresAtMs - Date.now());
        expiry.unref();
        decisions.set(lane, { controller: revocation, expiry });
        return approval;
      } catch (error) {
        revokeLane(lane);
        if (error && typeof error === "object" && "code" in error && error.code === "NATIVE_DENIED") return null;
        throw error;
      } finally { pending = undefined; }
    },
  });
  policies.set(policy, { owner, host, session, current });
  ownerPolicies.set(storage, { owner, host, policy });
  storage.retainNativeCleanup({ release: dispose });
  return Object.freeze({ kind: "pkm.original-native-recipe-source-policy/v1" as const, policy,
    signal: lifetime.signal, assertCurrent: current, revoke, dispose });
}
