import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { legacyProjectInvocationSchema } from "./host-composition-legacy-project-contracts.js";
import { executeLegacyExtensionCommand, resumeLegacyExtensionCommand } from "./legacy-command-extension-runtime.js";
import { inspectLegacyExtensionPending, readLegacyExtensionPendingEnvelope } from "./legacy-command-extension-recovery.js";
import { LegacyExtensionJournalError } from "./legacy-command-extension-journal.js";

export interface NativeLegacyCommandPolicy {
  authorize(actor: Readonly<Actor>, workspaceId: string): boolean;
  projectThreadMoveGuard?(request: Readonly<{
    actor: Readonly<Actor>;
    workspaceId: string;
    threadId: string;
  }>): { linkedActiveRunIds: readonly string[]; audienceChanges: boolean } | undefined;
}

export function recoverNativeLegacyCommands(database: DatabaseSync, root: string, assertExclusive: () => void): void {
  const pending = readLegacyExtensionPendingEnvelope(database);
  if (!pending) return;
  assertExclusive();
  inspectLegacyExtensionPending(database, root, pending);
  assertExclusive();
  resumeLegacyExtensionCommand(database, root, pending, { assertExclusive }, new Date().toISOString());
}

export function dispatchNativeLegacyCommand(
  database: DatabaseSync, root: string, workspaceId: string, actor: Actor, input: unknown,
  policy: NativeLegacyCommandPolicy, assertExclusive: () => void,
) {
  const args = legacyProjectInvocationSchema.parse(input);
  assertExclusive();
  let allowed = false;
  try { allowed = policy.authorize(Object.freeze({ ...actor }), workspaceId) === true; } catch { /* Native denial is fail closed. */ }
  if (!allowed) throw new CoreError("ACCESS_DENIED", "Native legacy command policy denied this actor.");
  if (args.update) throw new CoreError("INVALID_ARGUMENT", "Extension commands do not accept Project update arguments.");
  const priorReceipt = database.prepare("SELECT 1 FROM receipts WHERE operation_id=?").get(args.operationId);
  if (!priorReceipt && args.command.operation === "thread-move") {
    const request = args.args as { threadId?: string; linkedActiveRunIds?: string[]; includedRunIds?: string[];
      audienceChanges?: boolean; audienceChangeConfirmed?: boolean } | undefined;
    if (!request?.threadId || !policy.projectThreadMoveGuard) {
      throw new CoreError("ACCESS_DENIED", "Thread movement requires an explicit native active-run and audience guard.");
    }
    let guard: ReturnType<NonNullable<NativeLegacyCommandPolicy["projectThreadMoveGuard"]>>;
    try { guard = policy.projectThreadMoveGuard(Object.freeze({
      actor: Object.freeze({ ...actor }), workspaceId, threadId: request.threadId,
    })); } catch { guard = undefined; }
    if (!guard || !Array.isArray(guard.linkedActiveRunIds) || guard.linkedActiveRunIds.some(id => typeof id !== "string")
      || new Set(guard.linkedActiveRunIds).size !== guard.linkedActiveRunIds.length || typeof guard.audienceChanges !== "boolean"
      || JSON.stringify([...guard.linkedActiveRunIds].sort()) !== JSON.stringify([...(request.linkedActiveRunIds ?? [])].sort())
      || (request.includedRunIds ?? []).some(id => !guard!.linkedActiveRunIds.includes(id))
      || new Set(request.includedRunIds ?? []).size !== (request.includedRunIds ?? []).length
      || request.audienceChanges !== guard.audienceChanges
      || guard.audienceChanges && request.audienceChangeConfirmed !== true) {
      throw new CoreError("ACCESS_DENIED", "Thread move omitted a native active-run or audience fence.");
    }
  }
  const globalFingerprint = createHash("sha256").update(JSON.stringify({ operation: "project.legacy.command", actorId: actor.id, args })).digest("hex");
  try {
    return executeLegacyExtensionCommand(database, root, {
      envelope: { workspaceId, operationId: args.operationId, actorId: actor.id, globalFingerprint, command: args.command },
      ...(args.args === undefined ? {} : { args: args.args }),
    }, { assertExclusive }, new Date().toISOString());
  } catch (error) {
    if (error instanceof LegacyExtensionJournalError) throw new CoreError(error.code, error.message,
      database.prepare("SELECT 1 FROM legacy_command_extension_intent").get() ? "unknown" : "not-committed");
    if (database.prepare("SELECT 1 FROM legacy_command_extension_intent").get()) {
      throw new CoreError("LEGACY_COMMAND_UNKNOWN", "Native command intent is durable; retry only the same operation after native reconciliation.", "unknown");
    }
    throw error;
  }
}
