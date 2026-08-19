#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ChatPersistence } = require("../dist/chat-persistence");

const roomId = "identity-room-001";
const request = (requestId, alias, requestedAt) => ({ requestId, alias, clientKey: `client-${requestId}`, kind: "agent", requestedAt, expiresAt: requestedAt + 120_000 });

async function crash(persistence) {
  await persistence.worker.terminate();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-participant-persistence-test-"));
  try {
    const first = new ChatPersistence(root, 60_000);
    await first.createRoom(roomId, "Identity Room", {
      ownerInstallationId: "installation-owner",
      hostCredentialHash: "host-hash",
      joinSecretHash: "join-hash",
    });

    await first.requestJoin(roomId, request("join-1", "Alpha", 10));
    await assert.rejects(first.requestJoin(roomId, request("join-conflict", "Ａlpha", 11)), /reserved/,
      "NFKC-equivalent aliases must share one pending reservation");
    await first.resolveJoin(roomId, { requestId: "join-1", outcome: "new", participantId: "participant-1", resolvedAt: 20 });
    await assert.rejects(first.requestJoin(roomId, request("join-active", "alpha", 21)), /currently active/);

    await first.releaseAlias(roomId, "participant-1", 30, "Alpha");
    await first.requestJoin(roomId, request("join-2", "alpha", 31));
    await first.resolveJoin(roomId, { requestId: "join-2", outcome: "new", participantId: "participant-2", resolvedAt: 40 });
    await first.releaseAlias(roomId, "participant-2", 50);

    await first.requestJoin(roomId, request("join-3", "Beta", 51));
    await first.resolveJoin(roomId, { requestId: "join-3", outcome: "reuse", participantId: "participant-1", resolvedAt: 60 });
    await first.renameAlias(roomId, "participant-1", "Beta Prime", 65);
    await first.releaseAlias(roomId, "participant-1", 70);
    await first.forgetParticipant(roomId, "participant-1", 80);

    await first.requestJoin(roomId, request("join-4", "Gamma", 81));
    await assert.rejects(first.resolveJoin(roomId, { requestId: "join-4", outcome: "reuse", participantId: "participant-1", resolvedAt: 90 }), /forgotten/);
    await first.resolveJoin(roomId, { requestId: "join-4", outcome: "cancel", resolvedAt: 91, reason: "test cleanup" });

    await first.requestJoin(roomId, request("join-5", "Delta", 100));
    await crash(first);

    const second = new ChatPersistence(root, 60_000);
    const opened = await second.openRoom(roomId, "Identity Room");
    assert(opened.replayed >= 12, "all unflushed identity journal records must replay after crash");
    const state = await second.identityState(roomId);
    assert.deepStrictEqual(state.memberships.map(item => [item.participantId, item.forgottenAt]), [
      ["participant-1", 80],
      ["participant-2", undefined],
    ]);
    assert.deepStrictEqual(state.aliases.map(item => [item.alias, item.participantId, item.releasedAt]), [
      ["Alpha", "participant-1", 30],
      ["alpha", "participant-2", 50],
      ["Beta", "participant-1", 65],
      ["Beta Prime", "participant-1", 70],
    ], "alias history must preserve display snapshots and reuse across participants");
    assert.deepStrictEqual(state.pendingJoins.map(item => [item.requestId, item.status, item.participantId]), [
      ["join-1", "approved_new", "participant-1"],
      ["join-2", "approved_new", "participant-2"],
      ["join-3", "approved_reuse", "participant-1"],
      ["join-4", "cancelled", undefined],
      ["join-5", "pending", undefined],
    ]);
    await second.resolveJoin(roomId, { requestId: "join-5", outcome: "timeout", resolvedAt: 120_101, reason: "approval timeout" });
    assert.strictEqual((await second.identityState(roomId)).pendingJoins.at(-1).status, "timed_out");
    await second.requestJoin(roomId, request("join-6", "Epsilon", 121_000));
    await second.requestJoin(roomId, request("join-7", "Zeta", 121_001));
    await second.resolveJoin(roomId, { requestId: "join-7", outcome: "new", participantId: "participant-3", resolvedAt: 121_010 });
    await second.closeRoom(roomId, "host left");
    await second.dispose();

    const third = new ChatPersistence(root, 60_000);
    await third.openRoom(roomId, "Identity Room");
    const deactivated = await third.identityState(roomId);
    assert.strictEqual(deactivated.pendingJoins.find(item => item.requestId === "join-6").status, "cancelled",
      "Room deactivation must cancel pending approvals");
    assert.strictEqual(deactivated.aliases.find(item => item.participantId === "participant-3").releasedAt > 0, true,
      "Room deactivation must release active aliases");
    await third.requestJoin(roomId, request("join-8", "Zeta", 122_000));
    await third.resolveJoin(roomId, { requestId: "join-8", outcome: "new", participantId: "participant-4", resolvedAt: 122_010 });
    assert.strictEqual((await third.identityState(roomId)).memberships.at(-1).participantId, "participant-4",
      "a deactivated alias must be reusable by a different participant");
    await third.dispose();
    console.log("participant persistence test: reservation, New, Reuse, alias reuse, Forget, timeout, and crash replay OK");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});