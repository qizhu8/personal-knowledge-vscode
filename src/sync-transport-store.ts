import type { DatabaseSync } from "node:sqlite";
import { syncPlanHash } from "./sync-plan.js";
import {
  syncTransportPublicationSchema, syncTransportStatusSchema,
  type SyncTransportPublication, type SyncTransportStatus,
} from "./sync-transport-contracts.js";

export type SyncTransportJournal = {
  publication: SyncTransportPublication; status: SyncTransportStatus;
  pending?: { method: "POST" | "PATCH"; path: string; body: unknown; expectedSha?: string };
};

export function initializeSyncTransportStore(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_transport_intents (
    operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, plan_hash TEXT NOT NULL,
    journal_json TEXT NOT NULL, revision INTEGER NOT NULL
  ) STRICT;`);
}

/** Uses the integrator's shared database. No private database or filesystem journal is created. */
export class SyncTransportStore {
  constructor(private readonly db: DatabaseSync, private readonly receiptHook: (journal: SyncTransportJournal) => void) {}

  read(operationId: string, actorId: string): SyncTransportJournal | undefined {
    const row = this.db.prepare("SELECT actor_id, journal_json FROM sync_transport_intents WHERE operation_id = ?").get(operationId);
    if (!row || row.actor_id !== actorId) return undefined;
    const result = JSON.parse(String(row.journal_json)) as SyncTransportJournal;
    result.publication = syncTransportPublicationSchema.parse(result.publication);
    result.status = syncTransportStatusSchema.parse(result.status);
    return result;
  }

  /** Host hook and receipt are committed before any remote mutation; nested transactions are forbidden. */
  prepare(publication: SyncTransportPublication): SyncTransportJournal {
    const plan = syncTransportPublicationSchema.parse(publication);
    const { planHash, ...unsigned } = plan;
    if (syncPlanHash(unsigned) !== planHash) throw new Error("Publication hash mismatch");
    if (this.db.isTransaction) throw new Error("Publication intent requires a durable top-level commit");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT plan_hash, actor_id FROM sync_transport_intents WHERE operation_id = ?").get(plan.operationId);
      if (prior) {
        if (prior.plan_hash !== plan.planHash || prior.actor_id !== plan.actorId) throw new Error("Publication operation identity reused");
        const result = this.read(plan.operationId, plan.actorId)!;
        this.db.exec("COMMIT");
        return result;
      }
      const journal: SyncTransportJournal = { publication: plan, status: {
        schema: "pkm.sync-transport-status/v1", operationId: plan.operationId, policyId: plan.policyId,
        planHash: plan.planHash, state: "prepared", expectedCommit: plan.expectedCommit,
      } };
      this.db.prepare("INSERT INTO sync_transport_intents VALUES (?, ?, ?, ?, 1)").run(plan.operationId, plan.actorId, plan.planHash, JSON.stringify(journal));
      this.receiptHook(journal);
      this.db.exec("COMMIT");
      return journal;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  transition(journal: SyncTransportJournal, state: SyncTransportStatus["state"], changes: Partial<SyncTransportJournal> = {}): SyncTransportJournal {
    if (this.db.isTransaction) throw new Error("Remote receipts require durable top-level commit");
    const result = { ...journal, ...changes, status: syncTransportStatusSchema.parse({ ...journal.status, ...changes.status, state }) };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(`UPDATE sync_transport_intents SET journal_json = ?, revision = revision + 1
        WHERE operation_id = ? AND actor_id = ? AND journal_json = ?`).run(
        JSON.stringify(result), journal.publication.operationId, journal.publication.actorId, JSON.stringify(journal));
      if (update.changes !== 1) throw new Error("Publication journal advanced concurrently");
      this.receiptHook(result);
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
