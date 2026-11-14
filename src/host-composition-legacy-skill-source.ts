import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CoreError, type Actor } from "./contracts.js";
import { resourcePath } from "./document-path.js";
import { legacySkillBindingSchema, legacySkillManifestHash } from "./legacy-skill-lifecycle.js";
import { legacySkillSourceInstallInputSchema, legacySkillSourceRemoveInputSchema, legacySkillSourceBridgeInputSchema, validateLegacySkillSourceRemovePlan } from "./legacy-skill-source.js";
import {
  executeNativeLegacySkillSource, recoverNativeLegacySkillSource, executeNativeLegacySkillSourceRemove, recoverNativeLegacySkillSourceRemove, inspectNativeLegacySkillSource,
  readNativeLegacySkillSourceHistory, validateNativeLegacySkillSourceJournalSchema,
  type LegacySkillSourceNativeAuthority,
  executeNativeLegacySkillSourceBridge, verifyNativeLegacySkillSourceBridge, verifyNativeLegacySkillSourceBridgeSql,
  replayNativeLegacySkillSourceBridgeHistory,
} from "./legacy-skill-source-native.js";
import { assertBatch15OtherPending, inspectBatch15SkillPending, verifyBatch15SkillWorkspace } from "./host-composition-legacy-batch15-skill.js";
import { legacySkillSourceOperation, legacySkillSourceRemoveOperation, legacySkillSourceBridgeOperation } from "./host-composition-legacy-skill-source-contracts.js";
import type { Storage } from "./storage.js";

export interface NativeLegacySkillSourcePolicy {
  scope: "exclusive-native-disposable-fixture";
  authorityForActor(actor: Readonly<Actor>): LegacySkillSourceNativeAuthority | undefined;
}

export function inspectSkillSourceActivity(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_skill_source_native_intent'").get())
    return { active: false, pending: undefined };
  validateNativeLegacySkillSourceJournalSchema(db);
  const pending = db.prepare("SELECT operation_id,plan_json FROM legacy_skill_source_native_intent").get();
  const active = !!pending || !!db.prepare("SELECT 1 FROM legacy_skill_source_native_history LIMIT 1").get()
    || !!db.prepare("SELECT 1 FROM legacy_skill_source_native_receipt LIMIT 1").get()
    || !!db.prepare("SELECT 1 FROM legacy_skill_source_native_adoption LIMIT 1").get();
  if (pending) {
    try {
      const plan = JSON.parse(String(pending.plan_json));
      const input = (plan.kind === "bridge" ? legacySkillSourceBridgeInputSchema : plan.kind === "remove" ? legacySkillSourceRemoveInputSchema : legacySkillSourceInstallInputSchema).parse(plan.input);
      const binding = legacySkillBindingSchema.parse(plan.kind === "bridge" ? plan.genesis.binding : plan.binding);
      if (input.operationId !== pending.operation_id) throw new Error("Operation identity differs.");
      return { active, pending: { operationId: input.operationId, actorId: binding.actorId,
        operation: plan.kind === "bridge" ? legacySkillSourceBridgeOperation : plan.kind === "remove" ? legacySkillSourceRemoveOperation : legacySkillSourceOperation } };
    } catch {
      throw new CoreError("RECOVERY_CONFLICT", "Canonical Skill source intent identity changed.", "unknown");
    }
  }
  return { active, pending: undefined };
}

export function assertSkillSourceIntegrated(db: DatabaseSync, integrated = false) {
  const activity = inspectSkillSourceActivity(db);
  if (activity.active && !integrated)
    throw new CoreError("RECOVERY_AUTHORITY_REQUIRED", "Canonical Skill source history requires its independent native authority.", "unknown");
  return activity;
}

function assertNoLegacySkillHistory(db: DatabaseSync, root: string, host?: LegacySkillSourceNativeAuthority) {
  if (inspectBatch15SkillPending(db) || db.prepare("SELECT 1 FROM legacy_skill_native_history LIMIT 1").get()) {
    if (!host || inspectBatch15SkillPending(db) || !verifyNativeLegacySkillSourceBridge(db, host))
      throw new CoreError("RECOVERY_CONFLICT", "Canonical source and legacy projection journals lack a shared authorized version lineage.", "unknown");
    return;
  }
  verifyBatch15SkillWorkspace(db, root);
}

export function verifyGlobalSkillSourceReceipts(db: DatabaseSync, workspaceId: string, actor?: Actor) {
  const rows = db.prepare("SELECT operation_id,plan_json FROM legacy_skill_source_native_history ORDER BY sequence").all();
  const globalCount = Number(db.prepare("SELECT COUNT(*) n FROM receipts WHERE operation IN (?,?,?)")
    .get(legacySkillSourceOperation, legacySkillSourceRemoveOperation, legacySkillSourceBridgeOperation)!.n);
  if (rows.length !== Number(db.prepare("SELECT COUNT(*) n FROM legacy_skill_source_native_receipt").get()!.n) || rows.length !== globalCount)
    throw new CoreError("RECOVERY_CONFLICT", "Canonical Skill source history and receipts differ.", "unknown");
  for (const row of rows) {
    const raw = JSON.parse(String(row.plan_json)), bridge = raw.kind === "bridge";
    const plan = bridge ? raw.genesis : raw;
    const binding = legacySkillBindingSchema.parse(plan.binding);
    const remove = plan.kind === "remove";
    const input = (bridge ? legacySkillSourceBridgeInputSchema : remove ? legacySkillSourceRemoveInputSchema : legacySkillSourceInstallInputSchema).parse(bridge ? raw.input : plan.input);
    const result = remove ? (() => {
      const checked = validateLegacySkillSourceRemovePlan(plan);
      return { operationId: checked.input.operationId, sourceSha256: checked.input.sourceSha256,
        sourceManifestSha256: legacySkillManifestHash(checked.sourceAfterManifest), destinationSha256: null,
        destinationManifestSha256: legacySkillManifestHash(checked.destinationAfterManifest) };
    })() : {
      operationId: input.operationId,
      sourceSha256: plan.source.afterSha256,
      sourceManifestSha256: legacySkillManifestHash(plan.sourceAfterManifest),
      destinationSha256: createHash("sha256").update(Buffer.from(plan.destinationAfterBase64, "base64")).digest("hex"),
      destinationManifestSha256: legacySkillManifestHash(plan.destinationAfterManifest),
    };
    const local = db.prepare("SELECT * FROM legacy_skill_source_native_receipt WHERE operation_id=?").get(row.operation_id!);
    const global = db.prepare("SELECT * FROM receipts WHERE operation_id=?").get(row.operation_id!);
    if (input.operationId !== row.operation_id || binding.workspaceId !== workspaceId || !local || !global
      || local.binding_json !== JSON.stringify(binding) || global.actor_id !== binding.actorId
      || global.operation !== (bridge ? legacySkillSourceBridgeOperation : remove ? legacySkillSourceRemoveOperation : legacySkillSourceOperation) || global.fingerprint !== local.fingerprint
      || (actor && (actor.id !== binding.actorId || local.fingerprint !== createHash("sha256").update(JSON.stringify({ actor, binding, input })).digest("hex")))
      || local.result_json !== JSON.stringify(result) || global.result !== local.result_json)
      throw new CoreError("RECOVERY_CONFLICT", "Canonical Skill source global receipt lineage changed.", "unknown");
  }
}

export function createNativeLegacySkillSourceComposition(storage: Storage, db: DatabaseSync, workspaceId: string,
  policy: NativeLegacySkillSourcePolicy, assertSqlOwner: () => void) {
  if (policy.scope !== "exclusive-native-disposable-fixture" || typeof policy.authorityForActor !== "function")
    throw new CoreError("INVALID_CONFIGURATION", "Canonical Skill source requires exclusive native fixture authority.");
  function authority(actor: Actor, operation = legacySkillSourceOperation): LegacySkillSourceNativeAuthority {
    if (actor.collaborationKind !== "human") throw new CoreError("ACCESS_DENIED", "Canonical Skill source requires a human actor.");
    const supplied = policy.authorityForActor(Object.freeze({ ...actor }));
    if (!supplied) throw new CoreError("ACCESS_DENIED", "No canonical Skill source native admission.");
    const binding = legacySkillBindingSchema.parse(supplied.binding);
    if (binding.workspaceId !== workspaceId || binding.actorId !== actor.id)
      throw new CoreError("ACCESS_DENIED", "Canonical Skill source admission differs from authenticated actor or workspace.");
    for (const path of [supplied.roots.source, supplied.roots.destination]) {
      const local = relative(storage.workspaceRoot(), path);
      if (resolve(path) !== path || !resourcePath.safeParse(local).success || !local.startsWith("packages/")
        || join(storage.workspaceRoot(), local) !== path)
        throw new CoreError("ACCESS_DENIED", "Canonical Skill roots must be approved workspace package fixtures.");
    }
    return {
      ...supplied, binding: Object.freeze(binding), roots: Object.freeze({ ...supplied.roots }),
      bundle: Buffer.from(supplied.bundle),
      assertOwner: supplied.assertOwner.bind(supplied),
      authorize: supplied.authorize.bind(supplied),
      approvePlan: supplied.approvePlan.bind(supplied),
      approveRemovePlan: supplied.approveRemovePlan?.bind(supplied),
      approveBridge: supplied.approveBridge?.bind(supplied),
      verifyBridge: supplied.verifyBridge?.bind(supplied),
      reconcileBridgeAnchor: supplied.reconcileBridgeAnchor?.bind(supplied),
      checkAnchor: supplied.checkAnchor.bind(supplied),
      advanceAnchor: supplied.advanceAnchor.bind(supplied),
      reconcileAnchor: supplied.reconcileAnchor.bind(supplied),
      reconcileRemoveAnchor: supplied.reconcileRemoveAnchor?.bind(supplied),
      bundleForDigest: supplied.bundleForDigest.bind(supplied),
      assertSqlOwner(database) {
        if (database !== db) throw new CoreError("STORAGE_UNAVAILABLE", "Canonical Skill database owner differs.");
        assertSqlOwner();
      },
      assertNoOtherPendingNative() {
        if (operation === legacySkillSourceBridgeOperation && !inspectSkillSourceActivity(db).active)
          verifyBatch15SkillWorkspace(db, storage.workspaceRoot());
        else assertNoLegacySkillHistory(db, storage.workspaceRoot(), supplied);
        assertBatch15OtherPending(db, true);
        supplied.assertNoOtherPendingNative();
      },
      assertNoOtherPendingSql(database) {
        assertSqlOwner();
        if (database !== db) throw new CoreError("STORAGE_UNAVAILABLE", "Canonical Skill database owner differs.");
        if (database.prepare("SELECT 1 FROM legacy_skill_native_history LIMIT 1").get()) {
          const row = database.prepare("SELECT plan_json FROM legacy_skill_source_native_history WHERE sequence=1").get()
            ?? database.prepare("SELECT plan_json FROM legacy_skill_source_native_intent").get();
          if (row) {
            const plan = JSON.parse(String(row.plan_json));
            if (plan.kind !== "bridge") throw new CoreError("RECOVERY_CONFLICT", "Legacy history lacks source bridge.");
            verifyNativeLegacySkillSourceBridgeSql(database, plan);
          } else if (operation !== legacySkillSourceBridgeOperation)
            throw new CoreError("RECOVERY_CONFLICT", "Legacy projection history lacks an authorized source lineage.", "unknown");
        }
        verifyGlobalSkillSourceReceipts(database, workspaceId, actor);
        for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
          const name = String(row.name);
          if (name === "legacy_skill_source_native_intent" || !/^(?:pending_|legacy_.*_intent$)|_intents$|journal|_pending$/i.test(name))
            continue;
          const where = name === "remote_runtime_intents"
            ? " WHERE NOT (kind='remote.subscription.bundle' AND state='complete')" : "";
          if (database.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}"${where} LIMIT 1`).get())
            throw new CoreError("RECOVERY_CONFLICT", "Another pending journal appeared before canonical Skill SQL commit.", "unknown");
        }
        supplied.assertNoOtherPendingSql(database);
      },
      globalReceipt(database, id) {
        const row = database.prepare("SELECT * FROM receipts WHERE operation_id=?").get(id);
        if (!row) return null;
        if (row.actor_id !== actor.id || row.operation !== operation)
          throw new CoreError("CONFLICT", "Canonical Skill operation ID belongs to another actor or operation.");
        return { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result)) };
      },
      writeGlobalReceipt(database, id, fingerprint, result) {
        assertSqlOwner();
        database.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)")
          .run(id, fingerprint, JSON.stringify(result), actor.id, operation, new Date().toISOString());
      },
    };
  }
  return {
    available(actor: Readonly<Actor> | undefined, operation = legacySkillSourceOperation) {
      if (!actor?.canWrite) return false;
      try {
        const host = authority(actor, operation);
        host.assertOwner();
        if (operation === legacySkillSourceBridgeOperation) {
          if (inspectBatch15SkillPending(db) || !host.approveBridge || !host.verifyBridge || !host.reconcileBridgeAnchor) return false;
        } else assertNoLegacySkillHistory(db, storage.workspaceRoot(), host);
        return host.authorize(actor, host.binding) === true
          && (operation !== legacySkillSourceRemoveOperation || !!host.approveRemovePlan && !!host.reconcileRemoveAnchor);
      } catch { return false; }
    },
    verify(actor: Actor) {
      const host = authority(actor);
      assertNoLegacySkillHistory(db, storage.workspaceRoot(), host);
      const pending = inspectNativeLegacySkillSource(db, host, actor);
      const history = pending ? readNativeLegacySkillSourceHistory(db, host, actor)
        : readNativeLegacySkillSourceHistory(db, host, actor, { verifyDestination: true });
      verifyGlobalSkillSourceReceipts(db, workspaceId, actor);
      return { pending, history };
    },
    replayLegacy(actor: Actor) {
      const bridge = replayNativeLegacySkillSourceBridgeHistory(db, authority(actor), actor);
      verifyGlobalSkillSourceReceipts(db, workspaceId, actor);
      return bridge;
    },
    async dispatch(args: Record<string, unknown>, actor: Actor, operation = legacySkillSourceOperation) {
      const remove = operation === legacySkillSourceRemoveOperation;
      const bridge = operation === legacySkillSourceBridgeOperation;
      const input = (bridge ? legacySkillSourceBridgeInputSchema : remove ? legacySkillSourceRemoveInputSchema : legacySkillSourceInstallInputSchema).parse(args);
      return storage.withWorkspaceExclusive(() => {
        const host = authority(actor, operation);
        if (!bridge) assertNoLegacySkillHistory(db, storage.workspaceRoot(), host);
        verifyGlobalSkillSourceReceipts(db, workspaceId, actor);
        if (bridge) {
          const recovery = !!inspectSkillSourceActivity(db).pending;
          const committed = !!db.prepare("SELECT 1 FROM legacy_skill_source_native_receipt WHERE operation_id=?").get(input.operationId);
          try { return executeNativeLegacySkillSourceBridge(db, host, actor, input, recovery); }
          catch (error) {
            if (committed && error instanceof CoreError && error.code === "RECOVERY_REQUIRED")
              return executeNativeLegacySkillSourceBridge(db, host, actor, input, true);
            throw error;
          }
        }
        // Recovery is explicit for the identical request, including a committed
        // operation whose independent postcommit anchor advance was interrupted.
        const committed = db.prepare("SELECT 1 FROM legacy_skill_source_native_receipt WHERE operation_id=?").get(input.operationId);
        if (inspectSkillSourceActivity(db).pending)
          return remove ? recoverNativeLegacySkillSourceRemove(db, host, actor, input) : recoverNativeLegacySkillSource(db, host, actor, input);
        try {
          if (committed) {
            readNativeLegacySkillSourceHistory(db, host, actor, { verifyDestination: true });
          }
          return remove ? executeNativeLegacySkillSourceRemove(db, host, actor, input) : executeNativeLegacySkillSource(db, host, actor, input);
        }
        catch (error) {
          if (committed && error instanceof CoreError && error.code === "RECOVERY_REQUIRED")
            return remove ? recoverNativeLegacySkillSourceRemove(db, host, actor, input) : recoverNativeLegacySkillSource(db, host, actor, input);
          throw error;
        }
      });
    },
  };
}
