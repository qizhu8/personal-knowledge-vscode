import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ExecutionStatus = "pending" | "awaiting_approval" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface ExecutionRecord {
  id: string; actor: string; revision: number; status: ExecutionStatus;
  tool: string; arguments: Record<string, unknown>; approvalRequired: boolean;
  approvalDecisionId: string | null; createdAt: number; updatedAt: number;
}
export interface ExecutionEvent {
  sequence: number; executionId: string; revision: number; action: string;
  status: ExecutionStatus; operationId: string; at: number;
}
export type ExecutionAuthorizer = (request: Readonly<{
  operationId: string; record: Readonly<ExecutionRecord>;
}>) => Promise<{ decisionId: string; actorId: string } | null>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(value: unknown, name: string, max = 256): asserts value is string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || /[\u0000-\u001f]/u.test(value))
    throw new Error(`Invalid ${name}.`);
}
function operation(value: string) { if (!uuid.test(value)) throw new Error("Invalid operation ID."); }
function jsonArgs(value: Record<string, unknown>): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Arguments must be an object.");
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > 16000) throw new Error("Arguments exceed the 16000-byte limit.");
  const decoded: unknown = JSON.parse(encoded);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Arguments must be a JSON object.");
  return encoded;
}
function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}.`);
}
function budget(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid page limit.");
}
type Row = { id: string; actor: string; revision: number; status: ExecutionStatus; tool: string; arguments_json: string;
  approval_required: number; approval_decision_id: string | null; created_at: number; updated_at: number };
function record(row: Row): ExecutionRecord {
  return { id: row.id, actor: row.actor, revision: row.revision, status: row.status, tool: row.tool,
    arguments: JSON.parse(row.arguments_json), approvalRequired: row.approval_required === 1,
    approvalDecisionId: row.approval_decision_id, createdAt: row.created_at, updatedAt: row.updated_at };
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
function fingerprint(value: ExecutionRecord) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * All mutations must run inside the caller's SQLite transaction, alongside its
 * durable operation receipt. This class never invokes a tool or model.
 */
export class ExecutionStateStore {
  private readonly tokens = new WeakMap<object, { actor: string; id: string; revision: number; operationId: string; fingerprint: string; decisionId: string }>();
  constructor(private readonly db: DatabaseSync, private readonly authorizer?: ExecutionAuthorizer) {}

  initialize(): void {
    this.transactionRequired();
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('execution_schema','execution_records','execution_events')").all();
    if (existing.length) {
      if (existing.length !== 3) throw new Error("Incomplete execution-state schema.");
      const versions = this.db.prepare("SELECT version FROM execution_schema").all() as { version: number }[];
      if (versions.length !== 1 || versions[0].version !== 1) throw new Error("Unsupported execution-state schema version.");
      return;
    }
    this.db.exec(`
      CREATE TABLE execution_schema (version INTEGER NOT NULL CHECK(version = 1));
      INSERT INTO execution_schema VALUES (1);
      CREATE TABLE execution_records (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, revision INTEGER NOT NULL,
        status TEXT NOT NULL, tool TEXT NOT NULL, arguments_json TEXT NOT NULL,
        approval_required INTEGER NOT NULL, approval_decision_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX execution_records_actor_id ON execution_records(actor, id);
      CREATE TABLE execution_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL,
        actor TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
        operation_id TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(actor, operation_id),
        FOREIGN KEY(execution_id) REFERENCES execution_records(id)
      );
      CREATE INDEX execution_events_actor_execution_sequence ON execution_events(actor, execution_id, sequence);
    `);
  }
  private transactionRequired() {
    if (!this.db.isTransaction) throw new Error("Execution mutation requires the caller's transaction.");
  }
  get(actor: string, id: string): ExecutionRecord | null {
    text(actor, "actor"); text(id, "execution ID");
    const row = this.db.prepare("SELECT * FROM execution_records WHERE actor=? AND id=?").get(actor, id) as Row | undefined;
    return row ? record(row) : null;
  }
  list(actor: string, after = "", limit = 20): { records: ExecutionRecord[]; next: string | null } {
    text(actor, "actor"); if (after) text(after, "cursor"); budget(limit, 50);
    const rows = this.db.prepare("SELECT * FROM execution_records WHERE actor=? AND id>? ORDER BY id LIMIT ?")
      .all(actor, after, limit + 1) as Row[];
    const page = rows.slice(0, limit).map(record);
    return { records: page, next: rows.length > limit ? page[page.length - 1].id : null };
  }
  events(actor: string, id: string, after = 0, limit = 20): { events: ExecutionEvent[]; next: number | null } {
    text(actor, "actor"); text(id, "execution ID"); budget(limit, 50);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid event cursor.");
    if (!this.get(actor, id)) throw new Error("Execution not found.");
    const rows = this.db.prepare(`SELECT sequence, execution_id AS executionId, revision, action, status,
      operation_id AS operationId, at FROM execution_events WHERE actor=? AND execution_id=? AND sequence>? ORDER BY sequence LIMIT ?`)
      .all(actor, id, after, limit + 1) as unknown as ExecutionEvent[];
    const page = rows.slice(0, limit);
    return { events: page, next: rows.length > limit ? page[page.length - 1].sequence : null };
  }
  create(actor: string, input: { tool: string; arguments: Record<string, unknown>; approvalRequired: boolean; operationId: string }): ExecutionRecord {
    this.transactionRequired(); text(actor, "actor"); text(input.tool, "tool"); operation(input.operationId);
    if (typeof input.approvalRequired !== "boolean") throw new Error("Invalid approval policy.");
    const args = jsonArgs(input.arguments), id = randomUUID(), now = Date.now();
    const status = input.approvalRequired ? "awaiting_approval" : "pending";
    this.db.prepare("INSERT INTO execution_records VALUES (?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)")
      .run(id, actor, status, input.tool, args, input.approvalRequired ? 1 : 0, now, now);
    this.event(actor, id, 1, "created", status, input.operationId, now);
    return this.get(actor, id)!;
  }
  async authorize(actor: string, id: string, expectedRevision: number, operationId: string): Promise<object> {
    if (this.db.isTransaction) throw new Error("Native authorization must occur outside a transaction.");
    text(actor, "actor"); operation(operationId); positive(expectedRevision, "revision");
    const current = this.get(actor, id);
    if (!current || current.revision !== expectedRevision || current.status !== "awaiting_approval") throw new Error("Approval is no longer pending.");
    if (!this.authorizer) throw new Error("Native human authorizer is unavailable.");
    const snapshot = freezeDeep(structuredClone(current));
    const decision = await this.authorizer(Object.freeze({ operationId, record: snapshot }));
    if (!decision) throw new Error("Approval declined.");
    text(decision.decisionId, "decision ID"); text(decision.actorId, "decision actor");
    if (decision.actorId !== actor) throw new Error("Approval actor mismatch.");
    const token = Object.freeze({});
    this.tokens.set(token, { actor, id, revision: expectedRevision, operationId, fingerprint: fingerprint(current), decisionId: decision.decisionId });
    return token;
  }
  commitApproval(token: object): ExecutionRecord {
    this.transactionRequired();
    const grant = this.tokens.get(token);
    if (!grant) throw new Error("Invalid native approval.");
    this.tokens.delete(token);
    const current = this.get(grant.actor, grant.id);
    if (!current || current.status !== "awaiting_approval" || current.revision !== grant.revision || fingerprint(current) !== grant.fingerprint)
      throw new Error("Approval is stale.");
    return this.transition(current, grant.operationId, "approved", "pending", current.arguments, grant.decisionId);
  }
  revise(actor: string, id: string, expectedRevision: number, operationId: string, args: Record<string, unknown>): ExecutionRecord {
    const current = this.require(actor, id, expectedRevision, operationId);
    if (!["pending", "awaiting_approval"].includes(current.status)) throw new Error("Execution cannot be revised.");
    jsonArgs(args);
    return this.transition(current, operationId, "revised", current.approvalRequired ? "awaiting_approval" : "pending", args, null);
  }
  cancel(actor: string, id: string, expectedRevision: number, operationId: string): ExecutionRecord {
    const current = this.require(actor, id, expectedRevision, operationId);
    if (!["pending", "awaiting_approval", "running"].includes(current.status)) throw new Error("Execution cannot be cancelled.");
    return this.transition(current, operationId, "cancel_requested", current.status === "running" ? "unknown" : "cancelled", current.arguments, null);
  }
  /** Trusted adapter observations only; never expose through untrusted transports. */
  observe(actor: string, id: string, expectedRevision: number, operationId: string,
    observation: "started" | "succeeded" | "failed" | "interrupted"): ExecutionRecord {
    const current = this.require(actor, id, expectedRevision, operationId);
    if (observation === "started") {
      if (current.status !== "pending" || (current.approvalRequired && !current.approvalDecisionId)) throw new Error("Execution is not authorized to start.");
    } else if (current.status !== "running") throw new Error("Execution is not running.");
    const status: ExecutionStatus = observation === "started" ? "running" : observation === "interrupted" ? "unknown" : observation;
    return this.transition(current, operationId, observation, status, current.arguments, current.approvalDecisionId);
  }
  private require(actor: string, id: string, revision: number, operationId: string) {
    this.transactionRequired(); operation(operationId); positive(revision, "revision");
    const current = this.get(actor, id);
    if (!current || current.revision !== revision) throw new Error("Execution not found or revision conflict.");
    return current;
  }
  private transition(current: ExecutionRecord, operationId: string, action: string, status: ExecutionStatus,
    args: Record<string, unknown>, decision: string | null): ExecutionRecord {
    const now = Date.now(), revision = current.revision + 1;
    const result = this.db.prepare(`UPDATE execution_records SET revision=?,status=?,arguments_json=?,approval_decision_id=?,updated_at=?
      WHERE actor=? AND id=? AND revision=?`).run(revision, status, jsonArgs(args), decision, now, current.actor, current.id, current.revision);
    if (result.changes !== 1) throw new Error("Execution revision conflict.");
    this.event(current.actor, current.id, revision, action, status, operationId, now);
    return this.get(current.actor, current.id)!;
  }
  private event(actor: string, id: string, revision: number, action: string, status: ExecutionStatus, operationId: string, at: number) {
    this.db.prepare("INSERT INTO execution_events(execution_id,actor,revision,action,status,operation_id,at) VALUES (?,?,?,?,?,?,?)")
      .run(id, actor, revision, action, status, operationId, at);
  }
}
