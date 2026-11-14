import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createChannelRuntime, initializeChannelRuntimeSchema } from "../dist/channel-runtime.js";
import { initializeManagerRuntimeSchema } from "../dist/manager-runtime.js";

/** Synthetic parent composition: real shared SQL/Manager schema, opaque native identities and SQL-only authority hooks. */
export function channelFixture(options = {}) {
  const db = new DatabaseSync(":memory:");
  const tokens = { manager: Object.freeze({}), worker: Object.freeze({}), observer: Object.freeze({}), outsider: Object.freeze({}) };
  const identities = new WeakMap([
    [tokens.manager, { actorId: "human-manager", kind: "human" }],
    [tokens.worker, { actorId: "agent-worker", kind: "agent" }],
    [tokens.observer, { actorId: "agent-observer", kind: "agent" }],
    [tokens.outsider, { actorId: "agent-outsider", kind: "agent" }],
  ]);
  let lease = true, failReceipt = false, clockOffset = 0;
  const transaction = work => {
    if (db.isTransaction) throw new Error("Nested parent transaction");
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      if (result && typeof result.then === "function") throw new Error("Async parent transaction");
      db.exec("COMMIT"); return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  transaction(() => {
    initializeChannelRuntimeSchema(db);
    initializeManagerRuntimeSchema(db);
    db.exec("CREATE TABLE fixture_global_receipts(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL)");
  });
  const now = () => Date.now() + clockOffset;
  const notifications = [];
  const task = { authority: "manager", runId: "run-one", taskId: "task-one", attemptId: "attempt-one",
    definitionSha256: "a".repeat(64), expectedVersion: 1 };
  const run = {
    schema: "pkm.manager.runtime/v1", runId: task.runId, projectId: "project-one", version: 1,
    state: "active", phase: "worker", contract: {}, budget: {}, plan: {}, planHash: "b".repeat(64),
    tasks: [{ definition: { taskId: task.taskId }, definitionHash: task.definitionSha256,
      state: "working", owner: "agent-worker", attempts: [{ attemptId: task.attemptId, state: "working" }] }],
    checks: [], feedback: [], effect: null, freeze: null, integration: null, lastSequence: 0, createdAt: now(), updatedAt: now(), reason: null,
  };
  db.prepare("INSERT INTO manager_runtime_runs VALUES(?,?,?,?,?)")
    .run("human-manager", "native-host", task.runId, 1, JSON.stringify(run));
  function managerRun() {
    return JSON.parse(db.prepare("SELECT record FROM manager_runtime_runs WHERE run_id=?").get(task.runId).record);
  }
  const host = {
    resolveActor: token => identities.get(token),
    authorizeHuman: actor => actor.kind === "human" && actor.actorId === "human-manager",
    assertLease() { if (!lease) throw Object.assign(new Error("Native lease lost"), { code: "LEASE_LOST" }); },
    transaction,
    claimReceipt(operationId, fingerprint) {
      if (!db.isTransaction) throw new Error("Missing parent receipt transaction");
      if (failReceipt) throw Object.assign(new Error("receipt failure"), { code: "RECEIPT_FAILURE" });
      const existing = db.prepare("SELECT fingerprint FROM fixture_global_receipts WHERE operation_id=?").get(operationId);
      if (existing && existing.fingerprint !== fingerprint) throw Object.assign(new Error("global conflict"), { code: "GLOBAL_OPERATION_CONFLICT" });
      db.prepare("INSERT OR IGNORE INTO fixture_global_receipts VALUES(?,?)").run(operationId, fingerprint);
    },
    authorizeDirected(actor, recipient) {
      return actor.actorId === "human-manager" && ["agent-worker", "agent-observer"].includes(recipient.actorId)
        || actor.actorId === "agent-worker" && recipient.actorId === "human-manager";
    },
    taskAuthority: {
      authorize({ actor, recipient, task: pin, kind }) {
        if (!db.isTransaction) throw new Error("Task ACL outside parent transaction");
        const current = managerRun(), entry = current.tasks[0], attempt = entry.attempts[0];
        return pin.authority === "manager" && pin.runId === current.runId && pin.taskId === entry.definition.taskId
          && pin.attemptId === attempt.attemptId && pin.definitionSha256 === entry.definitionHash
          && pin.expectedVersion === current.version && current.state === "active" && attempt.state === "working"
          && (kind === "assign" ? actor.actorId === "human-manager" && recipient.actorId === entry.owner
            : actor.actorId === entry.owner && recipient.actorId === "human-manager");
      },
      apply({ task: pin, kind, text, operationId }) {
        const current = managerRun();
        current.version++;
        current.feedback.push({ id: operationId, message: text, state: "delivered", kind });
        if (kind === "reply") current.tasks[0].attempts[0].state = "delivered";
        const changed = db.prepare("UPDATE manager_runtime_runs SET version=?,record=? WHERE run_id=? AND version=?")
          .run(current.version, JSON.stringify(current), current.runId, pin.expectedVersion);
        if (changed.changes !== 1) throw new Error("Manager parent CAS conflict");
        return { ...pin, expectedVersion: current.version };
      },
    },
    notify: hint => notifications.push(hint),
  };
  const runtime = createChannelRuntime(db, options.noAuthority ? { ...host, taskAuthority: undefined } : host, { now, pollMs: 10 });
  const revision = channelId => Number(db.prepare("SELECT revision FROM channel_runtime_rooms WHERE channel_id=?").get(channelId).revision);
  const args = (channelId = "channel-one") => ({ operationId: randomUUID(), channelId, expectedRevision: revision(channelId) });
  function create(channelId = "channel-one") {
    return runtime.nativeCreate(tokens.manager, { operationId: randomUUID(), channelId, expectedRevision: 0,
      participantId: "manager", expiresAt: now() + 600_000 });
  }
  function invite(name = "worker", channelId = "channel-one", role = "worker", expiration = now() + 60_000) {
    const invitation = runtime.nativeInviteCreate(tokens.manager, { ...args(channelId), actor: identities.get(tokens[name]),
      participantId: name, role, expiresAt: expiration, memberExpiresAt: now() + 500_000 });
    return invitation;
  }
  function approve(invitation, channelId = "channel-one") {
    return runtime.nativeHumanApprove(tokens.manager, { ...args(channelId), invitationId: invitation.invitationId });
  }
  function accept(name, invitation, channelId = "channel-one") {
    return runtime.accept(tokens[name], { ...args(channelId), invitationId: invitation.invitationId, token: invitation.token });
  }
  function admit(name = "worker", channelId = "channel-one", role = "worker") {
    const invitation = invite(name, channelId, role); approve(invitation, channelId); accept(name, invitation, channelId);
    return runtime.connect(tokens[name], { channelId });
  }
  function close() { runtime.dispose(); db.close(); }
  return { db, runtime, host, tokens, task, now, args, revision, create, invite, approve, accept, admit, close, managerRun, notifications,
    applications: () => managerRun().feedback.length, loseLease: () => { lease = false; }, failReceipt: value => { failReceipt = value; },
    advance: ms => { clockOffset += ms; } };
}
