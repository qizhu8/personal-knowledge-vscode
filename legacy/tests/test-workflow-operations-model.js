#!/usr/bin/env node
const assert = require("assert");
const {
  EMPTY_ARCHIVE_BLOCKERS,
  REPAIR_REGISTRY,
  WorkflowOperationsError,
  abortArchiveDrain,
  beginArchiveDrain,
  canDispatch,
  canRenewLease,
  commitArchiveCascade,
  createArchiveEntity,
  createImpactPreview,
  createRepairCase,
  executeRepair,
  purgeArchiveEntity,
  reconcileArchiveDrain,
  repairRoute,
  restoreArchiveEntity,
  resumeRestoredEntity,
  trashArchiveEntity
} = require("../dist/workflows/operations-model.js");

const errorCode = (action, code) => assert.throws(action, error => error instanceof WorkflowOperationsError && error.code === code);
const command = (entity, commandId, fingerprint = `fp-${commandId}`) => ({ commandId, fingerprint, expectedVersion: entity.version });
const cascadeCommand = (entity, commandId, descendants = [], fingerprint) => ({
  ...command(entity, commandId, fingerprint),
  expectedDescendantVersions: Object.fromEntries(descendants.map(descendant => [descendant.entityId, descendant.version]))
});
const dispositionByKind = {
  queued: "cancel-before-dispatch",
  "checkpointable-leased": "checkpoint-and-pause",
  "noncheckpointable-leased": "cancel-attempt",
  "gate-blocked": "resolve-gate",
  "child-subflow": "archive-with-parent",
  indeterminate: "quarantine-for-repair"
};
const work = Object.keys(dispositionByKind).map((kind, index) => ({ workId: `work-${6 - index}`, kind }));
const dispositionsFor = preview => preview.work.map(item => ({ ...item, disposition: dispositionByKind[item.kind] }));
const reconcile = (entity, commandId, blockers = EMPTY_ARCHIVE_BLOCKERS, drainedAttemptIds = []) =>
  reconcileArchiveDrain(entity, command(entity, commandId), { blockers, drainedAttemptIds }).entity;
const drain = (entity, commandId, impact = work) => {
  const preview = createImpactPreview(entity, impact);
  return beginArchiveDrain(entity, command(entity, commandId), preview, dispositionsFor(preview)).entity;
};
const archive = (entity, prefix) => {
  const drained = reconcile(drain(entity, `${prefix}-begin`), `${prefix}-reconcile`);
  return commitArchiveCascade(drained, [], cascadeCommand(drained, `${prefix}-commit`)).parent;
};

errorCode(() => createArchiveEntity({ entityId: " " }), "entity-id");
errorCode(() => createArchiveEntity({ entityId: "entity-bad-alias", aliases: [" "] }), "identity");
let entity = createArchiveEntity({ entityId: "project-1", aliases: ["old-b", "old-a", "old-a"] });
assert.deepStrictEqual(entity.aliases, ["old-a", "old-b"]);
assert(Object.isFrozen(entity));
assert.strictEqual(canDispatch(entity), true);
assert.strictEqual(canRenewLease(entity), true);

errorCode(() => createImpactPreview(entity, [{ workId: " ", kind: "queued" }]), "impact-work-id");
errorCode(() => createImpactPreview(entity, [{ workId: "same", kind: "queued" }, { workId: "same", kind: "indeterminate" }]), "impact-work-duplicate");
const preview = createImpactPreview(entity, work);
assert.deepStrictEqual(preview.work.map(item => item.workId), ["work-1", "work-2", "work-3", "work-4", "work-5", "work-6"]);
assert(Object.isFrozen(preview.work));

errorCode(() => beginArchiveDrain(entity, { commandId: "", fingerprint: "fp", expectedVersion: 1 }, preview, dispositionsFor(preview)), "command-id");
errorCode(() => beginArchiveDrain(entity, { commandId: "cmd", fingerprint: "", expectedVersion: 1 }, preview, dispositionsFor(preview)), "command-fingerprint");
errorCode(() => beginArchiveDrain(entity, { commandId: "cmd", fingerprint: "fp", expectedVersion: 2 }, preview, dispositionsFor(preview)), "version-conflict");
errorCode(() => beginArchiveDrain(entity, command(entity, "stale-id"), { ...preview, entityId: "other" }, dispositionsFor(preview)), "impact-preview-stale");
errorCode(() => beginArchiveDrain(entity, command(entity, "stale-version"), { ...preview, entityVersion: 2 }, dispositionsFor(preview)), "impact-preview-stale");
errorCode(() => beginArchiveDrain(entity, command(entity, "forged-preview"), { ...preview, previewId: "forged" }, dispositionsFor(preview)), "impact-preview-stale");
errorCode(() => beginArchiveDrain(entity, command(entity, "short"), preview, dispositionsFor(preview).slice(1)), "disposition-incomplete");
const duplicateDispositions = dispositionsFor(preview);
duplicateDispositions[1] = { ...duplicateDispositions[1], workId: duplicateDispositions[0].workId };
errorCode(() => beginArchiveDrain(entity, command(entity, "duplicate"), preview, duplicateDispositions), "disposition-duplicate");
const mismatchDispositions = dispositionsFor(preview);
mismatchDispositions[0] = { ...mismatchDispositions[0], kind: "queued" };
errorCode(() => beginArchiveDrain(entity, command(entity, "mismatch"), preview, mismatchDispositions), "disposition-mismatch");
const invalidDispositions = dispositionsFor(preview);
invalidDispositions[0] = { ...invalidDispositions[0], disposition: "allow-finish" };
errorCode(() => beginArchiveDrain(entity, command(entity, "invalid"), preview, invalidDispositions), "disposition-invalid");

for (const systemKind of ["default-project", "general-thread"]) {
  const system = createArchiveEntity({ entityId: systemKind, systemKind });
  const systemPreview = createImpactPreview(system, []);
  errorCode(() => beginArchiveDrain(system, command(system, `system-${systemKind}`), systemPreview, []), "system-entity-restricted");
}

const beginCommand = command(entity, "begin");
const begun = beginArchiveDrain(entity, beginCommand, preview, dispositionsFor(preview));
entity = begun.entity;
assert.strictEqual(entity.lifecycle, "archiving-draining");
assert.strictEqual(entity.paused, true);
assert.strictEqual(canDispatch(entity), false);
assert.strictEqual(canRenewLease(entity), false);
assert.strictEqual(entity.dispositions.length, 6);
assert.strictEqual(beginArchiveDrain(entity, beginCommand, preview, dispositionsFor(preview)).replayed, true);
errorCode(() => beginArchiveDrain(entity, { ...beginCommand, fingerprint: "changed" }, preview, dispositionsFor(preview)), "command-conflict");
errorCode(() => createImpactPreview(entity, []), "lifecycle-conflict");
errorCode(() => abortArchiveDrain(entity, command(entity, "early-abort")), "drain-reconciliation-pending");
errorCode(() => reconcileArchiveDrain(createArchiveEntity({ entityId: "active-reconcile" }), { commandId: "x", fingerprint: "x", expectedVersion: 1 }, { blockers: EMPTY_ARCHIVE_BLOCKERS, drainedAttemptIds: [] }), "lifecycle-conflict");

const blockers = {
  effects: ["effect-1"], gates: ["gate-1"], usage: ["usage-1"], migration: ["migration-1"],
  threadDependencies: ["thread-1"], resources: ["resource-1"]
};
const reconcileCommand = command(entity, "reconcile");
const reconciledResult = reconcileArchiveDrain(entity, reconcileCommand, { blockers, drainedAttemptIds: ["attempt-b", "attempt-a", "attempt-a"] });
entity = reconciledResult.entity;
blockers.effects.push("mutated-after-command");
assert.deepStrictEqual(entity.blockers.effects, ["effect-1"]);
assert.deepStrictEqual(entity.drainedAttemptIds, ["attempt-a", "attempt-b"]);
assert.strictEqual(reconcileArchiveDrain(entity, reconcileCommand, { blockers: EMPTY_ARCHIVE_BLOCKERS, drainedAttemptIds: [] }).replayed, true);
errorCode(() => commitArchiveCascade(entity, [], cascadeCommand(entity, "blocked-commit")), "archive-hard-blocker");

const abortCommand = command(entity, "abort");
const abortedResult = abortArchiveDrain(entity, abortCommand);
const aborted = abortedResult.entity;
assert.strictEqual(aborted.lifecycle, "active");
assert.strictEqual(aborted.explicitResumeRequired, true);
assert.strictEqual(aborted.paused, true);
assert.deepStrictEqual(aborted.drainedAttemptIds, ["attempt-a", "attempt-b"]);
assert.strictEqual(aborted.dispositions.length, 6);
assert.strictEqual(abortArchiveDrain(aborted, abortCommand).replayed, true);
const resumedAbort = resumeRestoredEntity(aborted, command(aborted, "resume-abort")).entity;
assert.strictEqual(resumedAbort.paused, false);

let parent = reconcile(drain(createArchiveEntity({ entityId: "parent" }), "parent-begin"), "parent-reconcile", EMPTY_ARCHIVE_BLOCKERS, ["parent-attempt"]);
let child = reconcile(drain(createArchiveEntity({ entityId: "child" }), "child-begin", []), "child-reconcile");
let grandchild = reconcile(drain(createArchiveEntity({ entityId: "grandchild" }), "grandchild-begin", []), "grandchild-reconcile");
const unreconciled = drain(createArchiveEntity({ entityId: "unreconciled" }), "unreconciled-begin", []);
errorCode(() => commitArchiveCascade(parent, [unreconciled], cascadeCommand(parent, "pending-cascade", [unreconciled])), "drain-reconciliation-pending");
assert.strictEqual(parent.lifecycle, "archiving-draining");
assert.strictEqual(unreconciled.lifecycle, "archiving-draining");
const activeChild = createArchiveEntity({ entityId: "active-child" });
errorCode(() => commitArchiveCascade(parent, [activeChild], cascadeCommand(parent, "active-cascade", [activeChild])), "lifecycle-conflict");
const systemChild = reconcile(drain(createArchiveEntity({ entityId: "ordinary-system-prep" }), "system-prep-begin", []), "system-prep-reconcile");
const restrictedSystemChild = { ...systemChild, systemKind: "general-thread" };
errorCode(() => commitArchiveCascade(parent, [restrictedSystemChild], cascadeCommand(parent, "system-cascade", [restrictedSystemChild])), "system-entity-restricted");

errorCode(() => commitArchiveCascade(parent, [child], cascadeCommand(parent, "missing-descendant-cas")), "cascade-version-conflict");
errorCode(() => commitArchiveCascade(parent, [child], { ...cascadeCommand(parent, "stale-descendant-cas", [child]), expectedDescendantVersions: { child: child.version + 1 } }), "cascade-version-conflict");
const archiveCascadeCommand = cascadeCommand(parent, "cascade", [child, grandchild]);
const cascade = commitArchiveCascade(parent, [child, grandchild], archiveCascadeCommand);
parent = cascade.parent;
[parent, ...cascade.descendants].forEach(archived => {
  assert.strictEqual(archived.lifecycle, "archived");
  assert.strictEqual(archived.dispatchBlocked, true);
  assert.strictEqual(archived.renewalBlocked, true);
  assert.strictEqual(archived.dispositions.length, archived === parent ? 6 : 0);
});
assert.deepStrictEqual(parent.drainedAttemptIds, ["parent-attempt"]);
assert.strictEqual(commitArchiveCascade(parent, [child, grandchild], archiveCascadeCommand).replayed, true);

errorCode(() => resumeRestoredEntity(createArchiveEntity({ entityId: "not-paused" }), { commandId: "resume", fingerprint: "resume", expectedVersion: 1 }), "resume-not-required");
errorCode(() => restoreArchiveEntity(createArchiveEntity({ entityId: "not-archived" }), { commandId: "restore", fingerprint: "restore", expectedVersion: 1 }), "restore-state");
const restoreCommand = command(parent, "restore");
const restoredResult = restoreArchiveEntity(parent, restoreCommand);
let restored = restoredResult.entity;
assert.strictEqual(restored.entityId, "parent");
assert.deepStrictEqual(restored.aliases, []);
assert.strictEqual(restored.paused, true);
assert.strictEqual(restored.explicitResumeRequired, true);
assert.strictEqual(restoreArchiveEntity(restored, restoreCommand).replayed, true);
const resumeCommand = command(restored, "resume");
const resumedResult = resumeRestoredEntity(restored, resumeCommand);
restored = resumedResult.entity;
assert.strictEqual(restored.paused, false);
assert.strictEqual(restored.explicitResumeRequired, false);
assert.strictEqual(resumeRestoredEntity(restored, resumeCommand).replayed, true);

let terminal = archive(createArchiveEntity({ entityId: "terminal", aliases: ["legacy-terminal"] }), "terminal");
const blockedArchived = { ...terminal, blockers: { ...EMPTY_ARCHIVE_BLOCKERS, usage: ["run-1"] } };
errorCode(() => trashArchiveEntity(blockedArchived, command(blockedArchived, "blocked-trash")), "archive-hard-blocker");
const trashCommand = command(terminal, "trash");
const trashResult = trashArchiveEntity(terminal, trashCommand);
terminal = trashResult.entity;
assert.deepStrictEqual(terminal.tombstone, { entityId: "terminal", aliases: ["legacy-terminal"], purged: false });
assert.strictEqual(trashArchiveEntity(terminal, trashCommand).replayed, true);
errorCode(() => trashArchiveEntity(terminal, command(terminal, "trash-again")), "lifecycle-conflict");
const restoredTrash = restoreArchiveEntity(terminal, command(terminal, "restore-trash")).entity;
assert.strictEqual(restoredTrash.lifecycle, "active");
assert.strictEqual(restoredTrash.tombstone, undefined);

terminal = archive(createArchiveEntity({ entityId: "purge-target", aliases: ["reserved-alias"] }), "purge-target");
terminal = trashArchiveEntity(terminal, command(terminal, "trash-purge-target")).entity;
const blockedTrash = { ...terminal, blockers: { ...EMPTY_ARCHIVE_BLOCKERS, resources: ["blob-1"] } };
errorCode(() => purgeArchiveEntity(blockedTrash, command(blockedTrash, "blocked-purge")), "archive-hard-blocker");
const purgeCommand = command(terminal, "purge");
const purged = purgeArchiveEntity(terminal, purgeCommand).entity;
assert.strictEqual(purged.lifecycle, "purged");
assert.deepStrictEqual(purged.tombstone, { entityId: "purge-target", aliases: ["reserved-alias"], purged: true });
assert.strictEqual(purgeArchiveEntity(purged, purgeCommand).replayed, true);
errorCode(() => restoreArchiveEntity(purged, command(purged, "restore-purged")), "restore-state");

const archivedSystem = { ...archive(createArchiveEntity({ entityId: "system-trash-prep" }), "system-trash-prep"), systemKind: "default-project" };
errorCode(() => trashArchiveEntity(archivedSystem, command(archivedSystem, "system-trash")), "system-entity-restricted");
const trashedSystem = { ...terminal, systemKind: "general-thread" };
errorCode(() => purgeArchiveEntity(trashedSystem, command(trashedSystem, "system-purge")), "system-entity-restricted");

const conditions = Object.keys(REPAIR_REGISTRY);
assert.strictEqual(conditions.length, 12);
conditions.forEach((condition, index) => {
  const route = repairRoute(condition);
  assert.strictEqual(route.condition, condition);
  assert.strictEqual(route.nonDestructive, true);
  assert.match(route.route, /^operations\//);
  const repair = createRepairCase(`repair-${index}`, condition);
  const repairCommand = command(repair, `execute-${index}`);
  const result = executeRepair(repair, repairCommand, {
    role: route.roles[0],
    remediation: route.remediation,
    ...(condition === "secret-cleanup-quarantine" ? { secretReconciled: true } : {})
  });
  assert.strictEqual(result.repair.state, "remediated");
  assert.strictEqual(result.repair.version, 2);
  assert.strictEqual(executeRepair(result.repair, repairCommand, { role: route.roles[0], remediation: route.remediation }).replayed, true);
  errorCode(() => executeRepair(result.repair, command(result.repair, `closed-${index}`), { role: route.roles[0], remediation: route.remediation }), "repair-closed");
});

errorCode(() => createRepairCase(" ", "migration"), "repair-id");
const migrationRepair = createRepairCase("migration-repair", "migration");
const migrationRoute = repairRoute("migration");
errorCode(() => executeRepair(migrationRepair, { commandId: "bad-version", fingerprint: "bad-version", expectedVersion: 2 }, { role: "operator", remediation: migrationRoute.remediation }), "version-conflict");
errorCode(() => executeRepair(migrationRepair, command(migrationRepair, "bad-role"), { role: "security-admin", remediation: migrationRoute.remediation }), "repair-role");
errorCode(() => executeRepair(migrationRepair, command(migrationRepair, "bad-action"), { role: "operator", remediation: "delete-everything" }), "repair-remediation");
const migrationCommand = command(migrationRepair, "migration-ok");
const migratedRepair = executeRepair(migrationRepair, migrationCommand, { role: "project-admin", remediation: migrationRoute.remediation }).repair;
errorCode(() => executeRepair(migratedRepair, { ...migrationCommand, fingerprint: "changed" }, { role: "operator", remediation: migrationRoute.remediation }), "command-conflict");

const secretRepair = createRepairCase("secret-repair", "secret-cleanup-quarantine");
const secretRoute = repairRoute("secret-cleanup-quarantine");
errorCode(() => executeRepair(secretRepair, command(secretRepair, "secret-missing"), { role: "security-admin", remediation: secretRoute.remediation }), "secret-reconciliation-required");
errorCode(() => executeRepair(secretRepair, command(secretRepair, "secret-false"), { role: "security-admin", remediation: secretRoute.remediation, secretReconciled: false }), "secret-reconciliation-required");

console.log("workflow operations model test: archive/drain lifecycle and repair registry contracts OK");