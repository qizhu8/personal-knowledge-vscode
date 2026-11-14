import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { httpCall, invocation, nativeWorkspace, syntheticManager, until } from "./batch06-manager-fixtures.mjs";

const peers = new Set(["peer-one", "peer-two"]);
const operation = () => randomUUID();

test("composed native Channel and Manager deliver an actor-bound task, update, reply and wait over two HTTP peers", { timeout: 30_000 }, async t => {
  const manager = syntheticManager("migration", 1);
  let releaseWorker;
  const workerBarrier = new Promise(resolve => { releaseWorker = resolve; });
  manager.host.worker = async (input, signal) => {
    const delivery = {
      artifact: "native-channel-task",
      pin: "c".repeat(64),
      workerId: "peer-two",
      paths: ["deliverables/worker-1/result.md"],
    };
    input.publish({ grade: "draft", delivery });
    await Promise.race([
      workerBarrier,
      new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })),
    ]);
    return delivery;
  };
  const humanToken = Object.freeze({});
  const f = await nativeWorkspace(t, {
    manager: manager.config,
    channel: {
      actorForPublic: actor => peers.has(actor.id) ? { actorId: actor.id, kind: "agent" } : undefined,
      resolveNativeActor: token => token === humanToken ? { actorId: "channel-human", kind: "human" } : undefined,
      authorizeHuman: actor => actor.actorId === "channel-human" && actor.kind === "human",
      authorizeDirected: (actor, recipient) => peers.has(actor.actorId) && peers.has(recipient.actorId) && actor.actorId !== recipient.actorId,
      taskAuthorityFactory: ({ database, assertLease }) => {
        const findRun = task => database.prepare(`SELECT actor_id,owner_id,version,record FROM manager_runtime_runs
          WHERE actor_id='peer-one' AND run_id=?`).get(task.runId);
        const taskAndAttempt = (runRow, taskPin) => {
          if (!runRow || runRow.owner_id !== "batch06-native-owner") return undefined;
          const run = JSON.parse(runRow.record);
          const task = run.tasks.find(item => item.definition.taskId === taskPin.taskId);
          const attempt = task?.attempts.find(item => item.attemptId === taskPin.attemptId);
          return { run, task, attempt };
        };
        const event = (runRow, input) => {
          const current = JSON.parse(runRow.record);
          const priorVersion = current.version;
          current.version++;
          current.lastSequence++;
          current.updatedAt = Date.now();
          const record = {
            seq: current.lastSequence,
            runId: current.runId,
            version: current.version,
            type: `channel.task.${input.kind}`,
            time: current.updatedAt,
            data: {
              operationId: input.operationId,
              channelId: input.channelId,
              taskId: input.task.taskId,
              attemptId: input.task.attemptId,
              text: input.text,
            },
          };
          const changed = database.prepare(`UPDATE manager_runtime_runs SET version=?,record=?
            WHERE actor_id=? AND owner_id=? AND run_id=? AND version=?`)
            .run(current.version, JSON.stringify(current), runRow.actor_id, runRow.owner_id, current.runId, priorVersion);
          if (changed.changes !== 1) throw new Error("Canonical Manager task projection changed concurrently.");
          database.prepare("INSERT INTO manager_runtime_events VALUES(?,?,?,?,?)")
            .run(runRow.actor_id, runRow.owner_id, current.runId, record.seq, JSON.stringify(record));
          return { ...input.task, expectedVersion: current.version };
        };
        return {
          authorize(input) {
            assertLease();
            if (!database.isTransaction || input.task.authority !== "manager") return false;
            const managerActor = input.kind === "assign" ? input.actor : input.recipient;
            const workerActor = input.kind === "assign" ? input.recipient : input.actor;
            if (managerActor.actorId !== "peer-one" || workerActor.actorId !== "peer-two") return false;
            const row = findRun(input.task), current = taskAndAttempt(row, input.task);
            return !!current && row.version === input.task.expectedVersion
              && current.run.version === input.task.expectedVersion
              && current.run.state === "active"
              && current.task?.definitionHash === input.task.definitionSha256
              && current.task.owner === "peer-two"
              && current.task.state === "running"
              && current.attempt?.state === "running";
          },
          apply(input) {
            assertLease();
            if (!database.isTransaction) throw new Error("Channel task projection must share the parent transaction.");
            const row = findRun(input.task);
            if (!taskAndAttempt(row, input.task) || row.version !== input.task.expectedVersion) {
              throw new Error("Canonical Manager task pin changed.");
            }
            return event(row, input);
          },
        };
      },
    },
  });
  f.addCleanup(() => f.runtime.close());
  f.addCleanup(() => { releaseWorker(); manager.release(); });

  const managerToken = f.runtime.services.managerToken("peer-one");
  const managerRunInput = manager.start("channel-native");
  f.runtime.services.manager.start(managerToken, managerRunInput);
  const managerRun = await until(() => {
    const run = f.runtime.services.manager.get(managerToken, { runId: managerRunInput.runId });
    const running = run.tasks.find(task => task.definition.phase === "worker" && task.state === "running");
    return running?.owner === "peer-two" && running.attempts.at(-1)?.state === "running" ? { run, task: running } : undefined;
  }, "native Manager worker pin");

  const channel = f.runtime.services.channel;
  const now = Date.now();
  let room = channel.nativeCreate(humanToken, {
    operationId: operation(), channelId: "wire-room", expectedRevision: 0,
    participantId: "manager", expiresAt: now + 60_000,
  });
  const peerDetails = [
    { actorId: "peer-one", participantId: "peer-one", role: "manager" },
    { actorId: "peer-two", participantId: "peer-two", role: "worker" },
  ];
  const peerUrls = new Map();
  for (const peer of peerDetails) {
    const invite = channel.nativeInviteCreate(humanToken, {
      operationId: operation(), channelId: "wire-room", expectedRevision: room.revision,
      actor: { actorId: peer.actorId, kind: "agent" }, participantId: peer.participantId, role: peer.role,
      expiresAt: Date.now() + 50_000, memberExpiresAt: Date.now() + 55_000,
    });
    room = channel.nativeHumanApprove(humanToken, {
      operationId: operation(), channelId: "wire-room", expectedRevision: invite.revision,
      invitationId: invite.invitationId,
    });
    const url = await f.listen({ id: peer.actorId, canWrite: true });
    if (peer.actorId === "peer-two") {
      const forged = await httpCall(url, f.bearer, "capability_call", invocation("channel.runtime.accept", {
        operationId: operation(), channelId: "wire-room", expectedRevision: room.revision,
        invitationId: invite.invitationId, token: invite.token, role: "manager",
      }));
      assert.equal(forged.body.error.code, "INVALID_ARGUMENT", "a caller cannot forge the human-approved channel role");
    }
    const accepted = await httpCall(url, f.bearer, "capability_call", invocation("channel.runtime.accept", {
      operationId: operation(), channelId: "wire-room", expectedRevision: room.revision,
      invitationId: invite.invitationId, token: invite.token,
    }));
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    room = accepted.body.result;
    const reconnected = await httpCall(url, f.bearer, "capability_read", invocation("channel.runtime.reconnect", { channelId: "wire-room" }));
    assert.equal(reconnected.status, 200, JSON.stringify(reconnected.body));
    const nativeOnly = await httpCall(url, f.bearer, "capabilities_describe", { operation: "channel.runtime.nativeInviteCreate" });
    assert.notEqual(nativeOnly.status, 200, "agents cannot invoke human-only invitation administration");
    peerUrls.set(peer.actorId, url);
  }

  const invalidCursor = await httpCall(peerUrls.get("peer-one"), f.bearer, "capability_read",
    invocation("channel.runtime.read", { channelId: "wire-room", afterSeq: 99, limit: 10 }));
  assert.notEqual(invalidCursor.status, 200, "a cursor ahead of the recipient mailbox is rejected");

  const pin = {
    authority: "manager",
    runId: managerRun.run.runId,
    taskId: managerRun.task.definition.taskId,
    attemptId: managerRun.task.attempts.at(-1).attemptId,
    definitionSha256: managerRun.task.definitionHash,
    expectedVersion: managerRun.run.version,
  };
  const assigned = await httpCall(peerUrls.get("peer-one"), f.bearer, "capability_call",
    invocation("channel.runtime.assign", {
      operationId: operation(), channelId: "wire-room", expectedRevision: room.revision,
      recipientId: "peer-two", text: "Complete the pinned Manager task.", task: pin,
    }));
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  room = assigned.body.result;
  const workerRead = await httpCall(peerUrls.get("peer-two"), f.bearer, "capability_read",
    invocation("channel.runtime.read", { channelId: "wire-room", afterSeq: 0, limit: 10 }));
  assert.deepEqual(workerRead.body.result.messages.map(message => message.kind), ["assignment"]);
  const assignment = workerRead.body.result.messages[0];
  const update = await httpCall(peerUrls.get("peer-two"), f.bearer, "capability_call",
    invocation("channel.runtime.update", {
      operationId: operation(), channelId: "wire-room", expectedRevision: room.revision,
      assignmentId: assignment.id, task: assignment.task, text: "Worker progress is pinned to the same attempt.",
    }));
  assert.equal(update.status, 200, JSON.stringify(update.body));
  room = update.body.result;

  const waiting = httpCall(peerUrls.get("peer-one"), f.bearer, "capability_read",
    invocation("channel.runtime.wait", { channelId: "wire-room", afterSeq: update.body.result.message.seq, limit: 10, timeoutMs: 5000 }));
  const reply = await httpCall(peerUrls.get("peer-two"), f.bearer, "capability_call",
    invocation("channel.runtime.reply", {
      operationId: operation(), channelId: "wire-room", expectedRevision: room.revision,
      assignmentId: assignment.id, task: update.body.result.message.task,
      afterSeq: assignment.seq, text: "The pinned task handoff is complete.",
    }));
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  room = reply.body.result;
  const received = await waiting;
  assert.equal(received.status, 200, JSON.stringify(received.body));
  assert.deepEqual(received.body.result.messages.map(message => message.kind), ["reply"]);
  assert.equal(received.body.result.messages[0].text, "The pinned task handoff is complete.");

  const managerEvents = f.runtime.services.manager.events(managerToken, {
    runId: managerRun.run.runId, afterSeq: managerRun.run.lastSequence, limit: 10,
  });
  assert.deepEqual(managerEvents.items.map(item => item.type), ["channel.task.assign", "channel.task.update", "channel.task.reply"]);
  assert.equal(f.runtime.services.manager.get(managerToken, { runId: managerRun.run.runId }).version, pin.expectedVersion + 3);
  const database = f.storage.connectNative();
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM channel_runtime_rooms").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE '%channel%task%'").get().count, 0,
      "Channel task authority is projected into the canonical Manager tables, not a duplicate task table");
  } finally { database.close(); }

  const pendingWorkerWait = httpCall(peerUrls.get("peer-two"), f.bearer, "capability_read",
    invocation("channel.runtime.wait", { channelId: "wire-room", afterSeq: assignment.seq, limit: 10, timeoutMs: 5000 }));
  await new Promise(resolve => setTimeout(resolve, 25));
  room = channel.nativeRevoke(humanToken, {
    operationId: operation(), channelId: "wire-room", expectedRevision: room.revision, participantId: "peer-two",
  });
  const cancelledWait = await pendingWorkerWait;
  assert.notEqual(cancelledWait.status, 200, "revocation cancels the peer's active bounded wait");
  const revokedRead = await httpCall(peerUrls.get("peer-two"), f.bearer, "capability_read",
    invocation("channel.runtime.read", { channelId: "wire-room", afterSeq: 0, limit: 10 }));
  assert.notEqual(revokedRead.status, 200, "revocation closes the existing recipient session and mailbox");
  const revokedReconnect = await httpCall(peerUrls.get("peer-two"), f.bearer, "capability_read",
    invocation("channel.runtime.reconnect", { channelId: "wire-room" }));
  assert.notEqual(revokedReconnect.status, 200, "revocation cannot be bypassed by reconnecting");
  assert.equal(room.revision, reply.body.result.revision + 1);
});
