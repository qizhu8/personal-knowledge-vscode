import { createHash } from "crypto";
import { canonicalJson } from "../workflow-contracts";

export type AdapterTransport = "inline" | "local-isolated" | "remote";
export type ProtocolPhase = "created" | "dispatched" | "acknowledged" | "started" | "collecting-evidence" | "checkpointed" | "completed" | "cancelled" | "reconciling";
export type WorkflowFailureClass = "definition-invalid" | "input-invalid" | "resource-exhausted" | "deadline-exceeded" | "adapter-unavailable" | "execution-failed" | "cancelled";

export interface AdapterProfile {
  profileId: string;
  transport: AdapterTransport;
  capabilities: readonly string[];
  capabilityProfileDigest: string;
  attestationDigest: string;
  conformanceFixtureDigest: string;
  revoked: boolean;
}

export interface AdapterRegistry {
  profiles: readonly AdapterProfile[];
}

export interface InvocationEnvelope {
  schema: "pkm.workflow.executor-invocation/v1";
  run: Readonly<{ id: string; version: number }>;
  node: Readonly<{ id: string; version: number }>;
  attempt: Readonly<{ id: string; version: number }>;
  assignment: Readonly<{ id: string; version: number }>;
  lease: Readonly<{ id: string; version: number; fence: number }>;
  definition: Readonly<{
    versionId: string;
    executableDigest: string;
    dependencyLockDigest: string;
    nodeKind: string;
    nodeKindValidatorDigest: string;
  }>;
  requiredInputDigest: string;
  context: Readonly<{ projectId: string; environmentId: string; configurationSnapshotId: string }>;
  environment: Readonly<{
    locale: string;
    workingDirectory: string;
    resourceCeiling: Readonly<{ cpuMillis: number; memoryBytes: number; outputBytes: number }>;
  }>;
  secretHandles: readonly Readonly<{ name: string; handle: string; versionId: string }>[];
  deadlines: Readonly<{ executionAt: number; evidenceAt: number }>;
  evidencePolicy: Readonly<{ policyId: string; policyDigest: string }>;
  effectIdempotencyKey: string;
}

export interface DigestReceipt {
  receiptId: string;
  digest: string;
  mediaType: string;
  byteLength: number;
  truncated: boolean;
  originalByteLength?: number;
}

export interface AdapterOutcome {
  status: "succeeded" | "failed" | "cancelled" | "unknown-effect";
  code?: string;
  result?: DigestReceipt;
  artifacts?: readonly DigestReceipt[];
}

export interface CoreVisibleResult {
  state: "succeeded" | "failed" | "cancelled" | "reconciling";
  failureClass?: WorkflowFailureClass;
  result?: DigestReceipt;
  artifacts: readonly DigestReceipt[];
}

export interface ExecutorAdapter {
  profile: AdapterProfile;
  execute: (envelope: InvocationEnvelope) => AdapterOutcome;
}

export interface ExecutorCommand {
  commandId: string;
  fingerprint: string;
  expectedVersion: number;
  expectedFence: number;
}

export interface ExecutorCommandReceipt {
  commandId: string;
  fingerprint: string;
  operation: string;
  protocolVersion: number;
  leaseFence: number;
}

export interface ExecutorProtocol {
  invocationDigest: string;
  profileId: string;
  phase: ProtocolPhase;
  version: number;
  leaseFence: number;
  evidence: readonly DigestReceipt[];
  checkpoint?: DigestReceipt;
  outcome?: CoreVisibleResult;
  commandReceipts: readonly ExecutorCommandReceipt[];
}

export interface ExecutorCommandResult {
  protocol: ExecutorProtocol;
  receipt: ExecutorCommandReceipt;
  replayed: boolean;
}

export interface TransportConformanceProof {
  fixtureDigest: string;
  coreResultDigest: string;
  results: Readonly<Record<AdapterTransport, CoreVisibleResult>>;
}

export class WorkflowExecutorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowExecutorError";
  }
}

const DIGEST = /^[a-f0-9]{64}$/;
const TRANSPORTS: readonly AdapterTransport[] = ["inline", "local-isolated", "remote"];
const FAILURE_CODES: Readonly<Record<string, WorkflowFailureClass>> = {
  "definition-invalid": "definition-invalid",
  "input-invalid": "input-invalid",
  "resource-exhausted": "resource-exhausted",
  "deadline-exceeded": "deadline-exceeded",
  "adapter-unavailable": "adapter-unavailable"
};

export function digestExecutorValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function createAdapterRegistry(profiles: readonly AdapterProfile[]): AdapterRegistry {
  const normalized = profiles.map(profile => normalizeProfile(profile));
  if (new Set(normalized.map(profile => profile.transport)).size !== normalized.length) {
    fail("adapter-profile-duplicate", "Only one Adapter profile may be registered per transport.");
  }
  return Object.freeze({ profiles: Object.freeze(normalized) });
}

export function resolveAdapterProfile(
  registry: AdapterRegistry,
  transport: AdapterTransport,
  requiredCapabilities: readonly string[],
  conformanceFixtureDigest: string
): AdapterProfile {
  const profile = registry.profiles.find(candidate => candidate.transport === transport);
  if (!profile) fail("adapter-profile-unsupported", `Adapter profile ${transport} is unsupported.`);
  if (!profile.attestationDigest || !DIGEST.test(profile.attestationDigest) || !DIGEST.test(profile.capabilityProfileDigest)) {
    fail("adapter-profile-unattested", `Adapter profile ${transport} is not attested.`);
  }
  if (profile.revoked) fail("adapter-profile-revoked", `Adapter profile ${transport} is revoked.`);
  if (profile.conformanceFixtureDigest !== conformanceFixtureDigest) fail("adapter-conformance-mismatch", "Adapter conformance fixture digest does not match.");
  if (!requiredCapabilities.every(capability => profile.capabilities.includes(capability))) {
    fail("adapter-capability-missing", "Adapter profile lacks a required attested capability.");
  }
  return profile;
}

export function createInvocationEnvelope(input: InvocationEnvelope): InvocationEnvelope {
  validateInvocation(input);
  const envelope: InvocationEnvelope = {
    schema: "pkm.workflow.executor-invocation/v1",
    run: { ...input.run }, node: { ...input.node }, attempt: { ...input.attempt }, assignment: { ...input.assignment },
    lease: { ...input.lease }, definition: { ...input.definition }, requiredInputDigest: input.requiredInputDigest,
    context: { ...input.context },
    environment: { ...input.environment, resourceCeiling: { ...input.environment.resourceCeiling } },
    secretHandles: input.secretHandles.map(secret => ({ name: secret.name, handle: secret.handle, versionId: secret.versionId })),
    deadlines: { ...input.deadlines }, evidencePolicy: { ...input.evidencePolicy }, effectIdempotencyKey: input.effectIdempotencyKey
  };
  return deepFreeze(envelope);
}

export function createExecutorProtocol(envelope: InvocationEnvelope, profile: AdapterProfile): ExecutorProtocol {
  if (profile.revoked) fail("adapter-profile-revoked", "A revoked Adapter profile cannot receive an invocation.");
  return deepFreeze({
    invocationDigest: digestExecutorValue(envelope), profileId: profile.profileId, phase: "created",
    version: 1, leaseFence: envelope.lease.fence, evidence: [], commandReceipts: []
  });
}

export function dispatchExecution(protocol: ExecutorProtocol, command: ExecutorCommand): ExecutorCommandResult {
  return applyCommand(protocol, command, "dispatch", ["created"], current => ({ ...current, phase: "dispatched" }));
}

export function acknowledgeExecution(protocol: ExecutorProtocol, command: ExecutorCommand): ExecutorCommandResult {
  return applyCommand(protocol, command, "acknowledge", ["dispatched"], current => ({ ...current, phase: "acknowledged" }));
}

export function startExecution(protocol: ExecutorProtocol, command: ExecutorCommand): ExecutorCommandResult {
  return applyCommand(protocol, command, "start", ["acknowledged"], current => ({ ...current, phase: "started" }));
}

export function recordExecutionEvidence(protocol: ExecutorProtocol, command: ExecutorCommand, receipt: DigestReceipt): ExecutorCommandResult {
  return applyCommand(protocol, command, "evidence", ["started", "collecting-evidence"], current => ({
    ...current, phase: "collecting-evidence", evidence: [...current.evidence, normalizeReceipt(receipt)]
  }));
}

export function checkpointExecution(protocol: ExecutorProtocol, command: ExecutorCommand, receipt: DigestReceipt): ExecutorCommandResult {
  return applyCommand(protocol, command, "checkpoint", ["started", "collecting-evidence"], current => ({
    ...current, phase: "checkpointed", checkpoint: normalizeReceipt(receipt)
  }));
}

export function completeExecution(protocol: ExecutorProtocol, command: ExecutorCommand, outcome: AdapterOutcome): ExecutorCommandResult {
  return applyCommand(protocol, command, "complete", ["started", "collecting-evidence", "checkpointed"], current => {
    const visible = coreVisibleResult(outcome);
    return { ...current, phase: visible.state === "reconciling" ? "reconciling" : "completed", outcome: visible };
  });
}

export function cancelExecution(protocol: ExecutorProtocol, command: ExecutorCommand): ExecutorCommandResult {
  return applyCommand(protocol, command, "cancel", ["dispatched", "acknowledged", "started", "collecting-evidence", "checkpointed"], current => ({
    ...current, phase: "cancelled", outcome: { state: "cancelled", failureClass: "cancelled", artifacts: [] }
  }));
}

export function coreVisibleResult(outcome: AdapterOutcome): CoreVisibleResult {
  const artifacts = (outcome.artifacts || []).map(normalizeReceipt);
  const result = outcome.result && normalizeReceipt(outcome.result);
  const visibleResult = result ? { result } : {};
  if (outcome.status === "unknown-effect") return deepFreeze({ state: "reconciling", ...visibleResult, artifacts });
  if (outcome.status === "succeeded") return deepFreeze({ state: "succeeded", ...visibleResult, artifacts });
  if (outcome.status === "cancelled") return deepFreeze({ state: "cancelled", failureClass: "cancelled", ...visibleResult, artifacts });
  return deepFreeze({ state: "failed", failureClass: FAILURE_CODES[outcome.code || ""] || "execution-failed", ...visibleResult, artifacts });
}

export function proveTransportConformance(
  envelope: InvocationEnvelope,
  adapters: readonly ExecutorAdapter[],
  fixtureDigest: string
): TransportConformanceProof {
  if (!DIGEST.test(fixtureDigest)) fail("conformance-fixture-invalid", "Conformance fixture requires a SHA-256 digest.");
  const results = {} as Record<AdapterTransport, CoreVisibleResult>;
  for (const transport of TRANSPORTS) {
    const adapter = adapters.find(candidate => candidate.profile.transport === transport);
    if (!adapter) fail("adapter-profile-unsupported", `Conformance requires ${transport}.`);
    if (adapter.profile.conformanceFixtureDigest !== fixtureDigest) fail("adapter-conformance-mismatch", "Adapter does not attest the requested fixture.");
    results[transport] = coreVisibleResult(adapter.execute(envelope));
  }
  const digests = TRANSPORTS.map(transport => digestExecutorValue(results[transport]));
  if (!digests.every(digest => digest === digests[0])) fail("transport-conformance-failed", "Adapters produced different CORE-visible results.");
  return deepFreeze({ fixtureDigest, coreResultDigest: digests[0], results });
}

function applyCommand(
  protocol: ExecutorProtocol,
  command: ExecutorCommand,
  operation: string,
  allowed: readonly ProtocolPhase[],
  mutate: (current: ExecutorProtocol) => ExecutorProtocol
): ExecutorCommandResult {
  const prior = protocol.commandReceipts.find(receipt => receipt.commandId === command.commandId);
  if (prior) {
    if (prior.fingerprint !== command.fingerprint) fail("command-conflict", "Command ID was reused with a different fingerprint.");
    return { protocol, receipt: prior, replayed: true };
  }
  if (command.expectedVersion !== protocol.version) fail("protocol-version-conflict", "Expected Executor protocol version does not match.");
  if (command.expectedFence !== protocol.leaseFence) fail("lease-fenced", "Executor command carries a stale lease fence.");
  if (!allowed.includes(protocol.phase)) fail("protocol-state", `${operation} is not valid from ${protocol.phase}.`);
  const changed = mutate(protocol);
  const nextVersion = protocol.version + 1;
  const receipt: ExecutorCommandReceipt = deepFreeze({
    commandId: command.commandId, fingerprint: command.fingerprint, operation,
    protocolVersion: nextVersion, leaseFence: protocol.leaseFence
  });
  return {
    protocol: deepFreeze({ ...changed, version: nextVersion, commandReceipts: [...changed.commandReceipts, receipt] }),
    receipt, replayed: false
  };
}

function normalizeProfile(profile: AdapterProfile): AdapterProfile {
  if (!profile.profileId.trim()) fail("adapter-profile-invalid", "Adapter profile identity is required.");
  if (!DIGEST.test(profile.conformanceFixtureDigest)) fail("adapter-conformance-invalid", "Adapter conformance fixture requires a SHA-256 digest.");
  const capabilities = [...new Set(profile.capabilities.map(capability => capability.trim()))].sort();
  if (capabilities.some(capability => !capability)) fail("adapter-capability-invalid", "Adapter capabilities must be non-empty.");
  return deepFreeze({ ...profile, capabilities });
}

function validateInvocation(input: InvocationEnvelope): void {
  if (input.schema !== "pkm.workflow.executor-invocation/v1") fail("invocation-schema-invalid", "Executor invocation schema is unsupported.");
  for (const binding of [input.run, input.node, input.attempt, input.assignment]) validateBinding(binding);
  validateBinding({ id: input.lease.id, version: input.lease.version });
  if (!Number.isInteger(input.lease.fence) || input.lease.fence < 1) fail("lease-fence-invalid", "Lease fence must be a positive integer.");
  for (const digest of [input.definition.executableDigest, input.definition.dependencyLockDigest, input.definition.nodeKindValidatorDigest, input.requiredInputDigest, input.evidencePolicy.policyDigest]) {
    if (!DIGEST.test(digest)) fail("invocation-digest-invalid", "Invocation digests must be SHA-256 values.");
  }
  for (const text of [input.definition.versionId, input.definition.nodeKind, input.context.projectId, input.context.environmentId,
    input.context.configurationSnapshotId, input.environment.locale, input.environment.workingDirectory,
    input.evidencePolicy.policyId, input.effectIdempotencyKey]) {
    if (!text.trim()) fail("invocation-field-required", "Invocation identity and environment fields are required.");
  }
  for (const value of Object.values(input.environment.resourceCeiling)) {
    if (!Number.isInteger(value) || value < 1) fail("resource-ceiling-invalid", "Resource ceilings must be positive integers.");
  }
  if (!Number.isFinite(input.deadlines.executionAt) || !Number.isFinite(input.deadlines.evidenceAt)
    || input.deadlines.executionAt <= 0 || input.deadlines.evidenceAt < input.deadlines.executionAt) {
    fail("deadline-invalid", "Absolute execution and evidence deadlines are invalid.");
  }
  for (const secret of input.secretHandles) {
    if (Object.keys(secret).sort().join(",") !== "handle,name,versionId") fail("secret-material-forbidden", "Invocation may contain secret handles only.");
    if (!secret.name.trim() || !secret.handle.trim() || !secret.versionId.trim()) fail("secret-handle-invalid", "Secret handle metadata is incomplete.");
  }
}

function validateBinding(binding: { id: string; version: number }): void {
  if (!binding.id.trim() || !Number.isInteger(binding.version) || binding.version < 1) fail("invocation-binding-invalid", "Invocation bindings require identity and positive version.");
}

function normalizeReceipt(receipt: DigestReceipt): DigestReceipt {
  if (!receipt.receiptId.trim() || !receipt.mediaType.trim() || !DIGEST.test(receipt.digest)) fail("receipt-invalid", "Receipt identity, media type, and digest are required.");
  if (!Number.isInteger(receipt.byteLength) || receipt.byteLength < 0) fail("receipt-length-invalid", "Receipt byte length must be a non-negative integer.");
  const originalByteLength = receipt.originalByteLength;
  if (receipt.truncated && (!Number.isInteger(originalByteLength) || originalByteLength === undefined || originalByteLength < receipt.byteLength)) {
    fail("receipt-truncation-invalid", "Truncated receipts require the original byte length.");
  }
  if (!receipt.truncated && receipt.originalByteLength !== undefined) fail("receipt-truncation-invalid", "Untruncated receipts cannot declare an original byte length.");
  return deepFreeze({
    receiptId: receipt.receiptId,
    digest: receipt.digest,
    mediaType: receipt.mediaType,
    byteLength: receipt.byteLength,
    truncated: receipt.truncated,
    ...(originalByteLength === undefined ? {} : { originalByteLength })
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function fail(code: string, message: string): never {
  throw new WorkflowExecutorError(code, message);
}
