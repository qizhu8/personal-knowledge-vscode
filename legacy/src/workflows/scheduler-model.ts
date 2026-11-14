export type AssignmentState = "queued" | "offered" | "leased" | "released" | "revoked" | "expired";
export type AgentState = "available" | "draining" | "retired";

export interface AuthorityTuple {
  runVersion: number;
  readyVersion: number;
  policyVersion: number;
}

export interface AgentSnapshot {
  executorId: string;
  agentId: string;
  version: number;
  state: AgentState;
  capabilities: readonly string[];
  refreshedAt: number;
  refreshDeadline: number;
}

export interface AssignmentOffer {
  offerId: string;
  executorId: string;
  agentId: string;
  agentSnapshotVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export interface AssignmentLease {
  leaseId: string;
  executorId: string;
  agentId: string;
  agentSnapshotVersion: number;
  assignmentVersion: number;
  version: number;
  fencingToken: number;
  issuedAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface SchedulerCommand {
  commandId: string;
  fingerprint: string;
  expected: AuthorityTuple & { assignmentVersion: number };
}

export interface SchedulerReceipt {
  commandId: string;
  fingerprint: string;
  operation: string;
  assignmentVersion: number;
  authority: AuthorityTuple;
  fencingToken: number;
}

export interface DeclineRecord {
  executorId: string;
  agentId: string;
  reason: string;
  declinedAt: number;
}

export interface SchedulerAssignment {
  assignmentId: string;
  attemptId: string;
  state: AssignmentState;
  version: number;
  authority: AuthorityTuple;
  fencingToken: number;
  archived: boolean;
  offer?: AssignmentOffer;
  lease?: AssignmentLease;
  lastDecline?: DeclineRecord;
  invalidationReason?: string;
  receipts: readonly SchedulerReceipt[];
}

export interface SchedulerResult {
  assignment: SchedulerAssignment;
  receipt: SchedulerReceipt;
  replayed: boolean;
}

export interface LeaseProof {
  leaseId: string;
  leaseVersion: number;
  fencingToken: number;
}

export interface OutputSubmission extends AuthorityTuple, LeaseProof {
  assignmentId: string;
  attemptId: string;
  assignmentVersion: number;
  executorId: string;
  agentId: string;
}

export type OutputAuthorityReason =
  | "authoritative"
  | "assignment-mismatch"
  | "attempt-mismatch"
  | "authority-stale"
  | "assignment-version-stale"
  | "lease-inactive"
  | "lease-stale"
  | "identity-mismatch"
  | "lease-expired"
  | "agent-snapshot-stale";

export interface OutputAuthorityDecision {
  authoritative: boolean;
  reason: OutputAuthorityReason;
}

export class WorkflowSchedulerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function createAgentSnapshot(input: Omit<AgentSnapshot, "version">): AgentSnapshot {
  validateRefreshDeadline(input.refreshedAt, input.refreshDeadline);
  return { ...input, capabilities: [...input.capabilities], version: 1 };
}

export function refreshAgentSnapshot(
  current: AgentSnapshot,
  expectedVersion: number,
  update: Pick<AgentSnapshot, "state" | "capabilities" | "refreshedAt" | "refreshDeadline">
): AgentSnapshot {
  if (expectedVersion !== current.version) fail("agent-version-conflict", "Expected Agent snapshot version does not match.");
  validateRefreshDeadline(update.refreshedAt, update.refreshDeadline);
  return { ...current, ...update, capabilities: [...update.capabilities], version: current.version + 1 };
}

export function createSchedulerAssignment(
  assignmentId: string,
  attemptId: string,
  authority: AuthorityTuple
): SchedulerAssignment {
  return {
    assignmentId, attemptId, state: "queued", version: 1, authority: { ...authority },
    fencingToken: 0, archived: false, receipts: []
  };
}

export function offerAssignment(
  assignment: SchedulerAssignment,
  commandEnvelope: SchedulerCommand,
  agent: AgentSnapshot,
  input: { offerId: string; now: number; expiresAt: number; maxOfferDuration: number; requiredCapabilities: readonly string[] }
): SchedulerResult {
  return command(assignment, commandEnvelope, "offer", current => {
    if (current.state !== "queued") fail("offer-state", "Only queued work may be offered.");
    assertDispatchableAgent(agent, input.now, input.requiredCapabilities);
    if (input.expiresAt <= input.now) fail("offer-expiry", "Offer expiry must be after server time.");
    if (input.expiresAt > input.now + input.maxOfferDuration) fail("offer-expiry", "Offer expiry exceeds the configured bound.");
    const offer: AssignmentOffer = {
      offerId: input.offerId, executorId: agent.executorId, agentId: agent.agentId,
      agentSnapshotVersion: agent.version, issuedAt: input.now, expiresAt: input.expiresAt
    };
    return { ...current, state: "offered", version: current.version + 1, offer };
  });
}

export function claimAssignment(
  assignment: SchedulerAssignment,
  commandEnvelope: SchedulerCommand,
  agent: AgentSnapshot,
  input: { offerId: string; leaseId: string; now: number; expiresAt: number }
): SchedulerResult {
  return command(assignment, commandEnvelope, "claim", current => {
    if (current.state !== "offered" || !current.offer) fail("offer-stale-or-claimed", "Offer is stale or already claimed.");
    const offer = current.offer;
    if (offer.offerId !== input.offerId || input.now > offer.expiresAt) fail("offer-stale-or-claimed", "Offer is stale or already claimed.");
    assertOfferedAgent(offer, agent);
    assertDispatchableAgent(agent, input.now, []);
    if (input.expiresAt <= input.now) fail("lease-expiry", "Lease expiry must be after server time.");
    const fencingToken = current.fencingToken + 1;
    const assignmentVersion = current.version + 1;
    const lease: AssignmentLease = {
      leaseId: input.leaseId, executorId: agent.executorId, agentId: agent.agentId,
      agentSnapshotVersion: agent.version, assignmentVersion, version: 1, fencingToken,
      issuedAt: input.now, heartbeatAt: input.now, expiresAt: input.expiresAt
    };
    return { ...current, state: "leased", version: assignmentVersion, fencingToken, offer: undefined, lease };
  });
}

export function declineAssignment(
  assignment: SchedulerAssignment,
  commandEnvelope: SchedulerCommand,
  agent: AgentSnapshot,
  input: { offerId: string; reason: string; now: number }
): SchedulerResult {
  return command(assignment, commandEnvelope, "decline", current => {
    if (current.state !== "offered" || !current.offer) fail("offer-stale-or-claimed", "Offer is stale or already claimed.");
    if (current.offer.offerId !== input.offerId || input.now > current.offer.expiresAt) fail("offer-stale-or-claimed", "Offer is stale or already claimed.");
    assertOfferedAgent(current.offer, agent);
    const reason = input.reason.trim();
    if (!reason) fail("decline-reason-required", "Executor decline requires a reason.");
    return {
      ...current, state: "queued", version: current.version + 1, offer: undefined,
      lastDecline: { executorId: agent.executorId, agentId: agent.agentId, reason, declinedAt: input.now }
    };
  });
}

export function expireOffer(
  assignment: SchedulerAssignment,
  commandEnvelope: SchedulerCommand,
  now: number
): SchedulerResult {
  return command(assignment, commandEnvelope, "offer-expire", current => {
    if (current.state !== "offered" || !current.offer) fail("offer-state", "An active offer is required.");
    if (now <= current.offer.expiresAt) fail("offer-not-expired", "Server time has not passed offer expiry.");
    return { ...current, state: "queued", version: current.version + 1, offer: undefined };
  });
}

export function heartbeatLease(
  assignment: SchedulerAssignment,
  commandEnvelope: SchedulerCommand,
  proof: LeaseProof,
  now: number
): SchedulerResult {
  return command(assignment, commandEnvelope, "heartbeat", current => {
    const lease = assertLease(current, proof, now);
    if (now < lease.heartbeatAt) fail("server-time-regressed", "Heartbeat time cannot move backwards.");
    return {
      ...current, version: current.version + 1,
      lease: { ...lease, assignmentVersion: current.version + 1, version: lease.version + 1, heartbeatAt: now }
    };
  });
}

export function renewLease(
  assignment: SchedulerAssignment,
  commandEnvelope: SchedulerCommand,
  agent: AgentSnapshot,
  proof: LeaseProof,
  input: { now: number; expiresAt: number }
): SchedulerResult {
  return command(assignment, commandEnvelope, "renew", current => {
    const lease = assertLease(current, proof, input.now);
    assertLeaseAgent(lease, agent);
    assertDispatchableAgent(agent, input.now, []);
    if (input.expiresAt <= lease.expiresAt) fail("lease-renewal-invalid", "Renewal must extend absolute lease expiry.");
    return {
      ...current, version: current.version + 1,
      lease: {
        ...lease, agentSnapshotVersion: agent.version, assignmentVersion: current.version + 1,
        version: lease.version + 1, heartbeatAt: input.now, expiresAt: input.expiresAt
      }
    };
  });
}

export function releaseLease(
  assignment: SchedulerAssignment,
  commandEnvelope: SchedulerCommand,
  proof: LeaseProof,
  now: number
): SchedulerResult {
  return command(assignment, commandEnvelope, "release", current => {
    assertLease(current, proof, now);
    return fence(current, "released");
  });
}

export function revokeAuthority(
  assignment: SchedulerAssignment,
  commandEnvelope: SchedulerCommand,
  reason: string
): SchedulerResult {
  return command(assignment, commandEnvelope, "revoke", current => {
    if (current.state !== "offered" && current.state !== "leased") fail("authority-inactive", "An offer or lease is required for revocation.");
    const normalized = reason.trim();
    if (!normalized) fail("revocation-reason-required", "Revocation requires a reason.");
    return { ...fence(current, "revoked"), invalidationReason: normalized };
  });
}

export function expireLease(
  assignment: SchedulerAssignment,
  commandEnvelope: SchedulerCommand,
  now: number
): SchedulerResult {
  return command(assignment, commandEnvelope, "lease-expire", current => {
    if (current.state !== "leased" || !current.lease) fail("lease-inactive", "An active lease is required.");
    if (now <= current.lease.expiresAt) fail("lease-not-expired", "Server time has not passed lease expiry.");
    return fence(current, "expired");
  });
}

export function invalidateForEpochChange(
  assignment: SchedulerAssignment,
  commandEnvelope: SchedulerCommand,
  next: AuthorityTuple,
  archived: boolean,
  reason: string
): SchedulerResult {
  return command(assignment, commandEnvelope, "epoch-invalidate", current => {
    assertEpochAdvance(current.authority, next, current.archived, archived);
    const normalized = reason.trim();
    if (!normalized) fail("invalidation-reason-required", "Epoch invalidation requires a reason.");
    return {
      ...fence(current, "revoked"), authority: { ...next }, archived,
      invalidationReason: normalized
    };
  });
}

export function determineOutputAuthority(
  assignment: SchedulerAssignment,
  submission: OutputSubmission,
  agent: AgentSnapshot,
  now: number
): OutputAuthorityDecision {
  if (submission.assignmentId !== assignment.assignmentId) return denied("assignment-mismatch");
  if (submission.attemptId !== assignment.attemptId) return denied("attempt-mismatch");
  if (!sameAuthority(submission, assignment.authority)) return denied("authority-stale");
  if (submission.assignmentVersion !== assignment.version) return denied("assignment-version-stale");
  if (assignment.state !== "leased" || !assignment.lease) return denied("lease-inactive");
  const lease = assignment.lease;
  if (submission.leaseId !== lease.leaseId || submission.leaseVersion !== lease.version || submission.fencingToken !== lease.fencingToken) return denied("lease-stale");
  if (submission.executorId !== lease.executorId || submission.agentId !== lease.agentId) return denied("identity-mismatch");
  if (now > lease.expiresAt) return denied("lease-expired");
  if (!sameAgentSnapshot(lease, agent) || !isAgentFresh(agent, now)) return denied("agent-snapshot-stale");
  return { authoritative: true, reason: "authoritative" };
}

export function isOutputSubmissionAuthoritative(
  assignment: SchedulerAssignment,
  submission: OutputSubmission,
  agent: AgentSnapshot,
  now: number
): boolean {
  return determineOutputAuthority(assignment, submission, agent, now).authoritative;
}

function command(
  assignment: SchedulerAssignment,
  envelope: SchedulerCommand,
  operation: string,
  mutate: (current: SchedulerAssignment) => SchedulerAssignment
): SchedulerResult {
  const prior = assignment.receipts.find(receipt => receipt.commandId === envelope.commandId);
  if (prior) {
    if (prior.fingerprint !== envelope.fingerprint) fail("command-conflict", "Command ID was reused with a different fingerprint.");
    return { assignment, receipt: prior, replayed: true };
  }
  assertExpected(assignment, envelope.expected);
  const changed = mutate(assignment);
  const receipt: SchedulerReceipt = {
    commandId: envelope.commandId, fingerprint: envelope.fingerprint, operation,
    assignmentVersion: changed.version, authority: { ...changed.authority }, fencingToken: changed.fencingToken
  };
  return { assignment: { ...changed, receipts: [...changed.receipts, receipt] }, receipt, replayed: false };
}

function assertExpected(assignment: SchedulerAssignment, expected: SchedulerCommand["expected"]): void {
  if (expected.assignmentVersion !== assignment.version) fail("assignment-version-conflict", "Expected Assignment version does not match.");
  if (!sameAuthority(expected, assignment.authority)) fail("authority-version-conflict", "Expected Run, readiness, and policy versions must all match.");
}

function assertDispatchableAgent(agent: AgentSnapshot, now: number, requiredCapabilities: readonly string[]): void {
  if (agent.state !== "available") fail("agent-unavailable", "Agent is not available for dispatch.");
  if (!isAgentFresh(agent, now)) fail("agent-snapshot-stale", "Agent state/capability snapshot requires refresh.");
  if (!requiredCapabilities.every(capability => agent.capabilities.includes(capability))) fail("agent-capability-missing", "Agent lacks a required current capability.");
}

function assertOfferedAgent(offer: AssignmentOffer, agent: AgentSnapshot): void {
  if (offer.executorId !== agent.executorId || offer.agentId !== agent.agentId || offer.agentSnapshotVersion !== agent.version) {
    fail("offer-agent-mismatch", "Offer does not bind this Agent snapshot.");
  }
}

function assertLeaseAgent(lease: AssignmentLease, agent: AgentSnapshot): void {
  if (lease.executorId !== agent.executorId || lease.agentId !== agent.agentId || agent.version < lease.agentSnapshotVersion) {
    fail("lease-agent-mismatch", "Lease does not bind this Agent identity or a current snapshot.");
  }
}

function assertLease(assignment: SchedulerAssignment, proof: LeaseProof, now: number): AssignmentLease {
  if (assignment.state !== "leased" || !assignment.lease) fail("lease-inactive", "An active lease is required.");
  const lease = assignment.lease;
  if (proof.leaseId !== lease.leaseId || proof.leaseVersion !== lease.version || proof.fencingToken !== lease.fencingToken) {
    fail("lease-fenced", "Lease ID, version, or fencing token is stale.");
  }
  if (now > lease.expiresAt) fail("lease-expired", "Server-authoritative time is past lease expiry.");
  return lease;
}

function fence(assignment: SchedulerAssignment, state: "released" | "revoked" | "expired"): SchedulerAssignment {
  return {
    ...assignment, state, version: assignment.version + 1, fencingToken: assignment.fencingToken + 1,
    offer: undefined, lease: undefined
  };
}

function assertEpochAdvance(current: AuthorityTuple, next: AuthorityTuple, wasArchived: boolean, archived: boolean): void {
  if (next.runVersion < current.runVersion || next.readyVersion < current.readyVersion || next.policyVersion < current.policyVersion) {
    fail("authority-version-regressed", "Authority epochs cannot move backwards.");
  }
  if (sameAuthority(current, next) && wasArchived === archived) fail("authority-version-unchanged", "At least one authority epoch or archive state must change.");
}

function sameAuthority(left: AuthorityTuple, right: AuthorityTuple): boolean {
  return left.runVersion === right.runVersion && left.readyVersion === right.readyVersion && left.policyVersion === right.policyVersion;
}

function sameAgentSnapshot(lease: AssignmentLease, agent: AgentSnapshot): boolean {
  return lease.executorId === agent.executorId && lease.agentId === agent.agentId && lease.agentSnapshotVersion === agent.version;
}

function isAgentFresh(agent: AgentSnapshot, now: number): boolean {
  return now <= agent.refreshDeadline;
}

function validateRefreshDeadline(refreshedAt: number, refreshDeadline: number): void {
  if (!Number.isFinite(refreshedAt) || !Number.isFinite(refreshDeadline)) fail("agent-time-invalid", "Agent snapshot times must be finite.");
  if (refreshDeadline <= refreshedAt) fail("agent-refresh-deadline", "Agent refresh deadline must follow refresh time.");
}

function denied(reason: Exclude<OutputAuthorityReason, "authoritative">): OutputAuthorityDecision {
  return { authoritative: false, reason };
}

function fail(code: string, message: string): never {
  throw new WorkflowSchedulerError(code, message);
}