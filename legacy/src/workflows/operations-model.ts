import { createHash } from "crypto";

export type ArchiveLifecycle = "active" | "archiving-draining" | "archived" | "trashed" | "purged";
export type SystemEntityKind = "default-project" | "general-thread";
export type ImpactKind =
  | "queued"
  | "checkpointable-leased"
  | "noncheckpointable-leased"
  | "gate-blocked"
  | "child-subflow"
  | "indeterminate";
export type ImpactDisposition =
  | "cancel-before-dispatch"
  | "checkpoint-and-pause"
  | "allow-finish"
  | "cancel-attempt"
  | "resolve-gate"
  | "archive-with-parent"
  | "quarantine-for-repair";

export interface OperationsCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  readonly expectedVersion: number;
}

export interface ArchiveCascadeCommand extends OperationsCommand {
  readonly expectedDescendantVersions: Readonly<Record<string, number>>;
}

export interface OperationsReceipt {
  readonly commandId: string;
  readonly fingerprint: string;
  readonly operation: string;
  readonly version: number;
}

export interface ImpactWork {
  readonly workId: string;
  readonly kind: ImpactKind;
}

export interface ImpactPreview {
  readonly entityId: string;
  readonly entityVersion: number;
  readonly previewId: string;
  readonly work: readonly ImpactWork[];
}

export interface DurableDisposition {
  readonly workId: string;
  readonly kind: ImpactKind;
  readonly disposition: ImpactDisposition;
}

export interface ArchiveBlockers {
  readonly effects: readonly string[];
  readonly gates: readonly string[];
  readonly usage: readonly string[];
  readonly migration: readonly string[];
  readonly threadDependencies: readonly string[];
  readonly resources: readonly string[];
}

export interface ArchiveEntity {
  readonly entityId: string;
  readonly aliases: readonly string[];
  readonly systemKind?: SystemEntityKind;
  readonly lifecycle: ArchiveLifecycle;
  readonly version: number;
  readonly paused: boolean;
  readonly explicitResumeRequired: boolean;
  readonly dispatchBlocked: boolean;
  readonly renewalBlocked: boolean;
  readonly reconciliationComplete: boolean;
  readonly dispositions: readonly DurableDisposition[];
  readonly drainedAttemptIds: readonly string[];
  readonly blockers: ArchiveBlockers;
  readonly tombstone?: Readonly<{ entityId: string; aliases: readonly string[]; purged: boolean }>;
  readonly receipts: readonly OperationsReceipt[];
}

export interface ArchiveMutation {
  readonly entity: ArchiveEntity;
  readonly receipt: OperationsReceipt;
  readonly replayed: boolean;
}

export interface ArchiveCascadeMutation {
  readonly parent: ArchiveEntity;
  readonly descendants: readonly ArchiveEntity[];
  readonly receipt: OperationsReceipt;
  readonly replayed: boolean;
}

export class WorkflowOperationsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowOperationsError";
  }
}

const DISPOSITIONS: Readonly<Record<ImpactKind, readonly ImpactDisposition[]>> = {
  "queued": ["cancel-before-dispatch"],
  "checkpointable-leased": ["checkpoint-and-pause", "allow-finish"],
  "noncheckpointable-leased": ["allow-finish", "cancel-attempt"],
  "gate-blocked": ["resolve-gate"],
  "child-subflow": ["archive-with-parent"],
  "indeterminate": ["quarantine-for-repair"]
};

export const EMPTY_ARCHIVE_BLOCKERS: ArchiveBlockers = deepFreeze({
  effects: [], gates: [], usage: [], migration: [], threadDependencies: [], resources: []
});

export function createArchiveEntity(input: Readonly<{ entityId: string; aliases?: readonly string[]; systemKind?: SystemEntityKind }>): ArchiveEntity {
  requireText(input.entityId, "entity-id");
  return deepFreeze({
    entityId: input.entityId,
    aliases: unique(input.aliases || []),
    ...(input.systemKind ? { systemKind: input.systemKind } : {}),
    lifecycle: "active",
    version: 1,
    paused: false,
    explicitResumeRequired: false,
    dispatchBlocked: false,
    renewalBlocked: false,
    reconciliationComplete: true,
    dispositions: [],
    drainedAttemptIds: [],
    blockers: EMPTY_ARCHIVE_BLOCKERS,
    receipts: []
  });
}

export function createImpactPreview(entity: ArchiveEntity, work: readonly ImpactWork[]): ImpactPreview {
  requireLifecycle(entity, "active");
  const normalized = [...work].map(item => {
    requireText(item.workId, "impact-work-id");
    return { workId: item.workId, kind: item.kind };
  }).sort((left, right) => left.workId.localeCompare(right.workId));
  if (new Set(normalized.map(item => item.workId)).size !== normalized.length) fail("impact-work-duplicate", "Impact work IDs must be unique.");
  const previewId = impactPreviewId(entity.entityId, entity.version, normalized);
  return deepFreeze({ entityId: entity.entityId, entityVersion: entity.version, previewId, work: normalized });
}

export function beginArchiveDrain(entity: ArchiveEntity, command: OperationsCommand, preview: ImpactPreview, dispositions: readonly DurableDisposition[]): ArchiveMutation {
  const replay = replayReceipt(entity.receipts, command);
  if (replay) return { entity, receipt: replay, replayed: true };
  checkCommand(entity, command);
  restrictSystemEntity(entity);
  requireLifecycle(entity, "active");
  if (preview.entityId !== entity.entityId || preview.entityVersion !== entity.version || preview.previewId !== impactPreviewId(preview.entityId, preview.entityVersion, preview.work)) {
    fail("impact-preview-stale", "Impact preview is not bound to this entity version.");
  }
  validateDispositions(preview, dispositions);
  const receipt = receiptFor(command, "archive-drain-begin", entity.version + 1);
  return mutation(entity, receipt, {
    lifecycle: "archiving-draining",
    paused: true,
    dispatchBlocked: true,
    renewalBlocked: true,
    reconciliationComplete: false,
    dispositions: [...dispositions]
  });
}

export function reconcileArchiveDrain(
  entity: ArchiveEntity,
  command: OperationsCommand,
  input: Readonly<{ drainedAttemptIds: readonly string[]; blockers: ArchiveBlockers }>
): ArchiveMutation {
  const replay = replayReceipt(entity.receipts, command);
  if (replay) return { entity, receipt: replay, replayed: true };
  checkCommand(entity, command);
  requireLifecycle(entity, "archiving-draining");
  const receipt = receiptFor(command, "archive-drain-reconcile", entity.version + 1);
  return mutation(entity, receipt, {
    reconciliationComplete: true,
    drainedAttemptIds: unique([...entity.drainedAttemptIds, ...input.drainedAttemptIds]),
    blockers: copyBlockers(input.blockers)
  });
}

export function abortArchiveDrain(entity: ArchiveEntity, command: OperationsCommand): ArchiveMutation {
  const replay = replayReceipt(entity.receipts, command);
  if (replay) return { entity, receipt: replay, replayed: true };
  checkCommand(entity, command);
  requireLifecycle(entity, "archiving-draining");
  if (!entity.reconciliationComplete) fail("drain-reconciliation-pending", "Archive abort must wait for drain reconciliation.");
  const receipt = receiptFor(command, "archive-drain-abort", entity.version + 1);
  return mutation(entity, receipt, {
    lifecycle: "active",
    paused: true,
    explicitResumeRequired: true,
    dispatchBlocked: false,
    renewalBlocked: false
  });
}

export function commitArchiveCascade(parent: ArchiveEntity, descendants: readonly ArchiveEntity[], command: ArchiveCascadeCommand): ArchiveCascadeMutation {
  const replay = replayReceipt(parent.receipts, command);
  if (replay) return { parent, descendants, receipt: replay, replayed: true };
  checkCommand(parent, command);
  const expectedIds = Object.keys(command.expectedDescendantVersions).sort();
  const descendantIds = descendants.map(entity => entity.entityId).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(descendantIds) || descendants.some(entity => command.expectedDescendantVersions[entity.entityId] !== entity.version)) {
    fail("cascade-version-conflict", "Expected descendant versions do not match the archive cascade.");
  }
  const all = [parent, ...descendants];
  all.forEach(entity => {
    restrictSystemEntity(entity);
    requireLifecycle(entity, "archiving-draining");
    if (!entity.reconciliationComplete) fail("drain-reconciliation-pending", "Every entity must finish drain reconciliation.");
    requireNoBlockers(entity.blockers);
  });
  const receipt = receiptFor(command, "archive-cascade-commit", parent.version + 1);
  const archive = (entity: ArchiveEntity, parentReceipt?: OperationsReceipt): ArchiveEntity => deepFreeze({
    ...entity,
    lifecycle: "archived",
    version: entity.version + 1,
    paused: true,
    dispatchBlocked: true,
    renewalBlocked: true,
    receipts: parentReceipt ? [...entity.receipts, parentReceipt] : entity.receipts
  });
  return { parent: archive(parent, receipt), descendants: descendants.map(entity => archive(entity)), receipt, replayed: false };
}

export function restoreArchiveEntity(entity: ArchiveEntity, command: OperationsCommand): ArchiveMutation {
  const replay = replayReceipt(entity.receipts, command);
  if (replay) return { entity, receipt: replay, replayed: true };
  checkCommand(entity, command);
  if (entity.lifecycle !== "archived" && entity.lifecycle !== "trashed") fail("restore-state", "Only archived or trashed entities can be restored.");
  const receipt = receiptFor(command, "archive-restore", entity.version + 1);
  return mutation(entity, receipt, {
    lifecycle: "active",
    paused: true,
    explicitResumeRequired: true,
    dispatchBlocked: false,
    renewalBlocked: false,
    tombstone: undefined
  });
}

export function resumeRestoredEntity(entity: ArchiveEntity, command: OperationsCommand): ArchiveMutation {
  const replay = replayReceipt(entity.receipts, command);
  if (replay) return { entity, receipt: replay, replayed: true };
  checkCommand(entity, command);
  requireLifecycle(entity, "active");
  if (!entity.explicitResumeRequired) fail("resume-not-required", "Entity does not require an explicit resume.");
  const receipt = receiptFor(command, "archive-resume", entity.version + 1);
  return mutation(entity, receipt, { paused: false, explicitResumeRequired: false });
}

export function trashArchiveEntity(entity: ArchiveEntity, command: OperationsCommand): ArchiveMutation {
  return terminalArchiveMutation(entity, command, "archived", "trashed", false);
}

export function purgeArchiveEntity(entity: ArchiveEntity, command: OperationsCommand): ArchiveMutation {
  return terminalArchiveMutation(entity, command, "trashed", "purged", true);
}

export function canDispatch(entity: ArchiveEntity): boolean {
  return !entity.dispatchBlocked;
}

export function canRenewLease(entity: ArchiveEntity): boolean {
  return !entity.renewalBlocked;
}

export type RepairCondition =
  | "thread-run-binding"
  | "default-project-conflict"
  | "migration"
  | "git-backup"
  | "preflight"
  | "unavailable-capability"
  | "archive-drain"
  | "indeterminate-effect"
  | "evidence-corruption-revocation"
  | "secret-cleanup-quarantine"
  | "stale-lease"
  | "budget-circuit-breaker";

export type RepairRole = "operator" | "project-admin" | "security-admin" | "system-admin";

export interface RepairDefinition {
  readonly condition: RepairCondition;
  readonly remediation: string;
  readonly roles: readonly RepairRole[];
  readonly route: string;
  readonly nonDestructive: true;
}

export const REPAIR_REGISTRY: Readonly<Record<RepairCondition, RepairDefinition>> = deepFreeze({
  "thread-run-binding": definition("thread-run-binding", "rebind-thread-run", ["project-admin"], "operations/bindings"),
  "default-project-conflict": definition("default-project-conflict", "select-canonical-default", ["system-admin"], "operations/projects"),
  "migration": definition("migration", "retry-or-mark-migration", ["operator", "project-admin"], "operations/migrations"),
  "git-backup": definition("git-backup", "retry-backup", ["operator"], "operations/backups"),
  "preflight": definition("preflight", "rerun-preflight", ["operator"], "operations/preflight"),
  "unavailable-capability": definition("unavailable-capability", "reassign-capability", ["operator", "project-admin"], "operations/capabilities"),
  "archive-drain": definition("archive-drain", "reconcile-archive-drain", ["operator", "project-admin"], "operations/archive"),
  "indeterminate-effect": definition("indeterminate-effect", "reconcile-effect", ["operator", "project-admin"], "operations/effects"),
  "evidence-corruption-revocation": definition("evidence-corruption-revocation", "revoke-or-rebuild-evidence", ["security-admin"], "operations/evidence"),
  "secret-cleanup-quarantine": definition("secret-cleanup-quarantine", "reconcile-secret-cleanup", ["security-admin"], "operations/secrets"),
  "stale-lease": definition("stale-lease", "expire-stale-lease", ["operator"], "operations/leases"),
  "budget-circuit-breaker": definition("budget-circuit-breaker", "reset-budget-circuit", ["project-admin"], "operations/budgets")
});

export interface RepairCase {
  readonly repairId: string;
  readonly condition: RepairCondition;
  readonly state: "blocked" | "remediated";
  readonly version: number;
  readonly receipts: readonly OperationsReceipt[];
}

export function createRepairCase(repairId: string, condition: RepairCondition): RepairCase {
  requireText(repairId, "repair-id");
  return deepFreeze({ repairId, condition, state: "blocked", version: 1, receipts: [] });
}

export function repairRoute(condition: RepairCondition): RepairDefinition {
  return REPAIR_REGISTRY[condition];
}

export function executeRepair(
  repair: RepairCase,
  command: OperationsCommand,
  input: Readonly<{ role: RepairRole; remediation: string; secretReconciled?: boolean }>
): Readonly<{ repair: RepairCase; receipt: OperationsReceipt; replayed: boolean }> {
  const replay = replayReceipt(repair.receipts, command);
  if (replay) return { repair, receipt: replay, replayed: true };
  checkCommand(repair, command);
  if (repair.state !== "blocked") fail("repair-closed", "Repair case is already remediated.");
  const route = REPAIR_REGISTRY[repair.condition];
  if (!route.roles.includes(input.role)) fail("repair-role", "Role is not authorized for this repair route.");
  if (input.remediation !== route.remediation) fail("repair-remediation", "Repair action is not the registered non-destructive remediation.");
  if (repair.condition === "secret-cleanup-quarantine" && input.secretReconciled !== true) fail("secret-reconciliation-required", "Secret cleanup requires explicit reconciliation.");
  const receipt = receiptFor(command, `repair:${repair.condition}`, repair.version + 1);
  return {
    repair: deepFreeze({ ...repair, state: "remediated", version: receipt.version, receipts: [...repair.receipts, receipt] }),
    receipt,
    replayed: false
  };
}

function terminalArchiveMutation(entity: ArchiveEntity, command: OperationsCommand, from: ArchiveLifecycle, to: "trashed" | "purged", purged: boolean): ArchiveMutation {
  const replay = replayReceipt(entity.receipts, command);
  if (replay) return { entity, receipt: replay, replayed: true };
  checkCommand(entity, command);
  restrictSystemEntity(entity);
  requireLifecycle(entity, from);
  requireNoBlockers(entity.blockers);
  const receipt = receiptFor(command, `archive-${to}`, entity.version + 1);
  return mutation(entity, receipt, { lifecycle: to, tombstone: { entityId: entity.entityId, aliases: entity.aliases, purged } });
}

function validateDispositions(preview: ImpactPreview, dispositions: readonly DurableDisposition[]): void {
  if (dispositions.length !== preview.work.length) fail("disposition-incomplete", "Every impact condition requires one durable disposition.");
  const byWork = new Map(dispositions.map(item => [item.workId, item]));
  if (byWork.size !== dispositions.length) fail("disposition-duplicate", "Each impact condition requires exactly one disposition.");
  preview.work.forEach(work => {
    const disposition = byWork.get(work.workId);
    if (!disposition || disposition.kind !== work.kind) fail("disposition-mismatch", "Disposition must match the previewed impact condition.");
    if (!DISPOSITIONS[work.kind].includes(disposition.disposition)) fail("disposition-invalid", "Disposition is not allowed for this impact condition.");
  });
}

function impactPreviewId(entityId: string, entityVersion: number, work: readonly ImpactWork[]): string {
  return createHash("sha256").update(JSON.stringify([entityId, entityVersion, work])).digest("hex");
}

function requireNoBlockers(blockers: ArchiveBlockers): void {
  const unresolved = Object.entries(blockers).filter(([, values]) => values.length).map(([kind]) => kind);
  if (unresolved.length) fail("archive-hard-blocker", `Unresolved archive blockers: ${unresolved.join(", ")}.`);
}

function copyBlockers(blockers: ArchiveBlockers): ArchiveBlockers {
  return deepFreeze({
    effects: [...blockers.effects], gates: [...blockers.gates], usage: [...blockers.usage], migration: [...blockers.migration],
    threadDependencies: [...blockers.threadDependencies], resources: [...blockers.resources]
  });
}

function mutation(entity: ArchiveEntity, receipt: OperationsReceipt, patch: Partial<ArchiveEntity>): ArchiveMutation {
  return {
    entity: deepFreeze({ ...entity, ...patch, version: receipt.version, receipts: [...entity.receipts, receipt] }),
    receipt,
    replayed: false
  };
}

function definition(condition: RepairCondition, remediation: string, roles: readonly RepairRole[], route: string): RepairDefinition {
  return { condition, remediation, roles, route, nonDestructive: true };
}

function checkCommand(entity: Readonly<{ version: number }>, command: OperationsCommand): void {
  requireText(command.commandId, "command-id");
  requireText(command.fingerprint, "command-fingerprint");
  if (command.expectedVersion !== entity.version) fail("version-conflict", "Expected entity version does not match.");
}

function replayReceipt(receipts: readonly OperationsReceipt[], command: OperationsCommand): OperationsReceipt | undefined {
  const prior = receipts.find(receipt => receipt.commandId === command.commandId);
  if (prior && prior.fingerprint !== command.fingerprint) fail("command-conflict", "Command ID was reused with another fingerprint.");
  return prior;
}

function receiptFor(command: OperationsCommand, operation: string, version: number): OperationsReceipt {
  return deepFreeze({ commandId: command.commandId, fingerprint: command.fingerprint, operation, version });
}

function restrictSystemEntity(entity: ArchiveEntity): void {
  if (entity.systemKind) fail("system-entity-restricted", "Default Project and General cannot be archived, trashed, or purged.");
}

function requireLifecycle(entity: ArchiveEntity, lifecycle: ArchiveLifecycle): void {
  if (entity.lifecycle !== lifecycle) fail("lifecycle-conflict", `Expected ${lifecycle} lifecycle.`);
}

function requireText(value: string, code: string): void {
  if (!value.trim()) fail(code, "A non-empty value is required.");
}

function unique(values: readonly string[]): readonly string[] {
  const result = [...new Set(values)];
  result.forEach(value => requireText(value, "identity"));
  return result.sort();
}

function fail(code: string, message: string): never {
  throw new WorkflowOperationsError(code, message);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}