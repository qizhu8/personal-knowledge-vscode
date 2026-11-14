import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";
import { legacyProjectDomainDigest, readLegacyProjectControl, type LegacyProjectDomain } from "./legacy-control-import.js";
import { legacyProjectCommandSchema, type LegacyProjectCommand } from "./legacy-project-command-contracts.js";
import { deserializeProjectMutationPlan, serializeProjectMutationPlan } from "./project-mutations.js";
import type { ProjectMutationPlan } from "./project-mutations-contracts.js";
import {
  serializeLegacyProjectThreadEffect, type LegacyProjectThreadEffect,
} from "./legacy-project-thread-parity.js";

/*
 * This is a journal primitive, not a registered capability. The host must first
 * replace its update-only startup inspection with an extension-aware inspector.
 * Filesystem reads, effect application, and after-state verification must happen
 * outside SQLite transactions while the host retains exclusive workspace ownership.
 */
export class LegacyExtensionJournalError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const legacyExtensionEnvelopeSchema = z.strictObject({
  workspaceId: z.string().uuid(),
  operationId: z.string().uuid(),
  actorId: z.string().min(1).max(500),
  globalFingerprint: digest,
  command: legacyProjectCommandSchema,
});
export type LegacyExtensionEnvelope = z.infer<typeof legacyExtensionEnvelopeSchema>;

const candidates: Readonly<Record<string, string>> = Object.freeze({
  "project-archive": "project.archive",
  "recipe-create": "project.recipe.create",
  "recipe-update": "project.recipe.update",
  "project-create": "project-create",
  "thread-create": "thread-create",
  "thread-rename": "thread-rename",
  "thread-move": "thread-move",
});
const threadOperations = new Set(["project-create", "thread-create", "thread-rename", "thread-move"]);

function fail(code: string, message: string): never { throw new LegacyExtensionJournalError(code, message); }
function inTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) fail("TRANSACTION_REQUIRED", "The host must hold an immediate SQLite transaction.");
}
function control(database: DatabaseSync, workspaceId: string) {
  return readLegacyProjectControl(database, workspaceId)
    ?? fail("LEGACY_CONTROL_MISSING", "Workspace has no imported original Project control.");
}

/** Receipt lookup precedes both operation recognition and store-version checking. */
export function checkLegacyExtensionCommand(database: DatabaseSync, workspaceId: string, input: LegacyProjectCommand) {
  const command = legacyProjectCommandSchema.parse(input);
  const current = control(database, workspaceId);
  const prior = current.receipts.find(value => value.commandId === command.commandId);
  if (prior) {
    if (prior.fingerprint !== command.fingerprint) fail("COMMAND_CONFLICT", "Command ID belongs to another fingerprint.");
    return { status: "replay" as const, entityId: prior.entityId, storeVersion: current.storeVersion };
  }
  if (!Object.hasOwn(candidates, command.operation)) fail("LEGACY_COMMAND_UNSUPPORTED", "Operation has no extension journal candidate.");
  if (current.storeVersion !== command.expectedStoreVersion) fail("STORE_VERSION_CONFLICT", "Project store version changed.");
  if (!Number.isSafeInteger(current.storeVersion + 1)) fail("STORE_VERSION_CONFLICT", "Project store version is exhausted.");
  return { status: "new" as const, storeVersion: current.storeVersion };
}

/**
 * Persist a fully planned candidate. The host must check every other pending
 * journal and verify the canonical before snapshot while exclusively owning
 * the workspace; this function deliberately does no filesystem I/O.
 */
export function stageLegacyExtensionIntent(database: DatabaseSync, value: LegacyExtensionEnvelope,
  nativePlan: ProjectMutationPlan, verifiedBeforeDigest: string): void {
  inTransaction(database);
  const envelope = legacyExtensionEnvelopeSchema.parse(value);
  const plan = deserializeProjectMutationPlan(nativePlan);
  digest.parse(verifiedBeforeDigest);
  const decision = checkLegacyExtensionCommand(database, envelope.workspaceId, envelope.command);
  if (decision.status !== "new") fail("COMMAND_ALREADY_RECORDED", "Replay must not stage another intent.");
  if (control(database, envelope.workspaceId).canonicalDigest !== verifiedBeforeDigest) {
    fail("CONTROL_RECOVERY_CONFLICT", "Verified Project before-state differs from its durable digest.");
  }
  if (plan.operation !== candidates[envelope.command.operation] || plan.workspaceId !== envelope.workspaceId
    || plan.actorId !== envelope.actorId || plan.operationId !== envelope.operationId) {
    fail("INVALID_PLAN", "Native plan identity does not match the command envelope.");
  }
  if (database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(envelope.operationId)) {
    fail("GLOBAL_OPERATION_CONFLICT", "Global operation ID is already recorded.");
  }
  if (database.prepare("SELECT 1 FROM pending_project_mutation LIMIT 1").get()) fail("BUSY", "A Project intent is pending.");
  database.prepare(`INSERT INTO pending_project_mutation
    (singleton,operation_id,fingerprint,actor_id,operation,plan,legacy_command) VALUES(1,?,?,?,?,?,?)`)
    .run(envelope.operationId, envelope.globalFingerprint, envelope.actorId, "project.legacy.command",
      serializeProjectMutationPlan(plan), canonicalJson(envelope.command));
}

export function stageLegacyProjectThreadIntent(database: DatabaseSync, value: LegacyExtensionEnvelope,
  effect: LegacyProjectThreadEffect, verifiedBeforeDigest: string): void {
  inTransaction(database);
  const envelope = legacyExtensionEnvelopeSchema.parse(value);
  const serialized = serializeLegacyProjectThreadEffect(effect);
  const parsed = JSON.parse(serialized) as LegacyProjectThreadEffect;
  digest.parse(verifiedBeforeDigest);
  if (!threadOperations.has(envelope.command.operation)
    || parsed.workspaceId !== envelope.workspaceId || parsed.actorId !== envelope.actorId
    || parsed.operationId !== envelope.operationId || parsed.operation !== envelope.command.operation
    || canonicalJson(parsed.command) !== canonicalJson(envelope.command)
    || parsed.expectedStoreVersion !== envelope.command.expectedStoreVersion) {
    fail("INVALID_PLAN", "Captured Project/Thread effect identity differs from its native command.");
  }
  const decision = checkLegacyExtensionCommand(database, envelope.workspaceId, envelope.command);
  if (decision.status !== "new") fail("COMMAND_ALREADY_RECORDED", "Replay must not stage another intent.");
  if (control(database, envelope.workspaceId).canonicalDigest !== verifiedBeforeDigest) {
    fail("CONTROL_RECOVERY_CONFLICT", "Verified Project before-state differs from its durable digest.");
  }
  if (database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(envelope.operationId)) {
    fail("GLOBAL_OPERATION_CONFLICT", "Global operation ID is already recorded.");
  }
  if (database.prepare("SELECT 1 FROM pending_project_mutation LIMIT 1").get()) fail("BUSY", "A Project intent is pending.");
  database.prepare(`INSERT INTO pending_project_mutation
    (singleton,operation_id,fingerprint,actor_id,operation,plan,legacy_command) VALUES(1,?,?,?,?,?,?)`)
    .run(envelope.operationId, envelope.globalFingerprint, envelope.actorId, "project.legacy.command",
      serialized, canonicalJson(envelope.command));
}

/**
 * Finalize only after the host has verified the exact committed after-state,
 * all guards and the full current canonical snapshot outside the transaction.
 * Global receipt, original receipt, version, digest and intent deletion commit together.
 */
export function finalizeLegacyExtensionIntent(database: DatabaseSync, value: LegacyExtensionEnvelope,
  verifiedSnapshot: LegacyProjectDomain, now: string): void {
  inTransaction(database);
  const envelope = legacyExtensionEnvelopeSchema.parse(value);
  z.string().datetime({ offset: true }).parse(now);
  const row = database.prepare(`SELECT operation_id,fingerprint,actor_id,operation,plan,legacy_command
    FROM pending_project_mutation WHERE singleton=1`).get() as Record<string, unknown> | undefined;
  if (!row || row.operation_id !== envelope.operationId || row.fingerprint !== envelope.globalFingerprint
    || row.actor_id !== envelope.actorId || row.operation !== "project.legacy.command"
    || row.legacy_command !== canonicalJson(envelope.command)) {
    fail("CONTROL_RECOVERY_CONFLICT", "Pending extension intent identity changed.");
  }
  let plan: ProjectMutationPlan | undefined;
  let threadEffect: LegacyProjectThreadEffect | undefined;
  if (threadOperations.has(envelope.command.operation)) {
    try { threadEffect = JSON.parse(serializeLegacyProjectThreadEffect(JSON.parse(String(row.plan)))) as LegacyProjectThreadEffect; }
    catch { fail("CONTROL_RECOVERY_CONFLICT", "Pending Project/Thread effect is malformed."); }
    if (threadEffect.operation !== envelope.command.operation || threadEffect.workspaceId !== envelope.workspaceId
      || threadEffect.actorId !== envelope.actorId || threadEffect.operationId !== envelope.operationId
      || JSON.stringify(threadEffect.command) !== canonicalJson(envelope.command)) {
      fail("CONTROL_RECOVERY_CONFLICT", "Pending Project/Thread effect identity changed.");
    }
  } else {
    plan = deserializeProjectMutationPlan(String(row.plan));
    if (plan.operation !== candidates[envelope.command.operation] || plan.workspaceId !== envelope.workspaceId
      || plan.actorId !== envelope.actorId || plan.operationId !== envelope.operationId) {
      fail("CONTROL_RECOVERY_CONFLICT", "Pending extension plan identity changed.");
    }
  }
  const decision = checkLegacyExtensionCommand(database, envelope.workspaceId, envelope.command);
  if (decision.status !== "new") fail("COMMAND_ALREADY_RECORDED", "Pending command was already recorded.");
  const current = control(database, envelope.workspaceId);
  if (verifiedSnapshot.rootId !== current.rootId || verifiedSnapshot.storeVersion !== current.storeVersion) {
    fail("CONTROL_RECOVERY_CONFLICT", "Verified snapshot does not match current Project control.");
  }
  const canonicalDigest = legacyProjectDomainDigest(verifiedSnapshot);
  const version = current.storeVersion + 1;
  const entityId = threadEffect?.entityId ?? plan!.result.entityId;
  const receipt = { commandId: envelope.command.commandId, fingerprint: envelope.command.fingerprint,
    operation: envelope.command.operation, storeVersion: version, entityId };
  const updated = database.prepare(`UPDATE legacy_project_control SET store_version=?,canonical_digest=?
    WHERE workspace_id=? AND store_version=? AND canonical_digest=?`)
    .run(version, canonicalDigest, envelope.workspaceId, current.storeVersion, current.canonicalDigest);
  if (updated.changes !== 1) fail("STORE_VERSION_CONFLICT", "Project control changed during finalization.");
  const receipts = [...current.receipts, receipt].slice(-256);
  database.prepare("DELETE FROM legacy_project_receipt WHERE workspace_id=?").run(envelope.workspaceId);
  const insert = database.prepare(`INSERT INTO legacy_project_receipt
    (workspace_id,ordinal,command_id,fingerprint,operation,store_version,entity_id) VALUES(?,?,?,?,?,?,?)`);
  receipts.forEach((item, index) => insert.run(envelope.workspaceId, index, item.commandId, item.fingerprint,
    item.operation, item.storeVersion, item.entityId));
  const result = { snapshot: { ...verifiedSnapshot, storeVersion: version }, entityId: receipt.entityId,
    replayed: false, storeVersion: version };
  database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(envelope.operationId, envelope.globalFingerprint,
    JSON.stringify(result), envelope.actorId, "project.legacy.command", now);
  database.prepare("DELETE FROM pending_project_mutation WHERE singleton=1").run();
}
