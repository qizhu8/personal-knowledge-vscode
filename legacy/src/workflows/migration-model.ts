export const MIGRATION_ENVELOPE_MAGIC = "PKM-RUNTIME" as const;
export const MIGRATION_ENVELOPE_VERSION = 1 as const;

export const MIGRATION_PHASES = [
  "planned", "preflighting", "quiescing", "backed-up", "transforming", "validating",
  "commit-ready", "committed", "rebuilding", "completed", "rollback-required", "rolled-back", "repair-required"
] as const;

export type MigrationPhase = typeof MIGRATION_PHASES[number];
export type CompatibilityDecision = "read-write" | "read-only" | "upgrade-required" | "downgrade-transformable" | "refuse";
export type SecretReferenceState = "bound" | "unresolved" | "unavailable-provider" | "requires-reauthorization";
export type CheckStatus = "pass" | "block";

export interface SchemaRegistration {
  readonly subsystem: string;
  readonly schemaId: string;
  readonly version: number;
  readonly digest: string;
  readonly minimumReader: number;
  readonly maximumReader: number;
  readonly minimumWriter: number;
  readonly maximumWriter: number;
}

export interface ManifestEnvelope {
  readonly magic: typeof MIGRATION_ENVELOPE_MAGIC;
  readonly envelopeVersion: typeof MIGRATION_ENVELOPE_VERSION;
  readonly storageEpoch: number;
  readonly minimumReader: number;
  readonly maximumReader: number;
  readonly minimumWriter: number;
  readonly maximumWriter: number;
  readonly generationPointer: string;
  readonly migrationStatePointer?: string;
  readonly subsystemDigests: Readonly<Record<string, string>>;
  readonly integrityDigest: string;
}

export interface BinaryCompatibility {
  readonly envelopeVersions: readonly number[];
  readonly readerVersion: number;
  readonly writerVersion: number;
  readonly subsystemDigests: Readonly<Record<string, readonly string[]>>;
  readonly reversePathIds: readonly string[];
}

export interface CompatibilityResult {
  readonly decision: CompatibilityDecision;
  readonly reasons: readonly string[];
}

export interface PreflightCheck {
  readonly status: CheckStatus;
  readonly detail?: string;
}

export interface SecretReferenceCheck extends PreflightCheck {
  readonly referenceId: string;
  readonly state: SecretReferenceState;
  readonly keyId?: string;
}

export interface MigrationPreflight {
  readonly ownerIntent: PreflightCheck;
  readonly disk: PreflightCheck;
  readonly backupDestination: PreflightCheck;
  readonly keys: PreflightCheck;
  readonly secretReferences: readonly SecretReferenceCheck[];
  readonly integrity: PreflightCheck;
  readonly transitionPath: PreflightCheck;
  readonly runtimeCompatibility: PreflightCheck;
  readonly activeOperation: PreflightCheck;
  readonly activeEffects: PreflightCheck;
  readonly checkpoints: PreflightCheck;
  readonly activeWriters: PreflightCheck;
  readonly keyRotation: PreflightCheck;
}

export interface WriterRegistration {
  readonly writerId: string;
  readonly processFence: string;
  readonly channelFence: string;
  readonly leaseExpiresAt: number;
  readonly acknowledgedEpoch?: number;
  readonly evicted: boolean;
}

export interface MigrationLease {
  readonly operationId: string;
  readonly commandId: string;
  readonly sourceManifestDigest: string;
  readonly targetManifestDigest: string;
  readonly storageEpoch: number;
  readonly ownerProcessId: string;
  readonly fencingToken: number;
  readonly expiresAt: number;
  readonly heartbeatAt: number;
}

export interface RestorePoint {
  readonly restorePointId: string;
  readonly contentDigest: string;
  readonly sourceManifestDigest: string;
  readonly payloadClosureVerified: boolean;
  readonly referentialClosureVerified: boolean;
  readonly purgeLedgerDigest: string;
  readonly purgeLedgerVerified: boolean;
  readonly keyIds: readonly string[];
  readonly resolvableKeyIds: readonly string[];
  readonly smokeProbePassed: boolean;
}

export interface TransformChunk {
  readonly chunkId: string;
  readonly sourceChecksum: string;
  readonly targetChecksum: string;
  readonly sourceCount: number;
  readonly targetCount: number;
}

export interface ValidationReport {
  readonly targetSchema: CheckStatus;
  readonly crossStoreReferences: CheckStatus;
  readonly identities: CheckStatus;
  readonly immutableHistory: CheckStatus;
  readonly payloadClosure: CheckStatus;
  readonly purgeLedgerClosure: CheckStatus;
  readonly acls: CheckStatus;
  readonly invariantProbes: CheckStatus;
  readonly shadowStoresFlushed: CheckStatus;
}

export interface RebuildItem {
  readonly itemId: string;
  readonly checksum: string;
}

export interface PhaseReceipt {
  readonly sequence: number;
  readonly phase: MigrationPhase;
  readonly previousPhase?: MigrationPhase;
  readonly cursor: string;
  readonly storageEpoch: number;
  readonly fencingToken: number;
  readonly digest: string;
}

export interface MigrationCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  readonly expectedVersion: number;
}

export interface MigrationCommandReceipt {
  readonly commandId: string;
  readonly fingerprint: string;
  readonly version: number;
  readonly phase: MigrationPhase;
}

export interface MigrationOperation {
  readonly operationId: string;
  readonly direction: "upgrade" | "downgrade";
  readonly reversePathId?: string;
  readonly sourceManifestDigest: string;
  readonly targetManifestDigest: string;
  readonly preservedKeyIds: readonly string[];
  readonly storageEpoch: number;
  readonly generation: number;
  readonly version: number;
  readonly phase: MigrationPhase;
  readonly resumeCursor: string;
  readonly lease?: MigrationLease;
  readonly preflight?: MigrationPreflight;
  readonly writers: readonly WriterRegistration[];
  readonly restorePoint?: RestorePoint;
  readonly chunks: readonly TransformChunk[];
  readonly validation?: ValidationReport;
  readonly rebuildItems: readonly RebuildItem[];
  readonly receipts: readonly PhaseReceipt[];
  readonly commands: readonly MigrationCommandReceipt[];
  readonly commitBarrier?: Readonly<{ generation: number; storageEpoch: number; manifestDigest: string }>;
}

export interface MigrationResult {
  readonly operation: MigrationOperation;
  readonly receipt: MigrationCommandReceipt;
  readonly replayed: boolean;
}

export interface ManualResumePlan {
  readonly priorOperationId: string;
  readonly newOperationId: string;
  readonly sourceReceiptDigests: readonly string[];
  readonly sourceManifestDigest: string;
  readonly targetManifestDigest: string;
  readonly preservedKeyIds: readonly string[];
  readonly invalidatedAuthority: true;
}

export interface MigrationAdapters {
  readonly digest: (value: unknown) => string;
}

export class MigrationModelError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MigrationModelError";
  }
}

const FORWARD: Readonly<Record<MigrationPhase, readonly MigrationPhase[]>> = {
  planned: ["preflighting"], preflighting: ["quiescing"], quiescing: ["backed-up"],
  "backed-up": ["transforming"], transforming: ["validating"], validating: ["commit-ready"],
  "commit-ready": ["committed"], committed: ["rebuilding"], rebuilding: ["completed"],
  completed: [], "rollback-required": ["rolled-back"], "rolled-back": [], "repair-required": []
};

const PREFLIGHT_FIELDS: readonly (keyof Omit<MigrationPreflight, "secretReferences">)[] = [
  "ownerIntent", "disk", "backupDestination", "keys", "integrity", "transitionPath", "runtimeCompatibility",
  "activeOperation", "activeEffects", "checkpoints", "activeWriters", "keyRotation"
];

const VALIDATION_FIELDS: readonly (keyof ValidationReport)[] = [
  "targetSchema", "crossStoreReferences", "identities", "immutableHistory", "payloadClosure",
  "purgeLedgerClosure", "acls", "invariantProbes", "shadowStoresFlushed"
];

export function createManifestEnvelope(input: Omit<ManifestEnvelope, "magic" | "envelopeVersion" | "integrityDigest">, adapters: MigrationAdapters): ManifestEnvelope {
  const body = { magic: MIGRATION_ENVELOPE_MAGIC, envelopeVersion: MIGRATION_ENVELOPE_VERSION, ...input };
  requirePositiveInteger(input.storageEpoch, "manifest-invalid");
  requireText(input.generationPointer, "manifest-invalid");
  return Object.freeze({ ...body, integrityDigest: adapters.digest(body) });
}

export function verifyManifestEnvelope(envelope: ManifestEnvelope, adapters: MigrationAdapters): void {
  const { integrityDigest, ...body } = envelope;
  if (!integrityDigest || adapters.digest(body) !== integrityDigest) fail("manifest-digest-invalid", "Outer manifest envelope digest does not match.");
}

export function inspectManifest(envelope: ManifestEnvelope, binary: BinaryCompatibility, reversePathId?: string): CompatibilityResult {
  if (envelope.magic !== MIGRATION_ENVELOPE_MAGIC || !binary.envelopeVersions.includes(envelope.envelopeVersion)) {
    return decision("refuse", "outer-envelope-unsupported");
  }
  const digestMismatch = Object.entries(envelope.subsystemDigests).some(([subsystem, digest]) => !binary.subsystemDigests[subsystem]?.includes(digest));
  const canRead = inRange(binary.readerVersion, envelope.minimumReader, envelope.maximumReader);
  const canWrite = inRange(binary.writerVersion, envelope.minimumWriter, envelope.maximumWriter) && !digestMismatch;
  if (canRead && canWrite) return decision("read-write");
  if (canRead) return decision("read-only", digestMismatch ? "subsystem-digest-unsupported" : "writer-range-unsupported");
  if (binary.readerVersion < envelope.minimumReader) return decision("upgrade-required", "reader-too-old");
  if (reversePathId && binary.reversePathIds.includes(reversePathId)) return decision("downgrade-transformable", "explicit-lossless-reverse-path");
  return decision("refuse", "reader-range-unsupported");
}

export function createMigrationOperation(input: {
  operationId: string;
  direction: "upgrade" | "downgrade";
  reversePathId?: string;
  registeredLosslessReversePathIds?: readonly string[];
  sourceManifestDigest: string;
  targetManifestDigest: string;
  keyIds: readonly string[];
  storageEpoch: number;
  generation: number;
}, adapters: MigrationAdapters): MigrationOperation {
  requireText(input.operationId, "operation-invalid");
  requireText(input.sourceManifestDigest, "operation-invalid");
  requireText(input.targetManifestDigest, "operation-invalid");
  if (input.direction === "downgrade" && (!input.reversePathId || !input.registeredLosslessReversePathIds?.includes(input.reversePathId))) {
    fail("downgrade-path-required", "Downgrade requires an explicit registered lossless reverse path.");
  }
  requirePositiveInteger(input.storageEpoch, "operation-invalid");
  requirePositiveInteger(input.generation, "operation-invalid");
  assertNoSecretValues(input);
  const base: MigrationOperation = {
    operationId: input.operationId, direction: input.direction, reversePathId: input.reversePathId,
    sourceManifestDigest: input.sourceManifestDigest, targetManifestDigest: input.targetManifestDigest,
    preservedKeyIds: Object.freeze([...input.keyIds]), storageEpoch: input.storageEpoch, generation: input.generation,
    version: 1, phase: "planned", resumeCursor: "phase:planned", writers: Object.freeze([]), chunks: Object.freeze([]),
    rebuildItems: Object.freeze([]), receipts: Object.freeze([]), commands: Object.freeze([])
  };
  return appendPhaseReceipt(base, "planned", "phase:preflighting", 0, adapters);
}

export function acquireMigrationLease(operation: MigrationOperation, command: MigrationCommand, input: {
  ownerProcessId: string;
  fencingToken: number;
  now: number;
  expiresAt: number;
}, adapters: MigrationAdapters): MigrationResult {
  return execute(operation, command, adapters, current => {
    if (current.lease && current.lease.expiresAt > input.now) fail("lease-active", "A live migration owner already exists.");
    if (input.expiresAt <= input.now || !Number.isSafeInteger(input.fencingToken) || input.fencingToken <= (current.lease?.fencingToken || 0)) {
      fail("lease-invalid", "Lease expiry and fencing token must advance authority.");
    }
    requireText(input.ownerProcessId, "lease-invalid");
    const storageEpoch = current.storageEpoch + 1;
    const lease: MigrationLease = {
      operationId: current.operationId, commandId: command.commandId,
      sourceManifestDigest: current.sourceManifestDigest, targetManifestDigest: current.targetManifestDigest,
      storageEpoch, ownerProcessId: input.ownerProcessId, fencingToken: input.fencingToken,
      expiresAt: input.expiresAt, heartbeatAt: input.now
    };
    return { ...current, storageEpoch, lease };
  });
}

export function heartbeatMigrationLease(operation: MigrationOperation, command: MigrationCommand, fencingToken: number, now: number, expiresAt: number, adapters: MigrationAdapters): MigrationResult {
  return execute(operation, command, adapters, current => {
    assertLease(current, fencingToken, now);
    if (expiresAt <= now) fail("lease-invalid", "Heartbeat must extend a live lease.");
    return { ...current, lease: { ...current.lease!, heartbeatAt: now, expiresAt } };
  });
}

export function registerWriter(operation: MigrationOperation, writer: WriterRegistration): MigrationOperation {
  if (operation.writers.some(candidate => candidate.writerId === writer.writerId)) fail("writer-conflict", "Writer identity is already registered.");
  return { ...operation, writers: Object.freeze([...operation.writers, Object.freeze({ ...writer })]) };
}

export function acknowledgeWriter(operation: MigrationOperation, writerId: string, epoch: number): MigrationOperation {
  if (epoch !== operation.storageEpoch) fail("storage-epoch-fenced", "Writer acknowledgement has a stale storage epoch.");
  const writer = operation.writers.find(candidate => candidate.writerId === writerId);
  if (!writer || writer.evicted) fail("writer-unavailable", "Writer is absent or evicted.");
  return replaceWriter(operation, { ...writer, acknowledgedEpoch: epoch });
}

export function evictExpiredWriter(operation: MigrationOperation, writerId: string, now: number, processFenced: boolean, channelFenced: boolean): MigrationOperation {
  const writer = operation.writers.find(candidate => candidate.writerId === writerId);
  if (!writer) fail("writer-unavailable", "Writer is absent.");
  if (writer.leaseExpiresAt > now || !processFenced || !channelFenced) fail("writer-live", "Writer eviction requires expiry and proven process/channel fencing.");
  return replaceWriter(operation, { ...writer, evicted: true });
}

export function evaluateWriterQuiescence(operation: MigrationOperation, now: number): readonly string[] {
  return Object.freeze(operation.writers
    .filter(writer => !writer.evicted && writer.acknowledgedEpoch !== operation.storageEpoch && writer.leaseExpiresAt > now)
    .map(writer => writer.writerId));
}

export function recordPreflight(operation: MigrationOperation, command: MigrationCommand, report: MigrationPreflight, now: number, adapters: MigrationAdapters): MigrationResult {
  return execute(operation, command, adapters, current => {
    assertNoSecretValues(report);
    const blocked = PREFLIGHT_FIELDS.filter(field => report[field].status === "block");
    const badReferences = report.secretReferences.filter(reference => reference.status === "block" || reference.state !== "bound");
    const liveWriters = evaluateWriterQuiescence(current, now);
    if (blocked.length || badReferences.length || liveWriters.length) fail("preflight-blocked", "Preflight has blocking checks, secret references, or live unacknowledged writers.");
    return { ...current, preflight: freeze(report) };
  });
}

export function recordRestorePoint(operation: MigrationOperation, command: MigrationCommand, point: RestorePoint, adapters: MigrationAdapters): MigrationResult {
  return execute(operation, command, adapters, current => {
    assertNoSecretValues(point);
    const keysResolvable = point.keyIds.every(keyId => point.resolvableKeyIds.includes(keyId));
    if (!point.contentDigest || point.sourceManifestDigest !== current.sourceManifestDigest || !point.payloadClosureVerified
      || !point.referentialClosureVerified || !point.purgeLedgerDigest || !point.purgeLedgerVerified || !keysResolvable || !point.smokeProbePassed) {
      fail("restore-point-invalid", "Restore point closure, digest, purge ledger, keys, and smoke probe must verify.");
    }
    if (!sameSet(point.keyIds, current.preservedKeyIds)) fail("key-change-forbidden", "Schema migration must preserve historical key IDs.");
    return { ...current, restorePoint: freeze(point) };
  });
}

export function recordTransformChunk(operation: MigrationOperation, command: MigrationCommand, chunk: TransformChunk, adapters: MigrationAdapters): MigrationResult {
  return execute(operation, command, adapters, current => {
    requireText(chunk.chunkId, "chunk-invalid");
    requireText(chunk.sourceChecksum, "chunk-invalid");
    requireText(chunk.targetChecksum, "chunk-invalid");
    if (!Number.isSafeInteger(chunk.sourceCount) || chunk.sourceCount < 0 || !Number.isSafeInteger(chunk.targetCount) || chunk.targetCount < 0) fail("chunk-invalid", "Chunk counts must be non-negative safe integers.");
    const prior = current.chunks.find(candidate => candidate.chunkId === chunk.chunkId);
    if (prior) {
      if (adapters.digest(prior) !== adapters.digest(chunk)) fail("chunk-conflict", "Chunk replay differs from its deterministic result.");
      return current;
    }
    return { ...current, chunks: Object.freeze([...current.chunks, Object.freeze({ ...chunk })]), resumeCursor: `chunk:${chunk.chunkId}` };
  });
}

export function recordValidation(operation: MigrationOperation, command: MigrationCommand, report: ValidationReport, adapters: MigrationAdapters): MigrationResult {
  return execute(operation, command, adapters, current => {
    if (VALIDATION_FIELDS.some(field => report[field] !== "pass")) fail("validation-failed", "Every target validation and flush check must pass.");
    return { ...current, validation: freeze(report) };
  });
}

export function transitionMigration(operation: MigrationOperation, command: MigrationCommand, target: MigrationPhase, cursor: string, now: number, fencingToken: number, adapters: MigrationAdapters): MigrationResult {
  return execute(operation, command, adapters, current => {
    assertLease(current, fencingToken, now);
    requireText(cursor, "cursor-required");
    const exceptional = target === "repair-required" || target === "rollback-required";
    if (!exceptional && !FORWARD[current.phase].includes(target)) fail("phase-transition-invalid", `Transition ${current.phase} -> ${target} is not allowed.`);
    if (target === "quiescing" && !current.preflight) fail("preflight-required", "Successful preflight is required before quiescence.");
    if (target === "backed-up" && !current.restorePoint) fail("restore-point-required", "A verified restore point is required.");
    if (target === "commit-ready" && !current.validation) fail("validation-required", "Validation is required before commit readiness.");
    if (target === "rolled-back" && !current.restorePoint) fail("restore-point-required", "Rollback requires a verified restore point.");
    if (target === "rollback-required" && barrierCrossed(current)) fail("rollback-forbidden", "Automatic rollback is forbidden after the commit barrier.");
    return appendPhaseReceipt(current, target, cursor, fencingToken, adapters);
  });
}

export function commitMigration(operation: MigrationOperation, command: MigrationCommand, now: number, fencingToken: number, adapters: MigrationAdapters): MigrationResult {
  return execute(operation, command, adapters, current => {
    assertLease(current, fencingToken, now);
    if (current.phase !== "commit-ready" || !current.validation) fail("commit-not-ready", "Commit requires the validated commit-ready phase.");
    const generation = current.generation + 1;
    const storageEpoch = current.storageEpoch + 1;
    const committed = {
      ...current, generation, storageEpoch,
      lease: { ...current.lease!, storageEpoch },
      commitBarrier: Object.freeze({ generation, storageEpoch, manifestDigest: current.targetManifestDigest })
    };
    return appendPhaseReceipt(committed, "committed", "phase:rebuilding", fencingToken, adapters);
  });
}

export function recordRebuildItem(operation: MigrationOperation, command: MigrationCommand, item: RebuildItem, adapters: MigrationAdapters): MigrationResult {
  return execute(operation, command, adapters, current => {
    if (current.phase !== "rebuilding") fail("rebuild-phase-required", "Derived data rebuild occurs only after authoritative commit.");
    requireText(item.itemId, "rebuild-invalid");
    requireText(item.checksum, "rebuild-invalid");
    const prior = current.rebuildItems.find(candidate => candidate.itemId === item.itemId);
    if (prior) {
      if (prior.checksum !== item.checksum) fail("rebuild-conflict", "Rebuild item checksum changed on replay.");
      return current;
    }
    return { ...current, rebuildItems: Object.freeze([...current.rebuildItems, Object.freeze({ ...item })]), resumeCursor: `rebuild:${item.itemId}` };
  });
}

export function chooseStartupRecovery(operation: MigrationOperation, observedGenerationDigests: readonly string[], receiptsValid: boolean): MigrationPhase {
  const unique = [...new Set(observedGenerationDigests)];
  if (!receiptsValid || unique.length !== 1) return "repair-required";
  if (operation.phase === "commit-ready" && unique[0] === operation.targetManifestDigest) return "committed";
  const next = FORWARD[operation.phase];
  return next.length === 1 ? next[0] : operation.phase;
}

export function authorizeNormalWrite(operation: MigrationOperation, writerEpoch: number): void {
  if (writerEpoch !== operation.storageEpoch || operation.lease) {
    fail("storage-epoch-fenced", "Normal writes require the current epoch and no active migration authority.");
  }
}

export function createManualResumePlan(prior: MigrationOperation, newOperationId: string): ManualResumePlan {
  requireText(newOperationId, "operation-invalid");
  if (newOperationId === prior.operationId) fail("authority-reuse-forbidden", "Manual resume must create new command and lease authority.");
  return Object.freeze({
    priorOperationId: prior.operationId, newOperationId,
    sourceReceiptDigests: Object.freeze(prior.receipts.map(receipt => receipt.digest)),
    sourceManifestDigest: prior.sourceManifestDigest, targetManifestDigest: prior.targetManifestDigest,
    preservedKeyIds: Object.freeze([...prior.preservedKeyIds]), invalidatedAuthority: true
  });
}

function execute(operation: MigrationOperation, command: MigrationCommand, adapters: MigrationAdapters, mutate: (current: MigrationOperation) => MigrationOperation): MigrationResult {
  const prior = operation.commands.find(receipt => receipt.commandId === command.commandId);
  if (prior) {
    if (prior.fingerprint !== command.fingerprint) fail("command-conflict", "Command ID was reused with a different fingerprint.");
    return { operation, receipt: prior, replayed: true };
  }
  if (command.expectedVersion !== operation.version) fail("version-conflict", "Expected migration version does not match.");
  const changed = mutate(operation);
  const version = operation.version + 1;
  const receipt = Object.freeze({ commandId: command.commandId, fingerprint: command.fingerprint, version, phase: changed.phase });
  return { operation: { ...changed, version, commands: Object.freeze([...changed.commands, receipt]) }, receipt, replayed: false };
}

function appendPhaseReceipt(operation: MigrationOperation, phase: MigrationPhase, cursor: string, fencingToken: number, adapters: MigrationAdapters): MigrationOperation {
  const body = {
    sequence: operation.receipts.length + 1, phase, previousPhase: operation.receipts.length ? operation.phase : undefined,
    cursor, storageEpoch: operation.storageEpoch, fencingToken
  };
  const receipt = Object.freeze({ ...body, digest: adapters.digest(body) });
  return { ...operation, phase, resumeCursor: cursor, receipts: Object.freeze([...operation.receipts, receipt]) };
}

function assertLease(operation: MigrationOperation, fencingToken: number, now: number): void {
  if (!operation.lease || operation.lease.fencingToken !== fencingToken || operation.lease.storageEpoch !== operation.storageEpoch || operation.lease.expiresAt <= now) {
    fail("migration-fenced", "Migration lease is absent, stale, expired, or on another storage epoch.");
  }
}

function replaceWriter(operation: MigrationOperation, replacement: WriterRegistration): MigrationOperation {
  return { ...operation, writers: Object.freeze(operation.writers.map(writer => writer.writerId === replacement.writerId ? Object.freeze(replacement) : writer)) };
}

function barrierCrossed(operation: MigrationOperation): boolean {
  return operation.commitBarrier !== undefined || ["committed", "rebuilding", "completed"].includes(operation.phase);
}

function decision(decisionValue: CompatibilityDecision, reason?: string): CompatibilityResult {
  return Object.freeze({ decision: decisionValue, reasons: Object.freeze(reason ? [reason] : []) });
}

function inRange(value: number, minimum: number, maximum: number): boolean {
  return value >= minimum && value <= maximum;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value));
}

function assertNoSecretValues(value: unknown): void {
  if (containsSecretValue(value)) fail("secret-value-forbidden", "Secret values must never enter migration state, receipts, backups, or diagnostics.");
}

function containsSecretValue(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSecretValue);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => /^(secret|token|password|credential)(Value)?$/i.test(key) || containsSecretValue(child));
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze)) as T;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, freeze(child)]);
    return Object.freeze(Object.fromEntries(entries)) as T;
  }
  return value;
}

function requireText(value: string, code: string): void {
  if (!value || !value.trim()) fail(code, "A non-empty value is required.");
}

function requirePositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, "A positive safe integer is required.");
}

function fail(code: string, message: string): never {
  throw new MigrationModelError(code, message);
}