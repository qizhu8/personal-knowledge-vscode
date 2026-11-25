import { AsyncLocalStorage } from "node:async_hooks";
import { CoreError } from "./contracts.js";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { originalMcpNativeRequestMethods, originalMcpNativeRequestSession, requestOriginalMcpNative } from "./original-mcp-native-request.js";
import { SyncPlanStore } from "./sync-plan-store.js";
import { inspectSyncApplySourceReview } from "./sync-apply.js";
import type { SyncContentReview } from "./sync-content.js";
import type { DataRuntimeHost } from "./data-runtime.js";
import { originalNativeSyncMethod, originalNativeSyncDigest, originalNativeSyncResultSchema,
  parseOriginalNativeSyncPayload } from "./original-mcp-native-sync-contracts.js";

/** Same-owner signed source consent; never an execution grant or persisted historical authority. */
export function createOriginalMcpNativeSyncDataHost(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession): DataRuntimeHost {
  const lifetime = new AbortController();
  const active = new AsyncLocalStorage<{ review: SyncContentReview; expiresAtMs: number; live: boolean }>();
  function fail(): never { throw new CoreError("ACCESS_DENIED", "Current signed native Sync source consent is required."); }
  function current() {
    assertStorage(storage); storage.assertWorkspaceLease(); assertOriginalMcpNativeHost(host, storage);
    assertAuthenticatedOriginalMcpNativeSession(session);
    if (lifetime.signal.aborted || session.signal.aborted || host.signal.aborted
      || host.receipt.actorId !== "mcp:external" || session.activationId !== host.receipt.epoch
      || session.binding.root !== storage.workspaceRoot() || session.binding.workspaceId !== host.receipt.workspaceId
      || session.binding.profileSha256 !== host.receipt.profileSha256
      || session.binding.planSha256 !== host.receipt.planSha256 || session.binding.catalogSha256 !== host.receipt.sourceCatalogSha256
      || host.receipt.authorityId !== `native-rpc:${session.brokerId}`) fail();
  }
  current();
  storage.retainNativeCleanup({ release: async () => { lifetime.abort(); } });
  return {
    namespace: `native-sync:${host.receipt.workspaceId}`,
    syncContent: { root: storage.workspaceRoot(), actorId: "mcp:external", epoch: host.receipt.epoch,
      profileSha256: host.receipt.profileSha256,
      assertCurrent(review) {
        current(); const grant = active.getStore();
        if (!grant?.live || grant.expiresAtMs <= Date.now()
          || originalNativeSyncDigest(grant.review) !== originalNativeSyncDigest(review)) fail();
      } },
    async withSyncContentReview(request, work) {
      current();
      const database = storage.connectNative();
      let inspected: ReturnType<typeof inspectSyncApplySourceReview>;
      try { inspected = inspectSyncApplySourceReview(new SyncPlanStore(database), {
        sessionId: request.args.sessionId, actorId: request.actorId, input: request.args.input,
      }); } finally { database.close(); }
      if (!inspected.review.entities.length) return work();
      const { receiptSha256: _receipt, ...binding } = host.receipt;
      const inventory = Object.fromEntries(Object.entries(inspected.input).map(([side, value]) =>
        [side, originalNativeSyncDigest(value.manifest.files.map(({ contentBase64: _bytes, ...metadata }) => metadata))]));
      const source = { operation: request.operation, review: inspected.review, publication: "local-only", inventory,
        privateMetadata: Object.values(inspected.input).some(value => value.manifest.files.some(file => file.privacy === "private")),
        ...(request.operation === "sync.apply" ? { operationId: request.args.operationId, expectedPlanHash: request.args.expectedPlanHash } : {}) };
      const payload = parseOriginalNativeSyncPayload({ binding, noExecution: true, defaultDecision: "deny",
        request: source, requestSha256: originalNativeSyncDigest(source) }, originalMcpNativeRequestSession(session));
      const method = originalMcpNativeRequestMethods.find(value => String(value) === originalNativeSyncMethod);
      if (!method) fail();
      const signal = AbortSignal.any([lifetime.signal, session.signal, host.signal]);
      const decision = originalNativeSyncResultSchema.parse(await requestOriginalMcpNative(session, method, payload,
        { signal, timeoutMs: 120000 }));
      current();
      if (!decision || signal.aborted || decision.actorId !== request.actorId || decision.epoch !== host.receipt.epoch
        || decision.requestSha256 !== payload.requestSha256 || decision.expiresAtMs <= Date.now()
        || decision.expiresAtMs > Date.now() + 300000) fail();
      const grant = { review: structuredClone(inspected.review), expiresAtMs: decision.expiresAtMs, live: true };
      return active.run(grant, async () => {
        try { current(); return await work(); }
        finally { grant.live = false; }
      });
    },
  };
}
