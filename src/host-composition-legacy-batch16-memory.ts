import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "./contracts.js";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import type { Storage } from "./storage.js";
import {
  LegacyMemoryErasureError, LegacyMemoryErasureService,
  validateLegacyMemoryErasureLedger,
  type LegacyMemoryErasureGlobalReceipt, type LegacyMemoryForgetAuthorizationRequest,
  type LegacyMemoryForgetDecision,
} from "./legacy-memory-erasure.js";
import { LegacyMemoryErasureOwnedWorker } from "./legacy-memory-erasure-worker.js";
import { inspectPausedSnapshotJournal } from "./host-composition-legacy-snapshot-restore.js";
import { remoteRuntimePending } from "./remote-runtime.js";

export function inspectBatch16MemoryLedger(db: DatabaseSync, workspaceId: string) {
  return validateLegacyMemoryErasureLedger(db, workspaceId, { readGlobalReceipt: readMemoryGlobalReceipt });
}

function readMemoryGlobalReceipt(db: DatabaseSync, id: string): LegacyMemoryErasureGlobalReceipt | null {
  const row = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(id);
  if (!row) return null;
  return { operationId: id, actorId: String(row.actor_id), fingerprint: String(row.fingerprint),
    operation: String(row.operation) as "memory.scope.forget.native", result: JSON.parse(String(row.result)) };
}

export interface NativeBatch16MemoryPolicy {
  scope: "exclusive-native-disposable-fixture";
  worker: LegacyMemoryErasureOwnedWorker;
  authorizeActor(actor: Readonly<Actor>): boolean;
  authorizeForget(request: Readonly<LegacyMemoryForgetAuthorizationRequest>): Promise<LegacyMemoryForgetDecision | null> | LegacyMemoryForgetDecision | null;
  /** SQL-only check of live independent epoch/actor authority, including committed retries. */
  assertSqlAuthority(database: DatabaseSync, actor: Readonly<Actor>, operationId: string): void;
}

export function createBatch16MemoryComposition(storage: Storage, workspaceId: string,
  policy: NativeBatch16MemoryPolicy) {
  if (policy.scope !== "exclusive-native-disposable-fixture" || !(policy.worker instanceof LegacyMemoryErasureOwnedWorker)
    || !["authorizeActor", "authorizeForget", "assertSqlAuthority"].every(key => typeof policy[key as keyof NativeBatch16MemoryPolicy] === "function"))
    throw new CoreError("INVALID_CONFIGURATION", "Memory erasure requires the owned disposable worker and native actor/epoch authority.");
  const lease = storage.workspaceLease();
  function sqlLease(db: DatabaseSync) {
    const owner = db.prepare("SELECT owner_id,fence,lease_until FROM native_runtime_owner WHERE singleton=1").get();
    if (!db.isTransaction || !owner || owner.owner_id !== lease.ownerId || owner.fence !== lease.fence
      || Number(owner.lease_until) <= Date.now()) throw new CoreError("STORAGE_UNAVAILABLE", "Native memory owner lease was fenced.", "unknown");
  }
  function admission(db: DatabaseSync, actor: Actor, operationId: string) {
    sqlLease(db);
    policy.assertSqlAuthority(db, actor, operationId);
    inspectBatch16MemoryLedger(db, workspaceId);
    if (remoteRuntimePending(db) || inspectPausedSnapshotJournal(db))
      throw new CoreError("RECOVERY_REQUIRED", "Another native effect is unresolved.", "unknown");
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const name = String(row.name);
      if (name === "remote_runtime_intents") continue;
      if ((/^(?:pending_|legacy_.*_intent$)|_intents$|_pending$|journal/i.test(name))
        && db.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get())
        throw new CoreError("RECOVERY_REQUIRED", "Another durable workspace effect is unresolved.", "unknown");
    }
    if (db.prepare("SELECT 1 FROM legacy_memory_erasure_operations WHERE status='pending' AND operation_id<>? LIMIT 1").get(operationId)
      || db.prepare("SELECT 1 FROM coding_worker_effects WHERE state='intent' LIMIT 1").get()
      || db.prepare("SELECT 1 FROM coding_worker_records WHERE kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent' LIMIT 1").get())
      throw new CoreError("RECOVERY_REQUIRED", "Another native effect is unresolved.", "unknown");
  }
  function service(actor: Actor) {
    return new LegacyMemoryErasureService(storage, policy.worker.engineBinding(), {
      actorId: actor.id,
      acquireMemoryQuiescence: () => policy.worker.acquireMemoryQuiescence(),
      assertEffectAuthority: request => policy.worker.assertEffectAuthority(request),
      authorizeForget: request => policy.authorizeForget(request),
      sql: {
        assertSqlLease: sqlLease,
        assertSqlAdmission: (db, context) => admission(db, actor, context.operationId),
        readGlobalReceipt: readMemoryGlobalReceipt,
        writeGlobalReceipt(db, receipt) {
          db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(receipt.operationId, receipt.fingerprint,
            JSON.stringify(receipt.result), receipt.actorId, receipt.operation, new Date().toISOString());
        },
        authorizeReceiptReplay(db, receipt) {
          policy.assertSqlAuthority(db, actor, receipt.operationId);
          return policy.authorizeActor(actor) === true;
        },
      },
    });
  }
  return {
    available(actor: Readonly<Actor> | undefined) {
      if (!actor?.canWrite || actor.collaborationKind !== "human") return false;
      try { return policy.authorizeActor(actor) === true; } catch { return false; }
    },
    async dispatch(args: Record<string, unknown>, actor: Actor) {
      if (!this.available(actor)) throw new CoreError("ACCESS_DENIED", "Native memory authority denied.");
      try { return await service(actor).forget(args); }
      catch (error) {
        if (error instanceof LegacyMemoryErasureError)
          throw new CoreError(error.code, error.message, /RECOVERY|CORRUPT/.test(error.code) ? "unknown" : "not-committed");
        throw error;
      }
    },
    preview(actor: Actor, scope: string) {
      if (!this.available(actor)) throw new CoreError("ACCESS_DENIED", "Native memory authority denied.");
      return service(actor).preview(scope);
    },
    workspaceId,
  };
}
