import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import { readLegacyStateReceipt } from "./host-composition-legacy-state.js";
import {
  createLegacySnapshotRestore, LegacySnapshotRestoreError,
  validateLegacySnapshotRestoreStaging,
  type LegacySnapshotRestoreBinding, type LegacySnapshotRestoreHost,
} from "./legacy-snapshot-restore.js";
import { legacySnapshotRestoreDefinitions } from "./legacy-snapshot-restore-contracts.js";
import { inspectLegacyInlineNoteFence } from "./legacy-inline-note-journal.js";
import { remoteRuntimePending } from "./remote-runtime.js";
import { assertPortalRecoveryClear } from "./host-composition-portal.js";

export const snapshotRestoreOperations = new Set<string>(legacySnapshotRestoreDefinitions.map(item => item.id));
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export interface NativePausedSnapshotPolicy {
  readonly receiptSha256: string;
  bindingForActor(actor: Readonly<Actor>, receiptId: string): LegacySnapshotRestoreBinding | undefined;
  epoch: LegacySnapshotRestoreHost["epoch"];
  key: LegacySnapshotRestoreHost["key"];
  approve: LegacySnapshotRestoreHost["approve"];
  validateSafeState: LegacySnapshotRestoreHost["validateSafeState"];
  /** I/O-free live native human approval/revocation and exact target ownership fence. */
  assertBinding: LegacySnapshotRestoreHost["assertBinding"];
  control?: LegacySnapshotRestoreHost["control"];
}

export function assertSharedSourceRecoveryScope(database: DatabaseSync, allowInline = false, allowSkill = false, allowSkillSource = false): void {
  assertPortalRecoveryClear(database);
  if (remoteRuntimePending(database)) throw new CoreError("RECOVERY_CONFLICT", "Remote effects must be reconciled first.", "unknown");
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  for (const table of tables) {
    const name = String(table.name);
    if (!/^(?:pending_|legacy_.*_intent$)|_intents$/.test(name) || name === "remote_runtime_intents"
      || (name === "legacy_inline_note_intent" && allowInline)
      || (name === "legacy_skill_native_intent" && allowSkill)
      || (name === "legacy_skill_source_native_intent" && allowSkillSource)) continue;
    if (database.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get())
      throw new CoreError("RECOVERY_CONFLICT", "Another workspace journal must be reconciled before shared-source effects.", "unknown");
  }
  if (database.prepare("SELECT 1 FROM coding_worker_effects WHERE state='intent'").get()
    || database.prepare("SELECT 1 FROM coding_worker_records WHERE kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent'").get())
    throw new CoreError("RECOVERY_CONFLICT", "Coding effects must be reconciled before shared-source effects.", "unknown");
}

export function inspectPausedSnapshotJournal(database: DatabaseSync): number {
  if (database.prepare("SELECT version FROM legacy_snapshot_restore_schema WHERE singleton=1").get()?.version !== 1)
    throw new CoreError("RECOVERY_CONFLICT", "Paused Snapshot schema is invalid.", "unknown");
  const originals = database.prepare(`SELECT o.*,r.record FROM legacy_snapshot_restore_originals o
    LEFT JOIN legacy_snapshot_restore_records r USING(actor_id,owner_id,restore_id)`).all();
  if (database.prepare("SELECT COUNT(*) n FROM legacy_snapshot_restore_records").get()?.n !== originals.length)
    throw new CoreError("RECOVERY_CONFLICT", "Snapshot records are disconnected.", "unknown");
  let unknown = 0;
  const effectIds = new Set<string>();
  try {
    for (const row of originals) {
      const binding = JSON.parse(String(row.binding));
      const record = legacySnapshotRestoreDefinitions[0].output.parse(JSON.parse(String(row.record)));
      if (hash(JSON.stringify(binding)) !== row.restore_id || hash(row.original as Uint8Array) !== row.cipher_hash
        || binding.cipherSha256 !== row.cipher_hash || binding.actorId !== row.actor_id
        || binding.nativeOwnerId !== row.owner_id || binding.targetWorkspaceId !== row.workspace_id
        || binding.snapshotId !== row.snapshot_id || record.restoreId !== row.restore_id
        || record.sessionId !== binding.targetSessionId || record.chatId !== binding.targetChatId) throw new Error();
      const imported = readLegacyStateReceipt(database, binding.targetWorkspaceId);
      if (!imported || !imported.plan.statePlan || imported.outcome.receipt.receiptSha256 !== binding.snapshotReceiptId
        || imported.plan.fingerprint !== binding.sourceIdentity || imported.plan.statePlan.keyEpoch !== binding.keyEpoch
        || !imported.plan.statePlan.entries.some(entry => entry.sha256 === row.cipher_hash
          && entry.destination === `agent-snapshot-reads/.pkm/state/agent-snapshots/${binding.snapshotId}.json`)) throw new Error();
      const staging: Record<string, unknown> = {};
      const rows = database.prepare(`SELECT kind,record,sha256 FROM legacy_snapshot_restore_staging
        WHERE actor_id=? AND owner_id=? AND restore_id=? ORDER BY kind`).all(row.actor_id!, row.owner_id!, row.restore_id!);
      if (rows.length !== 5 || rows.map(item => item.kind).join(",") !== "checkpoints,history,recipes,task,transcript") throw new Error();
      for (const item of rows) {
        if (hash(String(item.record)) !== item.sha256) throw new Error();
        staging[String(item.kind)] = JSON.parse(String(item.record));
      }
      if (hash(JSON.stringify({ binding, staging })) !== record.planSha256) throw new Error();
      validateLegacySnapshotRestoreStaging(binding, String(row.restore_id), staging);
      const effects = database.prepare(`SELECT * FROM legacy_snapshot_restore_effects
        WHERE actor_id=? AND owner_id=? AND restore_id=?`).all(row.actor_id!, row.owner_id!, row.restore_id!);
      let pending = 0;
      for (const effect of effects) {
        if (!["resume", "cancel"].includes(String(effect.kind)) || !["unknown", "confirmed"].includes(String(effect.state))) throw new Error();
        const receipts = database.prepare(`SELECT op_id,record FROM legacy_snapshot_restore_receipts
          WHERE actor_id=? AND owner_id=?`).all(row.actor_id!, row.owner_id!);
        if (!receipts.some(receipt => JSON.parse(String(receipt.record)).restoreId === record.restoreId
          && hash(JSON.stringify([binding, effect.kind, receipt.op_id])) === effect.effect_id)) throw new Error();
        effectIds.add(String(effect.effect_id));
        if (effect.state === "unknown") pending++;
      }
      if ((record.state === "resume-unknown" && (pending !== 1 || effects.filter(effect => effect.state === "unknown")[0]?.kind !== "resume"))
        || (record.state === "cancel-unknown" && (pending < 1 || pending > 2 || effects.filter(effect => effect.state === "unknown" && effect.kind === "cancel").length !== 1))
        || (!record.state.endsWith("-unknown") && pending !== 0)) throw new Error();
      unknown += pending;
      if (!database.prepare("SELECT 1 FROM chat_sessions WHERE actor_id=? AND id=?")
        .get(row.actor_id!, binding.targetChatId)) throw new Error();
    }
    if (Number(database.prepare("SELECT COUNT(*) n FROM legacy_snapshot_restore_staging").get()?.n) !== originals.length * 5
      || Number(database.prepare("SELECT COUNT(*) n FROM legacy_snapshot_restore_effects").get()?.n) !== effectIds.size) throw new Error();
    for (const receipt of database.prepare("SELECT * FROM legacy_snapshot_restore_receipts").all()) {
      const record = legacySnapshotRestoreDefinitions[0].output.parse(JSON.parse(String(receipt.record)));
      if (!originals.some(row => row.actor_id === receipt.actor_id && row.owner_id === receipt.owner_id && row.restore_id === record.restoreId)) throw new Error();
      const global = database.prepare("SELECT actor_id,fingerprint,operation FROM receipts WHERE operation_id=?").get(receipt.op_id!);
      if (!global || global.actor_id !== receipt.actor_id || global.fingerprint !== receipt.fingerprint
        || !snapshotRestoreOperations.has(String(global.operation))) throw new Error();
    }
  } catch { throw new CoreError("RECOVERY_CONFLICT", "Paused Snapshot state/journal is inconsistent; no native effects replayed.", "unknown"); }
  return unknown;
}

export function createNativePausedSnapshotComposition(
  storage: Storage, database: DatabaseSync, workspaceId: string, policy: NativePausedSnapshotPolicy,
  assertOwner: () => void, assertAvailable: (operationId: string) => void,
) {
  if (!/^[a-f0-9]{64}$/.test(policy.receiptSha256)
    || ["bindingForActor", "epoch", "key", "approve", "validateSafeState", "assertBinding"].some(key =>
      typeof policy[key as keyof NativePausedSnapshotPolicy] !== "function"))
    throw new CoreError("INVALID_CONFIGURATION", "Paused restore requires explicit native receipt, target, key, safe-state and human authorities.");
  const tokens = new WeakMap<object, { actor: Actor; binding: LegacySnapshotRestoreBinding }>();
  let dispatchedOperation: string | undefined;
  database.function("legacy_snapshot_operation", () => {
    if (!dispatchedOperation || !snapshotRestoreOperations.has(dispatchedOperation))
      throw new CoreError("ACCESS_DENIED", "Snapshot receipts require a current trusted native dispatch scope.");
    return dispatchedOperation;
  });
  function fence(binding: Readonly<LegacySnapshotRestoreBinding>) {
    assertOwner();
    const receipt = readLegacyStateReceipt(database, workspaceId);
    if (!receipt || receipt.outcome.receipt.receiptSha256 !== policy.receiptSha256
      || binding.snapshotReceiptId !== policy.receiptSha256 || binding.sourceIdentity !== receipt.plan.fingerprint
      || binding.targetWorkspaceId !== workspaceId || binding.keyEpoch !== receipt.plan.statePlan?.keyEpoch
      || !receipt.plan.statePlan.entries.some(entry => entry.sha256 === binding.cipherSha256
        && entry.destination === `agent-snapshot-reads/.pkm/state/agent-snapshots/${binding.snapshotId}.json`))
      throw new CoreError("IMPORT_RECEIPT_INVALID", "Paused Snapshot authority differs from its imported ciphertext receipt.");
    policy.assertBinding(binding);
  }
  const runtime = createLegacySnapshotRestore(database, {
    assertOwner,
    host: {
      resolveOwner: token => {
        const issued = tokens.get(token);
        return issued ? { actorId: issued.actor.id, nativeOwnerId: issued.binding.nativeOwnerId } : undefined;
      },
      async loadImportedSnapshot(owner, receiptId) {
        const issued = [...active].find(token => {
          const value = tokens.get(token)!;
          return value.actor.id === owner.actorId && value.binding.nativeOwnerId === owner.nativeOwnerId
            && value.binding.snapshotReceiptId === receiptId;
        });
        if (!issued) throw new CoreError("ACCESS_DENIED", "No issued native Snapshot authority.");
        const binding = tokens.get(issued)!.binding;
        fence(binding);
        const full = join(storage.workspaceRoot(), "agent-snapshot-reads/.pkm/state/agent-snapshots", `${binding.snapshotId}.json`);
        if (await realpath(full) !== full) throw new CoreError("SOURCE_TAMPERED", "Imported Snapshot path changed.");
        const before = await lstat(full);
        const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.nlink !== 1 || opened.size > 2 * 1024 * 1024
            || before.ino !== opened.ino || before.dev !== opened.dev) throw new CoreError("SOURCE_TAMPERED", "Imported Snapshot identity changed.");
          const bytes = await handle.readFile(), after = await lstat(full);
          if (hash(bytes) !== binding.cipherSha256 || after.ino !== opened.ino || after.dev !== opened.dev
            || after.size !== opened.size || after.isSymbolicLink()) throw new CoreError("SOURCE_TAMPERED", "Imported Snapshot bytes changed.");
          fence(binding);
          return { binding, bytes };
        } finally { await handle.close(); }
      },
      epoch: () => policy.epoch(), key: (algorithm, epoch) => policy.key(algorithm, epoch),
      approve: (binding, action) => policy.approve(binding, action),
      validateSafeState: (binding, payload) => policy.validateSafeState(binding, payload),
      assertBinding: fence, control: policy.control,
    },
  });
  const active = new Set<object>();
  return {
    available(actor?: Readonly<Actor>) {
      if (!actor) return true;
      try { return policy.bindingForActor(actor, policy.receiptSha256)?.actorId === actor.id; } catch { return false; }
    },
    async dispatch(operation: string, args: Record<string, unknown>, actor: Actor) {
      return storage.withWorkspaceExclusive(async () => {
        const binding = policy.bindingForActor(Object.freeze({ ...actor }), policy.receiptSha256);
        if (!binding || binding.actorId !== actor.id) throw new CoreError("ACCESS_DENIED", "Explicit trusted native Snapshot target authority required.");
        fence(binding);
        const unknown = inspectPausedSnapshotJournal(database);
        if (inspectLegacyInlineNoteFence(database)) throw new CoreError("RECOVERY_REQUIRED", "Inline Note recovery must finish first.", "unknown");
        const reconciliation = ["agent.snapshot.confirm-native", "agent.snapshot.cancel-native", "agent.snapshot.restore-get"].includes(operation);
        if (!reconciliation || !unknown) assertAvailable(String(args.opId ?? "snapshot-read"));
        else {
          assertSharedSourceRecoveryScope(database);
          // Reconciliation is scoped to the recorded actor-owned target; it never admits another effect.
          const owned = database.prepare(`SELECT 1 FROM legacy_snapshot_restore_effects
            WHERE actor_id=? AND owner_id=? AND restore_id=? AND state='unknown'`).get(actor.id, binding.nativeOwnerId, String(args.restoreId));
          if (!owned) throw new CoreError("RECOVERY_REQUIRED", "A different Snapshot effect is unresolved.", "unknown");
        }
        const token = Object.freeze({});
        tokens.set(token, { actor, binding: Object.freeze(structuredClone(binding)) }); active.add(token);
        dispatchedOperation = operation;
        try {
          switch (operation) {
            case "agent.snapshot.restore-paused": return await runtime.restorePaused(token, args);
            case "agent.snapshot.restore-get": return runtime.get(token, args);
            case "agent.snapshot.resume-native": return await runtime.control(token, "resume", args);
            case "agent.snapshot.cancel-native": return await runtime.control(token, "cancel", args);
            case "agent.snapshot.confirm-native": return await runtime.confirmNative(token, args);
            default: throw new CoreError("NOT_FOUND", "Unknown paused Snapshot operation.");
          }
        } catch (error) {
          if (error instanceof LegacySnapshotRestoreError) throw new CoreError(error.code, error.message);
          if (error instanceof Error && error.message.includes("Global operationId conflict")) throw new CoreError("CONFLICT", "Global operationId belongs to another request or actor.");
          throw error;
        } finally { dispatchedOperation = undefined; active.delete(token); tokens.delete(token); }
      });
    },
  };
}
