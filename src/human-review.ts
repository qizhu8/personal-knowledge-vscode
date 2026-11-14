import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { approvalBridgeDigest, approvalBridgeFreeze, approvalBridgeJSON } from "./domain/approval-bridge-digest.js";
import { approvalHumanIntent, memoryHumanIntent, normalizeHumanReviewIntent, humanReviewDetail } from "./domain/human-review-intent.js";
import { humanReviewDecisionSchema, humanReviewPrincipalSchema, humanReviewReadSchema } from "./human-review-contracts.js";
import type { HumanReviewEntry, HumanReviewIntent, HumanReviewNative, HumanReviewOptions, HumanReviewPrincipal, HumanReviewStatus } from "./human-review-contracts.js";
export * from "./human-review-contracts.js";
export { humanReviewDetail } from "./domain/human-review-intent.js";

type Row = {
  id: string; workspace_id: string; actor_id: string; authority: "approval" | "memory"; operation_id: string;
  revision: number; intent_digest: string; intent_json: string; status: HumanReviewStatus;
  instance_id: string; created_at: number; expires_at: number; decision_id: string | null;
};
function project(row: Row): HumanReviewEntry {
  return approvalBridgeFreeze({ id: row.id, workspaceId: row.workspace_id, actorId: row.actor_id,
    authority: row.authority, operationId: row.operation_id, revision: row.revision,
    intentDigest: row.intent_digest, intent: JSON.parse(row.intent_json),
    status: row.status, createdAt: row.created_at, expiresAt: row.expires_at });
}
function synchronous<T>(value: T): T {
  if (value && typeof (value as { then?: unknown }).then === "function") throw new Error("Human review storage/recheck must be synchronous.");
  return value;
}
export function initializeHumanReviewSchema(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error("Human review migration requires a transaction.");
  db.exec(`
    CREATE TABLE IF NOT EXISTS human_review_schema(version INTEGER NOT NULL CHECK(version=1));
    INSERT INTO human_review_schema SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM human_review_schema);
    CREATE TABLE IF NOT EXISTS human_review_queue(
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, authority TEXT NOT NULL,
      operation_id TEXT NOT NULL, revision INTEGER NOT NULL, intent_digest TEXT NOT NULL, intent_json TEXT NOT NULL,
      status TEXT NOT NULL, instance_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      decision_id TEXT, UNIQUE(workspace_id,actor_id,authority,operation_id));
    CREATE TABLE IF NOT EXISTS human_review_events(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS human_review_scope ON human_review_queue(workspace_id,actor_id,status);
  `);
  const versions = db.prepare("SELECT version FROM human_review_schema").all() as { version: number }[];
  if (versions.length !== 1 || versions[0].version !== 1) throw new Error("Unsupported human review schema.");
}

/** Host-local bridge only. None of native or handlers belongs in the generic capability registry. */
export function createHumanReviewQueue(options: HumanReviewOptions) {
  const workspaceId = humanReviewPrincipalSchema.shape.workspaceId.parse(options.workspaceId);
  const leaseMs = z.number().int().min(1).max(300_000).parse(options.leaseMs ?? 120_000);
  const instanceId = randomUUID(), events = new EventEmitter();
  events.setMaxListeners(0);
  const sessions = new WeakMap<object, { principal: HumanReviewPrincipal; expiresAt: number }>();
  const waiters = new Map<string, () => void>();
  let closed = false;
  const tx = <T>(fn: (db: DatabaseSync) => T) => synchronous(options.storage.transaction(db => {
    if (!db.isTransaction) throw new Error("Human review mutation requires a transaction.");
    return synchronous(fn(db));
  }));
  const read = <T>(fn: (db: DatabaseSync) => T) => synchronous(options.storage.read(db => {
    if (db.isTransaction) throw new Error("Human review read must be outside a transaction.");
    return synchronous(fn(db));
  }));
  const row = (db: DatabaseSync, id: string) => {
    const found = db.prepare("SELECT * FROM human_review_queue WHERE id=? AND workspace_id=?").get(id, workspaceId) as Row | undefined;
    if (!found) throw new Error("Review unavailable.");
    return found;
  };
  function transition(db: DatabaseSync, value: Row, status: HumanReviewStatus, decisionId: string | null = null) {
    if (value.status !== "pending") return;
    db.prepare("UPDATE human_review_queue SET status=?,revision=revision+1,decision_id=? WHERE id=? AND status='pending'")
      .run(status, decisionId, value.id);
    db.prepare("INSERT INTO human_review_events(review_id,revision,status,at) VALUES(?,?,?,?)")
      .run(value.id, value.revision + 1, status, Date.now());
  }
  tx(db => {
    initializeHumanReviewSchema(db);
    const abandoned = db.prepare("SELECT * FROM human_review_queue WHERE workspace_id=? AND status='pending'").all(workspaceId) as Row[];
    for (const value of abandoned) transition(db, value, "unknown");
  });
  function principal(capability: unknown): HumanReviewPrincipal {
    if (closed || !capability || typeof capability !== "object") throw new Error("Native human session unavailable.");
    const session = sessions.get(capability);
    if (!session || session.expiresAt <= Date.now() || session.principal.readOnly) throw new Error("Native human session unavailable.");
    return session.principal;
  }
  function current(intent: HumanReviewIntent): boolean {
    if (!options.validateCurrent) return false;
    return read(() => synchronous(options.validateCurrent!(approvalBridgeFreeze(structuredClone(intent)))) === true);
  }
  function finish(id: string, status: HumanReviewStatus) {
    tx(db => { const value = row(db, id); if (value.instance_id === instanceId) transition(db, value, status); });
    events.emit(id);
  }
  async function request(intentInput: HumanReviewIntent, signal?: AbortSignal) {
    if (closed || !options.authenticateHuman || !options.validateCurrent) throw new Error("Native human reviewer unavailable.");
    const intent = normalizeHumanReviewIntent(intentInput);
    if (intent.workspaceId !== workspaceId) throw new Error("Review workspace mismatch.");
    if (signal?.aborted || !current(intent)) return null;
    const digest = approvalBridgeDigest(intent);
    const pending = tx(db => {
      const prior = db.prepare("SELECT * FROM human_review_queue WHERE workspace_id=? AND actor_id=? AND authority=? AND operation_id=?")
        .get(workspaceId, intent.actorId, intent.authority, intent.operationId) as Row | undefined;
      if (prior) {
        if (prior.intent_digest !== digest) throw new Error("Review operation pin conflict.");
        return null; // A decision or an in-flight review is never a reusable authorization.
      }
      const now = Date.now(), id = randomUUID();
      db.prepare("INSERT INTO human_review_queue VALUES(?,?,?,?,?,1,?,?,'pending',?,?,?,NULL)")
        .run(id, workspaceId, intent.actorId, intent.authority, intent.operationId, digest, approvalBridgeJSON(intent), instanceId, now, now + leaseMs);
      db.prepare("INSERT INTO human_review_events(review_id,revision,status,at) VALUES(?,1,'pending',?)").run(id, now);
      return row(db, id);
    });
    if (!pending) return null;
    const result = await new Promise<Row>(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        const value = read(db => row(db, pending.id));
        if (value.status === "pending") return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        events.removeListener(pending.id, wake); waiters.delete(pending.id); resolve(value);
      };
      const abort = () => finish(pending.id, "cancelled");
      waiters.set(pending.id, wake); events.on(pending.id, wake);
      timer = setTimeout(() => finish(pending.id, "expired"), Math.max(1, pending.expires_at - Date.now()));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      wake();
    });
    if (!["approved", "rejected"].includes(result.status) || closed || signal?.aborted || !current(intent)) return null;
    return { decision: result.status === "approved" ? "approve" as const : "reject" as const,
      decisionId: result.decision_id!, actorId: intent.actorId };
  }
  const handlers = Object.freeze({
    read(capability: unknown, input: unknown) {
      const human = principal(capability); humanReviewReadSchema.parse(input);
      const entries = tx(db => {
        const rows = db.prepare("SELECT * FROM human_review_queue WHERE workspace_id=? AND actor_id=? AND status='pending' ORDER BY created_at,id LIMIT 100")
          .all(workspaceId, human.actorId) as Row[];
        for (const value of rows) if (value.expires_at <= Date.now()) transition(db, value, "expired");
        return rows.filter(value => value.expires_at > Date.now() && value.instance_id === instanceId
          && human.authorities.includes(value.authority)).map(project);
      });
      for (const id of waiters.keys()) events.emit(id);
      return { entries };
    },
    decide(capability: unknown, input: unknown) {
      const human = principal(capability), parsed = humanReviewDecisionSchema.parse(input);
      const snapshot = read(db => row(db, parsed.id));
      if (snapshot.actor_id !== human.actorId || !human.authorities.includes(snapshot.authority)) throw new Error("Review unavailable.");
      const valid = current(JSON.parse(snapshot.intent_json));
      const status = tx(db => {
        principal(capability);
        const value = row(db, parsed.id);
        if (value.instance_id !== instanceId || value.status !== "pending"
          || value.revision !== parsed.expectedRevision || value.intent_digest !== parsed.intentDigest) throw new Error("Review pins are stale.");
        const next = value.expires_at <= Date.now() ? "expired" : !valid ? "stale"
          : parsed.decision === "approve" ? "approved" : parsed.decision === "reject" ? "rejected" : "cancelled";
        transition(db, value, next, next === "approved" || next === "rejected" ? randomUUID() : null);
        return next;
      });
      events.emit(parsed.id);
      return { id: parsed.id, revision: snapshot.revision + 1, status };
    },
  });
  const native = Object.freeze<HumanReviewNative>({
    async openSession(hostEvidence: unknown) {
      if (closed || !options.authenticateHuman) throw new Error("Native human authentication unavailable.");
      const raw = await options.authenticateHuman(hostEvidence);
      if (closed || !raw) throw new Error("Native human authentication unavailable.");
      const human = humanReviewPrincipalSchema.parse(raw);
      if (human.workspaceId !== workspaceId || human.readOnly) throw new Error("Native human session unavailable.");
      const capability = Object.freeze(Object.create(null)) as object;
      sessions.set(capability, { principal: approvalBridgeFreeze(structuredClone(human)), expiresAt: Date.now() + leaseMs });
      return capability;
    },
    closeSession(capability: object) { sessions.delete(capability); },
    reviewer: requestValue => request(approvalHumanIntent(requestValue)),
    reviewerWithSignal: (requestValue, signal) => request(approvalHumanIntent(requestValue), signal),
    memoryAuthorizer: async requestValue => {
      if (!options.memoryActorId) throw new Error("Native memory actor binding unavailable.");
      const result = await request(memoryHumanIntent(workspaceId, options.memoryActorId, requestValue));
      return result?.decision === "approve" ? { decisionId: result.decisionId, actorId: result.actorId } : null;
    },
    memoryAuthorizerFor: actorId => async requestValue => {
      humanReviewPrincipalSchema.shape.actorId.parse(actorId);
      const result = await request(memoryHumanIntent(workspaceId, actorId, requestValue));
      return result?.decision === "approve" ? { decisionId: result.decisionId, actorId: result.actorId } : null;
    },
    cancel(id: string) { z.uuid().parse(id); finish(id, "cancelled"); },
    shutdown() {
      if (closed) return;
      closed = true;
      tx(db => {
        const rows = db.prepare("SELECT * FROM human_review_queue WHERE workspace_id=? AND instance_id=? AND status='pending'")
          .all(workspaceId, instanceId) as Row[];
        for (const value of rows) transition(db, value, "unknown");
      });
      for (const id of waiters.keys()) events.emit(id);
    },
  });
  return Object.freeze({ native, handlers });
}

/** Inject vscode.window's real modal function; no VS Code imports in the isolated server. */
export async function presentNativeHumanReview(
  queue: ReturnType<typeof createHumanReviewQueue>, capability: object, id: string,
  showWarningMessage: (title: string, options: { modal: true; detail: string }, ...choices: string[]) => PromiseLike<string | undefined>,
) {
  const entry = queue.handlers.read(capability, {}).entries.find(value => value.id === id);
  if (!entry) throw new Error("Review unavailable.");
  const selected = await showWarningMessage("Review exact native operation",
    { modal: true, detail: `Workspace: ${entry.workspaceId}\nActor: ${entry.actorId}\nOperation: ${entry.operationId}\n${humanReviewDetail(entry.intent)}` },
    "Approve exact record", "Reject", "Cancel");
  return queue.handlers.decide(capability, { id, expectedRevision: entry.revision, intentDigest: entry.intentDigest,
    decision: selected === "Approve exact record" ? "approve" : selected === "Reject" ? "reject" : "cancel" });
}
