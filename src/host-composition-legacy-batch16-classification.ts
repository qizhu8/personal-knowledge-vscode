import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "./contracts.js";
import { CoreError } from "./host-composition-legacy-batch15-errors.js";
import { resourcePath } from "./document-path.js";
import type { Storage } from "./storage.js";
import { remoteRuntimePending } from "./remote-runtime.js";
import { inspectPausedSnapshotJournal } from "./host-composition-legacy-snapshot-restore.js";
import {
  executeNativeClassification, recoverNativeClassification, inspectNativeClassificationHistory,
  scanNativeClassification, validateNativeClassificationHistoryLayout,
  type LegacyClassificationAdoption,
  type LegacyClassificationNativeHost,
} from "./legacy-classification-native.js";

export interface NativeBatch16ClassificationPolicy {
  scope: "exclusive-native-disposable-fixture";
  sourceRelative: string;
  sourceRootId: string;
  /** Excludes all other fixture writers and parent replacement for the complete operation. */
  assertFixtureOwnership(): void;
  authorize: LegacyClassificationNativeHost["authorize"];
  approveRecovery: LegacyClassificationNativeHost["approveRecovery"];
  previewOriginal: LegacyClassificationNativeHost["previewOriginal"];
  afterEffect?: LegacyClassificationNativeHost["afterEffect"];
  afterStage?: LegacyClassificationNativeHost["afterStage"];
  /** Independent native trust for genesis, exact ordered history and epoch, never request JSON. */
  assertHistoryAnchor(value: Readonly<{ workspaceId: string; sourceRootId: string; root: string;
    rootPin: { dev: string; ino: string }; genesisSha256: string; historySha256: string }>): void;
  assertAdoptionAnchor?(value: Readonly<LegacyClassificationAdoption>): void;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function verifyBatch16ClassificationHistory(db: DatabaseSync, workspaceId: string, root: string,
  policy: Pick<NativeBatch16ClassificationPolicy, "sourceRootId" | "assertFixtureOwnership" | "assertHistoryAnchor" | "assertAdoptionAnchor">) {
  policy.assertFixtureOwnership();
  const native = {
    assertOwnedDisposableFixture: () => policy.assertFixtureOwnership(),
    assertAdoptionAnchor: policy.assertAdoptionAnchor,
    globalReceipt(database: DatabaseSync, id: string) {
      const row = database.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(id);
      return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) } : null;
    },
  } as LegacyClassificationNativeHost;
  const history = inspectNativeClassificationHistory(db, native);
  for (const receipt of history.receipts) {
    const global = db.prepare("SELECT actor_id,operation FROM receipts WHERE operation_id=?").get(receipt.request.operationId);
    if (!global || global.actor_id !== receipt.actor.id || global.operation !== "knowledge.classification.native-strict.command")
      throw new CoreError("RECOVERY_CONFLICT", "Classification global actor or operation identity changed.", "unknown");
  }
  const scan = scanNativeClassification(db, native, root);
  const lineage = {
    rootPins: history.rootPins.length ? history.rootPins : [scan.pin],
    adoptions: history.adoptions,
  };
  if (JSON.stringify(lineage.rootPins.at(-1)) !== JSON.stringify(scan.pin))
    throw new CoreError("RECOVERY_CONFLICT", "Classification adoption does not anchor the current root.", "unknown");
  const status = validateNativeClassificationHistoryLayout(
    history, { workspaceId, sourceRootId: policy.sourceRootId }, scan, lineage.rootPins);
  const first = history.receipts[0] ?? history.pending;
  const genesisSha256 = first ? hash(first.before) : scan.layoutSha256;
  const historySha256 = hash(history.receipts);
  const origin = lineage.adoptions[0];
  policy.assertHistoryAnchor(Object.freeze({ workspaceId, sourceRootId: policy.sourceRootId,
    root: origin?.sourceRoot ?? root, rootPin: origin?.sourceRootPin ?? scan.pin, genesisSha256, historySha256 }));
  return { history, scan, status, genesisSha256, historySha256, lineage };
}

export function verifyBatch16ClassificationBackup(
  db: DatabaseSync,
  request: Readonly<{
    workspaceId: string; sourceRootId: string; sourceRelative: string; workspaceRoot: string;
    rootDevice: string; rootInode: string; genesisSha256: string; historySha256: string; layoutSha256: string;
  }>,
  backupRoot: string,
  policy: Pick<NativeBatch16ClassificationPolicy, "sourceRootId" | "assertFixtureOwnership" | "assertHistoryAnchor" | "assertAdoptionAnchor">,
) {
  policy.assertFixtureOwnership();
  const native = {
    assertOwnedDisposableFixture: () => policy.assertFixtureOwnership(),
    assertAdoptionAnchor: policy.assertAdoptionAnchor,
    globalReceipt(database: DatabaseSync, id: string) {
      const row = database.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(id);
      return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) } : null;
    },
  } as LegacyClassificationNativeHost;
  const history = inspectNativeClassificationHistory(db, native);
  for (const receipt of history.receipts) {
    const global = db.prepare("SELECT actor_id,operation FROM receipts WHERE operation_id=?").get(receipt.request.operationId);
    if (!global || global.actor_id !== receipt.actor.id || global.operation !== "knowledge.classification.native-strict.command")
      throw new CoreError("RECOVERY_CONFLICT", "Classification global actor or operation identity changed.", "unknown");
  }
  const scan = scanNativeClassification(db, native, join(backupRoot, request.sourceRelative));
  const logicalRootPin = { dev: request.rootDevice, ino: request.rootInode };
  const lineage = {
    rootPins: history.rootPins.length ? history.rootPins : [logicalRootPin],
    adoptions: history.adoptions,
  };
  if (JSON.stringify(lineage.rootPins.at(-1)) !== JSON.stringify(logicalRootPin))
    throw new CoreError("RECOVERY_CONFLICT", "Classified backup adoption does not anchor its pinned root.", "unknown");
  const logicalScan = { ...scan, pin: logicalRootPin };
  const status = validateNativeClassificationHistoryLayout(history,
    { workspaceId: request.workspaceId, sourceRootId: request.sourceRootId }, logicalScan, lineage.rootPins);
  const first = history.receipts[0] ?? history.pending;
  const genesisSha256 = first ? hash(first.before) : scan.layoutSha256;
  const historySha256 = hash(history.receipts);
  const origin = lineage.adoptions[0];
  if (status.status !== "committed" || scan.layoutSha256 !== request.layoutSha256
    || genesisSha256 !== request.genesisSha256 || historySha256 !== request.historySha256) {
    throw new CoreError("RECOVERY_CONFLICT", "Classified backup history or layout differs from its immutable source pin.", "unknown");
  }
  policy.assertHistoryAnchor(Object.freeze({
    workspaceId: request.workspaceId, sourceRootId: request.sourceRootId,
    root: origin?.sourceRoot ?? join(request.workspaceRoot, request.sourceRelative),
    rootPin: origin?.sourceRootPin ?? logicalRootPin, genesisSha256, historySha256,
  }));
  return { history, scan, status, genesisSha256, historySha256, lineage };
}

export function createBatch16ClassificationComposition(storage: Storage, db: DatabaseSync, workspaceId: string,
  policy: NativeBatch16ClassificationPolicy, assertSqlOwner: () => void) {
  if (policy.scope !== "exclusive-native-disposable-fixture" || !resourcePath.safeParse(policy.sourceRelative).success
    || !policy.sourceRelative.startsWith("packages/") || !/^[a-f0-9]{64}$/.test(policy.sourceRootId)
    || !["assertFixtureOwnership", "authorize", "approveRecovery", "previewOriginal", "assertHistoryAnchor"]
      .every(key => typeof policy[key as keyof NativeBatch16ClassificationPolicy] === "function"))
    throw new CoreError("INVALID_CONFIGURATION", "Classification requires explicit disposable native fixture ownership and history authority.");
  const scope = { workspaceId, sourceRootId: policy.sourceRootId, root: join(storage.workspaceRoot(), policy.sourceRelative) };
  let active = false;
  const host = (actor: Actor): LegacyClassificationNativeHost => ({
    assertOwnedDisposableFixture: () => policy.assertFixtureOwnership(),
    authorize: (who, workspace, rootId, action) => who.collaborationKind === "human" && who.id === actor.id
      && policy.authorize(who, workspace, rootId, action) === true,
    authorizeRoot: (workspace, rootId, root) => workspace === workspaceId && rootId === scope.sourceRootId && root === scope.root,
    approveRecovery: (who, intent) => policy.approveRecovery(who, intent),
    assertAdoptionAnchor: policy.assertAdoptionAnchor,
    previewOriginal: root => policy.previewOriginal(root),
    afterEffect: policy.afterEffect,
    afterStage: policy.afterStage,
    assertNoOtherPending(database) {
      assertSqlOwner();
      if (remoteRuntimePending(database) || inspectPausedSnapshotJournal(database))
        throw new CoreError("RECOVERY_REQUIRED", "Another workspace effect remains unresolved.", "unknown");
      for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
        const name = String(row.name);
        if (name === "legacy_classification_native_intent" || name === "remote_runtime_intents") continue;
        if ((/^(?:pending_|legacy_.*_intent$)|_intents$|_pending$|journal/i.test(name))
          && database.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" LIMIT 1`).get())
          throw new CoreError("RECOVERY_REQUIRED", "Another durable workspace effect is unresolved.", "unknown");
      }
      if (database.prepare("SELECT 1 FROM legacy_memory_erasure_operations WHERE status<>'committed' LIMIT 1").get()
        || database.prepare("SELECT 1 FROM coding_worker_effects WHERE state='intent' LIMIT 1").get()
        || database.prepare("SELECT 1 FROM coding_worker_records WHERE kind IN ('worker','check-intent') AND json_extract(record,'$.status')='intent' LIMIT 1").get())
        throw new CoreError("RECOVERY_REQUIRED", "Another durable native effect is unresolved.", "unknown");
    },
    globalReceipt(database, id) {
      const row = database.prepare("SELECT fingerprint,result FROM receipts WHERE operation_id=?").get(id);
      return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) } : null;
    },
    writeGlobalReceipt(database, id, fingerprint, result) {
      assertSqlOwner();
      database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
        .run(id, fingerprint, JSON.stringify(result), actor.id, "knowledge.classification.native-strict.command", new Date().toISOString());
    },
  });
  function verify(actor: Actor = { id: "", canWrite: false, collaborationKind: "human" }) {
    const checked = verifyBatch16ClassificationHistory(db, workspaceId, scope.root, policy);
    return { native: host(actor), history: checked.history, status: checked.status };
  }
  return {
    available(actor: Readonly<Actor> | undefined) {
      if (!actor?.canWrite || actor.collaborationKind !== "human") return false;
      try {
        policy.assertFixtureOwnership();
        return policy.authorize(actor, workspaceId, scope.sourceRootId, "apply") === true
          || policy.authorize(actor, workspaceId, scope.sourceRootId, "rollback") === true;
      } catch { return false; }
    },
    verify,
    dispatch(args: Record<string, unknown>, actor: Actor) {
      if (active) throw new CoreError("BUSY", "A native classification fixture operation is already active.");
      active = true;
      return storage.withWorkspaceExclusive(() => {
        const { native, history } = verify(actor);
        const value = history.pending
          ? recoverNativeClassification(db, native, scope, actor, args)
          : executeNativeClassification(db, native, scope, actor, args);
        verify(actor);
        return value;
      }).finally(() => { active = false; });
    },
  };
}
