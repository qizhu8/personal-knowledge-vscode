import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ExecutionStateStore, type ExecutionRecord } from "./execution-state.js";
import { approvalBridgeDigest, approvalBridgeFreeze, approvalBridgeJSON, approvalBridgeRecordDigest } from "./domain/approval-bridge-digest.js";
import type {
  ApprovalBridgeBinding, ApprovalBridgeContext, ApprovalBridgeEvent, ApprovalBridgeOptions,
  ApprovalBridgeResult, ApprovalRequest, ApprovalRequestStatus,
} from "./approval-bridge-contracts.js";
export type * from "./approval-bridge-contracts.js";

const text = z.string().trim().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const operation = z.uuid();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const contextSchema = z.strictObject({ turnId: text, contextDigest: digest, readOnly: z.boolean() });
const pinSchema = z.strictObject({ executionId: text, expectedRevision: revision, operationId: operation });
const createSchema = z.strictObject({
  tool: text, arguments: z.record(z.string(), z.unknown()), approvalRequired: z.boolean(),
  operationId: operation, context: contextSchema,
});
const cancelSchema = z.strictObject({ id: text, expectedRevision: revision, operationId: operation });
const decisionSchema = z.strictObject({ decision: z.enum(["approve", "reject"]), decisionId: text, actorId: text });
const hostSchema = z.strictObject({ status: z.enum(["succeeded", "failed"]), result: z.unknown().optional() });
const memoryDecision = /^(?:memory[._]record[._](?:confirm|revise|revoke))$/;
type BindingRow = { execution_id: string; workspace_id: string; actor_id: string; operation_id: string; input_digest: string; context_json: string };
type RequestRow = {
  id: string; workspace_id: string; actor_id: string; execution_id: string; execution_revision: number;
  revision: number; status: ApprovalRequestStatus; operation_id: string; record_digest: string; arguments_digest: string;
  decision_id: string | null; resolved_execution_revision: number | null; created_at: number; updated_at: number;
};
type RunRow = { operation_id: string; expected_revision: number; started_revision: number; status: string; result_json: string | null };
function project(row: RequestRow): ApprovalRequest {
  return { id: row.id, workspaceId: row.workspace_id, actorId: row.actor_id, executionId: row.execution_id,
    executionRevision: row.execution_revision, revision: row.revision, status: row.status,
    operationId: row.operation_id, recordDigest: row.record_digest, argumentsDigest: row.arguments_digest,
    decisionId: row.decision_id, resolvedExecutionRevision: row.resolved_execution_revision,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function sync<T>(result: T): T {
  if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Storage callbacks must be synchronous.");
  return result;
}
function limit(value: number) { return z.number().int().min(1).max(50).parse(value); }

export function initializeApprovalBridgeSchema(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error("Approval bridge schema requires the parent's migration transaction.");
  new ExecutionStateStore(db).initialize();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (
    'approval_bridge_schema','approval_bridge_bindings','approval_bridge_requests','approval_bridge_events','approval_bridge_runs')`).all();
  if (tables.length !== 0 && tables.length !== 5) throw new Error("Incomplete approval bridge schema.");
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_bridge_schema(version INTEGER NOT NULL CHECK(version=1));
    INSERT INTO approval_bridge_schema SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM approval_bridge_schema);
    CREATE TABLE IF NOT EXISTS approval_bridge_bindings(
      execution_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      operation_id TEXT NOT NULL, input_digest TEXT NOT NULL, context_json TEXT NOT NULL,
      UNIQUE(workspace_id,actor_id,operation_id));
    CREATE TABLE IF NOT EXISTS approval_bridge_requests(
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      execution_id TEXT NOT NULL, execution_revision INTEGER NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL, operation_id TEXT NOT NULL, record_digest TEXT NOT NULL,
      arguments_digest TEXT NOT NULL, decision_id TEXT, resolved_execution_revision INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(workspace_id,actor_id,operation_id));
    CREATE INDEX IF NOT EXISTS approval_bridge_requests_scope ON approval_bridge_requests(workspace_id,actor_id,id);
    CREATE TABLE IF NOT EXISTS approval_bridge_events(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS approval_bridge_events_scope ON approval_bridge_events(workspace_id,actor_id,request_id,sequence);
    CREATE TABLE IF NOT EXISTS approval_bridge_runs(
      execution_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      operation_id TEXT NOT NULL, expected_revision INTEGER NOT NULL, started_revision INTEGER NOT NULL,
      status TEXT NOT NULL, result_json TEXT, UNIQUE(workspace_id,actor_id,operation_id));
  `);
  const versions = db.prepare("SELECT version FROM approval_bridge_schema").all() as { version: number }[];
  if (versions.length !== 1 || versions[0].version !== 1) throw new Error("Unsupported approval bridge schema.");
}

/**
 * New durable projection of native approval/reconnect boundaries, not recovery parity.
 * Only `public` belongs in a transport. Keep `native`, reviewer and dispatcher host-local.
 */
export function createApprovalBridge(options: ApprovalBridgeOptions) {
  const workspaceId = text.parse(options.workspaceId);
  const timeoutMs = z.number().int().min(1).max(3_600_000).parse(options.timeoutMs ?? 120_000);
  const resultBytes = z.number().int().min(1).max(131_072).parse(options.resultBytes ?? 65_536);
  const proofs = new WeakMap<object, { actor: string; executionId: string; revision: number; operationId: string; recordDigest: string }>();
  const reviewing = new Map<string, Promise<ApprovalRequest>>();
  function read<T>(fn: (db: DatabaseSync) => T): T {
    return sync(options.storage.read(db => {
      if (db.isTransaction) throw new Error("Bridge reads/review must be outside a transaction.");
      return sync(fn(db));
    }));
  }
  function tx<T>(fn: (db: DatabaseSync) => T): T {
    return sync(options.storage.transaction(db => {
      if (!db.isTransaction) throw new Error("Bridge mutation requires a transaction.");
      return sync(fn(db));
    }));
  }
  tx(initializeApprovalBridgeSchema);
  function binding(db: DatabaseSync, actor: string, executionId: string): BindingRow {
    text.parse(actor); text.parse(executionId);
    const row = db.prepare("SELECT * FROM approval_bridge_bindings WHERE execution_id=? AND workspace_id=? AND actor_id=?")
      .get(executionId, workspaceId, actor) as BindingRow | undefined;
    if (!row) throw new Error("Execution not found in this actor/workspace.");
    return row;
  }
  function requestRow(db: DatabaseSync, actor: string, id: string): RequestRow {
    text.parse(actor); text.parse(id);
    const row = db.prepare("SELECT * FROM approval_bridge_requests WHERE id=? AND workspace_id=? AND actor_id=?")
      .get(id, workspaceId, actor) as RequestRow | undefined;
    if (!row) throw new Error("Approval request not found.");
    return row;
  }
  function current(db: DatabaseSync, actor: string, executionId: string) {
    const bound = binding(db, actor, executionId), record = new ExecutionStateStore(db).get(actor, executionId);
    if (!record) throw new Error("Execution not found.");
    return { record, context: contextSchema.parse(JSON.parse(bound.context_json)), operationId: bound.operation_id };
  }
  function event(db: DatabaseSync, row: RequestRow, action: string) {
    db.prepare("INSERT INTO approval_bridge_events(request_id,workspace_id,actor_id,revision,status,action,at) VALUES (?,?,?,?,?,?,?)")
      .run(row.id, workspaceId, row.actor_id, row.revision, row.status, action, row.updated_at);
  }
  function resolve(db: DatabaseSync, row: RequestRow, status: ApprovalRequestStatus, action: string,
    decisionId: string | null = null, executionRevision: number | null = null): ApprovalRequest {
    const changed = db.prepare(`UPDATE approval_bridge_requests SET revision=revision+1,status=?,decision_id=?,
      resolved_execution_revision=?,updated_at=? WHERE id=? AND revision=? AND status='pending'`)
      .run(status, decisionId, executionRevision, Date.now(), row.id, row.revision);
    if (changed.changes !== 1) throw new Error("Approval resolution conflict.");
    const updated = requestRow(db, row.actor_id, row.id);
    event(db, updated, action);
    return project(updated);
  }
  function matches(db: DatabaseSync, row: RequestRow): boolean {
    try {
      const { record, context, operationId } = current(db, row.actor_id, row.execution_id);
      return record.revision === row.execution_revision && record.status === "awaiting_approval"
        && approvalBridgeRecordDigest(workspaceId, record, context, operationId) === row.record_digest;
    } catch { return false; }
  }
  const publicPort = Object.freeze({
    request(actor: string, input: { executionId: string; expectedRevision: number; operationId: string }): ApprovalRequest {
      const parsed = pinSchema.parse(input);
      return tx(db => {
        const prior = db.prepare("SELECT * FROM approval_bridge_requests WHERE workspace_id=? AND actor_id=? AND operation_id=?")
          .get(workspaceId, actor, parsed.operationId) as RequestRow | undefined;
        if (prior) {
          if (prior.execution_id !== parsed.executionId || prior.execution_revision !== parsed.expectedRevision)
            throw new Error("Approval operation ID conflict.");
          return project(prior);
        }
        const { record, context, operationId } = current(db, actor, parsed.executionId);
        if (record.revision !== parsed.expectedRevision || record.status !== "awaiting_approval")
          throw new Error("Approval is no longer pending at this revision.");
        if (memoryDecision.test(record.tool)) throw new Error("Memory decisions require their separate native exact-memory authorizer.");
        const now = Date.now(), id = randomUUID();
        db.prepare(`INSERT INTO approval_bridge_requests VALUES(?,?,?,?,?,1,'pending',?,?,?,NULL,NULL,?,?)`)
          .run(id, workspaceId, actor, record.id, record.revision, parsed.operationId,
            approvalBridgeRecordDigest(workspaceId, record, context, operationId), approvalBridgeDigest(record.arguments), now, now);
        const row = requestRow(db, actor, id); event(db, row, "requested"); return project(row);
      });
    },
    get(actor: string, id: string): ApprovalRequest { return read(db => project(requestRow(db, actor, id))); },
    list(actor: string, after = "", count = 20): { requests: ApprovalRequest[]; next: string | null } {
      text.parse(actor); if (after) text.parse(after); limit(count);
      return read(db => {
        const rows = db.prepare("SELECT * FROM approval_bridge_requests WHERE workspace_id=? AND actor_id=? AND id>? ORDER BY id LIMIT ?")
          .all(workspaceId, actor, after, count + 1) as RequestRow[];
        const page = rows.slice(0, count).map(project);
        return { requests: page, next: rows.length > count ? page.at(-1)!.id : null };
      });
    },
    events(actor: string, id: string, after = 0, count = 20): { events: ApprovalBridgeEvent[]; next: number | null } {
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(after); limit(count);
      return read(db => {
        requestRow(db, actor, id);
        const rows = db.prepare(`SELECT sequence,request_id AS requestId,revision,status,action,at FROM approval_bridge_events
          WHERE workspace_id=? AND actor_id=? AND request_id=? AND sequence>? ORDER BY sequence LIMIT ?`)
          .all(workspaceId, actor, id, after, count + 1) as unknown as ApprovalBridgeEvent[];
        const page = rows.slice(0, count);
        return { events: page, next: rows.length > count ? page.at(-1)!.sequence : null };
      });
    },
    cancel(actor: string, input: { id: string; expectedRevision: number; operationId: string }): ApprovalRequest {
      const parsed = cancelSchema.parse(input);
      return tx(db => {
        const row = requestRow(db, actor, parsed.id);
        const prior = db.prepare("SELECT operation_id FROM execution_events WHERE actor=? AND execution_id=? AND operation_id=? AND action='cancel_requested'")
          .get(actor, row.execution_id, parsed.operationId);
        if (row.status === "cancelled" && prior && row.revision === parsed.expectedRevision + 1) return project(row);
        if (row.revision !== parsed.expectedRevision || row.status !== "pending") throw new Error("Only an own pending request can be cancelled.");
        if (!matches(db, row)) return resolve(db, row, "stale", "stale");
        const cancelled = new ExecutionStateStore(db).cancel(actor, row.execution_id, row.execution_revision, parsed.operationId);
        return resolve(db, row, "cancelled", "cancelled", null, cancelled.revision);
      });
    },
  });
  async function review(actor: string, id: string): Promise<ApprovalRequest> {
    const key = `${actor}\0${id}`, active = reviewing.get(key);
    if (active) return active;
    const task = (async () => {
      const snapshot = tx(db => {
        const row = requestRow(db, actor, id);
        if (row.status !== "pending") return { done: project(row) };
        if (!matches(db, row)) return { done: resolve(db, row, "stale", "stale") };
        const { record, context, operationId } = current(db, actor, row.execution_id);
        return { row, request: approvalBridgeFreeze(structuredClone({
          workspaceId, actorId: actor, operationId: row.operation_id, executionOperationId: operationId, recordDigest: row.record_digest,
          argumentsDigest: row.arguments_digest, context, record,
        })) };
      });
      if (snapshot.done) return snapshot.done;
      if (!options.reviewer) throw new Error("Native human reviewer unavailable.");
      read(() => undefined);
      const rawDecision = await options.reviewer(snapshot.request!);
      const decision = rawDecision === null ? null : decisionSchema.parse(rawDecision);
      if (decision && decision.actorId !== actor) throw new Error("Native decision actor mismatch.");
      const pending = tx(db => {
        const row = requestRow(db, actor, id);
        if (row.status !== "pending") return project(row);
        if (!matches(db, row)) return resolve(db, row, "stale", "stale");
        if (!decision || decision.decision === "reject") {
          const cancelled = new ExecutionStateStore(db).cancel(actor, row.execution_id, row.execution_revision, row.operation_id);
          return resolve(db, row, "rejected", "rejected", decision?.decisionId ?? null, cancelled.revision);
        }
        return null;
      });
      if (pending) return pending;
      const store = read(db => new ExecutionStateStore(db, async () => ({ decisionId: decision!.decisionId, actorId: actor })));
      const token = await store.authorize(actor, snapshot.row!.execution_id, snapshot.row!.execution_revision, snapshot.row!.operation_id);
      return tx(db => {
        const row = requestRow(db, actor, id);
        if (row.status !== "pending") return project(row);
        if (!matches(db, row)) return resolve(db, row, "stale", "stale");
        const approved = store.commitApproval(token);
        return resolve(db, row, "approved", "approved", decision!.decisionId, approved.revision);
      });
    })();
    reviewing.set(key, task);
    try { return await task; } finally { reviewing.delete(key); }
  }
  const dispatches = new Set<Promise<unknown>>();
  const nativePort = Object.freeze({
    activity: () => dispatches.size,
    create(actor: string, input: {
      tool: string; arguments: Record<string, unknown>; approvalRequired: boolean; operationId: string; context: ApprovalBridgeContext;
    }): ExecutionRecord {
      const parsed = createSchema.parse(input);
      if (memoryDecision.test(parsed.tool)) throw new Error("Memory decisions require their separate native exact-memory authorizer.");
      const encoded = approvalBridgeJSON(parsed.arguments);
      if (Buffer.byteLength(encoded) > 16000) throw new Error("Execution arguments exceed 16000 bytes.");
      const inputDigest = approvalBridgeDigest(parsed);
      return tx(db => {
        text.parse(actor);
        const prior = db.prepare("SELECT * FROM approval_bridge_bindings WHERE workspace_id=? AND actor_id=? AND operation_id=?")
          .get(workspaceId, actor, parsed.operationId) as BindingRow | undefined;
        if (prior) {
          if (prior.input_digest !== inputDigest) throw new Error("Execution operation ID conflict.");
          return current(db, actor, prior.execution_id).record;
        }
        const record = new ExecutionStateStore(db).create(actor, { ...parsed, operationId: randomUUID(), arguments: JSON.parse(encoded) });
        db.prepare("INSERT INTO approval_bridge_bindings VALUES(?,?,?,?,?,?)")
          .run(record.id, workspaceId, actor, parsed.operationId, inputDigest, approvalBridgeJSON(parsed.context));
        return record;
      });
    },
    review,
    async verifyApproval(bound: ApprovalBridgeBinding, proof: unknown, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted || !proof || typeof proof !== "object") return false;
      const grant = proofs.get(proof);
      if (!grant) return false;
      proofs.delete(proof);
      return read(db => {
        const { record, context, operationId } = current(db, grant.actor, grant.executionId);
        return !memoryDecision.test(record.tool) && record.status === "running" && record.revision === grant.revision
          && approvalBridgeRecordDigest(workspaceId, record, context, operationId) === grant.recordDigest
          && bound.workspaceId === workspaceId && bound.actorId === grant.actor && bound.operation === record.tool
          && bound.version === 1 && (bound.operationId === grant.operationId || context.readOnly && bound.operationId === undefined)
          && bound.turnId === context.turnId
          && bound.contextDigest === context.contextDigest && bound.readOnly === context.readOnly
          && bound.argumentsDigest === approvalBridgeDigest(record.arguments)
          && approvalBridgeDigest(bound.arguments) === approvalBridgeDigest(record.arguments);
      });
    },
    async execute(actor: string, input: { executionId: string; expectedRevision: number; operationId: string },
      executionOptions: { signal?: AbortSignal } = {}): Promise<ApprovalBridgeResult> {
      const parsed = pinSchema.parse(input);
      const started = tx(db => {
        const { record, context, operationId } = current(db, actor, parsed.executionId);
        if (operationId !== parsed.operationId) throw new Error("Execution cannot be replayed with a different operation/revision.");
        const prior = db.prepare("SELECT * FROM approval_bridge_runs WHERE execution_id=?").get(record.id) as RunRow | undefined;
        if (prior) {
          if (prior.operation_id !== parsed.operationId || prior.expected_revision !== parsed.expectedRevision)
            throw new Error("Execution cannot be replayed with a different operation/revision.");
          return { existing: { execution: record, ...(prior.result_json !== null ? { result: JSON.parse(prior.result_json) } : {}) } };
        }
        if (!options.dispatch) throw new Error("Native dispatcher unavailable.");
        if (executionOptions.signal?.aborted) throw new Error("Execution cancelled before dispatch.");
        if (record.revision !== parsed.expectedRevision) throw new Error("Execution revision conflict.");
        const running = new ExecutionStateStore(db).observe(actor, record.id, record.revision, randomUUID(), "started");
        db.prepare("INSERT INTO approval_bridge_runs VALUES(?,?,?,?,?,?, 'running',NULL)")
          .run(record.id, workspaceId, actor, parsed.operationId, parsed.expectedRevision, running.revision);
        return { running, context };
      });
      if (started.existing) return started.existing;
      const running = started.running!, context = started.context!;
      const proof = Object.freeze({});
      const runningDigest = approvalBridgeRecordDigest(workspaceId, running, context, parsed.operationId);
      proofs.set(proof, { actor, executionId: running.id, revision: running.revision, operationId: parsed.operationId,
        recordDigest: runningDigest });
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      let interrupted = false;
      try {
        const cancelled = new Promise<never>((_, reject) => {
          const interrupt = () => { interrupted = true; controller.abort(); reject(new Error("Native execution interrupted.")); };
          onAbort = interrupt;
          executionOptions.signal?.addEventListener("abort", interrupt, { once: true });
          timeout = setTimeout(interrupt, timeoutMs);
          if (executionOptions.signal?.aborted) interrupt();
        });
        read(() => undefined);
        if (interrupted) throw new Error("Execution cancelled before host dispatch.");
        const dispatching = options.dispatch!(Object.freeze({ workspaceId, actorId: actor, operationId: parsed.operationId,
          execution: approvalBridgeFreeze(structuredClone(running)), approval: proof, signal: controller.signal }));
        dispatches.add(dispatching);
        void dispatching.then(() => dispatches.delete(dispatching), () => dispatches.delete(dispatching));
        const observed = await Promise.race([dispatching, cancelled]);
        if (interrupted || controller.signal.aborted) throw new Error("Native execution interrupted.");
        const result = hostSchema.parse(observed);
        const encoded = result.result === undefined ? null : approvalBridgeJSON(result.result);
        if (encoded !== null && Buffer.byteLength(encoded) > resultBytes) throw new Error("Host result exceeds the configured byte limit.");
        return tx(db => {
          const { record, context: liveContext, operationId } = current(db, actor, running.id);
          if (record.revision !== running.revision || record.status !== "running"
            || approvalBridgeRecordDigest(workspaceId, record, liveContext, operationId) !== runningDigest) {
            const uncertain = record.status === "running"
              ? new ExecutionStateStore(db).observe(actor, record.id, record.revision, randomUUID(), "interrupted") : record;
            db.prepare("UPDATE approval_bridge_runs SET status='unknown',result_json=NULL WHERE execution_id=? AND status='running'").run(record.id);
            return { execution: uncertain };
          }
          const completed = new ExecutionStateStore(db).observe(actor, running.id, running.revision, randomUUID(), result.status);
          db.prepare("UPDATE approval_bridge_runs SET status=?,result_json=? WHERE execution_id=? AND started_revision=? AND status='running'")
            .run(result.status, encoded, running.id, running.revision);
          return { execution: completed, ...(encoded !== null ? { result: JSON.parse(encoded) } : {}) };
        });
      } catch {
        return tx(db => {
          let { record } = current(db, actor, running.id);
          if (record.revision === running.revision && record.status === "running")
            record = new ExecutionStateStore(db).observe(actor, record.id, record.revision, randomUUID(), "interrupted");
          db.prepare("UPDATE approval_bridge_runs SET status='unknown',result_json=NULL WHERE execution_id=? AND status='running'").run(record.id);
          return { execution: record };
        });
      } finally {
        proofs.delete(proof);
        if (timeout) clearTimeout(timeout);
        if (onAbort) executionOptions.signal?.removeEventListener("abort", onAbort);
      }
    },
    recover(): { unknown: number } {
      return tx(db => {
        const rows = db.prepare("SELECT actor_id,execution_id FROM approval_bridge_runs WHERE workspace_id=? AND status='running'")
          .all(workspaceId) as { actor_id: string; execution_id: string }[];
        for (const row of rows) {
          const { record } = current(db, row.actor_id, row.execution_id);
          if (record.status === "running")
            new ExecutionStateStore(db).observe(row.actor_id, record.id, record.revision, randomUUID(), "interrupted");
          db.prepare("UPDATE approval_bridge_runs SET status='unknown',result_json=NULL WHERE execution_id=?").run(row.execution_id);
        }
        return { unknown: rows.length };
      });
    },
  });
  return Object.freeze({ public: publicPort, native: nativePort });
}
