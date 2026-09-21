#!/usr/bin/env node
const assert = require("assert");
const scheduler = require("../dist/workflows/scheduler-model.js");

const {
  WorkflowSchedulerError, claimAssignment, createAgentSnapshot, createSchedulerAssignment,
  declineAssignment, determineOutputAuthority, expireLease, expireOffer, heartbeatLease,
  invalidateForEpochChange, isOutputSubmissionAuthoritative, offerAssignment,
  refreshAgentSnapshot, releaseLease, renewLease, revokeAuthority
} = scheduler;

let commandNumber = 0;
const authority = (runVersion = 1, readyVersion = 1, policyVersion = 1) => ({ runVersion, readyVersion, policyVersion });
const command = (assignment, fingerprint = "fp") => ({
  commandId: `command-${++commandNumber}`,
  fingerprint,
  expected: { assignmentVersion: assignment.version, ...assignment.authority }
});
const apply = result => result.assignment;
const error = (action, code) => assert.throws(action, value => value instanceof WorkflowSchedulerError && value.code === code);
const newAgent = (overrides = {}) => createAgentSnapshot({
  executorId: "executor-1", agentId: "agent-1", state: "available",
  capabilities: ["reasoning", "code-edit"], refreshedAt: 10, refreshDeadline: 100,
  ...overrides
});
const newAssignment = () => createSchedulerAssignment("assignment-1", "attempt-1", authority());
const offer = (assignment = newAssignment(), agent = newAgent(), overrides = {}) => apply(offerAssignment(
  assignment, command(assignment, "offer"), agent,
  { offerId: "offer-1", now: 20, expiresAt: 50, maxOfferDuration: 30, requiredCapabilities: ["reasoning"], ...overrides }
));
const lease = (assignment = offer(), agent = newAgent(), overrides = {}) => apply(claimAssignment(
  assignment, command(assignment, "claim"), agent,
  { offerId: "offer-1", leaseId: "lease-1", now: 30, expiresAt: 80, ...overrides }
));
const proof = assignment => ({
  leaseId: assignment.lease.leaseId,
  leaseVersion: assignment.lease.version,
  fencingToken: assignment.lease.fencingToken
});
const submission = assignment => ({
  assignmentId: assignment.assignmentId,
  attemptId: assignment.attemptId,
  assignmentVersion: assignment.version,
  ...assignment.authority,
  ...proof(assignment),
  executorId: assignment.lease.executorId,
  agentId: assignment.lease.agentId
});

const agent = newAgent();
assert.deepStrictEqual(agent.capabilities, ["reasoning", "code-edit"]);
assert.strictEqual(agent.version, 1);
error(() => newAgent({ refreshedAt: Infinity }), "agent-time-invalid");
error(() => newAgent({ refreshDeadline: Infinity }), "agent-time-invalid");
error(() => newAgent({ refreshedAt: 10, refreshDeadline: 10 }), "agent-refresh-deadline");
error(() => refreshAgentSnapshot(agent, 2, { state: "available", capabilities: [], refreshedAt: 20, refreshDeadline: 30 }), "agent-version-conflict");
error(() => refreshAgentSnapshot(agent, 1, { state: "available", capabilities: [], refreshedAt: 20, refreshDeadline: 20 }), "agent-refresh-deadline");
const refreshedAgent = refreshAgentSnapshot(agent, 1, {
  state: "available", capabilities: ["reasoning"], refreshedAt: 20, refreshDeadline: 120
});
assert.strictEqual(refreshedAgent.version, 2);
assert.deepStrictEqual(refreshedAgent.capabilities, ["reasoning"]);

let assignment = newAssignment();
assert.deepStrictEqual(assignment.authority, authority());
assert.strictEqual(assignment.state, "queued");
assert.strictEqual(assignment.fencingToken, 0);

const badAssignmentVersion = command(assignment);
badAssignmentVersion.expected.assignmentVersion = 2;
error(() => offerAssignment(assignment, badAssignmentVersion, agent, { offerId: "o", now: 20, expiresAt: 30, maxOfferDuration: 20, requiredCapabilities: [] }), "assignment-version-conflict");
for (const changed of [authority(2, 1, 1), authority(1, 2, 1), authority(1, 1, 2)]) {
  const stale = command(assignment);
  Object.assign(stale.expected, changed);
  error(() => offerAssignment(assignment, stale, agent, { offerId: "o", now: 20, expiresAt: 30, maxOfferDuration: 20, requiredCapabilities: [] }), "authority-version-conflict");
}

const offerInput = { offerId: "offer-1", now: 20, expiresAt: 50, maxOfferDuration: 30, requiredCapabilities: ["reasoning"] };
error(() => offerAssignment({ ...assignment, state: "released" }, command({ ...assignment, state: "released" }), agent, offerInput), "offer-state");
error(() => offerAssignment(assignment, command(assignment), newAgent({ state: "draining" }), offerInput), "agent-unavailable");
error(() => offerAssignment(assignment, command(assignment), agent, { ...offerInput, now: 101, expiresAt: 110 }), "agent-snapshot-stale");
error(() => offerAssignment(assignment, command(assignment), agent, { ...offerInput, requiredCapabilities: ["terminal"] }), "agent-capability-missing");
error(() => offerAssignment(assignment, command(assignment), agent, { ...offerInput, expiresAt: 20 }), "offer-expiry");
error(() => offerAssignment(assignment, command(assignment), agent, { ...offerInput, expiresAt: 51 }), "offer-expiry");

let result = offerAssignment(assignment, command(assignment, "canonical-offer"), agent, offerInput);
assignment = result.assignment;
assert.strictEqual(result.replayed, false);
assert.strictEqual(result.receipt.operation, "offer");
assert.strictEqual(result.receipt.assignmentVersion, 2);
assert.deepStrictEqual(result.receipt.authority, authority());
assert.strictEqual(assignment.offer.agentSnapshotVersion, 1);
const replay = offerAssignment(assignment, {
  commandId: result.receipt.commandId, fingerprint: "canonical-offer",
  expected: { assignmentVersion: 0, ...authority(0, 0, 0) }
}, agent, offerInput);
assert.strictEqual(replay.replayed, true);
assert.strictEqual(replay.assignment, assignment);
assert.strictEqual(replay.receipt, result.receipt);
error(() => offerAssignment(assignment, {
  commandId: result.receipt.commandId, fingerprint: "altered",
  expected: { assignmentVersion: 0, ...authority(0, 0, 0) }
}, agent, offerInput), "command-conflict");

error(() => claimAssignment(newAssignment(), command(newAssignment()), agent, { offerId: "offer-1", leaseId: "l", now: 30, expiresAt: 40 }), "offer-stale-or-claimed");
const offeredWithoutRecord = { ...assignment, offer: undefined };
error(() => claimAssignment(offeredWithoutRecord, command(offeredWithoutRecord), agent, { offerId: "offer-1", leaseId: "l", now: 30, expiresAt: 40 }), "offer-stale-or-claimed");
error(() => claimAssignment(assignment, command(assignment), agent, { offerId: "wrong", leaseId: "l", now: 30, expiresAt: 40 }), "offer-stale-or-claimed");
error(() => claimAssignment(assignment, command(assignment), agent, { offerId: "offer-1", leaseId: "l", now: 51, expiresAt: 60 }), "offer-stale-or-claimed");
error(() => claimAssignment(assignment, command(assignment), newAgent({ executorId: "executor-2" }), { offerId: "offer-1", leaseId: "l", now: 30, expiresAt: 40 }), "offer-agent-mismatch");
error(() => claimAssignment(assignment, command(assignment), newAgent({ agentId: "agent-2" }), { offerId: "offer-1", leaseId: "l", now: 30, expiresAt: 40 }), "offer-agent-mismatch");
error(() => claimAssignment(assignment, command(assignment), refreshedAgent, { offerId: "offer-1", leaseId: "l", now: 30, expiresAt: 40 }), "offer-agent-mismatch");
error(() => claimAssignment(assignment, command(assignment), newAgent({ state: "retired" }), { offerId: "offer-1", leaseId: "l", now: 30, expiresAt: 40 }), "agent-unavailable");
const longOffer = offer(newAssignment(), newAgent({ refreshDeadline: 25 }), { now: 10, expiresAt: 30, maxOfferDuration: 20 });
error(() => claimAssignment(longOffer, command(longOffer), newAgent({ refreshDeadline: 25 }), { offerId: "offer-1", leaseId: "l", now: 26, expiresAt: 40 }), "agent-snapshot-stale");
error(() => claimAssignment(assignment, command(assignment), agent, { offerId: "offer-1", leaseId: "l", now: 30, expiresAt: 30 }), "lease-expiry");

result = claimAssignment(assignment, command(assignment, "claim-success"), agent, {
  offerId: "offer-1", leaseId: "lease-1", now: 30, expiresAt: 80
});
assignment = result.assignment;
assert.strictEqual(assignment.state, "leased");
assert.strictEqual(assignment.offer, undefined);
assert.strictEqual(assignment.fencingToken, 1);
assert.deepStrictEqual(assignment.lease, {
  leaseId: "lease-1", executorId: "executor-1", agentId: "agent-1", agentSnapshotVersion: 1,
  assignmentVersion: 3, version: 1, fencingToken: 1, issuedAt: 30, heartbeatAt: 30, expiresAt: 80
});
error(() => claimAssignment(assignment, command(assignment), agent, { offerId: "offer-1", leaseId: "l2", now: 31, expiresAt: 90 }), "offer-stale-or-claimed");

let declineBase = offer();
error(() => declineAssignment(newAssignment(), command(newAssignment()), agent, { offerId: "offer-1", reason: "busy", now: 30 }), "offer-stale-or-claimed");
const declineMissing = { ...declineBase, offer: undefined };
error(() => declineAssignment(declineMissing, command(declineMissing), agent, { offerId: "offer-1", reason: "busy", now: 30 }), "offer-stale-or-claimed");
error(() => declineAssignment(declineBase, command(declineBase), agent, { offerId: "wrong", reason: "busy", now: 30 }), "offer-stale-or-claimed");
error(() => declineAssignment(declineBase, command(declineBase), agent, { offerId: "offer-1", reason: "busy", now: 51 }), "offer-stale-or-claimed");
error(() => declineAssignment(declineBase, command(declineBase), agent, { offerId: "offer-1", reason: " ", now: 30 }), "decline-reason-required");
declineBase = apply(declineAssignment(declineBase, command(declineBase), agent, { offerId: "offer-1", reason: " capacity ", now: 30 }));
assert.strictEqual(declineBase.state, "queued");
assert.deepStrictEqual(declineBase.lastDecline, { executorId: "executor-1", agentId: "agent-1", reason: "capacity", declinedAt: 30 });

error(() => expireOffer(newAssignment(), command(newAssignment()), 60), "offer-state");
const expireMissing = { ...offer(), offer: undefined };
error(() => expireOffer(expireMissing, command(expireMissing), 60), "offer-state");
const expireBase = offer();
error(() => expireOffer(expireBase, command(expireBase), 50), "offer-not-expired");
assert.strictEqual(apply(expireOffer(expireBase, command(expireBase), 51)).state, "queued");

const leasedWithoutRecord = { ...assignment, lease: undefined };
error(() => heartbeatLease(newAssignment(), command(newAssignment()), { leaseId: "l", leaseVersion: 1, fencingToken: 1 }, 40), "lease-inactive");
error(() => heartbeatLease(leasedWithoutRecord, command(leasedWithoutRecord), { leaseId: "l", leaseVersion: 1, fencingToken: 1 }, 40), "lease-inactive");
error(() => heartbeatLease(assignment, command(assignment), { ...proof(assignment), leaseId: "wrong" }, 40), "lease-fenced");
error(() => heartbeatLease(assignment, command(assignment), { ...proof(assignment), leaseVersion: 2 }, 40), "lease-fenced");
error(() => heartbeatLease(assignment, command(assignment), { ...proof(assignment), fencingToken: 2 }, 40), "lease-fenced");
error(() => heartbeatLease(assignment, command(assignment), proof(assignment), 81), "lease-expired");
error(() => heartbeatLease(assignment, command(assignment), proof(assignment), 29), "server-time-regressed");
assignment = apply(heartbeatLease(assignment, command(assignment), proof(assignment), 40));
assert.strictEqual(assignment.lease.version, 2);
assert.strictEqual(assignment.lease.assignmentVersion, assignment.version);
assert.strictEqual(assignment.lease.heartbeatAt, 40);

error(() => renewLease(assignment, command(assignment), newAgent({ agentId: "other" }), proof(assignment), { now: 50, expiresAt: 90 }), "lease-agent-mismatch");
error(() => renewLease(assignment, command(assignment), newAgent({ state: "draining" }), proof(assignment), { now: 50, expiresAt: 90 }), "agent-unavailable");
error(() => renewLease(assignment, command(assignment), newAgent({ refreshDeadline: 49 }), proof(assignment), { now: 50, expiresAt: 90 }), "agent-snapshot-stale");
error(() => renewLease(assignment, command(assignment), refreshedAgent, proof(assignment), { now: 50, expiresAt: 80 }), "lease-renewal-invalid");
assignment = apply(renewLease(assignment, command(assignment), refreshedAgent, proof(assignment), { now: 50, expiresAt: 100 }));
assert.strictEqual(assignment.lease.version, 3);
assert.strictEqual(assignment.lease.agentSnapshotVersion, 2);
assert.strictEqual(assignment.lease.heartbeatAt, 50);
assert.strictEqual(assignment.lease.expiresAt, 100);
error(() => renewLease(assignment, command(assignment), agent, proof(assignment), { now: 60, expiresAt: 110 }), "lease-agent-mismatch");

const authoritativeSubmission = submission(assignment);
assert.deepStrictEqual(determineOutputAuthority(assignment, authoritativeSubmission, refreshedAgent, 100), { authoritative: true, reason: "authoritative" });
assert.strictEqual(isOutputSubmissionAuthoritative(assignment, authoritativeSubmission, refreshedAgent, 100), true);
const denied = (change, changedAssignment = assignment, changedAgent = refreshedAgent, now = 60) =>
  determineOutputAuthority(changedAssignment, { ...authoritativeSubmission, ...change }, changedAgent, now);
assert.strictEqual(denied({ assignmentId: "other" }).reason, "assignment-mismatch");
assert.strictEqual(denied({ attemptId: "other" }).reason, "attempt-mismatch");
assert.strictEqual(denied({ runVersion: 2 }).reason, "authority-stale");
assert.strictEqual(denied({ readyVersion: 2 }).reason, "authority-stale");
assert.strictEqual(denied({ policyVersion: 2 }).reason, "authority-stale");
assert.strictEqual(denied({ assignmentVersion: assignment.version - 1 }).reason, "assignment-version-stale");
assert.strictEqual(denied({}, { ...assignment, state: "released" }).reason, "lease-inactive");
assert.strictEqual(denied({}, { ...assignment, lease: undefined }).reason, "lease-inactive");
assert.strictEqual(denied({ leaseId: "other" }).reason, "lease-stale");
assert.strictEqual(denied({ leaseVersion: 1 }).reason, "lease-stale");
assert.strictEqual(denied({ fencingToken: 2 }).reason, "lease-stale");
assert.strictEqual(denied({ executorId: "other" }).reason, "identity-mismatch");
assert.strictEqual(denied({ agentId: "other" }).reason, "identity-mismatch");
assert.strictEqual(denied({}, assignment, agent, 101).reason, "lease-expired");
assert.strictEqual(denied({}, assignment, newAgent({ executorId: "other" })).reason, "agent-snapshot-stale");
assert.strictEqual(denied({}, assignment, newAgent({ agentId: "other" })).reason, "agent-snapshot-stale");
assert.strictEqual(denied({}, assignment, agent).reason, "agent-snapshot-stale");
assert.strictEqual(denied({}, assignment, newAgent({ refreshDeadline: 59 }), 60).reason, "agent-snapshot-stale");
assert.strictEqual(isOutputSubmissionAuthoritative(assignment, { ...authoritativeSubmission, leaseId: "old" }, refreshedAgent, 60), false);

let released = apply(releaseLease(assignment, command(assignment), proof(assignment), 100));
assert.strictEqual(released.state, "released");
assert.strictEqual(released.fencingToken, 2);
assert.strictEqual(released.lease, undefined);
assert.strictEqual(determineOutputAuthority(released, authoritativeSubmission, agent, 60).reason, "assignment-version-stale");

let revokeBase = offer();
error(() => revokeAuthority(newAssignment(), command(newAssignment()), "policy"), "authority-inactive");
error(() => revokeAuthority(revokeBase, command(revokeBase), " "), "revocation-reason-required");
let revoked = apply(revokeAuthority(revokeBase, command(revokeBase), " policy changed "));
assert.strictEqual(revoked.state, "revoked");
assert.strictEqual(revoked.fencingToken, 1);
assert.strictEqual(revoked.invalidationReason, "policy changed");
const revokeLeaseBase = lease();
revoked = apply(revokeAuthority(revokeLeaseBase, command(revokeLeaseBase), "cancelled"));
assert.strictEqual(revoked.fencingToken, 2);

error(() => expireLease(newAssignment(), command(newAssignment()), 100), "lease-inactive");
const expiryMissing = { ...lease(), lease: undefined };
error(() => expireLease(expiryMissing, command(expiryMissing), 100), "lease-inactive");
const expiryBase = lease();
error(() => expireLease(expiryBase, command(expiryBase), 80), "lease-not-expired");
const expired = apply(expireLease(expiryBase, command(expiryBase), 81));
assert.strictEqual(expired.state, "expired");
assert.strictEqual(expired.fencingToken, 2);
assert.strictEqual(Object.hasOwn(expired, "outcome"), false);
assert.strictEqual(Object.hasOwn(released, "outcome"), false);
assert.strictEqual(Object.hasOwn(revoked, "outcome"), false);

const epochBase = lease();
error(() => invalidateForEpochChange(epochBase, command(epochBase), authority(0, 1, 1), false, "run"), "authority-version-regressed");
error(() => invalidateForEpochChange(epochBase, command(epochBase), authority(1, 0, 1), false, "ready"), "authority-version-regressed");
error(() => invalidateForEpochChange(epochBase, command(epochBase), authority(1, 1, 0), false, "policy"), "authority-version-regressed");
error(() => invalidateForEpochChange(epochBase, command(epochBase), authority(), false, "none"), "authority-version-unchanged");
error(() => invalidateForEpochChange(epochBase, command(epochBase), authority(2, 1, 1), false, " "), "invalidation-reason-required");
const invalidated = apply(invalidateForEpochChange(epochBase, command(epochBase), authority(2, 2, 2), false, "epochs advanced"));
assert.strictEqual(invalidated.state, "revoked");
assert.strictEqual(invalidated.fencingToken, 2);
assert.deepStrictEqual(invalidated.authority, authority(2, 2, 2));
assert.strictEqual(determineOutputAuthority(invalidated, submission(epochBase), agent, 40).reason, "authority-stale");
const archived = apply(invalidateForEpochChange(newAssignment(), command(newAssignment()), authority(), true, "archived"));
assert.strictEqual(archived.archived, true);
assert.strictEqual(archived.state, "revoked");

console.log("workflow scheduler model test: offers, claims, leases, CAS, snapshots, fencing, and output authority OK");