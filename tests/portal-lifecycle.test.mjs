import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import { channelFixture } from "./channel-runtime-fixtures.mjs";
import { CollaborationStateStore } from "../dist/collaboration-state.js";
import {
  createPortalLifecycleHost, createPortalLifecycleRuntime, initializePortalLifecycleSchema,
  PortalLifecycleError, PORTAL_LIFECYCLE_SUPPORT,
} from "../dist/portal-lifecycle.js";
import { portalLifecycleDefinitions } from "../dist/portal-lifecycle-contracts.js";
import { checkNativeRecords, readOriginalSource } from "../scripts/migration.mjs";
import { authenticateContextSources } from "./context-original-source-captures.mjs";

const serverRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(serverRoot, "legacy");
const uuid = () => randomUUID();
const fail = (work, code) => assert.throws(work, error => error instanceof PortalLifecycleError && error.code === code);
const inviteArgs = (sessionId, expectedRevision, now, meetingId) => ({
  operationId: uuid(), sessionId, expectedRevision, expiresAt: now + 60_000, ...(meetingId ? { meetingId } : {}),
});

function lifecycleFixture(options = {}) {
  const f = channelFixture();
  const channelRuntime = f.runtime;
  const collaboration = new CollaborationStateStore(f.db, {
    authorizeHuman: actor => actor.kind === "human" && actor.actorId === "human-manager",
  });
  const roomId = "room-native-one";
  collaboration.create({ actorId: "human-manager", kind: "human" }, {
    operationId: uuid(), roomId, name: "Synthetic Room", alias: "Manager",
  });
  f.create();
  let permitHuman = true;
  f.host.transaction(() => initializePortalLifecycleSchema(f.db));
  const channel = options.channel ?? channelRuntime;
  const host = createPortalLifecycleHost({
    resolveActor: token => f.host.resolveActor(token),
    authorizeHuman: (actor, action) => permitHuman && actor.kind === "human" && actor.actorId === "human-manager"
      && !["portal.permissions", "portal.command"].includes(action),
    authorizeRoom: (actor, targetRoomId) => {
      try {
        const room = collaboration.read(actor, targetRoomId);
        return room.status === "active" && room.ownerParticipantId === room.members
          .find(member => member.actorId === actor.actorId && member.kind === actor.kind)?.participantId;
      } catch { return false; }
    },
    assertLease: () => f.host.assertLease(),
    transaction: f.host.transaction,
    claimReceipt: (...args) => f.host.claimReceipt(...args),
    channel,
    resolveChannelOwnerToken: () => f.tokens.manager,
    now: f.now,
  });
  const runtime = createPortalLifecycleRuntime(f.db, host);
  const open = runtime.openExisting(f.tokens.manager, {
    operationId: uuid(), channelId: "channel-one", roomId,
  });
  return {
    ...f, collaboration, runtime, channelRuntime, host, roomId, open,
    denyHuman() { permitHuman = false; },
    allowHuman() { permitHuman = true; },
    close() { runtime.dispose(); f.close(); },
    revision() { return runtime.status(f.tokens.manager, { sessionId: open.sessionId }).revision; },
  };
}

test("Portal lifecycle provenance authenticates the exact historical original sources", async () => {
  const provenance = JSON.parse(readFileSync(resolve(serverRoot, "migration/portal-lifecycle-provenance.json"), "utf8"));
  await authenticateContextSources(provenance.captures);
});

test("original Portal request oracle maps only the exact captured operation vocabulary", async () => {
  const source = readFileSync(resolve(serverRoot, "domain/portal-lifecycle-original-api-chat-control.py"), "utf8");
  const provenance = JSON.parse(readFileSync(resolve(serverRoot, "migration/portal-lifecycle-provenance.json"), "utf8"));
  assert.match(source, /if operation not in \{"open", "connections", "status", "send", "command", "route", "get", "attempts", "cancel", "disconnect", "switch", "permissions", "files"\}/);
  const operations = PORTAL_LIFECYCLE_SUPPORT.originalPortalControlOperations.map(item => item.operation);
  assert.deepEqual(operations, ["open", "connections", "status", "send", "command", "route", "get", "attempts",
    "cancel", "disconnect", "switch", "permissions", "files"]);
  for (const definition of portalLifecycleDefinitions) assert.match(definition.id, /^portal\.lifecycle\./);
  assert.ok(PORTAL_LIFECYCLE_SUPPORT.originalPortalControlOperations.some(item => item.operation === "files" && item.status === "unsupported"));
  const captures = provenance.captures.map(({ source, destination, sourceSha256, captureSha256 }) => ({
    source, captured: destination, sourceSha256, capturedSha256: captureSha256,
  }));
  for (const record of captures) {
    await readOriginalSource(record.captured, { root: serverRoot, kind: "captured", sha256: record.capturedSha256 });
  }
  assert.deepEqual(await checkNativeRecords(provenance.native), []);
  const hashFile = (root, path) => createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
  assert.deepEqual(await checkNativeRecords(provenance.nextServerEvidence.map(reference => ({
    file: reference.source, sha256: reference.sha256,
  }))), []);
  for (const reference of provenance.evidence) assert.equal(hashFile(repoRoot, reference.source), reference.sourceSha256);
});

test("native Portal lifecycle completes human admission, directed routing, transfer, cancellation and leave", () => {
  const f = lifecycleFixture();
  try {
    const manager = f.runtime, sessionId = f.open.sessionId;
    assert.equal(f.open.state, "active");
    const meeting = manager.startMeeting(f.tokens.manager, {
      operationId: uuid(), sessionId, expectedRevision: f.revision(), meetingId: uuid(), title: "Native lifecycle",
    });
    const pending = manager.requestAdmission(f.tokens.manager, f.tokens.worker,
      inviteArgs(sessionId, meeting.revision, f.now(), meeting.meetingId));
    const cancelled = manager.cancelAdmission(f.tokens.manager, {
      operationId: uuid(), sessionId, invitationId: pending.invitationId, expectedRevision: pending.revision,
    });
    assert.equal(cancelled.state, "cancelled");
    fail(() => manager.cancelAdmission(f.tokens.manager, {
      operationId: uuid(), sessionId: uuid(), invitationId: pending.invitationId, expectedRevision: cancelled.revision,
    }), "NOT_FOUND");
    fail(() => manager.approveAdmission(f.tokens.manager, f.tokens.worker, {
      operationId: uuid(), sessionId, invitationId: pending.invitationId, expectedRevision: cancelled.revision,
      expiresAt: f.now() + 30_000, memberExpiresAt: f.now() + 120_000,
    }), "INVITATION_UNAVAILABLE");

    const requested = manager.requestAdmission(f.tokens.manager, f.tokens.worker,
      inviteArgs(sessionId, cancelled.revision, f.now(), meeting.meetingId));
    assert.notEqual(manager.readAdmission(sessionId, requested.invitationId).participant_id,
      manager.readAdmission(sessionId, pending.invitationId).participant_id);
    const workerParticipantId = manager.readAdmission(sessionId, requested.invitationId).participant_id;
    const wrongIdentity = f.tokens.outsider;
    fail(() => manager.approveAdmission(f.tokens.manager, wrongIdentity, {
      operationId: uuid(), sessionId, invitationId: requested.invitationId, expectedRevision: requested.revision,
      expiresAt: f.now() + 30_000, memberExpiresAt: f.now() + 120_000,
    }), "INVITATION_UNAVAILABLE");

    f.denyHuman();
    fail(() => manager.approveAdmission(f.tokens.manager, f.tokens.worker, {
      operationId: uuid(), sessionId, invitationId: requested.invitationId, expectedRevision: requested.revision,
      expiresAt: f.now() + 30_000, memberExpiresAt: f.now() + 120_000,
    }), "HUMAN_AUTHORITY_REQUIRED");
    fail(() => manager.approveAdmission(f.tokens.worker, f.tokens.worker, {
      operationId: uuid(), sessionId, invitationId: requested.invitationId, expectedRevision: requested.revision,
      expiresAt: f.now() + 30_000, memberExpiresAt: f.now() + 120_000,
    }), "HUMAN_AUTHORITY_REQUIRED");
    f.allowHuman();

    const approvalArgs = {
      operationId: uuid(), sessionId, invitationId: requested.invitationId, expectedRevision: requested.revision,
      expiresAt: f.now() + 30_000, memberExpiresAt: f.now() + 120_000,
    };
    const approved = manager.approveAdmission(f.tokens.manager, f.tokens.worker, approvalArgs);
    assert.match(approved.token, /^[A-Za-z0-9_-]{43}$/);
    fail(() => manager.approveAdmission(f.tokens.manager, f.tokens.worker, approvalArgs), "INVITATION_SECRET_NOT_REPLAYED");
    const persisted = [
      "portal_lifecycle_pairs", "portal_lifecycle_admissions", "portal_lifecycle_meetings", "portal_lifecycle_receipts",
      "channel_runtime_rooms", "channel_runtime_receipts",
    ].flatMap(table => f.db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row))).join("\n");
    assert.equal(persisted.includes(approved.token), false);

    fail(() => manager.admit(f.tokens.outsider, {
      operationId: uuid(), sessionId, invitationId: requested.invitationId, expectedRevision: manager.status(f.tokens.manager, { sessionId }).revision,
      token: approved.token,
    }), "INVITATION_UNAVAILABLE");
    const admitted = manager.admit(f.tokens.worker, {
      operationId: uuid(), sessionId, invitationId: requested.invitationId,
      expectedRevision: manager.status(f.tokens.manager, { sessionId }).revision, token: approved.token,
    });
    assert.equal(admitted.state, "admitted");
    const activeStatus = manager.status(f.tokens.manager, { sessionId });
    assert.equal(z.json().safeParse(activeStatus).success, true);
    assert.equal(Object.hasOwn(activeStatus.meetings[0], "endedAt"), false);
    const sent = manager.route(f.tokens.manager, {
      operationId: uuid(), sessionId, expectedRevision: manager.status(f.tokens.manager, { sessionId }).revision,
      meetingId: meeting.meetingId, recipientId: workerParticipantId, text: "direct only",
    });
    assert.equal(sent.message.recipientId, workerParticipantId);
    const received = manager.read(f.tokens.worker, { sessionId, afterSeq: 0, limit: 50 });
    assert.deepEqual(received.messages.map(item => item.text), ["direct only"]);
    const oldConnection = f.channelRuntime.connect(f.tokens.worker, { channelId: "channel-one" });
    const oldGeneration = oldConnection.generation;

    const transferRevision = manager.status(f.tokens.manager, { sessionId }).revision;
    const transferred = manager.transfer(f.tokens.manager, f.tokens.observer, {
      revoke: {
        operationId: uuid(), sessionId, invitationId: requested.invitationId, expectedRevision: transferRevision,
      },
      invitation: inviteArgs(sessionId, transferRevision + 2, f.now(), meeting.meetingId),
    });
    assert.equal(transferred.revoked.state, "revoked");
    const approvedObserver = manager.approveAdmission(f.tokens.manager, f.tokens.observer, {
      operationId: uuid(), sessionId, invitationId: transferred.admission.invitationId,
      expectedRevision: manager.status(f.tokens.manager, { sessionId }).revision,
      expiresAt: f.now() + 30_000, memberExpiresAt: f.now() + 120_000,
    });
    const admittedObserver = manager.admit(f.tokens.observer, {
      operationId: uuid(), sessionId, invitationId: transferred.admission.invitationId,
      expectedRevision: manager.status(f.tokens.manager, { sessionId }).revision, token: approvedObserver.token,
    });
    assert.equal(admittedObserver.state, "admitted");
    const leave = manager.leave(f.tokens.observer, {
      operationId: uuid(), sessionId, invitationId: transferred.admission.invitationId,
      expectedRevision: manager.status(f.tokens.manager, { sessionId }).revision,
    });
    assert.equal(leave.state, "revoked");
    fail(() => manager.route(f.tokens.worker, {
      operationId: uuid(), sessionId, expectedRevision: manager.status(f.tokens.manager, { sessionId }).revision,
      recipientId: "manager", text: "after leave",
    }), "FORBIDDEN");
    assert.deepEqual(manager.connections(f.tokens.outsider).items, []);
    fail(() => manager.status(f.tokens.outsider, { sessionId }), "FORBIDDEN");
    assert.equal(manager.status(f.tokens.manager, { sessionId }).admissions[2].state, "revoked");
    assert.equal(manager.adjournMeeting(f.tokens.manager, {
      operationId: uuid(), sessionId, meetingId: meeting.meetingId,
      expectedRevision: manager.status(f.tokens.manager, { sessionId }).revision,
    }).status, "adjourned");
    const freshInvitation = manager.requestAdmission(f.tokens.manager, f.tokens.worker,
      inviteArgs(sessionId, f.revision(), f.now()));
    const freshParticipantId = manager.readAdmission(sessionId, freshInvitation.invitationId).participant_id;
    assert.notEqual(freshParticipantId, workerParticipantId);
    const freshApproval = manager.approveAdmission(f.tokens.manager, f.tokens.worker, {
      operationId: uuid(), sessionId, invitationId: freshInvitation.invitationId, expectedRevision: f.revision(),
      expiresAt: f.now() + 30_000, memberExpiresAt: f.now() + 120_000,
    });
    manager.admit(f.tokens.worker, {
      operationId: uuid(), sessionId, invitationId: freshInvitation.invitationId,
      expectedRevision: f.revision(), token: freshApproval.token,
    });
    const members = JSON.parse(f.db.prepare("SELECT record FROM channel_runtime_rooms WHERE channel_id=?")
      .get("channel-one").record).members;
    const newMember = members.find(member => member.participantId === freshParticipantId);
    assert.notEqual(newMember.generation, oldGeneration);
    assert.equal(members.find(member => member.participantId === workerParticipantId).revoked, true);
    assert.throws(() => oldConnection.read({ channelId: "channel-one" }),
      error => ["CONNECTION_UNAVAILABLE", "FORBIDDEN"].includes(error.code));
    const freshMessage = manager.route(f.tokens.manager, {
      operationId: uuid(), sessionId, expectedRevision: f.revision(), recipientId: freshParticipantId,
      text: "fresh generation only",
    });
    assert.equal(freshMessage.message.recipientGeneration, newMember.generation);
    assert.deepEqual(manager.read(f.tokens.worker, { sessionId }).messages.map(message => message.text),
      ["fresh generation only"]);
    const adjournedStatus = manager.status(f.tokens.manager, { sessionId });
    assert.equal(z.json().safeParse(adjournedStatus).success, true);
    assert.equal(Object.hasOwn(adjournedStatus.meetings[0], "endedAt"), true);
    assert.equal(Object.hasOwn(adjournedStatus.admissions.at(-1), "meetingId"), false);
    oldConnection.disconnect();
  } finally { f.close(); }
});

test("Portal route reserves public global operation IDs and replays exact receipts before revision checks", () => {
  const f = lifecycleFixture();
  try {
    const sessionId = f.open.sessionId;
    const invitation = f.runtime.requestAdmission(f.tokens.manager, f.tokens.worker,
      inviteArgs(sessionId, f.revision(), f.now()));
    const approved = f.runtime.approveAdmission(f.tokens.manager, f.tokens.worker, {
      operationId: uuid(), sessionId, invitationId: invitation.invitationId, expectedRevision: f.revision(),
      expiresAt: f.now() + 30_000, memberExpiresAt: f.now() + 120_000,
    });
    f.runtime.admit(f.tokens.worker, {
      operationId: uuid(), sessionId, invitationId: invitation.invitationId,
      expectedRevision: f.revision(), token: approved.token,
    });
    const input = { operationId: uuid(), sessionId, expectedRevision: f.revision(),
      recipientId: f.runtime.readAdmission(sessionId, invitation.invitationId).participant_id, text: "one committed delivery" };
    const conflict = uuid();
    f.host.transaction(() => f.host.claimReceipt(conflict, "another-domain-fingerprint"));
    assert.throws(() => f.runtime.route(f.tokens.manager, { ...input, operationId: conflict }),
      error => error.code === "GLOBAL_OPERATION_CONFLICT");
    assert.equal(f.revision(), input.expectedRevision);
    const result = f.runtime.route(f.tokens.manager, input);
    assert.deepEqual(f.runtime.route(f.tokens.manager, input), result);
    fail(() => f.runtime.route(f.tokens.manager, { ...input, text: "changed" }), "OPERATION_CONFLICT");
    assert.equal(f.runtime.read(f.tokens.worker, { sessionId }).messages.length, 1);
    const persisted = f.db.prepare("SELECT status FROM portal_lifecycle_receipts WHERE operation_id=?").get(input.operationId);
    assert.equal(persisted.status, "complete");

    const interrupted = createPortalLifecycleRuntime(f.db, {
      ...f.host,
      channel: {
        ...f.channelRuntime,
        connect(token, args) {
          const client = f.channelRuntime.connect(token, args);
          return { ...client, send(input) { client.send(input); throw new Error("after Channel commit"); } };
        },
      },
    });
    const unknownInput = { ...input, operationId: uuid(), expectedRevision: f.revision(), text: "unknown delivery" };
    fail(() => interrupted.route(f.tokens.manager, unknownInput), "OUTCOME_UNKNOWN");
    fail(() => interrupted.route(f.tokens.manager, unknownInput), "OUTCOME_UNKNOWN");
    assert.equal(interrupted.inspectRecovery().filter(row => row.operationId === unknownInput.operationId)[0].status, "unknown");
    assert.equal(f.runtime.read(f.tokens.worker, { sessionId }).messages.length, 2);
    interrupted.dispose();
  } finally { f.close(); }
});

test("restart exposes unknown effects and never replays a committed Channel invitation", () => {
  const f = lifecycleFixture();
  try {
    const sessionId = f.open.sessionId;
    const pending = f.runtime.requestAdmission(f.tokens.manager, f.tokens.worker,
      inviteArgs(sessionId, f.revision(), f.now()));
    let injected = false;
    const interruptedChannel = {
      ...f.channelRuntime,
      nativeInviteCreate(token, args) {
        const result = f.channelRuntime.nativeInviteCreate(token, args);
        if (!injected) { injected = true; throw new Error("simulated interruption after durable channel commit"); }
        return result;
      },
    };
    f.runtime.dispose();
    const restarted = createPortalLifecycleRuntime(f.db, createPortalLifecycleHost({
      resolveActor: token => f.host.resolveActor(token),
      authorizeHuman: (actor, action) => actor.kind === "human" && actor.actorId === "human-manager",
      authorizeRoom: (actor, target) => {
        try { return f.collaboration.read(actor, target).ownerParticipantId !== ""; } catch { return false; }
      },
      assertLease: () => f.host.assertLease(), transaction: f.host.transaction,
      claimReceipt: (...args) => f.host.claimReceipt(...args), channel: interruptedChannel,
      resolveChannelOwnerToken: () => f.tokens.manager, now: f.now,
    }));
    fail(() => restarted.approveAdmission(f.tokens.manager, f.tokens.worker, {
      operationId: uuid(), sessionId, invitationId: pending.invitationId, expectedRevision: pending.revision,
      expiresAt: f.now() + 30_000, memberExpiresAt: f.now() + 120_000,
    }), "OUTCOME_UNKNOWN");
    assert.equal(restarted.inspectRecovery().length, 1);
    assert.equal(restarted.inspectRecovery()[0].status, "unknown");
    fail(() => restarted.approveAdmission(f.tokens.manager, f.tokens.worker, {
      operationId: uuid(), sessionId, invitationId: pending.invitationId, expectedRevision: restarted.status(f.tokens.manager, { sessionId }).revision,
      expiresAt: f.now() + 30_000, memberExpiresAt: f.now() + 120_000,
    }), "OUTCOME_UNKNOWN");
    const room = JSON.parse(f.db.prepare("SELECT record FROM channel_runtime_rooms WHERE channel_id=?").get("channel-one").record);
    assert.equal(room.invitations.length, 1);
    assert.equal(room.invitations[0].approved, false);
    restarted.dispose();
  } finally { f.close(); }
});

test("default policies deny, invalid transfer scopes fail closed, and original external features are explicit", () => {
  const f = channelFixture();
  try {
    f.create();
    f.host.transaction(() => initializePortalLifecycleSchema(f.db));
    const unavailable = createPortalLifecycleRuntime(f.db, createPortalLifecycleHost({
      resolveActor: token => f.host.resolveActor(token),
      assertLease: () => f.host.assertLease(), transaction: f.host.transaction,
      claimReceipt: (...args) => f.host.claimReceipt(...args), channel: f.channelRuntime,
    }));
    fail(() => unavailable.openExisting(f.tokens.manager, { operationId: uuid(), channelId: "channel-one", roomId: "room" }),
      "HUMAN_AUTHORITY_REQUIRED");
    fail(() => unavailable.unsupported("files"), "UNSUPPORTED_OPERATION");
    fail(() => unavailable.unsupported("permissions"), "UNSUPPORTED_OPERATION");
    fail(() => unavailable.unsupported("command"), "UNSUPPORTED_OPERATION");
    fail(() => unavailable.unsupported("not-an-original-operation"), "INVALID_OPERATION");
    assert.deepEqual(unavailable.inspectRecovery(), []);
    unavailable.dispose();
  } finally { f.close(); }
});
