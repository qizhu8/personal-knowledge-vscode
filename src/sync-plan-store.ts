import type { DatabaseSync } from "node:sqlite";
import { syncPlanCreateSchema, syncPlanDecisionSchema, type SyncPlanCreate, type SyncPlanDecision } from "./sync-plan-contracts.js";
import { planSync, syncPlanHash, type SyncPlan } from "./sync-plan.js";

type Decision = {
  operationId: string; actorId: string; conflictId: string; choice: SyncPlanDecision["choice"];
  reason: string; revision: number;
};
export type SyncPlanSession = { sessionId: string; revision: number; plan: SyncPlan; decisions: Decision[] };

/** Call once on the caller-owned DatabaseSync connection before using the store. */
export function initializeSyncPlanStore(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_plan_sessions (
      session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision >= 1), plan_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_plan_decisions (
      operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sync_plan_sessions(session_id),
      revision INTEGER NOT NULL, actor_id TEXT NOT NULL, conflict_id TEXT NOT NULL,
      choice TEXT NOT NULL, reason TEXT NOT NULL, UNIQUE(session_id, revision)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_plan_operations (
      operation_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_plan_owners (
      session_id TEXT PRIMARY KEY REFERENCES sync_plan_sessions(session_id), actor_id TEXT NOT NULL
    ) STRICT;
  `);
}

export class SyncPlanStore {
  constructor(private readonly db: DatabaseSync) {}

  get(sessionId: string): SyncPlanSession | undefined {
    const row = this.db.prepare("SELECT revision, plan_json FROM sync_plan_sessions WHERE session_id = ?").get(sessionId);
    if (!row) return undefined;
    const decisions = this.db.prepare(`SELECT operation_id, actor_id, conflict_id, choice, reason, revision
      FROM sync_plan_decisions WHERE session_id = ? ORDER BY revision`).all(sessionId).map(value => ({
      operationId: String(value.operation_id), actorId: String(value.actor_id), conflictId: String(value.conflict_id),
      choice: value.choice as Decision["choice"], reason: String(value.reason), revision: Number(value.revision),
    }));
    return { sessionId, revision: Number(row.revision), plan: JSON.parse(String(row.plan_json)) as SyncPlan, decisions };
  }

  private operation(operationId: string, payload: unknown, run: () => SyncPlanSession): SyncPlanSession {
    const hash = syncPlanHash(payload);
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT sync_plan_operation" : "BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT payload_hash, result_json FROM sync_plan_operations WHERE operation_id = ?").get(operationId);
      if (previous) {
        if (previous.payload_hash !== hash) throw new Error("operationId reused with different request");
        const result = JSON.parse(String(previous.result_json)) as SyncPlanSession;
        this.db.exec(nested ? "RELEASE sync_plan_operation" : "COMMIT");
        return result;
      }
      const result = run();
      this.db.prepare("INSERT INTO sync_plan_operations VALUES (?, ?, ?)").run(operationId, hash, JSON.stringify(result));
      this.db.exec(nested ? "RELEASE sync_plan_operation" : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(nested ? "ROLLBACK TO sync_plan_operation; RELEASE sync_plan_operation" : "ROLLBACK");
      throw error;
    }
  }

  create(request: SyncPlanCreate): SyncPlanSession {
    const args = syncPlanCreateSchema.parse(request);
    const plan = planSync(args.input);
    return this.operation(args.operationId, { kind: "create", ...args }, () => {
      if (this.get(args.sessionId)) throw new Error("Session already exists");
      this.db.prepare("INSERT INTO sync_plan_sessions VALUES (?, 1, ?)").run(args.sessionId, JSON.stringify(plan));
      return this.get(args.sessionId)!;
    });
  }

  decide(request: SyncPlanDecision): SyncPlanSession {
    const args = syncPlanDecisionSchema.parse(request);
    return this.operation(args.operationId, { kind: "decide", ...args }, () => {
      const current = this.get(args.sessionId);
      if (!current) throw new Error("Session not found");
      if (current.revision !== args.expectedRevision) throw new Error("Session revision mismatch");
      const conflict = current.plan.conflicts.find(item => item.id === args.conflictId);
      if (!conflict) throw new Error("Conflict not found");
      if (args.choice !== "delete" && conflict[args.choice].kind === "absent") throw new Error("Absent variant cannot be selected; explicitly propose delete instead");
      const revision = current.revision + 1;
      const update = this.db.prepare("UPDATE sync_plan_sessions SET revision = ? WHERE session_id = ? AND revision = ?")
        .run(revision, args.sessionId, args.expectedRevision);
      if (update.changes !== 1) throw new Error("Session revision mismatch");
      this.db.prepare(`INSERT INTO sync_plan_decisions
        (operation_id, session_id, revision, actor_id, conflict_id, choice, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(args.operationId, args.sessionId, revision, args.actorId, args.conflictId, args.choice, args.reason);
      return this.get(args.sessionId)!;
    });
  }
}
