import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { CoreError, type Actor } from "./contracts.js";
import { legacyRecipeTrashCommandSchema, type LegacyRecipeTrashEnvelope } from "./legacy-recipe-trash-contracts.js";
import {
  executeLegacyRecipeTrashCommand, inspectLegacyRecipeTrashPending, LegacyRecipeTrashError,
  readLegacyRecipeTrashPendingEnvelope, resumeLegacyRecipeTrashCommand, type LegacyRecipeTrashHost,
} from "./legacy-recipe-trash.js";
import { readLegacyProjectControl } from "./legacy-control-import.js";
import { canonicalJson } from "./domain/project-recipes-workflow-contracts.js";

export const recipeTrashInvocationSchema = z.strictObject({
  operationId: z.string().uuid(),
  command: legacyRecipeTrashCommandSchema,
});
export const recipeTrashDefinitions = [{
  id: "project.recipe.trash.command", readOnly: false,
  description: "Move or restore an original Recipe with exact bytes and original opaque command history. Requires an explicit native actor policy. No permanent deletion, host-key grant or generic Note trash substitution.",
  input: recipeTrashInvocationSchema,
  output: z.strictObject({ entityId: z.string(), storeVersion: z.number().int().safe().positive(), replayed: z.boolean() }),
}] as const;
export interface NativeRecipeTrashPolicy {
  authorize(actorId: string, operation: Parameters<LegacyRecipeTrashHost["authorize"]>[1]): boolean;
  recoveryActorId?: string;
}
const fingerprint = (value: Pick<LegacyRecipeTrashEnvelope, "workspaceId" | "operationId" | "actorId" | "command">,
  binding: { rootId: string; controlSha256: string }) =>
  createHash("sha256").update(canonicalJson({
    operation: "project.recipe.trash.command", workspaceId: value.workspaceId,
    actorId: value.actorId, args: { operationId: value.operationId, command: value.command },
    sourceControl: { rootId: binding.rootId, sha256: binding.controlSha256 },
  })).digest("hex");

export function createNativeRecipeTrashHost(
  database: DatabaseSync, workspaceId: string, policy: NativeRecipeTrashPolicy,
  assertExclusive: () => void,
): LegacyRecipeTrashHost {
  return {
    assertExclusive,
    receiptOperation: "project.recipe.trash.command",
    recoveryActorId: policy.recoveryActorId,
    authorize(actorId, operation) {
      try { return policy.authorize(actorId, operation) === true; } catch { return false; }
    },
    verifyCallerHostFingerprint(envelope, binding) {
      const main = database.prepare("PRAGMA database_list").all().find(row => row.name === "main");
      return !!main && resolve(dirname(String(main.file))) === resolve(binding.root)
        && envelope.workspaceId === workspaceId && envelope.callerHostFingerprint === fingerprint(envelope, binding);
    },
    assertOperationAvailable(operationId) {
      assertExclusive();
      const own = readLegacyRecipeTrashPendingEnvelope(database);
      if (own && own.operationId !== operationId) throw new CoreError("BUSY", "Another Recipe trash intent is pending.", "unknown");
      for (const table of ["pending_write", "pending_todo", "pending_asset", "pending_resource",
        "pending_document_lifecycle", "pending_project_mutation", "data_runtime_intents",
        "migration_runtime_intents", "legacy_command_extension_intent"]) {
        if (database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
          throw new CoreError("BUSY", "Another workspace intent must be reconciled before Recipe trash.", "unknown");
        }
      }
      if (database.prepare("SELECT 1 FROM remote_runtime_intents WHERE NOT (kind='remote.subscription.bundle' AND state='complete') LIMIT 1").get()
        || database.prepare("SELECT 1 FROM coding_worker_effects WHERE state='intent' LIMIT 1").get()
        || database.prepare("SELECT 1 FROM coding_worker_records WHERE kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent' LIMIT 1").get()) {
        throw new CoreError("BUSY", "Unresolved native effects fence Recipe trash.", "unknown");
      }
    },
  };
}

export function recoverNativeRecipeTrash(
  database: DatabaseSync, root: string, host: LegacyRecipeTrashHost | undefined,
  transaction: <T>(work: () => T) => T,
): void {
  const envelope = readLegacyRecipeTrashPendingEnvelope(database);
  if (!envelope) return;
  if (!host || host.recoveryActorId !== envelope.actorId) {
    throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Pending Recipe trash requires its explicitly configured native recovery actor.", "unknown");
  }
  inspectLegacyRecipeTrashPending(database, root, envelope, host);
  resumeLegacyRecipeTrashCommand(database, root, envelope, host, transaction);
}

export function dispatchNativeRecipeTrash(
  database: DatabaseSync, root: string, workspaceId: string, actor: Actor, input: unknown,
  host: LegacyRecipeTrashHost, transaction: <T>(work: () => T) => T,
) {
  const args = recipeTrashInvocationSchema.parse(input);
  const body = { workspaceId, operationId: args.operationId, actorId: actor.id, command: args.command };
  host.assertExclusive();
  if (!host.authorize(actor.id, args.command.operation)) throw new CoreError("ACCESS_DENIED", "Native Recipe trash policy denied this actor.");
  const admittedControl = readLegacyProjectControl(database, workspaceId);
  if (!admittedControl) throw new CoreError("LEGACY_CONTROL_MISSING", "Recipe trash requires imported original Project control.");
  const envelope = { ...body, callerHostFingerprint: fingerprint(body, admittedControl) };
  const intent = readLegacyRecipeTrashPendingEnvelope(database);
  if (intent && canonicalJson(intent) !== canonicalJson(envelope)) {
    throw new CoreError("CONFLICT", "A different Recipe trash envelope is pending; retain it for authorized reconciliation.", "unknown");
  }
  const prior = database.prepare("SELECT fingerprint,actor_id,operation,result FROM receipts WHERE operation_id=?").get(args.operationId);
  if (prior && (prior.fingerprint !== envelope.callerHostFingerprint || prior.actor_id !== actor.id
    || prior.operation !== "project.recipe.trash.command")) {
    throw new CoreError("CONFLICT", "Global operation ID belongs to another request or actor.");
  }
  if (prior) {
    if (intent) throw new CoreError("RECOVERY_CONFLICT", "Recipe trash has both an intent and a receipt; retain the contradictory journal.", "unknown");
    const result = JSON.parse(String(prior.result));
    const control = readLegacyProjectControl(database, workspaceId);
    if (!control || typeof result.entityId !== "string" || result.operationId !== args.operationId
      || result.operation !== args.command.operation) throw new CoreError("RECOVERY_CONFLICT", "Recipe receipt identity is invalid.", "unknown");
    return { entityId: result.entityId as string, storeVersion: control.storeVersion, replayed: true };
  }
  try {
    const result = intent
      ? resumeLegacyRecipeTrashCommand(database, root, envelope, host, transaction)
      : executeLegacyRecipeTrashCommand(database, root, envelope, host, transaction);
    if (result.replayed) {
      const admitted = readLegacyProjectControl(database, workspaceId);
      host.assertOperationAvailable(args.operationId);
      transaction(() => {
        host.assertExclusive();
        const current = readLegacyProjectControl(database, workspaceId);
        if (!admitted || !current || JSON.stringify(current) !== JSON.stringify(admitted)
          || !current.receipts.some(receipt => receipt.commandId === args.command.commandId
            && receipt.fingerprint === args.command.fingerprint)) {
          throw new CoreError("CONFLICT", "Original Recipe receipt changed before global replay admission.");
        }
        database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(args.operationId,
          envelope.callerHostFingerprint, JSON.stringify({ ...result, operationId: args.operationId,
            operation: args.command.operation }), actor.id, "project.recipe.trash.command", new Date().toISOString());
      });
    }
    return result;
  } catch (error) {
    const pending = !!readLegacyRecipeTrashPendingEnvelope(database);
    if (error instanceof LegacyRecipeTrashError) throw new CoreError(error.code, error.message, pending ? "unknown" : "not-committed");
    if (pending) throw new CoreError("RECIPE_TRASH_UNKNOWN", "Recipe trash intent is durable; retain the journal and retry only the identical operation after authorized recovery.", "unknown");
    throw error;
  }
}
