import type { DatabaseSync } from "node:sqlite";
import { LegacyControlImportError, readLegacyProjectControl } from "./legacy-control-import.js";
import {
  LEGACY_PROJECT_COMMAND_OPERATIONS, legacyProjectCommandSchema, type LegacyProjectCommand,
} from "./legacy-project-command-contracts.js";

export { LEGACY_PROJECT_COMMAND_OPERATIONS, legacyProjectCommandSchema } from "./legacy-project-command-contracts.js";
export type { LegacyProjectCommand } from "./legacy-project-command-contracts.js";

export class LegacyProjectCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type LegacyProjectCommandCheck<TSnapshot> =
  | { status: "replay"; snapshot: TSnapshot; entityId: string; replayed: true }
  | { status: "new"; expectedStoreVersion: number; nextStoreVersion: number; replayed: false };

function commandError(code: string, message: string): never {
  throw new LegacyProjectCommandError(code, message);
}

export function checkLegacyProjectCommand<TSnapshot>(
  database: DatabaseSync,
  workspaceId: string,
  input: LegacyProjectCommand,
  currentSnapshot: TSnapshot,
): LegacyProjectCommandCheck<TSnapshot> {
  const command = legacyProjectCommandSchema.parse(input);
  let control;
  try { control = readLegacyProjectControl(database, workspaceId); }
  catch (error) {
    if (error instanceof LegacyControlImportError) commandError(error.code, error.message);
    throw error;
  }
  if (!control) commandError("LEGACY_CONTROL_MISSING", "Workspace has no imported original Project control.");
  const prior = control.receipts.find(receipt => receipt.commandId === command.commandId);
  if (prior) {
    if (prior.fingerprint !== command.fingerprint) {
      commandError("COMMAND_CONFLICT", "Command ID was already used with a different fingerprint.");
    }
    return { status: "replay", snapshot: currentSnapshot, entityId: prior.entityId, replayed: true };
  }
  if (!(LEGACY_PROJECT_COMMAND_OPERATIONS as readonly string[]).includes(command.operation)) {
    commandError("LEGACY_COMMAND_UNSUPPORTED", `Legacy Project operation is not supported: ${command.operation}`);
  }
  if (command.expectedStoreVersion !== control.storeVersion) {
    commandError("STORE_VERSION_CONFLICT", "Expected Project store version does not match the current version.");
  }
  return {
    status: "new",
    expectedStoreVersion: control.storeVersion,
    nextStoreVersion: control.storeVersion + 1,
    replayed: false,
  };
}

export interface LegacyProjectCommandCommit {
  entityId: string;
  canonicalDigest: string;
}

export function recordLegacyProjectCommand(
  database: DatabaseSync,
  workspaceId: string,
  input: LegacyProjectCommand,
  result: LegacyProjectCommandCommit,
): number {
  if (!database.isTransaction) {
    throw new LegacyProjectCommandError("TRANSACTION_REQUIRED", "Project version and original receipt must be committed in one SQLite transaction.");
  }
  const command = legacyProjectCommandSchema.parse(input);
  if (!(LEGACY_PROJECT_COMMAND_OPERATIONS as readonly string[]).includes(command.operation)) {
    commandError("LEGACY_COMMAND_UNSUPPORTED", `Legacy Project operation is not supported: ${command.operation}`);
  }
  if (!/^[a-f0-9]{64}$/.test(result.canonicalDigest) || !result.entityId) {
    commandError("INVALID_RESULT", "Legacy Project command result is invalid.");
  }
  const control = readLegacyProjectControl(database, workspaceId);
  if (!control) commandError("LEGACY_CONTROL_MISSING", "Workspace has no imported original Project control.");
  if (control.receipts.some(receipt => receipt.commandId === command.commandId)) {
    commandError("COMMAND_ALREADY_RECORDED", "Project command receipt already exists; replay must be checked before applying a mutation.");
  }
  if (command.expectedStoreVersion !== control.storeVersion) {
    commandError("STORE_VERSION_CONFLICT", "Expected Project store version does not match the current version.");
  }
  const nextVersion = control.storeVersion + 1;
  const receipts = [...control.receipts, {
    commandId: command.commandId,
    fingerprint: command.fingerprint,
    operation: command.operation,
    storeVersion: nextVersion,
    entityId: result.entityId,
  }].slice(-256);
  database.prepare(`UPDATE legacy_project_control SET store_version=?,canonical_digest=?
    WHERE workspace_id=? AND store_version=?`)
    .run(nextVersion, result.canonicalDigest, workspaceId, control.storeVersion);
  const changed = database.prepare("SELECT changes() AS count").get() as { count: number };
  if (changed.count !== 1) commandError("STORE_VERSION_CONFLICT", "Project control changed before its command receipt could commit.");
  database.prepare("DELETE FROM legacy_project_receipt WHERE workspace_id=?").run(workspaceId);
  const insertReceipt = database.prepare(`INSERT INTO legacy_project_receipt
    (workspace_id,ordinal,command_id,fingerprint,operation,store_version,entity_id)
    VALUES(?,?,?,?,?,?,?)`);
  receipts.forEach((receipt, ordinal) => insertReceipt.run(
    workspaceId, ordinal, receipt.commandId, receipt.fingerprint, receipt.operation, receipt.storeVersion, receipt.entityId));
  return nextVersion;
}
