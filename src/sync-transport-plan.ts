import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { SyncPlanStore } from "./sync-plan-store.js";
import { planSync, syncPlanHash } from "./sync-plan.js";
import { readSyncApplyReceipt, serializeSyncApplyPlan } from "./sync-apply.js";
import { syncApplyPlanSchema, syncApplyReceiptSchema } from "./sync-apply-contracts.js";
import { syncPlanInputSchema, syncPlanSessionSchema, type SyncManifest } from "./sync-plan-contracts.js";
import {
  syncTransportPinSchema, syncTransportPublicationSchema,
  type SyncTransportPin, type SyncTransportPublication,
} from "./sync-transport-contracts.js";

export type SyncTransportStagingAuthority = {
  /** Host reads a durable domain/apply receipt, never trusts a receipt supplied in an HTTP request. */
  verifyStaged(request: {
    actorId: string; receiptId: string; sessionHash: string;
    sourcePins: SyncTransportPublication["sourcePins"]; manifestHash: string;
  }): void;
};

/** Bridge for the existing Markdown/attachment apply journal; other domains require native staged receipts. */
export function syncTransportApplyStaging(db: DatabaseSync, store: SyncPlanStore, request: {
  sessionId: string; actorId: string; input: unknown;
}): SyncTransportStagingAuthority {
  const plan = serializeSyncApplyPlan(store, request);
  return {
    verifyStaged(expected) {
      if (expected.actorId !== plan.actorId || expected.sessionHash !== plan.sessionHash
        || syncPlanHash(expected.sourcePins) !== syncPlanHash(plan.sourcePins)) throw new Error("Staging pins mismatch");
      const row = db.prepare("SELECT plan_json, root_path, state FROM sync_apply_journal WHERE apply_id = ?").get(expected.receiptId);
      if (!row || row.state !== "completed") throw new Error("A completed durable apply receipt is required");
      const receipt = readSyncApplyReceipt(store, plan.planHash, String(row.root_path));
      if (!receipt || receipt.applyId !== expected.receiptId) throw new Error("A valid completed durable apply receipt is required");
      syncApplyReceiptSchema.parse(receipt);
      const journaled = syncApplyPlanSchema.parse(JSON.parse(String(row.plan_json)));
      if (receipt.planHash !== plan.planHash || receipt.actorId !== plan.actorId || receipt.sessionId !== plan.sessionId
        || journaled.planHash !== plan.planHash
        || syncPlanHash(receipt.operations) !== syncPlanHash(journaled.actions.map(action => ({
          path: action.path, beforeSha256: action.beforeSha256, afterSha256: action.afterSha256,
          ...(action.afterMode !== undefined ? { beforeMode: action.beforeMode, afterMode: action.afterMode } : {}),
        })))
        || syncPlanHash(receipt.tombstones) !== syncPlanHash(plan.tombstones)) throw new Error("Apply receipt mismatch");
    },
  };
}

/** Actor and database must be supplied by the native host, not caller-controlled request fields. */
export function prepareSyncTransportPublication(
  db: DatabaseSync, store: SyncPlanStore,
  request: { sessionId: string; actorId: string; input: unknown; stagedReceiptId: string; operationId?: string },
  remote: SyncTransportPin,
  staging: SyncTransportStagingAuthority,
  now = new Date(),
): SyncTransportPublication {
  const pin = syncTransportPinSchema.parse(remote);
  const input = syncPlanInputSchema.parse(request.input);
  const owner = db.prepare("SELECT actor_id FROM sync_plan_owners WHERE session_id = ?").get(request.sessionId);
  if (!owner || owner.actor_id !== request.actorId) throw new Error("Only the native authenticated plan owner may publish");
  const session = syncPlanSessionSchema.parse(store.get(request.sessionId));
  if (syncPlanHash(session.plan) !== syncPlanHash(planSync(input)) || input.remote.sha256 !== pin.manifestHash
    || syncPlanHash(input.remote.manifest) !== syncPlanHash(pin.manifest)) throw new Error("Publication source pins mismatch");
  const sessionHash = syncPlanHash({ sessionId: session.sessionId, revision: session.revision, plan: session.plan, decisions: session.decisions });
  const selected = session.plan.proposals.map(proposal => proposal.state);
  // The planner deliberately omits entities unchanged on all three sides. Keep
  // those remote entities in the publication instead of silently deleting them.
  const changedKeys = new Set([...session.plan.proposals, ...session.plan.conflicts]
    .map(item => JSON.stringify([item.type, item.itemId])));
  const unchanged = new Map<string, SyncManifest["files"]>();
  for (const file of pin.manifest.files) {
    const key = JSON.stringify([file.type, file.itemId]);
    if (!changedKeys.has(key)) unchanged.set(key, [...(unchanged.get(key) ?? []), file]);
  }
  for (const files of unchanged.values()) selected.push({ kind: "live", files });
  for (const deletion of pin.manifest.deletions) {
    if (!changedKeys.has(JSON.stringify([deletion.type, deletion.itemId]))) selected.push({ kind: "deleted", deletion });
  }
  for (const conflict of session.plan.conflicts) {
    const decision = session.decisions.filter(item => item.conflictId === conflict.id).at(-1);
    if (!decision || decision.actorId !== request.actorId) throw new Error("Every conflict requires the owner's persisted decision");
    selected.push(decision.choice === "delete" ? {
      kind: "deleted", deletion: {
        type: conflict.type, itemId: conflict.itemId, deletedAt: now.toISOString(),
        ...(["local", "remote", "base"] as const).map(side => conflict[side]).flatMap(state =>
          state.kind === "live" ? [{ privacy: state.files[0].privacy, category: state.files[0].category }]
            : state.kind === "deleted" ? [{ privacy: state.deletion.privacy, category: state.deletion.category }] : []).at(0),
      },
    } : conflict[decision.choice]);
  }
  const manifest: SyncManifest = {
    schema: 3, capabilities: {
      storage: "pkm.github.publication/v1",
      required: ["explicit-deletions", "stable-entity-identity", "entity-partial-progress"],
    },
    files: selected.flatMap(state => state.kind === "live" ? state.files : []),
    deletions: selected.flatMap(state => state.kind === "deleted" ? [state.deletion] : []),
  };
  if ([...manifest.files, ...manifest.deletions].some(file => file.type === "actions" || file.type === "action-module-sets")) manifest.capabilities.required.push("action-library-assets");
  if ([...manifest.files, ...manifest.deletions].some(file => file.type === "profiles")) manifest.capabilities.required.push("profile-cards");
  const snapshot = { manifest, sha256: syncPlanHash(manifest) };
  planSync({ base: snapshot, local: snapshot, remote: snapshot });
  staging.verifyStaged({
    actorId: request.actorId, receiptId: request.stagedReceiptId, sessionHash,
    sourcePins: session.plan.pins, manifestHash: snapshot.sha256,
  });
  const unsigned = {
    schema: "pkm.sync-transport-publication/v1" as const,
    operationId: request.operationId ?? randomUUID(), policyId: pin.policyId, actorId: request.actorId,
    sessionId: session.sessionId, revision: session.revision, sessionHash, sourcePins: session.plan.pins,
    expectedCommit: pin.commit, expectedTree: pin.tree, manifest, manifestHash: snapshot.sha256,
    stagedReceiptId: request.stagedReceiptId, message: `PKM sync ${now.toISOString()}`,
  };
  return syncTransportPublicationSchema.parse({ ...unsigned, planHash: syncPlanHash(unsigned) });
}
