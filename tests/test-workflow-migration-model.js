#!/usr/bin/env node
const assert = require("assert");
const { createHash } = require("crypto");
const migration = require("../dist/workflows/migration-model.js");

const {
  MIGRATION_ENVELOPE_MAGIC, MIGRATION_ENVELOPE_VERSION, MIGRATION_PHASES, MigrationModelError,
  acknowledgeWriter, acquireMigrationLease, authorizeNormalWrite, chooseStartupRecovery,
  commitMigration, createManifestEnvelope, createManualResumePlan, createMigrationOperation,
  evaluateWriterQuiescence, evictExpiredWriter, heartbeatMigrationLease, inspectManifest,
  recordPreflight, recordRebuildItem, recordRestorePoint, recordTransformChunk, recordValidation,
  registerWriter, transitionMigration, verifyManifestEnvelope
} = migration;

const adapters = { digest: value => createHash("sha256").update(JSON.stringify(value)).digest("hex") };
const errorCode = (action, code) => assert.throws(action, error => error instanceof MigrationModelError && error.code === code);
const command = (operation, id, fingerprint = id) => ({ commandId: id, fingerprint, expectedVersion: operation.version });
const apply = result => result.operation;
const pass = Object.freeze({ status: "pass" });
const goodPreflight = () => ({
  ownerIntent: pass, disk: pass, backupDestination: pass, keys: pass,
  secretReferences: [{ referenceId: "provider/api", state: "bound", status: "pass", keyId: "key-a" }],
  integrity: pass, transitionPath: pass, runtimeCompatibility: pass, activeOperation: pass,
  activeEffects: pass, checkpoints: pass, activeWriters: pass, keyRotation: pass
});
const goodRestore = () => ({
  restorePointId: "restore-1", contentDigest: "sha256:backup", sourceManifestDigest: "sha256:source",
  payloadClosureVerified: true, referentialClosureVerified: true, purgeLedgerDigest: "sha256:purge",
  purgeLedgerVerified: true, keyIds: ["key-a"], resolvableKeyIds: ["key-a"], smokeProbePassed: true
});
const goodValidation = () => ({
  targetSchema: "pass", crossStoreReferences: "pass", identities: "pass", immutableHistory: "pass",
  payloadClosure: "pass", purgeLedgerClosure: "pass", acls: "pass", invariantProbes: "pass", shadowStoresFlushed: "pass"
});
const makeOperation = (overrides = {}) => createMigrationOperation({
  operationId: "migration-1", direction: "upgrade", sourceManifestDigest: "sha256:source",
  targetManifestDigest: "sha256:target", keyIds: ["key-a"], storageEpoch: 4, generation: 2, ...overrides
}, adapters);
const lease = (operation, id = "lease", now = 100, expiresAt = 200, fencingToken = 1) => apply(acquireMigrationLease(
  operation, command(operation, id), { ownerProcessId: "process-1", fencingToken, now, expiresAt }, adapters
));
const advance = (operation, target, id, cursor = `phase:${target}`, now = 120, fence = 1) => apply(transitionMigration(operation, command(operation, id), target, cursor, now, fence, adapters));

assert.strictEqual(MIGRATION_ENVELOPE_MAGIC, "PKM-RUNTIME");
assert.strictEqual(MIGRATION_ENVELOPE_VERSION, 1);
assert.deepStrictEqual(MIGRATION_PHASES, [
  "planned", "preflighting", "quiescing", "backed-up", "transforming", "validating", "commit-ready",
  "committed", "rebuilding", "completed", "rollback-required", "rolled-back", "repair-required"
]);

const envelopeInput = {
  storageEpoch: 4, minimumReader: 2, maximumReader: 4, minimumWriter: 3, maximumWriter: 4,
  generationPointer: "generation-2", migrationStatePointer: "migration-1",
  subsystemDigests: { workflow: "sha256:workflow-v2" }
};
const envelope = createManifestEnvelope(envelopeInput, adapters);
assert.strictEqual(envelope.magic, MIGRATION_ENVELOPE_MAGIC);
assert.strictEqual(envelope.integrityDigest, adapters.digest({ magic: MIGRATION_ENVELOPE_MAGIC, envelopeVersion: 1, ...envelopeInput }));
verifyManifestEnvelope(envelope, adapters);
errorCode(() => verifyManifestEnvelope({ ...envelope, integrityDigest: "" }, adapters), "manifest-digest-invalid");
errorCode(() => verifyManifestEnvelope({ ...envelope, storageEpoch: 9 }, adapters), "manifest-digest-invalid");
errorCode(() => createManifestEnvelope({ ...envelopeInput, storageEpoch: 0 }, adapters), "manifest-invalid");
errorCode(() => createManifestEnvelope({ ...envelopeInput, generationPointer: " " }, adapters), "manifest-invalid");
const binary = {
  envelopeVersions: [1], readerVersion: 3, writerVersion: 3,
  subsystemDigests: { workflow: ["sha256:workflow-v2"] }, reversePathIds: ["reverse-v2-v1"]
};
assert.deepStrictEqual(inspectManifest(envelope, binary), { decision: "read-write", reasons: [] });
assert.deepStrictEqual(inspectManifest({ ...envelope, magic: "OTHER" }, binary), { decision: "refuse", reasons: ["outer-envelope-unsupported"] });
assert.deepStrictEqual(inspectManifest(envelope, { ...binary, envelopeVersions: [] }), { decision: "refuse", reasons: ["outer-envelope-unsupported"] });
assert.deepStrictEqual(inspectManifest(envelope, { ...binary, subsystemDigests: {} }), { decision: "read-only", reasons: ["subsystem-digest-unsupported"] });
assert.deepStrictEqual(inspectManifest(envelope, { ...binary, writerVersion: 2 }), { decision: "read-only", reasons: ["writer-range-unsupported"] });
assert.deepStrictEqual(inspectManifest(envelope, { ...binary, readerVersion: 1, writerVersion: 1 }), { decision: "upgrade-required", reasons: ["reader-too-old"] });
assert.deepStrictEqual(inspectManifest(envelope, { ...binary, readerVersion: 5, writerVersion: 5 }, "reverse-v2-v1"), { decision: "downgrade-transformable", reasons: ["explicit-lossless-reverse-path"] });
assert.deepStrictEqual(inspectManifest(envelope, { ...binary, readerVersion: 5, writerVersion: 5 }), { decision: "refuse", reasons: ["reader-range-unsupported"] });

errorCode(() => makeOperation({ operationId: " " }), "operation-invalid");
errorCode(() => makeOperation({ sourceManifestDigest: "" }), "operation-invalid");
errorCode(() => makeOperation({ targetManifestDigest: "" }), "operation-invalid");
errorCode(() => makeOperation({ storageEpoch: 0 }), "operation-invalid");
errorCode(() => makeOperation({ generation: 0 }), "operation-invalid");
errorCode(() => makeOperation({ direction: "downgrade" }), "downgrade-path-required");
errorCode(() => makeOperation({ direction: "downgrade", reversePathId: "missing", registeredLosslessReversePathIds: [] }), "downgrade-path-required");
const downgrade = makeOperation({ direction: "downgrade", reversePathId: "reverse-v2-v1", registeredLosslessReversePathIds: ["reverse-v2-v1"] });
assert.strictEqual(downgrade.direction, "downgrade");
errorCode(() => makeOperation({ keyIds: ["key-a"], credential: "forbidden" }), "secret-value-forbidden");

let operation = makeOperation();
assert.strictEqual(operation.phase, "planned");
assert.strictEqual(operation.receipts[0].previousPhase, undefined);
assert(Object.isFrozen(operation.receipts));
errorCode(() => acquireMigrationLease(operation, command(operation, "bad-owner"), { ownerProcessId: "", fencingToken: 1, now: 100, expiresAt: 200 }, adapters), "lease-invalid");
errorCode(() => acquireMigrationLease(operation, command(operation, "bad-expiry"), { ownerProcessId: "p", fencingToken: 1, now: 100, expiresAt: 100 }, adapters), "lease-invalid");
operation = lease(operation);
assert.strictEqual(operation.storageEpoch, 5);
assert.strictEqual(operation.lease.commandId, "lease");
errorCode(() => acquireMigrationLease(operation, command(operation, "lease-live"), { ownerProcessId: "p2", fencingToken: 2, now: 150, expiresAt: 250 }, adapters), "lease-active");
errorCode(() => acquireMigrationLease({ ...operation, lease: { ...operation.lease, expiresAt: 90 } }, command(operation, "lease-stale-token"), { ownerProcessId: "p2", fencingToken: 1, now: 100, expiresAt: 250 }, adapters), "lease-invalid");
const reacquiredBase = { ...operation, lease: { ...operation.lease, expiresAt: 90 } };
const reacquired = apply(acquireMigrationLease(reacquiredBase, command(reacquiredBase, "lease-new"), { ownerProcessId: "p2", fencingToken: 2, now: 100, expiresAt: 250 }, adapters));
assert.strictEqual(reacquired.lease.ownerProcessId, "p2");
errorCode(() => heartbeatMigrationLease(operation, command(operation, "heartbeat-expired"), 1, 250, 300, adapters), "migration-fenced");
errorCode(() => heartbeatMigrationLease(operation, command(operation, "heartbeat-short"), 1, 150, 150, adapters), "lease-invalid");
operation = apply(heartbeatMigrationLease(operation, command(operation, "heartbeat"), 1, 150, 300, adapters));
assert.strictEqual(operation.lease.heartbeatAt, 150);

const replayCommand = command(operation, "register-phase");
let phaseResult = transitionMigration(operation, replayCommand, "preflighting", "phase:preflight", 160, 1, adapters);
operation = phaseResult.operation;
assert.strictEqual(phaseResult.replayed, false);
const replay = transitionMigration(operation, replayCommand, "preflighting", "ignored", 160, 1, adapters);
assert.strictEqual(replay.replayed, true);
assert.strictEqual(replay.operation, operation);
errorCode(() => transitionMigration(operation, { ...replayCommand, fingerprint: "different", expectedVersion: operation.version }, "quiescing", "x", 160, 1, adapters), "command-conflict");
errorCode(() => transitionMigration(operation, { commandId: "stale", fingerprint: "stale", expectedVersion: 1 }, "quiescing", "x", 160, 1, adapters), "version-conflict");

operation = registerWriter(operation, { writerId: "writer-live", processFence: "p1", channelFence: "c1", leaseExpiresAt: 250, evicted: false });
operation = registerWriter(operation, { writerId: "writer-dead", processFence: "p2", channelFence: "c2", leaseExpiresAt: 100, evicted: false });
errorCode(() => registerWriter(operation, operation.writers[0]), "writer-conflict");
assert.deepStrictEqual(evaluateWriterQuiescence(operation, 170), ["writer-live"]);
errorCode(() => acknowledgeWriter(operation, "writer-live", 4), "storage-epoch-fenced");
errorCode(() => acknowledgeWriter(operation, "missing", operation.storageEpoch), "writer-unavailable");
operation = acknowledgeWriter(operation, "writer-live", operation.storageEpoch);
assert.deepStrictEqual(evaluateWriterQuiescence(operation, 170), []);
errorCode(() => evictExpiredWriter(operation, "missing", 200, true, true), "writer-unavailable");
errorCode(() => evictExpiredWriter(operation, "writer-live", 200, true, true), "writer-live");
errorCode(() => evictExpiredWriter(operation, "writer-dead", 200, false, true), "writer-live");
errorCode(() => evictExpiredWriter(operation, "writer-dead", 200, true, false), "writer-live");
operation = evictExpiredWriter(operation, "writer-dead", 200, true, true);
errorCode(() => acknowledgeWriter(operation, "writer-dead", operation.storageEpoch), "writer-unavailable");

const blockedFields = [
  "ownerIntent", "disk", "backupDestination", "keys", "integrity", "transitionPath", "runtimeCompatibility",
  "activeOperation", "activeEffects", "checkpoints", "activeWriters", "keyRotation"
];
for (const field of blockedFields) {
  const report = goodPreflight();
  report[field] = { status: "block", detail: field };
  errorCode(() => recordPreflight(operation, command(operation, `blocked-${field}`), report, 170, adapters), "preflight-blocked");
}
for (const reference of [
  { referenceId: "r", state: "bound", status: "block" },
  { referenceId: "r", state: "unresolved", status: "pass" },
  { referenceId: "r", state: "unavailable-provider", status: "pass" },
  { referenceId: "r", state: "requires-reauthorization", status: "pass" }
]) errorCode(() => recordPreflight(operation, command(operation, `ref-${reference.state}-${reference.status}`), { ...goodPreflight(), secretReferences: [reference] }, 170, adapters), "preflight-blocked");
errorCode(() => recordPreflight(operation, command(operation, "secret"), { ...goodPreflight(), secretReferences: [{ referenceId: "r", state: "bound", status: "pass", secretValue: "no" }] }, 170, adapters), "secret-value-forbidden");
const liveBlocked = registerWriter(operation, { writerId: "writer-new", processFence: "p", channelFence: "c", leaseExpiresAt: 250, evicted: false });
errorCode(() => recordPreflight(liveBlocked, command(liveBlocked, "live-writer"), goodPreflight(), 170, adapters), "preflight-blocked");
operation = apply(recordPreflight(operation, command(operation, "preflight-ok"), goodPreflight(), 170, adapters));
assert(Object.isFrozen(operation.preflight.secretReferences));
errorCode(() => advance(operation, "quiescing", "empty-cursor", " "), "cursor-required");
operation = advance(operation, "quiescing", "quiesce");
errorCode(() => advance(operation, "transforming", "skip"), "phase-transition-invalid");

const noPreflight = lease(makeOperation(), "np-lease");
const npPreflighting = advance(noPreflight, "preflighting", "np-phase");
errorCode(() => advance(npPreflighting, "quiescing", "np-quiesce"), "preflight-required");
errorCode(() => advance(operation, "backed-up", "no-backup"), "restore-point-required");
for (const change of [
  { contentDigest: "" }, { sourceManifestDigest: "other" }, { payloadClosureVerified: false },
  { referentialClosureVerified: false }, { purgeLedgerDigest: "" }, { purgeLedgerVerified: false },
  { resolvableKeyIds: [] }, { smokeProbePassed: false }
]) errorCode(() => recordRestorePoint(operation, command(operation, `restore-${Object.keys(change)[0]}`), { ...goodRestore(), ...change }, adapters), "restore-point-invalid");
errorCode(() => recordRestorePoint(operation, command(operation, "restore-secret"), { ...goodRestore(), token: "no" }, adapters), "secret-value-forbidden");
errorCode(() => recordRestorePoint(operation, command(operation, "restore-keys"), { ...goodRestore(), keyIds: ["key-b"], resolvableKeyIds: ["key-b"] }, adapters), "key-change-forbidden");
operation = apply(recordRestorePoint(operation, command(operation, "restore-ok"), goodRestore(), adapters));
operation = advance(operation, "backed-up", "backed-up");
operation = advance(operation, "transforming", "transforming");

const chunk = { chunkId: "chunk-1", sourceChecksum: "sha256:s1", targetChecksum: "sha256:t1", sourceCount: 2, targetCount: 2 };
for (const bad of [
  { ...chunk, chunkId: "" }, { ...chunk, sourceChecksum: "" }, { ...chunk, targetChecksum: "" },
  { ...chunk, sourceCount: -1 }, { ...chunk, sourceCount: 1.5 }, { ...chunk, targetCount: -1 }, { ...chunk, targetCount: 1.5 }
]) errorCode(() => recordTransformChunk(operation, command(operation, `bad-chunk-${JSON.stringify(bad)}`), bad, adapters), "chunk-invalid");
operation = apply(recordTransformChunk(operation, command(operation, "chunk-1"), chunk, adapters));
const replayedChunk = apply(recordTransformChunk(operation, command(operation, "chunk-1-again"), { ...chunk }, adapters));
assert.strictEqual(replayedChunk.chunks.length, 1);
errorCode(() => recordTransformChunk(operation, command(operation, "chunk-conflict"), { ...chunk, targetChecksum: "changed" }, adapters), "chunk-conflict");
operation = advance(operation, "validating", "validating");
errorCode(() => advance(operation, "commit-ready", "commit-ready-early"), "validation-required");
for (const field of Object.keys(goodValidation())) {
  errorCode(() => recordValidation(operation, command(operation, `validation-${field}`), { ...goodValidation(), [field]: "block" }, adapters), "validation-failed");
}
operation = apply(recordValidation(operation, command(operation, "validation-ok"), goodValidation(), adapters));
operation = advance(operation, "commit-ready", "commit-ready");

const noValidation = { ...operation, validation: undefined };
errorCode(() => commitMigration(noValidation, command(noValidation, "commit-no-validation"), 180, 1, adapters), "commit-not-ready");
errorCode(() => commitMigration({ ...operation, phase: "validating" }, command(operation, "commit-phase"), 180, 1, adapters), "commit-not-ready");
operation = apply(commitMigration(operation, command(operation, "commit"), 180, 1, adapters));
assert.deepStrictEqual(operation.commitBarrier, { generation: 3, storageEpoch: 6, manifestDigest: "sha256:target" });
assert.strictEqual(operation.lease.storageEpoch, operation.storageEpoch);
errorCode(() => transitionMigration(operation, command(operation, "post-rollback"), "rollback-required", "rollback", 180, 1, adapters), "rollback-forbidden");
operation = advance(operation, "rebuilding", "rebuilding", "phase:rebuilding", 180);
errorCode(() => recordRebuildItem({ ...operation, phase: "committed" }, command(operation, "rebuild-phase"), { itemId: "i", checksum: "c" }, adapters), "rebuild-phase-required");
errorCode(() => recordRebuildItem(operation, command(operation, "rebuild-id"), { itemId: "", checksum: "c" }, adapters), "rebuild-invalid");
errorCode(() => recordRebuildItem(operation, command(operation, "rebuild-checksum"), { itemId: "i", checksum: "" }, adapters), "rebuild-invalid");
operation = apply(recordRebuildItem(operation, command(operation, "rebuild-1"), { itemId: "index-1", checksum: "sha256:i1" }, adapters));
operation = apply(recordRebuildItem(operation, command(operation, "rebuild-1-again"), { itemId: "index-1", checksum: "sha256:i1" }, adapters));
assert.strictEqual(operation.rebuildItems.length, 1);
errorCode(() => recordRebuildItem(operation, command(operation, "rebuild-conflict"), { itemId: "index-1", checksum: "changed" }, adapters), "rebuild-conflict");
operation = advance(operation, "completed", "complete", "done", 180);
assert.strictEqual(operation.phase, "completed");
errorCode(() => advance(operation, "preflighting", "terminal"), "phase-transition-invalid");

let rollback = lease(makeOperation(), "rollback-lease");
rollback = advance(rollback, "preflighting", "rollback-preflight");
rollback = apply(recordPreflight(rollback, command(rollback, "rollback-report"), goodPreflight(), 120, adapters));
rollback = advance(rollback, "quiescing", "rollback-quiesce");
rollback = apply(recordRestorePoint(rollback, command(rollback, "rollback-backup"), goodRestore(), adapters));
rollback = advance(rollback, "rollback-required", "rollback-required");
rollback = advance(rollback, "rolled-back", "rolled-back");
assert.strictEqual(rollback.phase, "rolled-back");
let noRestoreRollback = lease(makeOperation(), "no-restore-lease");
noRestoreRollback = advance(noRestoreRollback, "rollback-required", "no-restore-required");
errorCode(() => advance(noRestoreRollback, "rolled-back", "no-restore-rolled"), "restore-point-required");
let repair = lease(makeOperation(), "repair-lease");
repair = advance(repair, "repair-required", "repair");
assert.strictEqual(repair.phase, "repair-required");

assert.strictEqual(chooseStartupRecovery(operation, ["sha256:target"], true), "completed");
assert.strictEqual(chooseStartupRecovery(operation, ["a", "b"], true), "repair-required");
assert.strictEqual(chooseStartupRecovery(operation, ["a"], false), "repair-required");
assert.strictEqual(chooseStartupRecovery({ ...operation, phase: "commit-ready" }, ["sha256:target"], true), "committed");
assert.strictEqual(chooseStartupRecovery({ ...operation, phase: "rebuilding" }, ["sha256:target", "sha256:target"], true), "completed");
assert.strictEqual(chooseStartupRecovery({ ...operation, phase: "repair-required" }, ["sha256:target"], true), "repair-required");

errorCode(() => authorizeNormalWrite(operation, operation.storageEpoch - 1), "storage-epoch-fenced");
errorCode(() => authorizeNormalWrite(operation, operation.storageEpoch), "storage-epoch-fenced");
authorizeNormalWrite({ ...operation, lease: undefined }, operation.storageEpoch);
errorCode(() => authorizeNormalWrite({ ...operation, lease: { ...operation.lease, expiresAt: operation.lease.heartbeatAt } }, operation.storageEpoch), "storage-epoch-fenced");

errorCode(() => createManualResumePlan(operation, " "), "operation-invalid");
errorCode(() => createManualResumePlan(operation, operation.operationId), "authority-reuse-forbidden");
const resume = createManualResumePlan(operation, "migration-2");
assert.strictEqual(resume.invalidatedAuthority, true);
assert.deepStrictEqual(resume.sourceReceiptDigests, operation.receipts.map(receipt => receipt.digest));
assert.deepStrictEqual(resume.preservedKeyIds, ["key-a"]);
assert(Object.isFrozen(resume));

errorCode(() => transitionMigration({ ...operation, lease: undefined }, command(operation, "no-lease"), "repair-required", "repair", 180, 1, adapters), "migration-fenced");
errorCode(() => transitionMigration({ ...operation, lease: { ...operation.lease, fencingToken: 2 } }, command(operation, "wrong-fence"), "repair-required", "repair", 180, 1, adapters), "migration-fenced");
errorCode(() => transitionMigration({ ...operation, lease: { ...operation.lease, storageEpoch: 1 } }, command(operation, "wrong-epoch"), "repair-required", "repair", 180, 1, adapters), "migration-fenced");
errorCode(() => transitionMigration({ ...operation, lease: { ...operation.lease, expiresAt: 180 } }, command(operation, "expired"), "repair-required", "repair", 180, 1, adapters), "migration-fenced");

console.log("workflow migration model test: compatibility, fencing, restore, migration, recovery, and downgrade contracts OK");