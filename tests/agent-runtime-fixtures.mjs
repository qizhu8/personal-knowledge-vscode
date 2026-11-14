import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAgentRuntime } from "../dist/agent-runtime.js";
import { initializeAgentRuntimeSchema } from "../dist/agent-runtime-store.js";
import { agentRuntimeHash } from "../dist/domain/agent-runtime-policy.js";

export const tasks = [
  { key: "synthetic.manager", title: "Synthetic manager", capabilities: ["read.synthetic", "write.synthetic"] },
  { key: "synthetic.reader", title: "Synthetic reader", capabilities: ["read.synthetic"] },
  { key: "synthetic.writer", title: "Synthetic writer", capabilities: ["write.synthetic"] },
];
export const syntheticSnapshot = {
  schema: "pkm.agent.runtime.synthetic-snapshot/v1", synthetic: true,
  snapshotId: "agent_snapshot_synthetic_tree",
  nodes: [
    { sourceId: "old-root", parentSourceId: null, taskKey: "synthetic.manager" },
    { sourceId: "old-reader", parentSourceId: "old-root", taskKey: "synthetic.reader" },
    { sourceId: "old-nested", parentSourceId: "old-reader", taskKey: "synthetic.reader" },
  ],
};
export const snapshotDigest = agentRuntimeHash(syntheticSnapshot);
export const owner = { actorId: "synthetic-actor", nativeOwnerId: "synthetic-native-owner" };
export const snapshots = [{ ...owner, digest: snapshotDigest, snapshot: syntheticSnapshot }];
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function database(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  transaction(db, () => initializeAgentRuntimeSchema(db));
  return db;
}
/** Deliberately synthetic: in-memory work only, no agent, model, UI, network or filesystem execution. */
export function syntheticHost(db) {
  const tokens = new WeakMap();
  const sessions = new Map();
  const calls = [];
  const host = {
    resolveOwner: token => tokens.get(token),
    async spawn(invocation) {
      if (db.isTransaction) throw new Error("Host effect occurred inside transaction");
      const { sessionId, intentId, task } = invocation;
      const durable = db.prepare("SELECT state FROM agent_runtime_sessions WHERE id=?").get(sessionId);
      if (durable?.state !== "spawn-unknown") throw new Error("Spawn without committed intent");
      if (sessions.has(sessionId)) throw new Error("Duplicate synthetic spawn");
      calls.push({ kind: "spawn", id: sessionId, task: structuredClone(task), intentId });
      sessions.set(sessionId, { state: "running", handle: "synthetic:" + sessionId });
      return structuredClone(sessions.get(sessionId));
    },
    async inspect({ sessionId }) {
      if (db.isTransaction) throw new Error("Host read occurred inside transaction");
      calls.push({ kind: "inspect", id: sessionId });
      return structuredClone(sessions.get(sessionId) ?? { state: "unknown" });
    },
    async cancel({ sessionId }) {
      if (db.isTransaction) throw new Error("Host cancel occurred inside transaction");
      calls.push({ kind: "cancel", id: sessionId });
      const record = sessions.get(sessionId);
      if (record && !["completed", "failed", "cancelled"].includes(record.state)) record.state = "cancelled";
    },
  };
  function token(context = owner) {
    const token = Object.freeze({});
    tokens.set(token, { ...context });
    return token;
  }
  return { host, token, calls, sessions };
}
export function fixture() {
  const db = database();
  const native = syntheticHost(db);
  const runtime = createAgentRuntime(db, { tasks, snapshots, host: native.host });
  return { db, native, runtime, token: native.token(), close: () => db.close() };
}
export const spawnArgs = (taskKey = "synthetic.manager", parent) => ({
  opId: randomUUID(), taskKey, ...(parent ? { parentId: parent.id, expectedParentRevision: parent.revision } : {}),
});
export const reconnectArgs = record => ({ opId: randomUUID(), id: record.id, expectedRevision: record.revision });
