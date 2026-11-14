import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { RUNTIME_PROCESS_LIMITS, runtimeProcessJob, runtimeProcessEvent, type RuntimeProcessJob, type RuntimeProcessEvent } from "./runtime-process-contracts.js";

export class RuntimeProcessError extends Error {
  constructor(readonly code: string, message: string, readonly effect: "not-committed" | "unknown" = "not-committed") {
    super(message);
  }
}

export const RUNTIME_PROCESS_DDL = `
CREATE TABLE IF NOT EXISTS runtime_process_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  owner_id TEXT NOT NULL, closed INTEGER NOT NULL CHECK(closed IN (0,1))
);
CREATE TABLE IF NOT EXISTS runtime_process_jobs (
  job_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, state TEXT NOT NULL, fingerprint TEXT NOT NULL, record_json TEXT NOT NULL,
  UNIQUE(actor_id, operation_id)
);
CREATE INDEX IF NOT EXISTS runtime_process_actor ON runtime_process_jobs(actor_id, job_id);
CREATE TABLE IF NOT EXISTS runtime_process_events (
  job_id TEXT NOT NULL REFERENCES runtime_process_jobs(job_id), sequence INTEGER NOT NULL,
  record_json TEXT NOT NULL, PRIMARY KEY(job_id, sequence)
);
`;

/** Inject the isolated shared connection, not a path. This store never closes its caller's database.
 * A takeover is a trusted host decision with exact prior-owner CAS, not a PID/liveness probe.
 */
export class RuntimeProcessStore {
  constructor(readonly database: DatabaseSync, readonly ownerId: string,
    private readonly eventCapacity: number, previousOwnerId?: string) {
    z.string().uuid().parse(ownerId);
    if (previousOwnerId !== undefined) z.string().uuid().parse(previousOwnerId);
    if (!Number.isSafeInteger(eventCapacity) || eventCapacity < 1 || eventCapacity > RUNTIME_PROCESS_LIMITS.events) {
      throw new RuntimeProcessError("INVALID_LIMIT", "Invalid durable event ring capacity.");
    }
    this.outsideTransaction();
    database.exec(RUNTIME_PROCESS_DDL);
    this.atomic(() => {
      const owner = database.prepare("SELECT owner_id, closed FROM runtime_process_owner WHERE singleton=1").get();
      if (owner && owner.closed !== 1 && owner.owner_id !== previousOwnerId) {
        throw new RuntimeProcessError("OWNERSHIP_CONFLICT", "An explicit exact-owner takeover is required.");
      }
      if (previousOwnerId !== undefined && owner?.owner_id !== previousOwnerId) {
        throw new RuntimeProcessError("OWNERSHIP_CONFLICT", "The prior owner changed.");
      }
      database.prepare("INSERT INTO runtime_process_owner VALUES(1,?,0) ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,closed=0").run(ownerId);
      const rows = database.prepare("SELECT record_json FROM runtime_process_jobs WHERE state IN ('QUEUED','RUNNING','PAUSED')").all();
      for (const row of rows) {
        const job = runtimeProcessJob.parse(JSON.parse(String(row.record_json)));
        const running = job.state === "RUNNING" || job.state === "PAUSED";
        job.state = "INTERRUPTED";
        job.effect = running ? "unknown" : "not-started";
        job.reason = "restart";
        job.finishedAt = Date.now();
        this.write(job, "interrupted");
      }
    }, false);
  }
  private outsideTransaction() {
    if (this.database.isTransaction) throw new RuntimeProcessError("TRANSACTION_BOUNDARY", "Process service calls must run outside SQLite transactions.");
  }
  private owns() {
    const owner = this.database.prepare("SELECT owner_id, closed FROM runtime_process_owner WHERE singleton=1").get();
    if (owner?.owner_id !== this.ownerId || owner.closed !== 0) {
      throw new RuntimeProcessError("OWNERSHIP_LOST", "Runtime process ownership is no longer current.", "unknown");
    }
  }
  private atomic<T>(fn: () => T, guard = true): T {
    this.outsideTransaction();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (guard) this.owns();
      const result = fn();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  assertOwner() { this.outsideTransaction(); this.owns(); }
  private write(job: RuntimeProcessJob, kind: RuntimeProcessEvent["kind"], bytes?: number) {
    const next = runtimeProcessJob.parse({ ...job, eventSequence: job.eventSequence + 1 });
    const event = runtimeProcessEvent.parse({
      sequence: next.eventSequence, at: Date.now(), jobId: job.jobId, kind, state: job.state,
      ...(bytes === undefined ? {} : { bytes }),
    });
    this.database.prepare("UPDATE runtime_process_jobs SET state=?,record_json=? WHERE job_id=?").run(next.state, JSON.stringify(next), job.jobId);
    this.database.prepare("INSERT INTO runtime_process_events VALUES(?,?,?)").run(job.jobId, event.sequence, JSON.stringify(event));
    this.database.prepare("DELETE FROM runtime_process_events WHERE job_id=? AND sequence<=?").run(job.jobId, event.sequence - this.eventCapacity);
    job.eventSequence = next.eventSequence;
  }
  insert(job: RuntimeProcessJob, fingerprint: string, capacity: number) {
    this.atomic(() => {
      if (Number(this.database.prepare("SELECT count(*) AS n FROM runtime_process_jobs").get()!.n) >= capacity) {
        throw new RuntimeProcessError("JOB_CAPACITY", "Durable job receipt capacity reached; trusted archival is required.");
      }
      this.database.prepare("INSERT INTO runtime_process_jobs VALUES(?,?,?,?,?,?,?)")
        .run(job.jobId, job.actorId, job.operationId, job.ownerId, job.state, fingerprint, JSON.stringify(job));
      this.write(job, "queued");
    });
  }
  save(job: RuntimeProcessJob, kind: RuntimeProcessEvent["kind"], bytes?: number) {
    this.atomic(() => this.write(job, kind, bytes));
  }
  receipt(actorId: string, operationId: string) {
    this.outsideTransaction();
    const row = this.database.prepare("SELECT record_json,fingerprint FROM runtime_process_jobs WHERE actor_id=? AND operation_id=?").get(actorId, operationId);
    return row ? { job: runtimeProcessJob.parse(JSON.parse(String(row.record_json))), fingerprint: String(row.fingerprint) } : undefined;
  }
  get(actorId: string, jobId: string): RuntimeProcessJob {
    this.outsideTransaction();
    const row = this.database.prepare("SELECT record_json FROM runtime_process_jobs WHERE actor_id=? AND job_id=?").get(actorId, jobId);
    if (!row) throw new RuntimeProcessError("NOT_FOUND", "Owned job not found.");
    return runtimeProcessJob.parse(JSON.parse(String(row.record_json)));
  }
  list(actorId: string, offset: number, limit: number) {
    this.outsideTransaction();
    return {
      items: this.database.prepare("SELECT record_json FROM runtime_process_jobs WHERE actor_id=? ORDER BY job_id LIMIT ? OFFSET ?")
        .all(actorId, limit, offset).map(row => runtimeProcessJob.parse(JSON.parse(String(row.record_json)))),
      total: Number(this.database.prepare("SELECT count(*) AS n FROM runtime_process_jobs WHERE actor_id=?").get(actorId)!.n),
    };
  }
  events(actorId: string, jobId: string, after: number, limit: number) {
    const job = this.get(actorId, jobId);
    const oldestSequence = Number(this.database.prepare("SELECT min(sequence) AS n FROM runtime_process_events WHERE job_id=?").get(jobId)!.n ?? 0);
    return {
      items: this.database.prepare("SELECT record_json FROM runtime_process_events WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT ?")
        .all(jobId, after, limit).map(row => runtimeProcessEvent.parse(JSON.parse(String(row.record_json)))),
      oldestSequence, latestSequence: job.eventSequence, gap: after < oldestSequence - 1,
    };
  }
  release() {
    this.atomic(() => { this.database.prepare("UPDATE runtime_process_owner SET closed=1 WHERE singleton=1 AND owner_id=?").run(this.ownerId); });
  }
}
