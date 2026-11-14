import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AGENT_RUNTIME_LIMITS, agentRuntimeDefinitions, agentRuntimeRecord, agentRuntimeReceipt, agentRuntimeTask,
  type AgentRuntimeRecord, type AgentRuntimeReceipt, type AgentRuntimeTask, type AgentRuntimeSnapshot,
} from "./agent-runtime-contracts.js";
import {
  AgentRuntimeError, agentRuntimeHash, agentRuntimeGroup, agentRuntimeTerminal, assertAgentRuntimeChild,
  validateAgentRuntimeSnapshot,
} from "./domain/agent-runtime-policy.js";

export const AGENT_RUNTIME_TABLES = ["agent_runtime_schema", "agent_runtime_sessions", "agent_runtime_receipts"] as const;
/** Parent migration transaction only. Owns neither connection, PRAGMAs nor user_version. */
export function initializeAgentRuntimeSchema(db: DatabaseSync): void {
  if (!db.isTransaction) throw new AgentRuntimeError("TRANSACTION_REQUIRED", "Initialize Agent runtime in the parent's migration transaction.");
  db.exec("CREATE TABLE IF NOT EXISTS agent_runtime_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL)");
  const version = db.prepare("SELECT version FROM agent_runtime_schema WHERE singleton=1").get();
  if (version && version.version !== 1) throw new AgentRuntimeError("UNSUPPORTED_SCHEMA", "Unsupported Agent runtime schema.");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runtime_sessions(
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      id TEXT NOT NULL UNIQUE, tree_id TEXT NOT NULL, parent_id TEXT,
      revision INTEGER NOT NULL CHECK(revision>0), state TEXT NOT NULL, handle TEXT, record TEXT NOT NULL,
      FOREIGN KEY(parent_id) REFERENCES agent_runtime_sessions(id)
    );
    CREATE INDEX IF NOT EXISTS agent_runtime_actor ON agent_runtime_sessions(actor_id,owner_id,tree_id,ordinal);
    CREATE TABLE IF NOT EXISTS agent_runtime_receipts(
      actor_id TEXT NOT NULL, owner_id TEXT NOT NULL, op_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(actor_id,owner_id,op_id)
    );
    INSERT OR IGNORE INTO agent_runtime_schema VALUES(1,1);
  `);
}
export interface AgentRuntimeOwner { actorId: string; nativeOwnerId: string; }
export interface AgentRuntimePinnedSnapshot {
  actorId: string; nativeOwnerId: string; digest: string; snapshot: AgentRuntimeSnapshot;
}
export interface AgentRuntimeStoreOptions {
  tasks: readonly AgentRuntimeTask[];
  snapshots?: readonly AgentRuntimePinnedSnapshot[];
  now?: () => string;
}
const ownerSchema = z.strictObject({
  actorId: z.string().min(1).max(160).regex(/^[^\u0000-\u001f]+$/),
  nativeOwnerId: z.string().min(1).max(160).regex(/^[^\u0000-\u001f]+$/),
});
const observationSchema = z.strictObject({
  state: z.enum(["unknown", "running", "completed", "failed", "cancelled"]),
  handle: z.string().min(1).max(256).regex(/^[^\u0000-\u001f]+$/).optional(),
});
export type AgentRuntimeObservation = z.infer<typeof observationSchema>;

/**
 * Trusted storage API, never an RPC handler. actor/owner MUST come from a native token resolver.
 * execute(), claimSpawn() and observe() require an existing synchronous parent transaction:
 * state, CAS and opId receipts share that transaction; parent rolls back on ANY error.
 * No method commits, starts a transaction, invokes a host or closes the shared DatabaseSync.
 */
export function createAgentRuntimeStore(db: DatabaseSync, options: AgentRuntimeStoreOptions) {
  const tasks = new Map<string, AgentRuntimeTask>();
  for (const value of options.tasks) {
    const task = agentRuntimeTask.parse(value);
    if (tasks.has(task.key)) throw new AgentRuntimeError("INVALID_POLICY", "Duplicate native task key.");
    tasks.set(task.key, task);
  }
  const snapshots = (options.snapshots ?? []).map(pin => {
    ownerSchema.parse({ actorId: pin.actorId, nativeOwnerId: pin.nativeOwnerId });
    const snapshot = validateAgentRuntimeSnapshot(pin.snapshot);
    if (pin.digest !== agentRuntimeHash(snapshot)) throw new AgentRuntimeError("SNAPSHOT_PIN", "Synthetic snapshot pin does not match.");
    return { ...pin, snapshot };
  });
  if (new Set(snapshots.map(pin => JSON.stringify([pin.actorId, pin.nativeOwnerId, pin.snapshot.snapshotId]))).size !== snapshots.length) {
    throw new AgentRuntimeError("INVALID_POLICY", "Duplicate synthetic snapshot pin.");
  }
  function ready(owner: AgentRuntimeOwner, mutation = false) {
    if (!ownerSchema.safeParse(owner).success) throw new AgentRuntimeError("UNAUTHORIZED", "Trusted native owner context required.");
    const version = db.prepare("SELECT version FROM agent_runtime_schema WHERE singleton=1").get();
    if (version?.version !== 1) throw new AgentRuntimeError("UNSUPPORTED_SCHEMA", "Unsupported Agent runtime schema.");
    if (mutation && !db.isTransaction) throw new AgentRuntimeError("TRANSACTION_REQUIRED", "Agent mutations and receipts require the parent's transaction.");
  }
  function clock() {
    const text = options.now?.() ?? new Date().toISOString();
    if (!z.string().datetime().safeParse(text).success) throw new AgentRuntimeError("INVALID_TIME", "Native runtime requires an ISO clock.");
    return text;
  }
  function decode(row: Record<string, unknown>): AgentRuntimeRecord {
    try {
      const record = agentRuntimeRecord.parse(JSON.parse(String(row.record)));
      if (record.id !== row.id || record.treeId !== row.tree_id || record.parentId !== row.parent_id
        || record.state !== row.state || record.revision !== row.revision) throw new Error();
      return record;
    } catch { throw new AgentRuntimeError("STATE_CORRUPT", "Agent session indexes do not match durable state."); }
  }
  function internal(owner: AgentRuntimeOwner, id: string) {
    ready(owner);
    const row = db.prepare("SELECT * FROM agent_runtime_sessions WHERE actor_id=? AND owner_id=? AND id=?")
      .get(owner.actorId, owner.nativeOwnerId, id);
    if (!row) throw new AgentRuntimeError("NOT_FOUND", "Owned Agent session not found.");
    const record = decode(row);
    if (record.groupId !== agentRuntimeGroup(owner.nativeOwnerId)) throw new AgentRuntimeError("STATE_CORRUPT", "Native group identity mismatch.");
    return { record, handle: row.handle === null ? undefined : String(row.handle) };
  }
  function taskFor(record: AgentRuntimeRecord) {
    const task = tasks.get(record.taskKey);
    if (!task || agentRuntimeHash(task) !== record.policyDigest) throw new AgentRuntimeError("POLICY_CHANGED", "Pinned native task policy is no longer configured.");
    return structuredClone(task);
  }
  function list(owner: AgentRuntimeOwner, input: unknown = {}) {
    ready(owner);
    const parsed = agentRuntimeDefinitions[4].input.safeParse(input);
    if (!parsed.success) throw new AgentRuntimeError("INVALID_INPUT", "Invalid Agent list arguments.");
    const { treeId, offset, limit } = parsed.data;
    if (treeId) internal(owner, treeId);
    const rows = db.prepare("SELECT * FROM agent_runtime_sessions WHERE actor_id=? AND owner_id=? ORDER BY ordinal")
      .all(owner.actorId, owner.nativeOwnerId).filter(row => !treeId || row.tree_id === treeId);
    if (rows.length > AGENT_RUNTIME_LIMITS.sessionsPerActor) throw new AgentRuntimeError("STATE_CORRUPT", "Agent state exceeds actor boundary.");
    return { items: rows.slice(offset, offset + limit).map(decode), total: rows.length };
  }
  function save(owner: AgentRuntimeOwner, record: AgentRuntimeRecord, expectedRevision: number, handle?: string) {
    record.updatedAt = clock();
    record.revision = expectedRevision + 1;
    agentRuntimeRecord.parse(record);
    const result = db.prepare("UPDATE agent_runtime_sessions SET revision=?,state=?,handle=COALESCE(?,handle),record=? WHERE actor_id=? AND owner_id=? AND id=? AND revision=?")
      .run(record.revision, record.state, handle ?? null, JSON.stringify(record), owner.actorId, owner.nativeOwnerId, record.id, expectedRevision);
    if (result.changes !== 1) throw new AgentRuntimeError("REVISION_CONFLICT", "Agent session revision changed.");
  }
  function add(owner: AgentRuntimeOwner, taskKey: string, parent: AgentRuntimeRecord | null,
    restoredFrom: AgentRuntimeRecord["restoredFrom"] = null) {
    const task = tasks.get(taskKey);
    if (!task) throw new AgentRuntimeError("POLICY_DENIED", "Only configured native tasks can be created.");
    if (parent) {
      if (!["intent", "running"].includes(parent.state)) throw new AgentRuntimeError("PARENT_INACTIVE", "Parent is not accepting child reservations.");
      assertAgentRuntimeChild(taskFor(parent), task);
      const treeCount = Number(db.prepare("SELECT count(*) AS n FROM agent_runtime_sessions WHERE tree_id=?").get(parent.treeId)!.n);
      const fanout = Number(db.prepare("SELECT count(*) AS n FROM agent_runtime_sessions WHERE parent_id=?").get(parent.id)!.n);
      if (parent.depth >= AGENT_RUNTIME_LIMITS.depth || treeCount >= AGENT_RUNTIME_LIMITS.treeNodes || fanout >= AGENT_RUNTIME_LIMITS.fanout) {
        throw new AgentRuntimeError("LIMIT_EXCEEDED", "Agent tree depth, history or fanout reached its boundary.");
      }
    }
    const actorCount = Number(db.prepare("SELECT count(*) AS n FROM agent_runtime_sessions WHERE actor_id=?").get(owner.actorId)!.n);
    if (actorCount >= AGENT_RUNTIME_LIMITS.sessionsPerActor) throw new AgentRuntimeError("LIMIT_EXCEEDED", "Actor Agent history is full.");
    const id = "agent_session_" + randomUUID();
    const at = clock();
    const record: AgentRuntimeRecord = {
      schema: "pkm.agent.runtime/v1", id, treeId: parent?.treeId ?? id, parentId: parent?.id ?? null,
      groupId: agentRuntimeGroup(owner.nativeOwnerId), taskKey, title: task.title, policyDigest: agentRuntimeHash(task),
      depth: parent ? parent.depth + 1 : 0, revision: 1, state: "intent", createdAt: at, updatedAt: at, restoredFrom,
    };
    agentRuntimeRecord.parse(record);
    db.prepare("INSERT INTO agent_runtime_sessions(actor_id,owner_id,id,tree_id,parent_id,revision,state,record) VALUES(?,?,?,?,?,?,?,?)")
      .run(owner.actorId, owner.nativeOwnerId, id, record.treeId, record.parentId, 1, record.state, JSON.stringify(record));
    if (parent) save(owner, parent, parent.revision);
    return record;
  }
  function expected(record: AgentRuntimeRecord, value: number) {
    if (record.revision !== value) throw new AgentRuntimeError("REVISION_CONFLICT", "Agent session revision changed.");
  }
  function execute(owner: AgentRuntimeOwner, operation: "spawn" | "cancel" | "restore" | "reconnect", input: unknown): AgentRuntimeReceipt {
    ready(owner, true);
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(input) ?? ""); }
    catch { throw new AgentRuntimeError("INVALID_INPUT", "Agent requests require bounded JSON."); }
    if (bytes > AGENT_RUNTIME_LIMITS.requestBytes) throw new AgentRuntimeError("LIMIT_EXCEEDED", "Agent request exceeds its byte boundary.");
    const definition = agentRuntimeDefinitions.find(item => item.id === "agent.runtime." + operation);
    const parsed = definition?.input.safeParse(input);
    if (!parsed?.success) throw new AgentRuntimeError("INVALID_INPUT", "Invalid Agent mutation arguments.");
    const args = parsed.data;
    if (!("opId" in args)) throw new AgentRuntimeError("INVALID_INPUT", "Operation receipt required.");
    const fingerprint = agentRuntimeHash([operation, args]);
    const prior = db.prepare("SELECT fingerprint,record FROM agent_runtime_receipts WHERE actor_id=? AND owner_id=? AND op_id=?")
      .get(owner.actorId, owner.nativeOwnerId, args.opId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new AgentRuntimeError("OPERATION_CONFLICT", "Operation identity was already used with different arguments.");
      return agentRuntimeReceipt.parse(JSON.parse(String(prior.record)));
    }
    const receipts = Number(db.prepare("SELECT count(*) AS n FROM agent_runtime_receipts WHERE actor_id=?").get(owner.actorId)!.n);
    if (receipts >= AGENT_RUNTIME_LIMITS.receiptsPerActor) throw new AgentRuntimeError("LIMIT_EXCEEDED", "Actor Agent receipt capacity reached.");
    let records: AgentRuntimeRecord[] = [];
    if (operation === "spawn" && "taskKey" in args) {
      const parent = args.parentId ? internal(owner, args.parentId).record : null;
      if (parent) expected(parent, args.expectedParentRevision!);
      records = [add(owner, args.taskKey, parent)];
    } else if (operation === "cancel") {
      const cancel = agentRuntimeDefinitions[1].input.parse(args);
      const target = internal(owner, cancel.id).record;
      expected(target, cancel.expectedRevision);
      const rows = db.prepare("SELECT * FROM agent_runtime_sessions WHERE actor_id=? AND owner_id=? AND tree_id=? ORDER BY ordinal")
        .all(owner.actorId, owner.nativeOwnerId, target.treeId);
      const selected = new Set([target.id]);
      for (const row of rows) {
        const record = decode(row);
        if (record.parentId && selected.has(record.parentId)) selected.add(record.id);
        if (selected.has(record.id)) {
          if (!agentRuntimeTerminal(record.state) && record.state !== "cancel-requested") {
            const previous = record.revision;
            record.state = record.state === "intent" ? "cancelled" : "cancel-requested";
            save(owner, record, previous);
          }
          records.push(record);
        }
      }
    } else if (operation === "reconnect") {
      const reconnect = agentRuntimeDefinitions[5].input.parse(args);
      const record = internal(owner, reconnect.id).record;
      expected(record, reconnect.expectedRevision);
      records = [record];
    } else if (operation === "restore" && "snapshotId" in args) {
      const pin = snapshots.find(item => item.actorId === owner.actorId && item.nativeOwnerId === owner.nativeOwnerId
        && item.snapshot.snapshotId === args.snapshotId && item.digest === args.digest);
      if (!pin) throw new AgentRuntimeError("SNAPSHOT_DENIED", "No explicit synthetic snapshot pin is authorized for this native owner.");
      const mapping = new Map<string, AgentRuntimeRecord>();
      for (const node of pin.snapshot.nodes) {
        const parent = node.parentSourceId ? internal(owner, mapping.get(node.parentSourceId)!.id).record : null;
        const record = add(owner, node.taskKey, parent, { snapshotId: args.snapshotId, digest: args.digest });
        mapping.set(node.sourceId, record);
        records.push(record);
      }
    } else throw new AgentRuntimeError("INVALID_INPUT", "Invalid Agent mutation.");
    const first = internal(owner, records[0].id).record;
    const receipt = agentRuntimeReceipt.parse({
      opId: args.opId, operation, ids: records.map(record => record.id), rootId: first.id, revision: first.revision,
    });
    db.prepare("INSERT INTO agent_runtime_receipts VALUES(?,?,?,?,?)")
      .run(owner.actorId, owner.nativeOwnerId, args.opId, fingerprint, JSON.stringify(receipt));
    return receipt;
  }
  function claimSpawn(owner: AgentRuntimeOwner, id: string) {
    ready(owner, true);
    const { record } = internal(owner, id);
    if (record.state !== "intent") return null;
    if (record.parentId && internal(owner, record.parentId).record.state !== "running") return null;
    const task = taskFor(record);
    const previous = record.revision;
    // Unknown BEFORE dispatch: a crash on either side of the host call never authorizes another spawn.
    record.state = "spawn-unknown";
    save(owner, record, previous);
    return { record, task };
  }
  function observe(owner: AgentRuntimeOwner, id: string, expectedRevision: number, input: unknown) {
    ready(owner, true);
    const observation = observationSchema.safeParse(input);
    if (!observation.success) throw new AgentRuntimeError("HOST_PROTOCOL", "Invalid native host observation.");
    const { record, handle } = internal(owner, id);
    expected(record, expectedRevision);
    if (agentRuntimeTerminal(record.state)) return record;
    if (record.state === "intent") throw new AgentRuntimeError("HOST_PROTOCOL", "Cannot observe a session before committed dispatch claim.");
    const value = observation.data;
    if (handle && value.handle && handle !== value.handle) throw new AgentRuntimeError("HOST_PROTOCOL", "Native host handle cannot be rebound.");
    if (value.state === "unknown") return record;
    if (!handle && !value.handle) throw new AgentRuntimeError("HOST_PROTOCOL", "Known host observations require a native handle.");
    record.state = record.state === "cancel-requested" && value.state === "running" ? "cancel-requested" : value.state;
    save(owner, record, expectedRevision, value.handle);
    return record;
  }
  return {
    execute, claimSpawn, observe, list,
    get: (owner: AgentRuntimeOwner, id: string) => internal(owner, id).record,
    /** Native coordinator only; handle and task policy are never part of public reads. */
    binding: (owner: AgentRuntimeOwner, id: string) => internal(owner, id),
  };
}
export type AgentRuntimeStore = ReturnType<typeof createAgentRuntimeStore>;
