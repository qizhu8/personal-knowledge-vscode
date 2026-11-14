#!/usr/bin/env node
const assert = require("assert");
const evidence = require("../dist/workflows/evidence-model.js");

const {
  WorkflowEvidenceError, archiveEvidence, compactEvidence, createEvidenceRegistry, decideGate,
  deliverEvidence, encodeEvidenceCursor, listEvidence, placeEvidenceHold, purgeEvidence,
  registerEvidence, resolveCitation, sha256, updateEvidenceAcl
} = evidence;

let commandId = 0;
const command = (registry, fingerprint = "fp") => ({ commandId: `command-${++commandId}`, fingerprint, expectedRegistryVersion: registry.version });
const bytes = value => Buffer.from(value, "utf8");
const input = (id, value, overrides = {}) => ({
  evidenceId: id, representationId: `representation-${id}`,
  provenance: { runId: "run-1", nodeId: "node-1", attemptId: "attempt-1" },
  kind: "check-result", retentionRole: "result", contentDigest: sha256(bytes(value)),
  mediaType: "text/plain", acl: { policyId: "acl-1", version: 1 }, payload: bytes(value),
  ...overrides
});
const apply = result => result.registry;
const error = (action, code) => assert.throws(action, value => value instanceof WorkflowEvidenceError && value.code === code);
const access = (registry, allowed = true) => ({ authEpoch: registry.authEpoch, canRead: metadata => allowed && !Object.hasOwn(metadata, "payload") });
const citation = record => ({
  evidenceId: record.evidenceId, evidenceVersion: record.version, representationId: record.representationId,
  sourceDigest: record.contentDigest, aclPolicyId: record.acl.policyId, aclVersion: record.acl.version,
  authEpoch: record.authEpoch, fragment: { kind: "bytes", start: 0, end: Math.min(5, record.byteLength) }
});

error(() => createEvidenceRegistry(0), "auth-epoch-invalid");
error(() => createEvidenceRegistry(1.5), "auth-epoch-invalid");
let registry = createEvidenceRegistry();
assert.deepStrictEqual({ version: registry.version, authEpoch: registry.authEpoch, next: registry.nextCreatedSeq }, { version: 1, authEpoch: 1, next: 1 });

const malformed = [
  [input("", "alpha"), "evidence-identity-required"],
  [input("a", "alpha", { representationId: "" }), "evidence-identity-required"],
  [input("a", "alpha", { provenance: { runId: "", nodeId: "n", attemptId: "a" } }), "evidence-provenance-required"],
  [input("a", "alpha", { provenance: { runId: "r", nodeId: "", attemptId: "a" } }), "evidence-provenance-required"],
  [input("a", "alpha", { provenance: { runId: "r", nodeId: "n", attemptId: "" } }), "evidence-provenance-required"],
  [input("a", "alpha", { kind: "" }), "evidence-description-required"],
  [input("a", "alpha", { mediaType: "" }), "evidence-description-required"],
  [input("a", "alpha", { contentDigest: "x".repeat(64) }), "content-digest-invalid"],
  [input("a", "alpha", { contentDigest: "A".repeat(64) }), "content-digest-invalid"],
  [input("a", "alpha", { acl: { policyId: "", version: 1 } }), "acl-invalid"],
  [input("a", "alpha", { acl: { policyId: "acl", version: 0 } }), "acl-invalid"],
  [input("a", "alpha", { acl: { policyId: "acl", version: 1.5 } }), "acl-invalid"]
];
for (const [candidate, code] of malformed) error(() => registerEvidence(registry, command(registry), candidate), code);

let result = registerEvidence(registry, command(registry, "register-alpha"), input("evidence-alpha", "alpha payload"));
registry = result.registry;
assert.strictEqual(result.replayed, false);
assert.strictEqual(result.receipt.operation, "register");
assert.deepStrictEqual(result.receipt.evidenceIds, ["evidence-alpha"]);
assert.strictEqual(registry.records[0].createdSeq, 1);
assert.strictEqual(registry.records[0].version, 1);
assert.strictEqual(registry.records[0].lifecycle, "active");
assert.notStrictEqual(registry.records[0].payload, input("x", "alpha payload").payload);
const replayCommand = { commandId: result.receipt.commandId, fingerprint: "register-alpha", expectedRegistryVersion: 0 };
const replay = registerEvidence(registry, replayCommand, input("ignored", "ignored"));
assert.strictEqual(replay.replayed, true);
assert.strictEqual(replay.registry, registry);
assert.strictEqual(replay.receipt, result.receipt);
error(() => registerEvidence(registry, { ...replayCommand, fingerprint: "changed" }, input("ignored", "ignored")), "command-conflict");
error(() => registerEvidence(registry, { ...command(registry), expectedRegistryVersion: 1 }, input("evidence-b", "bravo")), "registry-version-conflict");
error(() => registerEvidence(registry, command(registry), input("evidence-alpha", "other")), "evidence-identity-conflict");
error(() => registerEvidence(registry, command(registry), input("other", "other", { representationId: "representation-evidence-alpha" })), "evidence-identity-conflict");

registry = apply(registerEvidence(registry, command(registry), input("evidence-beta", "beta payload")));
const alpha = registry.records[0];
const alphaCitation = citation(alpha);
assert.strictEqual(Buffer.from(deliverEvidence(registry, alpha.evidenceId, access(registry)).payload).toString(), "alpha payload");
error(() => deliverEvidence(registry, "missing", access(registry)), "not-found-or-inaccessible");
error(() => deliverEvidence(registry, alpha.evidenceId, access(registry, false)), "not-found-or-inaccessible");
error(() => deliverEvidence(registry, alpha.evidenceId, { ...access(registry), authEpoch: 0 }), "authorization-epoch-stale");

assert.strictEqual(resolveCitation(registry, alphaCitation, access(registry)).state, "available-raw");
assert.strictEqual(Buffer.from(resolveCitation(registry, alphaCitation, access(registry)).payload).toString(), "alpha");
for (const changed of [
  { evidenceVersion: 2 }, { representationId: "wrong" }, { sourceDigest: "0".repeat(64) },
  { aclPolicyId: "wrong" }, { aclVersion: 2 }, { authEpoch: 2 }
]) error(() => resolveCitation(registry, { ...alphaCitation, ...changed }, access(registry)), "citation-stale");
for (const fragment of [
  { kind: "bytes", start: -1, end: 1 }, { kind: "bytes", start: 0.5, end: 1 },
  { kind: "bytes", start: 0, end: 1.5 }, { kind: "bytes", start: 1, end: 1 },
  { kind: "bytes", start: 2, end: 1 }, { kind: "bytes", start: 0, end: 100 }
]) error(() => resolveCitation(registry, { ...alphaCitation, fragment }, access(registry)), "citation-fragment-invalid");

const firstPage = listEvidence(registry, access(registry), undefined, 1);
assert.deepStrictEqual(firstPage.records.map(record => record.evidenceId), ["evidence-alpha"]);
assert(!Object.hasOwn(firstPage.records[0], "payload"));
assert(firstPage.cursor);
assert.deepStrictEqual(listEvidence(registry, access(registry), firstPage.cursor, 10).records.map(record => record.evidenceId), ["evidence-beta"]);
assert.deepStrictEqual(listEvidence(registry, access(registry, false)).records, []);
error(() => listEvidence(registry, access(registry), undefined, 0), "page-limit-invalid");
error(() => listEvidence(registry, access(registry), "bad"), "cursor-invalid");
const staleCursor = encodeEvidenceCursor({ authEpoch: 0, afterCreatedSeq: 0 });
error(() => listEvidence(registry, access(registry), staleCursor), "cursor-auth-epoch-stale");

const compactInput = (overrides = {}) => ({
  receiptId: "compaction-1", sourceEvidenceId: "evidence-alpha",
  derived: input("evidence-alpha-compact", "alpha", { kind: "compacted-log", retentionRole: "diagnostic" }),
  transform: "text-extract", transformVersion: "1", deterministic: true, lossy: false,
  fragmentMap: [{ sourceStart: 0, sourceEnd: 5, derivedStart: 0, derivedEnd: 5 }],
  protectedCitations: [alphaCitation], ...overrides
});
error(() => compactEvidence(registry, command(registry), { ...compactInput(), sourceEvidenceId: "missing" }), "evidence-not-found");
error(() => compactEvidence(registry, command(registry), { ...compactInput(), deterministic: false }), "compaction-nondeterministic");
error(() => compactEvidence(registry, command(registry), { ...compactInput(), lossy: true }), "citation-compaction-loss");
error(() => compactEvidence(registry, command(registry), { ...compactInput(), fragmentMap: [] }), "citation-compaction-loss");
error(() => compactEvidence(registry, command(registry), { ...compactInput(), protectedCitations: [{ ...alphaCitation, sourceDigest: "0".repeat(64) }] }), "citation-stale");
error(() => compactEvidence(registry, command(registry), { ...compactInput(), fragmentMap: [{ sourceStart: 0, sourceEnd: 50, derivedStart: 0, derivedEnd: 5 }] }), "citation-fragment-invalid");
error(() => compactEvidence(registry, command(registry), { ...compactInput(), fragmentMap: [{ sourceStart: 0, sourceEnd: 5, derivedStart: 0, derivedEnd: 50 }] }), "citation-fragment-invalid");
error(() => compactEvidence(registry, command(registry), { ...compactInput(), fragmentMap: [{ sourceStart: 0, sourceEnd: 5, derivedStart: 0, derivedEnd: 4 }] }), "fragment-map-lossy");

result = compactEvidence(registry, command(registry, "compact-alpha"), compactInput());
registry = result.registry;
assert.strictEqual(result.receipt.controlId, "compaction-1");
assert.strictEqual(registry.records.find(record => record.evidenceId === "evidence-alpha").payload, undefined);
assert.strictEqual(registry.records.find(record => record.evidenceId === "evidence-alpha").lifecycle, "compacted");
assert.strictEqual(registry.compactionReceipts[0].sourceVersion, 1);
assert.strictEqual(registry.compactionReceipts[0].sourceDigest, alpha.contentDigest);
assert.match(registry.compactionReceipts[0].receiptDigest, /^[a-f0-9]{64}$/);
const resolved = resolveCitation(registry, alphaCitation, access(registry));
assert.strictEqual(resolved.state, "available-derived");
assert.strictEqual(resolved.derivedEvidenceId, "evidence-alpha-compact");
assert.strictEqual(Buffer.from(resolved.payload).toString(), "alpha");
assert(decideGate(registry, command(registry, "gate-compacted"), {
  gateId: "gate-compacted", decision: "approve", citations: [alphaCitation], access: access(registry)
}).receipt.controlId);
error(() => compactEvidence(registry, command(registry), compactInput()), "compaction-source-state");

let duplicateReceiptRegistry = apply(registerEvidence(registry, command(registry), input("evidence-gamma", "gamma payload")));
error(() => compactEvidence(duplicateReceiptRegistry, command(duplicateReceiptRegistry), {
  ...compactInput(), sourceEvidenceId: "evidence-gamma",
  derived: input("evidence-gamma-compact", "gamma"), protectedCitations: [],
  fragmentMap: [{ sourceStart: 0, sourceEnd: 5, derivedStart: 0, derivedEnd: 5 }]
}), "compaction-receipt-conflict");

let lossyRegistry = createEvidenceRegistry();
lossyRegistry = apply(registerEvidence(lossyRegistry, command(lossyRegistry), input("lossy-source", "source")));
const lossyCitation = citation(lossyRegistry.records[0]);
lossyRegistry = apply(compactEvidence(lossyRegistry, command(lossyRegistry), {
  receiptId: "lossy-receipt", sourceEvidenceId: "lossy-source", derived: input("lossy-derived", "sum"),
  transform: "summary", transformVersion: "1", deterministic: true, lossy: true, fragmentMap: [], protectedCitations: []
}));
error(() => resolveCitation(lossyRegistry, lossyCitation, access(lossyRegistry)), "citation-unresolvable");

let missingDerived = { ...registry, records: registry.records.filter(record => record.evidenceId !== "evidence-alpha-compact") };
error(() => resolveCitation(missingDerived, alphaCitation, access(missingDerived)), "not-found-or-inaccessible");
missingDerived = { ...registry, records: registry.records.map(record => record.evidenceId === "evidence-alpha-compact" ? { ...record, contentDigest: "0".repeat(64) } : record) };
error(() => resolveCitation(missingDerived, alphaCitation, access(missingDerived)), "citation-unresolvable");

let critical = apply(registerEvidence(registry, command(registry), input("critical", "approve", { retentionRole: "decision-critical" })));
error(() => compactEvidence(critical, command(critical), {
  ...compactInput(), receiptId: "critical-compact", sourceEvidenceId: "critical", derived: input("critical-derived", "approve"), protectedCitations: []
}), "decision-critical-immutable");

error(() => archiveEvidence(registry, command(registry), "missing"), "evidence-not-found");
registry = apply(archiveEvidence(registry, command(registry), "evidence-beta"));
const beta = registry.records.find(record => record.evidenceId === "evidence-beta");
assert.strictEqual(beta.lifecycle, "archived");
assert.strictEqual(resolveCitation(registry, { ...citation(beta), fragment: { kind: "bytes", start: 0, end: 4 } }, access(registry)).state, "archived-restorable");
error(() => resolveCitation(registry, { ...citation(beta), fragment: { kind: "bytes", start: 0, end: 100 } }, access(registry)), "citation-fragment-invalid");
error(() => archiveEvidence(registry, command(registry), "evidence-beta"), "archive-state");

error(() => placeEvidenceHold(registry, command(registry), "missing", "h", "reason"), "evidence-not-found");
error(() => placeEvidenceHold(registry, command(registry), "evidence-beta", "h", " "), "hold-reason-required");
registry = apply(placeEvidenceHold(registry, command(registry), "evidence-beta", "hold-1", " legal "));
assert.strictEqual(registry.holds[0].reason, "legal");
error(() => placeEvidenceHold(registry, command(registry), "evidence-alpha", "hold-1", "other"), "hold-id-conflict");
error(() => purgeEvidence(registry, command(registry), "evidence-beta"), "purge-held");
error(() => purgeEvidence(registry, command(registry), "missing"), "evidence-not-found");

registry = apply(purgeEvidence(registry, command(registry), "evidence-alpha-compact"));
const tombstone = registry.records.find(record => record.evidenceId === "evidence-alpha-compact");
assert.strictEqual(tombstone.lifecycle, "purged");
assert.strictEqual(tombstone.payload, undefined);
assert.strictEqual(tombstone.contentDigest, sha256(bytes("alpha")));
assert.strictEqual(tombstone.provenance.runId, "run-1");
assert.strictEqual(resolveCitation(registry, citation(tombstone), access(registry)).state, "purged-tombstone");
error(() => purgeEvidence(registry, command(registry), "evidence-alpha-compact"), "purge-state");

const preAclCursor = encodeEvidenceCursor({ authEpoch: registry.authEpoch, afterCreatedSeq: 0 });
error(() => updateEvidenceAcl(registry, command(registry), "missing", { policyId: "acl-2", version: 1 }, registry.authEpoch + 1), "evidence-not-found");
error(() => updateEvidenceAcl(registry, command(registry), "evidence-beta", { policyId: "acl-2", version: 1 }, registry.authEpoch + 2), "auth-epoch-sequence");
error(() => updateEvidenceAcl(registry, command(registry), "evidence-beta", { policyId: "", version: 1 }, registry.authEpoch + 1), "acl-invalid");
error(() => updateEvidenceAcl(registry, command(registry), "evidence-beta", { policyId: "acl", version: 0 }, registry.authEpoch + 1), "acl-invalid");
error(() => updateEvidenceAcl(registry, command(registry), "evidence-beta", { policyId: "acl", version: 1.5 }, registry.authEpoch + 1), "acl-invalid");
const oldBetaCitation = citation(beta);
registry = apply(updateEvidenceAcl(registry, command(registry), "evidence-beta", { policyId: "acl-2", version: 2 }, registry.authEpoch + 1));
error(() => listEvidence(registry, access(registry), preAclCursor), "cursor-auth-epoch-stale");
error(() => listEvidence(registry, { ...access(registry), authEpoch: registry.authEpoch - 1 }), "authorization-epoch-stale");
error(() => resolveCitation(registry, oldBetaCitation, access(registry)), "citation-stale");

const currentBeta = registry.records.find(record => record.evidenceId === "evidence-beta");
const gateCitation = { ...citation(currentBeta), fragment: { kind: "bytes", start: 0, end: 4 } };
error(() => decideGate(registry, command(registry), { gateId: "gate-1", decision: "approve", citations: [], access: access(registry) }), "gate-evidence-required");
error(() => decideGate(registry, command(registry), { gateId: "gate-1", decision: "approve", citations: [{ ...gateCitation, aclVersion: 1 }], access: access(registry) }), "gate-evidence-invalid");
error(() => decideGate(registry, command(registry), { gateId: "gate-1", decision: "approve", citations: [gateCitation], access: access(registry, false) }), "gate-evidence-invalid");
result = decideGate(registry, command(registry, "gate"), { gateId: "gate-1", decision: "approve", citations: [gateCitation], access: access(registry) });
registry = result.registry;
assert.strictEqual(result.receipt.operation, "gate-decision");
assert.match(result.receipt.controlId, /^[a-f0-9]{64}$/);
assert.deepStrictEqual(result.receipt.evidenceIds, ["evidence-beta"]);

const thrown = new Error("authorizer failed");
assert.throws(() => decideGate(registry, command(registry), {
  gateId: "gate-2", decision: "deny", citations: [{ ...gateCitation, evidenceVersion: currentBeta.version }],
  access: { authEpoch: registry.authEpoch, canRead: () => { throw thrown; } }
}), value => value === thrown);

console.log("workflow evidence model test: registry, citations, compaction, authorization, purge, and Gate CAS OK");