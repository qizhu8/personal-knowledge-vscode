import type { OriginalMcpNativeHostPolicy } from "./original-mcp-native-host.js";
import { CoreError } from "./contracts.js";
import { readNativeSubscriptionProfile } from "./native-subscription-profile.js";
import { verifyNativeSubscriptionIdentity } from "./host-composition-legacy-state.js";
import type { NativeSubscriptionIdentityPolicy } from "./legacy-subscription-identity.js";
import type { Storage } from "./storage.js";
import { SUBSCRIPTION_READ_LIMITS } from "./subscription-reads.js";

/** Trusted current producer only: the immutable profile reader verifies membership intents, generations and cache hashes. */
export function createOriginalMcpSubscriptionSource(storage: Storage, profile: string,
  identity?: NativeSubscriptionIdentityPolicy,
  memberKeyAvailable?: (request: Readonly<{ actorId: string; epoch: string; workspaceId: string;
    nodeId: string; shareId: string; publicKey: string; source: unknown }>) => Promise<boolean>,
): NonNullable<OriginalMcpNativeHostPolicy["subscriptionSource"]> {
  const capture = () => {
    const db = storage.connectNative();
    try {
      let files = 0, bytes = 0, metadata = 0;
      for (const table of ["native_subscription_profile_files", "native_subscription_generation_files"]) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        const row = db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(length(bytes)),0) AS bytes,
          COALESCE(MAX(length(bytes)),0) AS maximum FROM ${table}`).get()!;
        files += Number(row.count); bytes += Number(row.bytes);
        if (Number(row.maximum) > SUBSCRIPTION_READ_LIMITS.fileBytes)
          throw new CoreError("LIMIT_EXCEEDED", "Native Subscription source file exceeds the public read bound.");
      }
      for (const table of ["native_subscription_profile", "native_subscription_generations"]) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        metadata += Number(db.prepare(`SELECT COALESCE(SUM(length(body)),0) AS bytes FROM ${table}`).get()!.bytes);
      }
      if (files > SUBSCRIPTION_READ_LIMITS.files || bytes > SUBSCRIPTION_READ_LIMITS.snapshotBytes
        || metadata > SUBSCRIPTION_READ_LIMITS.snapshotBytes)
        throw new CoreError("LIMIT_EXCEEDED", "Native Subscription validated lineage exceeds the public read bound.");
    } finally { db.close(); }
    return readNativeSubscriptionProfile(storage, profile);
  };
  return Object.freeze({
    async capture(binding, signal) {
      storage.assertWorkspaceLease();
      if (signal.aborted || binding.root !== storage.workspaceRoot() || binding.workspaceId !== await storage.workspaceId()
        || identity && (identity.actorId !== binding.actorId || identity.ownerEpoch !== binding.epoch))
        throw new CoreError("ACCESS_DENIED", "Current Subscription source binding differs.");
      const db = storage.connectNative();
      try {
        await verifyNativeSubscriptionIdentity(db, binding.root, binding.workspaceId, identity, "read", null,
          { id: binding.actorId, canWrite: false });
        const value = capture();
        const members = value.state.subscriptions;
        if (!Array.isArray(members)) throw new CoreError("ACCESS_DENIED", "Current Subscription membership is unavailable.");
        for (const member of members) {
          if (member.secretProtected || member.source?.credentialTargetId) {
            let available = false;
            try { available = await memberKeyAvailable?.(Object.freeze({ actorId: binding.actorId, epoch: binding.epoch,
              workspaceId: binding.workspaceId, nodeId: member.nodeId, shareId: member.shareId,
              publicKey: member.publicKey, source: structuredClone(member.source) })) === true; } catch {}
            if (!available) throw new CoreError("ACCESS_DENIED", "Current native Subscription key is unavailable.");
          }
        }
        await verifyNativeSubscriptionIdentity(db, binding.root, binding.workspaceId, identity, "read", null,
          { id: binding.actorId, canWrite: false });
        if (signal.aborted || capture().head !== value.head)
          throw new CoreError("REVISION_CONFLICT", "Current Subscription source changed.");
        return value;
      } finally { db.close(); }
    },
    assertCurrent(binding, head) {
      storage.assertWorkspaceLease();
      if (binding.root !== storage.workspaceRoot() || capture().head !== head)
        throw new CoreError("REVISION_CONFLICT", "Current Subscription membership, keys or corpus changed.");
    },
  });
}
