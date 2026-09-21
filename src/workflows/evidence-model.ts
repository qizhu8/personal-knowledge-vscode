import { createHash } from "crypto";

export type EvidenceRetentionRole = "decision-critical" | "result" | "reproducibility" | "diagnostic" | "telemetry" | "ephemeral";
export type EvidenceLifecycle = "active" | "compacted" | "archived" | "purged";

export interface EvidenceProvenance {
  runId: string;
  nodeId: string;
  attemptId: string;
}

export interface EvidenceAcl {
  policyId: string;
  version: number;
}

export interface EvidenceRecord {
  evidenceId: string;
  representationId: string;
  provenance: EvidenceProvenance;
  kind: string;
  retentionRole: EvidenceRetentionRole;
  contentDigest: string;
  mediaType: string;
  lifecycle: EvidenceLifecycle;
  acl: EvidenceAcl;
  authEpoch: number;
  createdSeq: number;
  version: number;
  byteLength: number;
  payload?: Uint8Array;
  derivedFrom: readonly string[];
}

export type EvidenceMetadata = Omit<EvidenceRecord, "payload">;

export interface EvidenceCommand {
  commandId: string;
  fingerprint: string;
  expectedRegistryVersion: number;
}

export interface EvidenceCommandReceipt {
  commandId: string;
  fingerprint: string;
  operation: string;
  registryVersion: number;
  evidenceIds: readonly string[];
  controlId?: string;
}

export interface ByteFragment {
  kind: "bytes";
  start: number;
  end: number;
}

export interface EvidenceCitation {
  evidenceId: string;
  evidenceVersion: number;
  representationId: string;
  sourceDigest: string;
  aclPolicyId: string;
  aclVersion: number;
  authEpoch: number;
  fragment: ByteFragment;
}

export interface FragmentMapEntry {
  sourceStart: number;
  sourceEnd: number;
  derivedStart: number;
  derivedEnd: number;
}

export interface CompactionReceipt {
  receiptId: string;
  receiptDigest: string;
  commandId: string;
  sourceEvidenceId: string;
  sourceVersion: number;
  sourceDigest: string;
  derivedEvidenceId: string;
  derivedDigest: string;
  transform: string;
  transformVersion: string;
  deterministic: boolean;
  lossy: boolean;
  fragmentMap: readonly FragmentMapEntry[];
}

export interface EvidenceHold {
  holdId: string;
  evidenceId: string;
  reason: string;
}

export interface EvidenceRegistry {
  version: number;
  authEpoch: number;
  nextCreatedSeq: number;
  records: readonly EvidenceRecord[];
  commandReceipts: readonly EvidenceCommandReceipt[];
  compactionReceipts: readonly CompactionReceipt[];
  holds: readonly EvidenceHold[];
}

export interface EvidenceCommandResult {
  registry: EvidenceRegistry;
  receipt: EvidenceCommandReceipt;
  replayed: boolean;
}

export interface RegisterEvidenceInput {
  evidenceId: string;
  representationId: string;
  provenance: EvidenceProvenance;
  kind: string;
  retentionRole: EvidenceRetentionRole;
  contentDigest: string;
  mediaType: string;
  acl: EvidenceAcl;
  payload: Uint8Array;
  derivedFrom?: readonly string[];
}

export interface EvidenceAccessContext {
  authEpoch: number;
  canRead: (metadata: EvidenceMetadata) => boolean;
}

export interface EvidenceCursor {
  authEpoch: number;
  afterCreatedSeq: number;
}

export interface CitationResolution {
  state: "available-raw" | "available-derived" | "archived-restorable" | "purged-tombstone";
  evidenceId: string;
  contentDigest: string;
  fragment?: ByteFragment;
  payload?: Uint8Array;
  derivedEvidenceId?: string;
}

export interface GateDecisionReceipt {
  gateId: string;
  decision: "approve" | "deny";
  registryVersion: number;
  evidence: readonly EvidenceCitation[];
}

export class WorkflowEvidenceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const SHA256 = /^[a-f0-9]{64}$/;

export function createEvidenceRegistry(authEpoch = 1): EvidenceRegistry {
  if (!Number.isInteger(authEpoch) || authEpoch < 1) fail("auth-epoch-invalid", "Authorization epoch must be a positive integer.");
  return { version: 1, authEpoch, nextCreatedSeq: 1, records: [], commandReceipts: [], compactionReceipts: [], holds: [] };
}

export function sha256(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

export function registerEvidence(registry: EvidenceRegistry, commandEnvelope: EvidenceCommand, input: RegisterEvidenceInput): EvidenceCommandResult {
  return command(registry, commandEnvelope, "register", current => {
    validateRegistration(current, input);
    const record: EvidenceRecord = {
      ...input,
      provenance: { ...input.provenance },
      acl: { ...input.acl },
      payload: new Uint8Array(input.payload),
      lifecycle: "active",
      authEpoch: current.authEpoch,
      createdSeq: current.nextCreatedSeq,
      version: 1,
      byteLength: input.payload.byteLength,
      derivedFrom: [...(input.derivedFrom || [])]
    };
    return { registry: { ...current, records: [...current.records, record], nextCreatedSeq: current.nextCreatedSeq + 1 }, evidenceIds: [record.evidenceId] };
  });
}

export function compactEvidence(
  registry: EvidenceRegistry,
  commandEnvelope: EvidenceCommand,
  input: {
    receiptId: string;
    sourceEvidenceId: string;
    derived: RegisterEvidenceInput;
    transform: string;
    transformVersion: string;
    deterministic: boolean;
    lossy: boolean;
    fragmentMap: readonly FragmentMapEntry[];
    protectedCitations: readonly EvidenceCitation[];
  }
): EvidenceCommandResult {
  return command(registry, commandEnvelope, "compact", current => {
    const source = requireRecord(current, input.sourceEvidenceId);
    if (source.lifecycle !== "active" || !source.payload) fail("compaction-source-state", "Compaction requires active source payload.");
    if (source.retentionRole === "decision-critical") fail("decision-critical-immutable", "Decision-critical evidence cannot be destructively compacted.");
    if (!input.deterministic) fail("compaction-nondeterministic", "Exact fragment mapping requires a deterministic transform.");
    if (current.compactionReceipts.some(receipt => receipt.receiptId === input.receiptId)) fail("compaction-receipt-conflict", "Compaction receipt identity already exists.");
    validateRegistration(current, input.derived);
    validateFragmentMap(input.fragmentMap, source.byteLength, input.derived.payload.byteLength);
    for (const citation of input.protectedCitations) {
      assertCitationIdentity(source, citation);
      if (input.lossy || !findExactMap(input.fragmentMap, citation.fragment)) fail("citation-compaction-loss", "Compaction would lose an exact cited fragment.");
    }
    const derivedDigest = sha256(input.derived.payload);
    const receiptShape = {
      receiptId: input.receiptId, commandId: commandEnvelope.commandId,
      sourceEvidenceId: source.evidenceId, sourceVersion: source.version, sourceDigest: source.contentDigest,
      derivedEvidenceId: input.derived.evidenceId, derivedDigest,
      transform: input.transform, transformVersion: input.transformVersion,
      deterministic: input.deterministic, lossy: input.lossy,
      fragmentMap: input.fragmentMap.map(entry => ({ ...entry }))
    };
    const compactionReceipt: CompactionReceipt = {
      ...receiptShape,
      receiptDigest: sha256(Buffer.from(JSON.stringify(receiptShape), "utf8"))
    };
    const derived: EvidenceRecord = {
      ...input.derived,
      provenance: { ...input.derived.provenance }, acl: { ...input.derived.acl },
      payload: new Uint8Array(input.derived.payload), lifecycle: "active", authEpoch: current.authEpoch,
      createdSeq: current.nextCreatedSeq, version: 1, byteLength: input.derived.payload.byteLength,
      derivedFrom: [source.evidenceId]
    };
    const compacted = { ...source, lifecycle: "compacted" as const, payload: undefined, version: source.version + 1 };
    return {
      registry: {
        ...current,
        records: [...current.records.map(record => record.evidenceId === source.evidenceId ? compacted : record), derived],
        compactionReceipts: [...current.compactionReceipts, compactionReceipt],
        nextCreatedSeq: current.nextCreatedSeq + 1
      },
      evidenceIds: [source.evidenceId, derived.evidenceId], controlId: input.receiptId
    };
  });
}

export function archiveEvidence(registry: EvidenceRegistry, commandEnvelope: EvidenceCommand, evidenceId: string): EvidenceCommandResult {
  return command(registry, commandEnvelope, "archive", current => {
    const record = requireRecord(current, evidenceId);
    if (record.lifecycle !== "active" && record.lifecycle !== "compacted") fail("archive-state", "Only active or compacted evidence may be archived.");
    return { registry: replaceRecord(current, { ...record, lifecycle: "archived", version: record.version + 1 }), evidenceIds: [evidenceId] };
  });
}

export function placeEvidenceHold(
  registry: EvidenceRegistry,
  commandEnvelope: EvidenceCommand,
  evidenceId: string,
  holdId: string,
  reason: string
): EvidenceCommandResult {
  return command(registry, commandEnvelope, "hold", current => {
    requireRecord(current, evidenceId);
    if (!reason.trim()) fail("hold-reason-required", "A hold reason is required.");
    if (current.holds.some(hold => hold.holdId === holdId)) fail("hold-id-conflict", "Hold identity already exists.");
    const hold = { holdId, evidenceId, reason: reason.trim() };
    return { registry: { ...current, holds: [...current.holds, hold] }, evidenceIds: [evidenceId], controlId: holdId };
  });
}

export function purgeEvidence(registry: EvidenceRegistry, commandEnvelope: EvidenceCommand, evidenceId: string): EvidenceCommandResult {
  return command(registry, commandEnvelope, "purge", current => {
    const record = requireRecord(current, evidenceId);
    if (record.lifecycle === "purged") fail("purge-state", "Evidence is already purged.");
    if (current.holds.some(hold => hold.evidenceId === evidenceId)) fail("purge-held", "An active hold blocks purge.");
    const tombstone = { ...record, lifecycle: "purged" as const, payload: undefined, version: record.version + 1 };
    return { registry: replaceRecord(current, tombstone), evidenceIds: [evidenceId] };
  });
}

export function updateEvidenceAcl(
  registry: EvidenceRegistry,
  commandEnvelope: EvidenceCommand,
  evidenceId: string,
  acl: EvidenceAcl,
  nextAuthEpoch: number
): EvidenceCommandResult {
  return command(registry, commandEnvelope, "acl-update", current => {
    const record = requireRecord(current, evidenceId);
    if (nextAuthEpoch !== current.authEpoch + 1) fail("auth-epoch-sequence", "Authorization epoch must advance exactly once.");
    if (!acl.policyId.trim() || !Number.isInteger(acl.version) || acl.version < 1) fail("acl-invalid", "ACL policy identity and positive version are required.");
    const updated = { ...record, acl: { ...acl }, authEpoch: nextAuthEpoch, version: record.version + 1 };
    return { registry: { ...replaceRecord(current, updated), authEpoch: nextAuthEpoch }, evidenceIds: [evidenceId] };
  });
}

export function encodeEvidenceCursor(cursor: EvidenceCursor): string {
  return Buffer.from(`${cursor.authEpoch}:${cursor.afterCreatedSeq}`, "utf8").toString("base64url");
}

export function listEvidence(
  registry: EvidenceRegistry,
  access: EvidenceAccessContext,
  cursorValue?: string,
  limit = 50
): { records: readonly EvidenceMetadata[]; cursor?: string } {
  assertCurrentEpoch(registry, access);
  if (!Number.isInteger(limit) || limit < 1) fail("page-limit-invalid", "Page limit must be a positive integer.");
  const cursor = cursorValue ? decodeEvidenceCursor(cursorValue) : { authEpoch: registry.authEpoch, afterCreatedSeq: 0 };
  if (cursor.authEpoch !== registry.authEpoch) fail("cursor-auth-epoch-stale", "Cursor authorization epoch is stale.");
  const visible = registry.records
    .filter(record => record.createdSeq > cursor.afterCreatedSeq)
    .filter(record => access.canRead(metadata(record)))
    .slice(0, limit);
  const next = visible.length === limit ? encodeEvidenceCursor({ authEpoch: registry.authEpoch, afterCreatedSeq: visible[visible.length - 1].createdSeq }) : undefined;
  return { records: visible.map(metadata), cursor: next };
}

export function deliverEvidence(registry: EvidenceRegistry, evidenceId: string, access: EvidenceAccessContext): EvidenceRecord {
  assertCurrentEpoch(registry, access);
  const record = registry.records.find(candidate => candidate.evidenceId === evidenceId);
  if (!record || !access.canRead(metadata(record))) fail("not-found-or-inaccessible", "Evidence was not found or is inaccessible.");
  return { ...record, payload: record.payload && new Uint8Array(record.payload) };
}

export function resolveCitation(registry: EvidenceRegistry, citation: EvidenceCitation, access: EvidenceAccessContext): CitationResolution {
  const record = deliverEvidence(registry, citation.evidenceId, access);
  const receipt = record.lifecycle === "compacted"
    ? registry.compactionReceipts.find(candidate => candidate.sourceEvidenceId === record.evidenceId)
    : undefined;
  assertCitationIdentity(record, citation, receipt?.sourceVersion);
  validateFragment(citation.fragment, record.byteLength);
  if (record.lifecycle === "purged") return { state: "purged-tombstone", evidenceId: record.evidenceId, contentDigest: record.contentDigest };
  if (record.lifecycle === "archived") return { state: "archived-restorable", evidenceId: record.evidenceId, contentDigest: record.contentDigest, fragment: { ...citation.fragment } };
  if (record.payload) {
    return { state: "available-raw", evidenceId: record.evidenceId, contentDigest: record.contentDigest, fragment: { ...citation.fragment }, payload: record.payload.slice(citation.fragment.start, citation.fragment.end) };
  }
  const mapped = receipt && !receipt.lossy ? findExactMap(receipt.fragmentMap, citation.fragment) : undefined;
  if (!receipt || !mapped) fail("citation-unresolvable", "The exact cited fragment is unavailable.");
  const derived = deliverEvidence(registry, receipt.derivedEvidenceId, access);
  if (!derived.payload || derived.contentDigest !== receipt.derivedDigest) fail("citation-unresolvable", "The exact cited fragment is unavailable.");
  return {
    state: "available-derived", evidenceId: record.evidenceId, contentDigest: record.contentDigest,
    fragment: { kind: "bytes", start: mapped.derivedStart, end: mapped.derivedEnd },
    payload: derived.payload.slice(mapped.derivedStart, mapped.derivedEnd), derivedEvidenceId: derived.evidenceId
  };
}

export function decideGate(
  registry: EvidenceRegistry,
  commandEnvelope: EvidenceCommand,
  input: { gateId: string; decision: "approve" | "deny"; citations: readonly EvidenceCitation[]; access: EvidenceAccessContext }
): EvidenceCommandResult {
  return command(registry, commandEnvelope, "gate-decision", current => {
    if (!input.citations.length) fail("gate-evidence-required", "A Gate decision requires cited evidence.");
    for (const citation of input.citations) {
      try {
        resolveCitation(current, citation, input.access);
      } catch (error) {
        if (error instanceof WorkflowEvidenceError) fail("gate-evidence-invalid", "Gate evidence is revoked, stale, changed, or unavailable.");
        throw error;
      }
    }
    const gateReceipt: GateDecisionReceipt = {
      gateId: input.gateId, decision: input.decision, registryVersion: current.version + 1,
      evidence: input.citations.map(citation => ({ ...citation, fragment: { ...citation.fragment } }))
    };
    return { registry: current, evidenceIds: input.citations.map(citation => citation.evidenceId), controlId: sha256(Buffer.from(JSON.stringify(gateReceipt), "utf8")) };
  });
}

function command(
  registry: EvidenceRegistry,
  commandEnvelope: EvidenceCommand,
  operation: string,
  mutate: (registry: EvidenceRegistry) => { registry: EvidenceRegistry; evidenceIds: readonly string[]; controlId?: string }
): EvidenceCommandResult {
  const prior = registry.commandReceipts.find(receipt => receipt.commandId === commandEnvelope.commandId);
  if (prior) {
    if (prior.fingerprint !== commandEnvelope.fingerprint) fail("command-conflict", "Command ID was reused with a different canonical request fingerprint.");
    return { registry, receipt: prior, replayed: true };
  }
  if (commandEnvelope.expectedRegistryVersion !== registry.version) fail("registry-version-conflict", "Expected Evidence Registry version does not match.");
  const changed = mutate(registry);
  const nextVersion = registry.version + 1;
  const receipt: EvidenceCommandReceipt = {
    commandId: commandEnvelope.commandId, fingerprint: commandEnvelope.fingerprint, operation,
    registryVersion: nextVersion, evidenceIds: [...changed.evidenceIds], controlId: changed.controlId
  };
  return { registry: { ...changed.registry, version: nextVersion, commandReceipts: [...changed.registry.commandReceipts, receipt] }, receipt, replayed: false };
}

function validateRegistration(registry: EvidenceRegistry, input: RegisterEvidenceInput): void {
  if (!input.evidenceId.trim() || !input.representationId.trim()) fail("evidence-identity-required", "Evidence and representation identities are required.");
  if (registry.records.some(record => record.evidenceId === input.evidenceId || record.representationId === input.representationId)) fail("evidence-identity-conflict", "Evidence or representation identity already exists.");
  if (!input.provenance.runId.trim() || !input.provenance.nodeId.trim() || !input.provenance.attemptId.trim()) fail("evidence-provenance-required", "Run, Node, and Attempt provenance are required.");
  if (!input.kind.trim() || !input.mediaType.trim()) fail("evidence-description-required", "Evidence kind and media type are required.");
  if (!SHA256.test(input.contentDigest) || input.contentDigest !== sha256(input.payload)) fail("content-digest-invalid", "Evidence content digest is not the SHA-256 of its payload.");
  if (!input.acl.policyId.trim() || !Number.isInteger(input.acl.version) || input.acl.version < 1) fail("acl-invalid", "ACL policy identity and positive version are required.");
}

function validateFragmentMap(entries: readonly FragmentMapEntry[], sourceLength: number, derivedLength: number): void {
  for (const entry of entries) {
    validateFragment({ kind: "bytes", start: entry.sourceStart, end: entry.sourceEnd }, sourceLength);
    validateFragment({ kind: "bytes", start: entry.derivedStart, end: entry.derivedEnd }, derivedLength);
    if (entry.sourceEnd - entry.sourceStart !== entry.derivedEnd - entry.derivedStart) fail("fragment-map-lossy", "Exact fragment map spans must have equal byte length.");
  }
}

function validateFragment(fragment: ByteFragment, byteLength: number): void {
  if (!Number.isInteger(fragment.start) || !Number.isInteger(fragment.end) || fragment.start < 0 || fragment.end <= fragment.start || fragment.end > byteLength) {
    fail("citation-fragment-invalid", "Citation byte fragment is outside the source representation.");
  }
}

function findExactMap(entries: readonly FragmentMapEntry[], fragment: ByteFragment): FragmentMapEntry | undefined {
  return entries.find(entry => entry.sourceStart === fragment.start && entry.sourceEnd === fragment.end);
}

function assertCitationIdentity(record: EvidenceRecord, citation: EvidenceCitation, sourceVersion = record.version): void {
  if (
    sourceVersion !== citation.evidenceVersion || record.representationId !== citation.representationId ||
    record.contentDigest !== citation.sourceDigest || record.acl.policyId !== citation.aclPolicyId ||
    record.acl.version !== citation.aclVersion || record.authEpoch !== citation.authEpoch
  ) fail("citation-stale", "Citation identity, version, digest, or authorization snapshot is stale.");
}

function assertCurrentEpoch(registry: EvidenceRegistry, access: EvidenceAccessContext): void {
  if (access.authEpoch !== registry.authEpoch) fail("authorization-epoch-stale", "Authorization must be re-evaluated at the current epoch.");
}

function decodeEvidenceCursor(value: string): EvidenceCursor {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const match = /^(\d+):(\d+)$/.exec(decoded);
  if (!match) fail("cursor-invalid", "Evidence cursor is invalid.");
  return { authEpoch: Number(match[1]), afterCreatedSeq: Number(match[2]) };
}

function metadata(record: EvidenceRecord): EvidenceMetadata {
  const { payload, ...safe } = record;
  return { ...safe, provenance: { ...safe.provenance }, acl: { ...safe.acl }, derivedFrom: [...safe.derivedFrom] };
}

function requireRecord(registry: EvidenceRegistry, evidenceId: string): EvidenceRecord {
  const record = registry.records.find(candidate => candidate.evidenceId === evidenceId);
  if (!record) fail("evidence-not-found", "Evidence does not exist.");
  return record;
}

function replaceRecord(registry: EvidenceRegistry, replacement: EvidenceRecord): EvidenceRegistry {
  return { ...registry, records: registry.records.map(record => record.evidenceId === replacement.evidenceId ? replacement : record) };
}

function fail(code: string, message: string): never {
  throw new WorkflowEvidenceError(code, message);
}