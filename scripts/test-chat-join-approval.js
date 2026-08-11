#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ChatPersistence } = require("../dist/chat-persistence");
const { ChatJoinApprovalManager } = require("../dist/chat-join-approval");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkm-join-approval-test-"));
  const roomId = "approval-room-001";
  const online = new Set();
  try {
    const persistence = new ChatPersistence(root, 60_000);
    await persistence.createRoom(roomId, "Approval Room", {
      ownerInstallationId: "owner", hostCredentialHash: "host", joinSecretHash: "join",
    });
    const changes = [];
    const approvals = new ChatJoinApprovalManager(persistence, (_roomId, participantId) => online.has(participantId), 40, () => changes.push(Date.now()));

    const first = await approvals.request(roomId, "connection-1", "Alpha", "agent");
    assert.strictEqual(approvals.list(roomId).length, 1);
    await approvals.approveNew(first.approval.requestId);
    const firstResult = await first.result;
    assert.strictEqual(firstResult.outcome, "new");
    assert(firstResult.participantId);

    await persistence.releaseAlias(roomId, firstResult.participantId, Date.now());
    const second = await approvals.request(roomId, "connection-2", "Beta", "agent");
    assert(second.approval.reusableParticipants.some(item => item.participantId === firstResult.participantId && item.previousAlias === "Alpha"));
    online.add(firstResult.participantId);
    await assert.rejects(approvals.approveReuse(second.approval.requestId, firstResult.participantId), /offline/);
    online.delete(firstResult.participantId);
    await approvals.approveReuse(second.approval.requestId, firstResult.participantId);
    assert.deepStrictEqual(await second.result, { outcome: "reuse", participantId: firstResult.participantId });

    await persistence.releaseAlias(roomId, firstResult.participantId, Date.now());
    const rejected = await approvals.request(roomId, "connection-3", "Gamma", "browser");
    await approvals.reject(rejected.approval.requestId, "No guests today.");
    assert.deepStrictEqual(await rejected.result, { outcome: "reject", reason: "No guests today." });

    const browser = await approvals.request(roomId, "connection-browser", "Browser", "browser");
    await approvals.approveNew(browser.approval.requestId);
    const browserResult = await browser.result;
    await persistence.releaseAlias(roomId, browserResult.participantId, Date.now());
    const browserRetry = await approvals.request(roomId, "connection-browser-2", "Browser Again", "browser");
    assert(!browserRetry.approval.reusableParticipants.some(item => item.participantId === browserResult.participantId),
      "temporary browser identities must not be offered for Reuse");
    await approvals.reject(browserRetry.approval.requestId);

    const cancelled = await approvals.request(roomId, "connection-4", "Delta", "agent");
    await approvals.cancelConnection("connection-4");
    assert.strictEqual((await cancelled.result).outcome, "cancel");

    const timedOut = await approvals.request(roomId, "connection-5", "Epsilon", "agent");
    assert.strictEqual((await timedOut.result).outcome, "timeout");
    assert.strictEqual(approvals.list().length, 0);
    const persisted = await persistence.identityState(roomId);
    assert.deepStrictEqual(persisted.pendingJoins.map(item => item.status), [
      "approved_new", "approved_reuse", "rejected", "approved_new", "rejected", "cancelled", "timed_out",
    ]);
    assert(changes.length >= 10, "Host UI callback should run when requests enter and leave the queue");
    await approvals.dispose();
    await persistence.dispose();
    console.log("join approval test: New, offline-only Reuse, Reject, disconnect cancel, timeout, and UI notifications OK");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});