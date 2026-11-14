import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "./contracts.js";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { resourcePath } from "./document-path.js";
import type { Storage } from "./storage.js";
import { LEGACY_CLASSIFICATION_COMMAND_ID } from "./legacy-classification-command-contracts.js";
import { executeLegacyClassificationCommand, verifyLegacyClassificationCommandHistory, type LegacyClassificationCommandHost } from "./legacy-classification-command.js";

export interface NativeLegacyClassificationCommandPolicy extends Omit<LegacyClassificationCommandHost, "assertNoOtherPending" | "globalReceipt" | "writeGlobalReceipt"> {
  scope: "exclusive-native-disposable-fixture";
  sourceRelative: string;
  sourceRootId: string;
}
export function createLegacyClassificationCommandComposition(storage: Storage, db: DatabaseSync, workspaceId: string,
  policy: NativeLegacyClassificationCommandPolicy, assertSqlOwner: () => void) {
  if (policy.scope !== "exclusive-native-disposable-fixture" || !resourcePath.safeParse(policy.sourceRelative).success
    || !policy.sourceRelative.startsWith("packages/") || !/^[a-f0-9]{64}$/.test(policy.sourceRootId)
    || !["assertOwnedDisposableFixture", "authorize", "previewOriginal", "reviewedPreview", "isPrivate",
      "assertHistoryAnchor", "approveHistoryTransition", "assertPendingAnchor", "approvePendingTransition", "approveRecovery"].every(k => typeof policy[k as keyof NativeLegacyClassificationCommandPolicy] === "function"))
    throw new CoreError("INVALID_CONFIGURATION", "Original classification requires explicit native fixture, preview and epoch/history authority.");
  const scope = { workspaceId, sourceRootId: policy.sourceRootId, root: join(storage.workspaceRoot(), policy.sourceRelative) };
  const host: LegacyClassificationCommandHost = {
    ...policy,
    assertNoOtherPending(database) {
      assertSqlOwner();
      for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        const name = String(row.name);
        if (name === "legacy_classification_command_intent") continue;
        if ((/^(?:pending_|legacy_.*_intent$)|_intents$|_pending$|journal/i.test(name))
          && database.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get())
          throw new CoreError("RECOVERY_REQUIRED", "Another durable workspace effect is unresolved.", "unknown");
      }
      if (database.prepare("SELECT 1 FROM legacy_memory_erasure_operations WHERE status<>'committed' LIMIT 1").get()
        || database.prepare("SELECT 1 FROM coding_worker_effects WHERE state='intent' LIMIT 1").get()
        || database.prepare("SELECT 1 FROM coding_worker_records WHERE kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent' LIMIT 1").get())
        throw new CoreError("RECOVERY_REQUIRED", "Another durable native effect is unresolved.", "unknown");
    },
    globalReceipt(database, id) {
      const row = database.prepare("SELECT fingerprint,result,actor_id,operation FROM receipts WHERE operation_id=?").get(id);
      return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) } : null;
    },
    writeGlobalReceipt(database, id, fingerprint, result) {
      assertSqlOwner();
      const pending = database.prepare("SELECT payload FROM legacy_classification_command_intent WHERE operation_id=?").get(id);
      const actorId = JSON.parse(String(pending!.payload)).actor.id;
      database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(id, fingerprint, JSON.stringify(result), actorId, LEGACY_CLASSIFICATION_COMMAND_ID, new Date().toISOString());
    },
  };
  let active = false;
  const verify = () => {
    const checked = verifyLegacyClassificationCommandHistory(db, host, scope);
    for (const receipt of checked.receipts) {
      const global = db.prepare("SELECT actor_id,operation FROM receipts WHERE operation_id=?").get(receipt.request.operationId);
      if (!global || global.actor_id !== receipt.actor.id || global.operation !== LEGACY_CLASSIFICATION_COMMAND_ID)
        throw new CoreError("RECOVERY_CONFLICT", "Original classification actor or operation provenance differs.", "unknown");
    }
    return checked;
  };
  return {
    verify,
    available(actor: Readonly<Actor> | undefined) {
      if (!actor?.canWrite || actor.collaborationKind !== "human") return false;
      try { policy.assertOwnedDisposableFixture(); return policy.authorize(actor, scope, "preview") || policy.authorize(actor, scope, "apply") || policy.authorize(actor, scope, "rollback"); }
      catch { return false; }
    },
    dispatch(args: Record<string, unknown>, actor: Actor) {
      if (active) throw new CoreError("BUSY", "Original classification fixture operation is active.");
      active = true;
      return storage.withWorkspaceExclusive(() => executeLegacyClassificationCommand(db, host, scope, actor, args))
        .finally(() => { active = false; });
    },
  };
}
